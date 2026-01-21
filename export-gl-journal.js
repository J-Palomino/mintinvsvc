/**
 * Export GL Journal Entries by Location
 * Format matches accounting system import requirements
 */

const axios = require('axios');
const fs = require('fs');
const path = require('path');

const STORES_API_URL = process.env.STORES_API_URL || 'https://mintdealsbackend-production.up.railway.app/api/stores';
const DUTCHIE_API_URL = process.env.DUTCHIE_API_URL || 'https://api.pos.dutchie.com';

// Report date (local time for each store) - can be passed as command line argument
const REPORT_DATE = process.argv[2] || '2026-01-06';
const REF_SUFFIX = 'DS'; // Daily Sales

const OUTPUT_DIR = './exports';

// Timezone offsets from UTC (standard time - winter)
// Positive number = hours behind UTC
const TIMEZONE_OFFSETS = {
  'FLD-': 5,   // Florida - Eastern (UTC-5)
  'MID-': 5,   // Michigan - Eastern (UTC-5)
  'MI-': 5,    // Michigan - Eastern (UTC-5)
  'AZD-': 7,   // Arizona - Mountain, no DST (UTC-7)
  'AZV-': 7,   // Arizona - Mountain, no DST (UTC-7)
  'NVD-': 8,   // Nevada - Pacific (UTC-8)
  'MOD-': 6,   // Missouri - Central (UTC-6)
  'ILD-': 6    // Illinois - Central (UTC-6)
};

// State ordering for grouped output (alphabetical)
const STATE_ORDER = {
  'AZD-': 1, 'AZV-': 1,  // Arizona
  'FLD-': 2,              // Florida
  'ILD-': 3,              // Illinois
  'MID-': 4, 'MI-': 4,    // Michigan
  'MOD-': 5,              // Missouri
  'NVD-': 6               // Nevada
};

const STATE_NAMES = {
  'AZD-': 'Arizona', 'AZV-': 'Arizona',
  'FLD-': 'Florida',
  'ILD-': 'Illinois',
  'MID-': 'Michigan', 'MI-': 'Michigan',
  'MOD-': 'Missouri',
  'NVD-': 'Nevada'
};

function getStateOrder(branchCode) {
  for (const [prefix, order] of Object.entries(STATE_ORDER)) {
    if (branchCode.startsWith(prefix)) return order;
  }
  return 99; // Unknown states at end
}

function getStateName(branchCode) {
  for (const [prefix, name] of Object.entries(STATE_NAMES)) {
    if (branchCode.startsWith(prefix)) return name;
  }
  return 'Unknown';
}

/**
 * Check if a date is in US Daylight Saving Time
 * DST starts: Second Sunday in March at 2am
 * DST ends: First Sunday in November at 2am
 */
function isDST(date) {
  const year = date.getFullYear();
  const marchFirst = new Date(year, 2, 1);
  const dstStart = new Date(year, 2, 14 - marchFirst.getDay(), 2);
  const novFirst = new Date(year, 10, 1);
  const dstEnd = new Date(year, 10, 7 - novFirst.getDay(), 2);
  return date >= dstStart && date < dstEnd;
}

/**
 * Get UTC date range for a store's local day
 */
function getLocalDayUTCRange(reportDate, branchCode) {
  // Find timezone offset based on branch code prefix
  let offsetHours = 5; // Default to Eastern
  for (const [prefix, offset] of Object.entries(TIMEZONE_OFFSETS)) {
    if (branchCode.startsWith(prefix)) {
      offsetHours = offset;
      break;
    }
  }

  // Parse the report date
  const [year, month, day] = reportDate.split('-').map(Number);
  const localDate = new Date(year, month - 1, day);

  // Adjust for DST (Arizona doesn't observe it)
  const isArizona = branchCode.startsWith('AZ');
  if (!isArizona && isDST(localDate)) {
    offsetHours -= 1; // DST: offset is 1 hour less
  }

  // Local midnight = UTC midnight + offset hours
  // e.g., Jan 6 00:00 PST (UTC-8) = Jan 6 08:00 UTC
  const fromUTC = new Date(Date.UTC(year, month - 1, day, offsetHours, 0, 0));
  const toUTC = new Date(Date.UTC(year, month - 1, day, offsetHours + 23, 59, 59));

  return {
    fromDate: fromUTC.toISOString(),
    toDate: toUTC.toISOString()
  };
}

