/**
 * Test /reporting/transactions endpoint with date parameters
 */

const axios = require('axios');

const STORES_API_URL = process.env.STORES_API_URL || 'https://mintdealsbackend-production.up.railway.app/api/stores';
const DUTCHIE_API_URL = process.env.DUTCHIE_API_URL || 'https://api.pos.dutchie.com';

// This month: January 2026
const START_DATE = '2026-01-01';
const END_DATE = '2026-01-14';

// Different parameter formats to try
const PARAM_VARIATIONS = [
  { startDate: START_DATE, endDate: END_DATE },
  { start_date: START_DATE, end_date: END_DATE },
  { from: START_DATE, to: END_DATE },
  { fromDate: START_DATE, toDate: END_DATE },
  { dateFrom: START_DATE, dateTo: END_DATE },
  { startTime: `${START_DATE}T00:00:00`, endTime: `${END_DATE}T23:59:59` },
  { start: START_DATE, end: END_DATE },
];

async function testTransactions(client, storeName) {
  console.log(`\nTesting /reporting/transactions for ${storeName}`);
  console.log(`Date range: ${START_DATE} to ${END_DATE}\n`);

  for (const params of PARAM_VARIATIONS) {
    const paramStr = Object.entries(params).map(([k, v]) => `${k}=${v}`).join('&');
    process.stdout.write(`  Trying: ${paramStr.substring(0, 50)}... `);

    try {
      const response = await client.get('/reporting/transactions', { params, timeout: 30000 });
      console.log(`✓ ${response.status} - ${Array.isArray(response.data) ? response.data.length + ' records' : typeof response.data}`);

      if (Array.isArray(response.data) && response.data.length > 0) {
        console.log(`\n  SUCCESS! Found working params: ${JSON.stringify(params)}`);
        console.log(`  Records: ${response.data.length}`);
        console.log(`  Sample fields: ${Object.keys(response.data[0]).slice(0, 15).join(', ')}`);
        console.log(`\n  First transaction sample:`);
        const sample = response.data[0];
        console.log(`    ID: ${sample.transactionId || sample.id || sample.orderId || 'N/A'}`);
        console.log(`    Date: ${sample.date || sample.transactionDate || sample.createdAt || 'N/A'}`);
        console.log(`    Total: ${sample.total || sample.amount || sample.grandTotal || 'N/A'}`);
        return { success: true, params, count: response.data.length, sample: response.data[0] };
      }
      return { success: true, params, count: 0 };
    } catch (error) {
      const status = error.response?.status || 'ERR';
      const msg = error.response?.data?.message || error.response?.statusText || error.message;
      console.log(`✗ ${status} - ${msg}`);
    }
  }

  // Try without params to see error message
  console.log(`\n  Trying without params to see error details...`);
  try {
    await client.get('/reporting/transactions', { timeout: 10000 });
  } catch (error) {
    console.log(`  Error response: ${JSON.stringify(error.response?.data || error.message)}`);
  }

  return { success: false };
}

// Also test other potential sales/order endpoints with date params
async function testOtherEndpoints(client) {
  const endpoints = [
    '/reporting/sales',
    '/reporting/orders',
    '/sales',
    '/orders',
    '/transactions',
    '/reporting/receipts',
    '/receipts',
  ];

  console.log(`\n${'='.repeat(60)}`);
  console.log('Testing other potential sales endpoints with date params');
  console.log('='.repeat(60));

  const params = { startDate: START_DATE, endDate: END_DATE };

  for (const endpoint of endpoints) {
    process.stdout.write(`  ${endpoint}... `);
    try {
      const response = await client.get(endpoint, { params, timeout: 10000 });
      console.log(`✓ ${response.status} - ${Array.isArray(response.data) ? response.data.length + ' records' : typeof response.data}`);
      if (Array.isArray(response.data) && response.data.length > 0) {
        console.log(`    Fields: ${Object.keys(response.data[0]).slice(0, 10).join(', ')}`);
      }
    } catch (error) {
      const status = error.response?.status || 'ERR';
      console.log(`✗ ${status}`);
    }
  }
}

async function main() {
  console.log('Fetching store API key...\n');

  try {
    const response = await axios.get(`${STORES_API_URL}?pagination[limit]=100`);
    const stores = response.data.data || response.data;
    const store = stores.find(s => s.dutchieApiKey && s.is_active);

    if (!store) {
      console.error('No active store with API key found');
      return;
    }

    const client = axios.create({
      baseURL: DUTCHIE_API_URL,
      auth: { username: store.dutchieApiKey, password: '' }
    });

    const result = await testTransactions(client, store.name);
    await testOtherEndpoints(client);

    console.log(`\n${'='.repeat(60)}`);
    console.log('SUMMARY');
    console.log('='.repeat(60));

    if (result.success && result.count > 0) {
      console.log(`✓ Transactions endpoint WORKS with params: ${JSON.stringify(result.params)}`);
      console.log(`  Found ${result.count} transactions for ${START_DATE} to ${END_DATE}`);
    } else {
      console.log('✗ Could not access transaction/sales data with any parameter format');
      console.log('  This data may not be available via the POS API');
    }

  } catch (error) {
    console.error('Failed:', error.message);
  }
}

main();
