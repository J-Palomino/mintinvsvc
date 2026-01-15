/**
 * GL Journal Export Service
 * Generates daily GL journal entries for accounting system import
 * Source of Truth: Dutchie POS API (/reporting/transactions)
 */

const axios = require('axios');
const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');

const DUTCHIE_API_URL = process.env.DUTCHIE_API_URL || 'https://api.pos.dutchie.com';
const OUTPUT_DIR = process.env.GL_EXPORT_DIR || './exports';

// Dutchie to Accumatica branch code mapping
const BRANCH_CODES = {
  // Florida (FLD-)
  'Mint Bonita Springs': 'FLD-BONITA',
  'Mint Bonita Springs ': 'FLD-BONITA',
  'Mint Bradenton': 'FLD-BRADEN',
  'Mint Brandon': 'FLD-BRANDO',
  'Mint Cape Coral': 'FLD-CAPECO',
  'Mint Delray Beach': 'FLD-DELRAY',
  'Mint Gainesville': 'FLD-GAINES',
  'Mint Jacksonville': 'FLD-JA4332',
  'Mint Longwood': 'FLD-LONGWO',
  'Mint Melbourne': 'FLD-MELBOU',
  'Mint Miami': 'FLD-MIAMI',
  'Mint Orlando': 'FLD-O10615',
  'Mint Orlando ': 'FLD-O10615',
  'Mint Sarasota': 'FLD-SARASO',
  'Mint St. Augustine': 'FLD-STAUGU',
  'Mint Stuart': 'FLD-STUART',
  // Michigan (MID-)
  'Mint Kalamazoo': 'MID-KALAMA',
  'Mint Portage': 'MI-GB2',
  'Mint Roseville': 'MID-ROSE',
  'Mint Coldwater': 'MID-COLDWA',
  'Mint Monroe': 'MID-MONROE',
  'Mint New Buffalo': 'MID-NB',
  // Arizona (AZD-/AZV-)
  'Mint Mesa': 'AZD-4245IN',
  'Mint Mesa ': 'AZD-4245IN',
  'Mint Bell Road Phoenix': 'AZD-UH',
  'Mint 75th Ave Phoenix': 'AZV-ENCANT',
  'Mint Buckeye/Verado': 'AZD-BUCK',
  'Mint El Mirage': 'AZD-ELMIRA',
  'Mint Northern Phoenix': 'AZV-GTL',
  'Mint Scottsdale': 'AZV-EBA',
  'Mint Tempe': 'AZV-SWT',
  // Nevada (NVD-)
  'Mint Spring Valley': 'NVD-RAIN',
  'Mint Las Vegas Strip': 'NVD-PARA',
  'Mint Las Vegas Strip ': 'NVD-PARA',
  // Missouri (MOD-)
  'Mint St. Peters': 'MOD-MO4',
  // Illinois (ILD-)
  'Mint Willowbrook': 'ILD-WILLOW'
};

// GL Account codes in order
const ACCOUNTS = [
  { code: '40001', desc: 'Retail Income: Retail Sales', type: 'credit', field: 'grossSales' },
  { code: '40002', desc: 'Retail Income: Retail: Discounts and Coupons', type: 'debit', field: 'discounts' },
  { code: '40003', desc: 'Retail Income: Sales Return', type: 'debit', field: 'returns' },
  { code: '40004', desc: 'Loyalty Discounts', type: 'debit', field: 'loyaltySpent' },
  { code: '23500', desc: 'Taxes Payable - Sales & Use', type: 'credit', field: 'tax' },
  { code: '10000', desc: 'Cash on Hand', type: 'debit', field: 'netCash' },
  { code: '11010', desc: 'Debit Card Receivable', type: 'debit', field: 'debitPaid' },
  { code: '70260', desc: 'Overage/Shortage: Cash Ledger Adj', type: 'balance', field: 'overage' },
  { code: '50000', desc: 'Retail - Consumable Products for Resale', type: 'debit', field: 'cogs' },
  { code: '12250', desc: 'Inventory - Finished Goods', type: 'credit', field: 'cogs' }
];

