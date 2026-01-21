/**
 * Test script for hourly sales sync
 * Run: node test-hourly-sales.js [YYYY-MM-DD]
 *
 * Tests fetching transactions for the previous hour from all stores
 * Does NOT write to database (for testing locally without DB connection)
 */

const axios = require('axios');

const STORES_API_URL = process.env.STORES_API_URL || 'https://mintdealsbackend-production.up.railway.app/api/stores';
const DUTCHIE_API_URL = process.env.DUTCHIE_API_URL || 'https://api.pos.dutchie.com';

// Branch codes
const BRANCH_CODES = {
  'Mint Bonita Springs': 'FLD-BONITA',
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
  'Mint Sarasota': 'FLD-SARASO',
  'Mint St. Augustine': 'FLD-STAUGU',
  'Mint Stuart': 'FLD-STUART',
  'Mint Kalamazoo': 'MID-KALAMA',
  'Mint Portage': 'MI-GB2',
  'Mint Roseville': 'MID-ROSE',
  'Mint Coldwater': 'MID-COLDWA',
  'Mint Monroe': 'MID-MONROE',
  'Mint New Buffalo': 'MID-NB',
  'Mint Mesa': 'AZD-4245IN',
  'Mint Bell Road Phoenix': 'AZD-UH',
  'Mint 75th Ave Phoenix': 'AZV-ENCANT',
  'Mint Buckeye/Verado': 'AZD-BUCK',
  'Mint El Mirage': 'AZD-ELMIRA',
  'Mint Northern Phoenix': 'AZV-GTL',
  'Mint Scottsdale': 'AZV-EBA',
  'Mint Tempe': 'AZV-SWT',
  'Mint Spring Valley': 'NVD-RAIN',
  'Mint Las Vegas Strip': 'NVD-PARA',
  'Mint St. Peters': 'MOD-MO4',
  'Mint Willowbrook': 'ILD-WILLOW'
};

function getBranchCode(storeName) {
  const trimmed = storeName.trim();
  return BRANCH_CODES[trimmed] || BRANCH_CODES[storeName] || `UNK-${storeName.substring(0, 6)}`;
}

function getPreviousHourRange() {
  const now = new Date();
  const hourStart = new Date(now);
  hourStart.setUTCMinutes(0, 0, 0);
  hourStart.setUTCHours(hourStart.getUTCHours() - 1);

  const hourEnd = new Date(hourStart);
  hourEnd.setUTCHours(hourEnd.getUTCHours() + 1);
  hourEnd.setUTCMilliseconds(hourEnd.getUTCMilliseconds() - 1);

  return {
    hourStart,
    hourEnd,
    fromDateUTC: hourStart.toISOString(),
    toDateUTC: hourEnd.toISOString()
  };
}

async function fetchTransactions(apiKey, fromDateUTC, toDateUTC) {
  const client = axios.create({
    baseURL: DUTCHIE_API_URL,
    auth: { username: apiKey, password: '' }
  });

  const params = {
    FromDateUTC: fromDateUTC,
    ToDateUTC: toDateUTC,
    IncludeDetail: false,
    IncludeTaxes: true,
    IncludeOrderIds: false
  };

  const response = await client.get('/reporting/transactions', { params, timeout: 60000 });
  return response.data || [];
}

function aggregateTransactions(transactions) {
  const totals = {
    grossSales: 0,
    discounts: 0,
    returns: 0,
    tax: 0,
    transactionCount: 0,
    cashPaid: 0,
    debitPaid: 0
  };

  for (const t of transactions) {
    if (t.isVoid) continue;

    if (t.isReturn) {
      totals.returns += Math.abs(t.total || 0);
    } else {
      totals.grossSales += t.subtotal || 0;
      totals.discounts += t.totalDiscount || 0;
      totals.tax += t.tax || 0;
      totals.cashPaid += (t.cashPaid || 0) - (t.changeDue || 0);
      totals.debitPaid += t.debitPaid || 0;
      totals.transactionCount += 1;
    }
  }

  totals.netSales = totals.grossSales - totals.discounts - totals.returns;
  return totals;
}

async function main() {
  console.log('='.repeat(60));
  console.log('TESTING HOURLY SALES SYNC');
  console.log('='.repeat(60));

  const timeRange = getPreviousHourRange();
  const hourLabel = timeRange.hourStart.toISOString().slice(0, 16).replace('T', ' ');

  console.log(`\nFetching sales for hour: ${hourLabel} UTC`);
  console.log(`From: ${timeRange.fromDateUTC}`);
  console.log(`To:   ${timeRange.toDateUTC}\n`);

  // Fetch store configs
  console.log('Fetching store configurations...\n');
  const response = await axios.get(`${STORES_API_URL}?pagination[limit]=100`);
  const stores = response.data.data || response.data;
  const activeStores = stores.filter(s => s.dutchieApiKey && s.is_active);

  console.log(`Found ${activeStores.length} active stores\n`);

  let totalTransactions = 0;
  let totalSales = 0;
  const results = [];

  for (const store of activeStores) {
    const branchCode = getBranchCode(store.name);
    process.stdout.write(`  ${store.name} (${branchCode})... `);

    try {
      const transactions = await fetchTransactions(
        store.dutchieApiKey,
        timeRange.fromDateUTC,
        timeRange.toDateUTC
      );

      const totals = aggregateTransactions(transactions);
      totalTransactions += totals.transactionCount;
      totalSales += totals.grossSales;

      results.push({
        store: store.name,
        branch: branchCode,
        ...totals
      });

      if (totals.transactionCount > 0) {
        console.log(`${totals.transactionCount} txns, $${totals.grossSales.toFixed(2)}`);
      } else {
        console.log('0 txns');
      }
    } catch (error) {
      console.log(`FAILED - ${error.message}`);
    }
  }

  console.log('\n' + '='.repeat(60));
  console.log('SUMMARY');
  console.log('='.repeat(60));
  console.log(`Total Stores: ${results.length}`);
  console.log(`Total Transactions: ${totalTransactions}`);
  console.log(`Total Gross Sales: $${totalSales.toFixed(2)}`);
  console.log('\nNote: This test does NOT write to database');
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
