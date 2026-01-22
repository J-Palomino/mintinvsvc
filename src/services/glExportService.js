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

// Store timezone mapping (IANA timezone names)
// Used to convert local business day to UTC for Dutchie API queries
const STORE_TIMEZONES = {
  // Florida - Eastern Time
  'Mint Bonita Springs': 'America/New_York',
  'Mint Bonita Springs ': 'America/New_York',
  'Mint Bradenton': 'America/New_York',
  'Mint Brandon': 'America/New_York',
  'Mint Cape Coral': 'America/New_York',
  'Mint Delray Beach': 'America/New_York',
  'Mint Gainesville': 'America/New_York',
  'Mint Jacksonville': 'America/New_York',
  'Mint Longwood': 'America/New_York',
  'Mint Melbourne': 'America/New_York',
  'Mint Miami': 'America/New_York',
  'Mint Orlando': 'America/New_York',
  'Mint Orlando ': 'America/New_York',
  'Mint Sarasota': 'America/New_York',
  'Mint St. Augustine': 'America/New_York',
  'Mint Stuart': 'America/New_York',
  // Michigan - Eastern Time
  'Mint Kalamazoo': 'America/Detroit',
  'Mint Portage': 'America/Detroit',
  'Mint Roseville': 'America/Detroit',
  'Mint Coldwater': 'America/Detroit',
  'Mint Monroe': 'America/Detroit',
  'Mint New Buffalo': 'America/Detroit',
  // Arizona - Mountain Time (no DST)
  'Mint Mesa': 'America/Phoenix',
  'Mint Mesa ': 'America/Phoenix',
  'Mint Bell Road Phoenix': 'America/Phoenix',
  'Mint 75th Ave Phoenix': 'America/Phoenix',
  'Mint Buckeye/Verado': 'America/Phoenix',
  'Mint El Mirage': 'America/Phoenix',
  'Mint Northern Phoenix': 'America/Phoenix',
  'Mint Scottsdale': 'America/Phoenix',
  'Mint Tempe': 'America/Phoenix',
  // Nevada - Pacific Time
  'Mint Spring Valley': 'America/Los_Angeles',
  'Mint Las Vegas Strip': 'America/Los_Angeles',
  'Mint Las Vegas Strip ': 'America/Los_Angeles',
  // Missouri - Central Time
  'Mint St. Peters': 'America/Chicago',
  // Illinois - Central Time
  'Mint Willowbrook': 'America/Chicago'
};

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

  /**
   * Get the IANA timezone for a store
   * @param {string} storeName - The store name
   * @returns {string} IANA timezone name (defaults to America/New_York)
   */
  getStoreTimezone(storeName) {
    if (STORE_TIMEZONES[storeName]) return STORE_TIMEZONES[storeName];
    const trimmed = storeName.trim();
    if (STORE_TIMEZONES[trimmed]) return STORE_TIMEZONES[trimmed];
    // Default to Eastern Time if unknown
    return 'America/New_York';
  }

  /**
   * Calculate the UTC offset in hours for a given timezone and date
   * Handles DST automatically using JavaScript's Intl API
   * @param {string} timezone - IANA timezone name (e.g., 'America/Phoenix')
   * @param {string} dateStr - Date string in YYYY-MM-DD format
   * @returns {number} UTC offset in hours (negative for west of UTC)
   */
  getUTCOffsetHours(timezone, dateStr) {
    // Create a date at noon local time to avoid DST transition edge cases
    const date = new Date(`${dateStr}T12:00:00`);

    // Get the timezone offset using Intl.DateTimeFormat
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      timeZoneName: 'shortOffset'
    });

    const parts = formatter.formatToParts(date);
    const tzPart = parts.find(p => p.type === 'timeZoneName');

    if (tzPart && tzPart.value) {
      // Parse offset like "GMT-7" or "GMT-8"
      const match = tzPart.value.match(/GMT([+-]?\d+)/);
      if (match) {
        return parseInt(match[1], 10);
      }
    }

    // Fallback: calculate offset by comparing local and UTC representations
    const utcDate = new Date(date.toLocaleString('en-US', { timeZone: 'UTC' }));
    const tzDate = new Date(date.toLocaleString('en-US', { timeZone: timezone }));
    return Math.round((tzDate - utcDate) / (1000 * 60 * 60));
  }

  /**
   * Get UTC boundaries for a local business day
   * Converts local midnight-to-midnight into UTC timestamps for Dutchie API
   * @param {string} reportDate - Date in YYYY-MM-DD format (local date)
   * @param {string} timezone - IANA timezone name
   * @returns {{ fromDateUTC: string, toDateUTC: string }} UTC timestamps
   */
  getLocalDayBoundariesUTC(reportDate, timezone) {
    const offsetHours = this.getUTCOffsetHours(timezone, reportDate);

    // Local midnight in UTC: if offset is -7, local midnight = 07:00 UTC
    const utcStartHour = -offsetHours;

    // Calculate the UTC date/time for local midnight
    const [year, month, day] = reportDate.split('-').map(Number);

    // Start: local midnight = reportDate at 00:00 local = reportDate at (utcStartHour):00 UTC
    // If utcStartHour >= 24, it rolls into the next UTC day
    // If utcStartHour < 0, it rolls into the previous UTC day (shouldn't happen for US timezones)

    let startDate = new Date(Date.UTC(year, month - 1, day, utcStartHour, 0, 0, 0));
    let endDate = new Date(Date.UTC(year, month - 1, day + 1, utcStartHour, 0, 0, 0));
    // End is exclusive, so we use the next day's midnight, then subtract 1 second for the query
    endDate.setUTCSeconds(-1);

    const fromDateUTC = startDate.toISOString().replace('.000Z', 'Z');
    const toDateUTC = endDate.toISOString().replace('.000Z', 'Z');

    return { fromDateUTC, toDateUTC };
  }

  /**
   * Get extended UTC boundaries that capture all possible local-time transactions.
   * This fetches a wider range (day before to day after) to ensure edge-case transactions
   * are captured, with filtering by transactionDateLocalTime done afterward.
   */
  getExtendedBoundariesUTC(reportDate, timezone) {
    const [year, month, day] = reportDate.split('-').map(Number);

    // Start 1 day before at midnight UTC
    const startDate = new Date(Date.UTC(year, month - 1, day - 1, 0, 0, 0, 0));
    // End 1 day after at 23:59:59 UTC
    const endDate = new Date(Date.UTC(year, month - 1, day + 1, 23, 59, 59, 0));

    const fromDateUTC = startDate.toISOString().replace('.000Z', 'Z');
    const toDateUTC = endDate.toISOString().replace('.000Z', 'Z');

    return { fromDateUTC, toDateUTC };
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

  /**
   * Check if an item return should be excluded from the report
   * A return should be excluded if it was processed on or before the report date
   * @param {string} returnDate - Item return date (ISO format)
   * @param {string} reportDate - Report date in YYYY-MM-DD format
   * @returns {boolean} True if the return should be excluded from gross sales
   */
  shouldExcludeReturn(returnDate, reportDate) {
    if (!returnDate) return false;

    // Extract YYYY-MM-DD from returnDate
    const retDateStr = String(returnDate).slice(0, 10);

    // Exclude return if it happened on or before the report date
    return retDateStr <= reportDate;
  }

  aggregateTransactions(transactions, reportDate = null, storeName = '') {
    // Return handling: ALL returned items are excluded from gross sales.
    // This matches auditor methodology - returns are "backdated" to the original sale,
    // meaning the returned item is removed from the original sale's revenue.
    // Account 40003 (Sales Return) stays at $0 since we don't record returns separately.

    const totals = {
      grossSales: 0,
      discounts: 0,        // Non-loyalty discounts only (totalDiscount - loyaltySpent)
      loyaltySpent: 0,
      returns: 0,          // Always 0 - returns are backdated to original sale
      tax: 0,
      cashPaid: 0,
      debitPaid: 0,
      creditPaid: 0,
      totalPaid: 0,
      changeDue: 0,
      cashOnlyChangeDue: 0,  // Change given on cash-only transactions (not debit cash-back)
      cogs: 0,
      netCash: 0,
      overage: 0
    };

    // Track debit components separately for accurate calculation
    let rawDebit = 0;        // Sum of debitPaid field values
    let electronicDebit = 0; // Sum of electronicPaid field values (different payment processor)
    let prePaidDebit = 0;    // prePaymentAmount for prepaid/online orders
    let unpaidDue = 0;       // Calculated due for transactions with no payment recorded

    for (const t of transactions) {
      // Skip voided transactions
      if (t.isVoid) continue;

      // Skip return transactions (isReturn === true)
      // Returns are handled by backdating - excluding items with isReturned=true
      // from the original sale transaction. This matches auditor methodology.
      if (t.isReturn) continue;

      // Skip non-retail transactions (wholesale orders, transfers, etc.)
      // These are B2B transactions that shouldn't be in retail GL entries
      const txnType = t.transactionType || 'Retail';
      if (txnType !== 'Retail') continue;

      // For regular sales, calculate grossSales at the ITEM level
      // ALL returned items are excluded from gross sales (backdate methodology)
      //
      // IMPORTANT: Some transactions have subtotal=0 but items with prices - these are
      // inventory transfers/adjustments, NOT customer sales. Use subtotal for such transactions.
      if (t.items && t.items.length > 0 && (t.subtotal || 0) !== 0) {
        for (const item of t.items) {
          // Exclude returned items from gross sales (backdate to original sale)
          if (!item.isReturned) {
            totals.grossSales += item.totalPrice || 0;
            // Only include COGS for items with a selling price > 0
            // Zero-price items (freebies/samples) don't generate revenue,
            // so their cost shouldn't be recorded as COGS against sales
            if ((item.totalPrice || 0) > 0) {
              totals.cogs += (item.unitCost || 0) * (item.quantity || 0);
            }
          }
        }
      } else {
        // Use transaction subtotal for:
        // - Transactions without items array
        // - Transactions with subtotal=0 (inventory transfers)
        totals.grossSales += t.subtotal || 0;
      }

      // Add discounts, payments, etc. for non-return transactions
      // Calculate discounts at item level to exclude returned items
      let totalDiscount = 0;

      // If we have items, sum discounts excluding returned items (backdate methodology)
      if (t.items && t.items.length > 0 && (t.subtotal || 0) !== 0) {
        for (const item of t.items) {
          if (!item.isReturned) {
            totalDiscount += item.totalDiscount || 0;
          }
        }
      } else {
        // Fallback to transaction-level discount if no items
        totalDiscount = t.totalDiscount || 0;
      }

      // LOYALTY CALCULATION:
      // Some stores have loyaltySpent field populated, others store loyalty in discounts array.
      // Missouri stores (St. Peters) use "* Loyalty 10", "* Loyalty 20" in discounts.
      // Illinois stores (Willowbrook) use "Dutchie Loyalty X points" in discounts.
      // Florida stores use "X Loyalty Points" which auditor treats as discounts, NOT loyalty.
      //
      // IMPORTANT: For stores with loyaltySpent field, the auditor subtracts loyalty from discounts.
      // For stores with loyalty in discounts array (MO, IL), the auditor does NOT subtract -
      // they report both discounts (including loyalty) AND loyalty separately.
      let loyaltyAmount = t.loyaltySpent || 0;
      let loyaltyFromDiscountsArray = false;

      if (loyaltyAmount === 0 && t.discounts && t.discounts.length > 0) {
        // Extract loyalty from discounts array using specific patterns
        // Match: "* Loyalty X" (Missouri) or "Dutchie Loyalty X points" (Illinois)
        // Exclude: "X Loyalty Points" (Florida) - auditor treats as discount
        for (const d of t.discounts) {
          const reason = (d.discountReason || d.discountName || '').trim();
          const upper = reason.toUpperCase();
          // Match patterns that auditor classifies as loyalty redemptions
          if (upper.startsWith('* LOYALTY') || upper.startsWith('DUTCHIE LOYALTY') ||
              upper === 'LOYALTY APPLIED') {
            loyaltyAmount += d.amount || 0;
            loyaltyFromDiscountsArray = true;
          }
        }
      }

      // For loyaltySpent field stores: subtract loyalty from discounts
      // For discounts-array loyalty stores: do NOT subtract (auditor includes both)
      if (loyaltyFromDiscountsArray) {
        totals.discounts += totalDiscount;  // Full discount including loyalty
      } else {
        totals.discounts += totalDiscount - loyaltyAmount;  // Non-loyalty discounts only
      }
      totals.loyaltySpent += loyaltyAmount;
      totals.tax += t.tax || 0;

      // Check if all items in this transaction are returned
      // If so, exclude cash since it would have been refunded (backdate methodology)
      let allItemsReturned = false;
      if (t.items && t.items.length > 0) {
        allItemsReturned = t.items.every(item => item.isReturned);
      }

      // Only count cash if not all items returned
      if (!allItemsReturned) {
        totals.cashPaid += t.cashPaid || 0;
        totals.changeDue += t.changeDue || 0;
      }
      totals.creditPaid += t.creditPaid || 0;
      totals.totalPaid += t.paid || 0;

      // Extract payment-related fields
      const cashAmount = allItemsReturned ? 0 : (t.cashPaid || 0);
      const debitAmount = t.debitPaid || 0;
      const electronicAmount = t.electronicPaid || 0;
      const prePaymentAmount = t.prePaymentAmount || 0;
      const changeAmount = allItemsReturned ? 0 : (t.changeDue || 0);

      // Only count changeDue as cash drawer change if it's a cash transaction (no debit/electronic)
      if (cashAmount > 0 && debitAmount === 0 && electronicAmount === 0) {
        totals.cashOnlyChangeDue += changeAmount;
      }

      // DEBIT CALCULATION:
      // The Dutchie API has inconsistent debitPaid field population across stores.
      // Some stores (Florida) have raw debitPaid values, others (AZ, MI, MO, IL, NV) don't.
      // Additionally, some stores use electronicPaid for non-cash payments.
      // We use a combined approach:
      // 1. Always add raw debitPaid and electronicPaid values
      // 2. For transactions with no cash/debit/electronic but HAS prePaymentAmount: use prePaymentAmount
      //    (These are prepaid/online orders - prePaymentAmount includes tips and fees)
      // 3. For transactions with no payment but HAS balance due: add the due
      //    (These are transactions where payment wasn't recorded but sale happened)

      rawDebit += debitAmount;
      electronicDebit += electronicAmount;

      // Skip calculations for transactions where all items are returned
      // (these would have been refunded)
      if (!allItemsReturned) {
        // Always add prepayment amounts - they represent online/debit payments made before pickup
        // These can exist even when customer also pays cash at pickup
        if (prePaymentAmount > 0) {
          prePaidDebit += prePaymentAmount;
        }

        // Only calculate unpaid due if there's no payment at all
        if (cashAmount === 0 && debitAmount === 0 && electronicAmount === 0 && prePaymentAmount === 0) {
          const subtotal = t.subtotal || 0;
          const tax = t.tax || 0;
          const discount = t.totalDiscount || 0;
          const loyalty = t.loyaltySpent || 0;
          const due = subtotal + tax - discount - loyalty;
          if (due > 0) {
            unpaidDue += due;
          }
        }
      }
    }

    // netCash = cash received minus change given on CASH transactions only
    totals.netCash = totals.cashPaid - totals.cashOnlyChangeDue;

    // Debit = raw debitPaid + electronicPaid + prepaid amounts + unpaid dues
    totals.debitPaid = rawDebit + electronicDebit + prePaidDebit + unpaidDue;

    // Overage calculation:
    // Total debits should equal total credits
    // Any difference shows up in overage
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
        // Overage = totalCredits - totalDebits
        // If positive (credits > debits): add to DEBIT to balance
        // If negative (credits < debits): add to CREDIT to balance
        if (totals.overage > 0) {
          debit = totals.overage;
        } else if (totals.overage < 0) {
          credit = Math.abs(totals.overage);
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
    const refNumber = `${reportDate} DS`;

    console.log(`\n=== GL Journal Export for ${reportDate} (using local timezone boundaries) ===`);

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
      `# NOTE: Transactions are fetched using local timezone boundaries (midnight-to-midnight).`,
      `# Branch codes in this export are derived from Dutchie location names.`,
      `#`
    ].join('\n');

    const allRows = [];
    const failedStores = [];
    let grandSales = 0;
    let successCount = 0;

    for (const loc of this.locationConfigs) {
      const branchCode = this.getBranchCode(loc.name);
      const timezone = this.getStoreTimezone(loc.name);

      // Fetch with extended range to capture edge cases, then filter by local time
      // This ensures we don't miss transactions at day boundaries due to timezone differences
      const { fromDateUTC, toDateUTC } = this.getExtendedBoundariesUTC(reportDate, timezone);

      process.stdout.write(`  ${loc.name} (${branchCode})... `);

      const result = await this.fetchTransactions(loc.apiKey, loc.name, fromDateUTC, toDateUTC);

      if (!result.success) {
        console.log(`FAILED: ${result.error}`);
        failedStores.push({ store: loc.name, error: result.error });
        continue;
      }

      // Filter transactions by local time date (transactionDateLocalTime)
      // The auditor uses local time for day boundaries, not UTC
      const transactions = result.data.filter(t => {
        const localDate = (t.transactionDateLocalTime || '').slice(0, 10);
        return localDate === reportDate;
      });
      const totals = this.aggregateTransactions(transactions, reportDate, loc.name);
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