class GLExportService {
  constructor(locationConfigs) {
    this.locationConfigs = locationConfigs;
  }

  formatNumber(num) {
    return num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  getBranchCode(storeName) {
    if (BRANCH_CODES[storeName]) return BRANCH_CODES[storeName];
    const trimmed = storeName.trim();
    if (BRANCH_CODES[trimmed]) return BRANCH_CODES[trimmed];
    const parts = storeName.replace('Mint ', '').trim().split(' ');
    const code = parts[0].substring(0, 6).toUpperCase();
    return `UNK-${code}`;
  }

  async fetchTransactions(apiKey, storeName, fromDate, toDate, attempt = 1) {
    const client = axios.create({
      baseURL: DUTCHIE_API_URL,
      auth: { username: apiKey, password: '' }
    });

    const params = {
      FromDateUTC: fromDate,
      ToDateUTC: toDate,
      IncludeDetail: true,
      IncludeTaxes: true,
      IncludeOrderIds: true
    };

    try {
      const response = await client.get('/reporting/transactions', { params, timeout: 180000 });
      return { success: true, data: response.data || [] };
    } catch (error) {
      const errorMsg = error.response?.status || error.message;
      if (attempt === 1) {
        console.log(`  ${storeName}: FAILED (${errorMsg}) - retrying...`);
        await new Promise(r => setTimeout(r, 2000));
        return this.fetchTransactions(apiKey, storeName, fromDate, toDate, 2);
      }
      return { success: false, error: errorMsg };
    }
  }

  aggregateTransactions(transactions) {
    const totals = {
      grossSales: 0,
      discounts: 0,        // Non-loyalty discounts only (totalDiscount - loyaltySpent)
      loyaltySpent: 0,
      returns: 0,
      tax: 0,
      cashPaid: 0,
      debitPaid: 0,
      creditPaid: 0,
      totalPaid: 0,
      changeDue: 0,
      cogs: 0,
      netCash: 0,
      overage: 0
    };

    for (const t of transactions) {
      if (t.isVoid) continue;

      if (t.isReturn) {
        totals.returns += Math.abs(t.total || 0);
      } else {
        totals.grossSales += t.subtotal || 0;
        // loyaltySpent is already included in totalDiscount, so subtract to avoid double-counting
        const loyaltyAmount = t.loyaltySpent || 0;
        const totalDiscount = t.totalDiscount || 0;
        totals.discounts += totalDiscount - loyaltyAmount;  // Non-loyalty discounts only
        totals.loyaltySpent += loyaltyAmount;
        totals.tax += t.tax || 0;
        totals.cashPaid += t.cashPaid || 0;
        totals.debitPaid += t.debitPaid || 0;
        totals.creditPaid += t.creditPaid || 0;
        totals.totalPaid += t.paid || 0;
        totals.changeDue += t.changeDue || 0;
      }

      if (t.items) {
        for (const item of t.items) {
          if (!item.isReturned) {
            totals.cogs += (item.unitCost || 0) * (item.quantity || 0);
          }
        }
      }
    }

    totals.netCash = totals.cashPaid - totals.changeDue;

    const totalDebits = totals.discounts + totals.returns + totals.loyaltySpent +
                        totals.netCash + totals.debitPaid + totals.cogs;
    const totalCredits = totals.grossSales + totals.tax + totals.cogs;
    totals.overage = totalCredits - totalDebits;

    return totals;
  }

  escapeCSV(value) {
    if (value === null || value === undefined) return '';
    const str = String(value);
    if (str.includes(',') || str.includes('"') || str.includes('\n')) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  }

  generateGLRows(branchCode, dutchieStoreName, totals, refNumber) {
    const rows = [];

    for (const account of ACCOUNTS) {
      let debit = 0;
      let credit = 0;
      const value = totals[account.field] || 0;

      if (account.code === '70260') {
        if (totals.overage > 0) {
          credit = totals.overage;
        } else if (totals.overage < 0) {
          debit = Math.abs(totals.overage);
        }
      } else if (account.type === 'debit') {
        debit = value;
      } else if (account.type === 'credit') {
        credit = value;
      }

      rows.push({
        branchCode,
        dutchieStoreName,
        accountCode: account.code,
        accountDesc: account.desc,
        subaccount: '00-00',
        refNumber,
        quantity: '1.00',
        uom: '',
        debit: this.formatNumber(debit),
        credit: this.formatNumber(credit)
      });
    }

    return rows;
  }

  rowToTSV(row) {
    return [
      row.branchCode,
      row.dutchieStoreName,
      row.accountCode,
      row.accountDesc,
      row.subaccount,
      row.refNumber,
      row.quantity,
      row.uom,
      row.debit,
      row.credit
    ].join('\t');
  }

  rowToCSV(row) {
    return [
      this.escapeCSV(row.branchCode),
      this.escapeCSV(row.dutchieStoreName),
      this.escapeCSV(row.accountCode),
      this.escapeCSV(row.accountDesc),
      this.escapeCSV(row.subaccount),
      this.escapeCSV(row.refNumber),
      this.escapeCSV(row.quantity),
      this.escapeCSV(row.uom),
      this.escapeCSV(row.debit),
      this.escapeCSV(row.credit)
    ].join(',');
  }

  async exportForDate(reportDate) {
    const fromDate = `${reportDate}T00:00:00Z`;
    const toDate = `${reportDate}T23:59:59Z`;
    const refNumber = `${reportDate} DS`;

    console.log(`\n=== GL Journal Export for ${reportDate} ===`);

    if (!fs.existsSync(OUTPUT_DIR)) {
      fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    }

    const headerColumns = [
      'Branch',
      'Dutchie Store Name',
      'Account',
      'Description',
      'Subaccount',
      'Ref. Number',
      'Quantity',
      'UOM',
      'Debit Amount',
      'Credit Amount'
    ];

    const tsvHeaders = headerColumns.join('\t');
    const csvHeaders = headerColumns.join(',');

    const note = [
      `# GL Journal Export - ${reportDate}`,
      `# Source of Truth: Dutchie POS API (/reporting/transactions)`,
      `# Generated: ${new Date().toISOString()}`,
      `# NOTE: Verify branch codes and account mappings match your accounting system.`,
      `# Branch codes in this export are derived from Dutchie location names.`,
      `#`
    ].join('\n');

    const allRows = [];
    const failedStores = [];
    let grandSales = 0;
    let successCount = 0;

    for (const loc of this.locationConfigs) {
      const branchCode = this.getBranchCode(loc.name);
      process.stdout.write(`  ${loc.name} (${branchCode})... `);

      const result = await this.fetchTransactions(loc.apiKey, loc.name, fromDate, toDate);

      if (!result.success) {
        console.log(`FAILED: ${result.error}`);
        failedStores.push({ store: loc.name, error: result.error });
        continue;
      }

      const transactions = result.data;
      const totals = this.aggregateTransactions(transactions);
      const rows = this.generateGLRows(branchCode, loc.name, totals, refNumber);

      allRows.push(...rows);
      grandSales += totals.grossSales;
      successCount++;

      console.log(`${transactions.length} txns, $${this.formatNumber(totals.grossSales)}`);
    }

    // Generate TSV file
    const tsvFilename = `gl_journal_${reportDate}.tsv`;
    const tsvFilepath = path.join(OUTPUT_DIR, tsvFilename);
    const tsvContent = [note, tsvHeaders, ...allRows.map(r => this.rowToTSV(r))].join('\n');
    fs.writeFileSync(tsvFilepath, tsvContent);

    // Generate CSV file
    const csvFilename = `gl_journal_${reportDate}.csv`;
    const csvFilepath = path.join(OUTPUT_DIR, csvFilename);
    const csvContent = [csvHeaders, ...allRows.map(r => this.rowToCSV(r))].join('\n');
    fs.writeFileSync(csvFilepath, csvContent);

    console.log(`\nGL Export complete: ${successCount}/${this.locationConfigs.length} stores, $${this.formatNumber(grandSales)} total sales`);
    console.log(`Files: ${tsvFilepath}, ${csvFilepath}`);

    if (failedStores.length > 0) {
      console.error(`WARNING: ${failedStores.length} store(s) failed:`);
      failedStores.forEach(f => console.error(`  - ${f.store}: ${f.error}`));
      return { success: false, failedStores, tsvFilepath, csvFilepath };
    }

    return { success: true, stores: successCount, totalSales: grandSales, tsvFilepath, csvFilepath };
  }

  async exportYesterday() {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const reportDate = yesterday.toISOString().split('T')[0];
    return this.exportForDate(reportDate);
  }

  async sendEmail(tsvFilepath, csvFilepath, reportDate, summary) {
    // Check if email is configured
    const smtpHost = process.env.SMTP_HOST;
    const smtpPort = process.env.SMTP_PORT || 587;
    const smtpUser = process.env.SMTP_USER;
    const smtpPass = process.env.SMTP_PASS;
    const emailTo = process.env.GL_EMAIL_TO;
    const emailFrom = process.env.GL_EMAIL_FROM || smtpUser;

    if (!smtpHost || !smtpUser || !emailTo) {
      console.log('Email not configured - skipping email delivery');
      console.log('Required env vars: SMTP_HOST, SMTP_USER, SMTP_PASS, GL_EMAIL_TO');
      return { sent: false, reason: 'not configured' };
    }

    const transporter = nodemailer.createTransport({
      host: smtpHost,
      port: smtpPort,
      secure: smtpPort === 465,
      auth: {
        user: smtpUser,
        pass: smtpPass
      }
    });

    const recipients = emailTo.split(',').map(e => e.trim());

    const mailOptions = {
      from: emailFrom,
      to: recipients,
      subject: `GL Journal Export - ${reportDate}`,
      text: `GL Journal Export for ${reportDate}

Source: Dutchie POS API
Generated: ${new Date().toISOString()}

Summary:
- Stores: ${summary.stores}
- Total Sales: $${this.formatNumber(summary.totalSales)}
- Status: ${summary.success ? 'SUCCESS' : 'COMPLETED WITH ERRORS'}

The GL journal files are attached (TSV and CSV formats).

---
This is an automated report from Mint Inventory Sync Service.
`,
      html: `
<h2>GL Journal Export - ${reportDate}</h2>
<p><strong>Source:</strong> Dutchie POS API<br>
<strong>Generated:</strong> ${new Date().toISOString()}</p>

<h3>Summary</h3>
<table border="1" cellpadding="8" cellspacing="0">
  <tr><td><strong>Stores</strong></td><td>${summary.stores}</td></tr>
  <tr><td><strong>Total Sales</strong></td><td>$${this.formatNumber(summary.totalSales)}</td></tr>
  <tr><td><strong>Status</strong></td><td>${summary.success ? '✓ SUCCESS' : '⚠ COMPLETED WITH ERRORS'}</td></tr>
</table>

<p>The GL journal files are attached (TSV and CSV formats).</p>

<hr>
<p style="color: #666; font-size: 12px;">This is an automated report from Mint Inventory Sync Service.</p>
`,
      attachments: [
        {
          filename: path.basename(tsvFilepath),
          path: tsvFilepath
        },
        {
          filename: path.basename(csvFilepath),
          path: csvFilepath
        }
      ]
    };

    try {
      const info = await transporter.sendMail(mailOptions);
      console.log(`Email sent to ${recipients.join(', ')}: ${info.messageId}`);
      return { sent: true, messageId: info.messageId, recipients };
    } catch (error) {
      console.error('Failed to send email:', error.message);
      return { sent: false, error: error.message };
    }
  }

  async exportAndEmail(reportDate = null) {
    // If no date provided, use yesterday
    if (!reportDate) {
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      reportDate = yesterday.toISOString().split('T')[0];
    }

    const result = await this.exportForDate(reportDate);

    // Send email with both TSV and CSV attachments
    const emailResult = await this.sendEmail(result.tsvFilepath, result.csvFilepath, reportDate, {
      stores: result.stores || 0,
      totalSales: result.totalSales || 0,
      success: result.success
    });

    return { ...result, email: emailResult };
  }
}

module.exports = GLExportService;