// Dutchie to Accumatica branch code mapping
// Format: 'Dutchie Store Name': 'ACCUMATICA-CODE'
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
  'Mint Mt Pleasant': 'MID-MT',      // TODO: Verify Dutchie store name, needs API key
  'Mint Mount Pleasant': 'MID-MT',   // TODO: Verify Dutchie store name, needs API key
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
  'Mint Power Road': 'AZD-120PR',    // TODO: Verify Dutchie store name, needs API key
  'Mint Gilbert': 'AZD-120PR',       // TODO: Verify Dutchie store name, needs API key
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

function formatNumber(num) {
  return num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function escapeCSV(value) {
  if (value === null || value === undefined) return '';
  const str = String(value);
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function getSubaccount(accountCode) {
  // Subaccount rules:
  // 4000 codes (40001-40004) → 20-00
  // 5000 codes (50000) → 20-00
  // 7000 codes (70260) → 20-00
  // All others → 00-00
  if (accountCode.startsWith('4') || accountCode.startsWith('5') || accountCode.startsWith('7')) {
    return '20-00';
  }
  return '00-00';
}

const HEADERS = [
  'Branch',
  'Account',
  'Account Description',
  'Subaccount',
  'Ref. Number',
  'Debit Amount',
  'Credit Amount',
  'Description'
].join(',');

async function fetchTransactions(client, storeName, fromDate, toDate, attempt = 1) {
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
      console.log(`FAILED (${errorMsg}) - retrying...`);
      await new Promise(r => setTimeout(r, 2000));
      return fetchTransactions(client, storeName, fromDate, toDate, 2);
    }
    return { success: false, error: errorMsg };
  }
}

function aggregateTransactions(transactions) {
  const totals = {
    grossSales: 0,
    discounts: 0,
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
      totals.discounts += t.totalDiscount || 0;
      totals.tax += t.tax || 0;
      totals.cashPaid += t.cashPaid || 0;
      totals.debitPaid += t.debitPaid || 0;
      totals.creditPaid += t.creditPaid || 0;
      totals.totalPaid += t.paid || 0;
      totals.changeDue += t.changeDue || 0;
      totals.loyaltySpent += t.loyaltySpent || 0;
    }

    // Calculate COGS from items
    if (t.items) {
      for (const item of t.items) {
        if (!item.isReturned) {
          totals.cogs += (item.unitCost || 0) * (item.quantity || 0);
        }
      }
    }
  }

  // Calculate net cash (cash received minus change given)
  totals.netCash = totals.cashPaid - totals.changeDue;

  // Calculate overage/shortage to balance the entry
  // Debits: discounts + returns + loyaltySpent + netCash + debitPaid + cogs
  // Credits: grossSales + tax + cogs (inventory)
  const totalDebits = totals.discounts + totals.returns + totals.loyaltySpent +
                      totals.netCash + totals.debitPaid + totals.cogs;
  const totalCredits = totals.grossSales + totals.tax + totals.cogs;

  // overage = totalDebits - totalCredits
  // If positive: debit, if negative: credit
  totals.overage = totalDebits - totalCredits;

  return totals;
}

function generateGLRows(branchCode, dutchieStoreName, totals, refNumber) {
  const rows = [];

  for (const account of ACCOUNTS) {
    let debit = 0;
    let credit = 0;
    const value = totals[account.field] || 0;

    if (account.code === '70260') {
      // Overage/shortage: totalDebits - totalCredits
      // If positive: credit, if negative: debit (absolute value)
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

    const description = `${refNumber} - ${dutchieStoreName}: Daily Sales`;
    rows.push([
      escapeCSV(branchCode),
      escapeCSV(account.code),
      escapeCSV(account.desc),
      escapeCSV(getSubaccount(account.code)),
      escapeCSV(refNumber),
      escapeCSV(formatNumber(debit)),
      escapeCSV(formatNumber(credit)),
      escapeCSV(description)
    ].join(','));
  }

  return rows;
}

function getBranchCode(storeName) {
  // Try exact match first
  if (BRANCH_CODES[storeName]) return BRANCH_CODES[storeName];

  // Try trimmed match
  const trimmed = storeName.trim();
  if (BRANCH_CODES[trimmed]) return BRANCH_CODES[trimmed];

  // Generate a code from the name
  const parts = storeName.replace('Mint ', '').trim().split(' ');
  const code = parts[0].substring(0, 6).toUpperCase();
  return `UNK-${code}`;
}

async function main() {
  console.log('='.repeat(60));
  console.log('EXPORTING GL JOURNAL ENTRIES BY LOCATION');
  console.log('='.repeat(60));
  console.log(`Date: ${REPORT_DATE}\n`);

  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  console.log('Fetching store configurations...\n');
  const response = await axios.get(`${STORES_API_URL}?pagination[limit]=100`);
  const stores = response.data.data || response.data;
  const activeStores = stores.filter(s => s.dutchieApiKey && s.is_active);

  // Sort stores by state (alphabetical), then by store name within state
  activeStores.sort((a, b) => {
    const branchA = getBranchCode(a.name);
    const branchB = getBranchCode(b.name);
    const stateOrderA = getStateOrder(branchA);
    const stateOrderB = getStateOrder(branchB);
    if (stateOrderA !== stateOrderB) return stateOrderA - stateOrderB;
    return a.name.localeCompare(b.name);
  });

  console.log(`Found ${activeStores.length} active stores (sorted by state)\n`);

  // Add parity note at top of file
  const note = [
    `# GL Journal Export - ${REPORT_DATE}`,
    `# Source of Truth: Dutchie POS API (/reporting/transactions)`,
    `# Generated: ${new Date().toISOString()}`,
    `# Time basis: Local store time (per-store timezone conversion)`,
    `# NOTE: Verify branch codes and account mappings match your accounting system.`,
    `#`
  ].join('\n');

  const allRows = [note, HEADERS];
  const failedStores = [];
  const summary = [];

  for (const store of activeStores) {
    const storeName = store.name;
    const branchCode = getBranchCode(storeName);
    const refNumber = `${REPORT_DATE} ${REF_SUFFIX}`;

    // Get UTC date range for this store's local day
    const { fromDate, toDate } = getLocalDayUTCRange(REPORT_DATE, branchCode);

    process.stdout.write(`Fetching ${storeName} (${branchCode})... `);

    const client = axios.create({
      baseURL: DUTCHIE_API_URL,
      auth: { username: store.dutchieApiKey, password: '' }
    });

    const result = await fetchTransactions(client, storeName, fromDate, toDate);

    if (!result.success) {
      console.log(`FAILED after retry: ${result.error}`);
      failedStores.push({ store: storeName, error: result.error });
      continue;
    }

    const transactions = result.data;
    const totals = aggregateTransactions(transactions);
    const rows = generateGLRows(branchCode, storeName, totals, refNumber);

    allRows.push(...rows);

    console.log(`${transactions.length} txns, $${formatNumber(totals.grossSales)} sales`);
    summary.push({
      store: storeName,
      branch: branchCode,
      transactions: transactions.length,
      grossSales: totals.grossSales,
      tax: totals.tax,
      cash: totals.netCash,
      debit: totals.debitPaid
    });
  }

  // Write output file
  const filename = `gl_journal_${REPORT_DATE}.csv`;
  fs.writeFileSync(path.join(OUTPUT_DIR, filename), allRows.join('\n'));

  // Print summary
  console.log('\n' + '='.repeat(60));
  console.log('SUMMARY');
  console.log('='.repeat(60));

  let grandSales = 0, grandTax = 0;
  for (const s of summary) {
    grandSales += s.grossSales;
    grandTax += s.tax;
  }

  console.log(`\nTotal Stores: ${summary.length}`);
  console.log(`Total Gross Sales: $${formatNumber(grandSales)}`);
  console.log(`Total Tax: $${formatNumber(grandTax)}`);

  console.log('\n' + '='.repeat(60));
  console.log('EXPORTED FILE');
  console.log('='.repeat(60));
  console.log(`\n${path.resolve(OUTPUT_DIR, filename)}`);

  // Validation
  if (failedStores.length > 0) {
    console.log('\n' + '='.repeat(60));
    console.log('ERROR: FAILED STORES');
    console.log('='.repeat(60));
    failedStores.forEach(f => console.log(`  ✗ ${f.store}: ${f.error}`));
    throw new Error(`Export incomplete: ${failedStores.length} store(s) failed after retry`);
  }

  if (summary.length !== activeStores.length) {
    throw new Error(`Export incomplete: Expected ${activeStores.length} stores, got ${summary.length}`);
  }

  console.log('\n' + '='.repeat(60));
  console.log('✓ EXPORT COMPLETE - ALL STORES SUCCESSFUL');
  console.log('='.repeat(60));
}

main().catch(err => {
  console.error('\n' + '!'.repeat(60));
  console.error('EXPORT FAILED:', err.message);
  console.error('!'.repeat(60));
  process.exit(1);
});
