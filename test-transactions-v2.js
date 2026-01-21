/**
 * Test /reporting/transactions with correct parameter names
 * API expects: transactionDate window or lastModified window
 */

const axios = require('axios');

const STORES_API_URL = process.env.STORES_API_URL || 'https://mintdealsbackend-production.up.railway.app/api/stores';
const DUTCHIE_API_URL = process.env.DUTCHIE_API_URL || 'https://api.pos.dutchie.com';

const START_DATE = '2026-01-01';
const END_DATE = '2026-01-14';

// Based on error: "transactionDate window or lastModified window must be provided"
const PARAM_VARIATIONS = [
  // transactionDate window variations
  { transactionDateStart: START_DATE, transactionDateEnd: END_DATE },
  { transactionDateFrom: START_DATE, transactionDateTo: END_DATE },
  { transactionDate: START_DATE, transactionDateEnd: END_DATE },
  { 'transactionDate.start': START_DATE, 'transactionDate.end': END_DATE },
  { transactionDateMin: START_DATE, transactionDateMax: END_DATE },

  // lastModified window variations
  { lastModifiedStart: START_DATE, lastModifiedEnd: END_DATE },
  { lastModifiedFrom: START_DATE, lastModifiedTo: END_DATE },
  { 'lastModified.start': START_DATE, 'lastModified.end': END_DATE },

  // With timestamps
  { transactionDateStart: `${START_DATE}T00:00:00Z`, transactionDateEnd: `${END_DATE}T23:59:59Z` },
  { lastModifiedStart: `${START_DATE}T00:00:00Z`, lastModifiedEnd: `${END_DATE}T23:59:59Z` },

  // ISO format with timezone
  { transactionDateStart: `${START_DATE}T00:00:00.000Z`, transactionDateEnd: `${END_DATE}T23:59:59.999Z` },
];

async function testTransactions(client, storeName) {
  console.log(`Testing /reporting/transactions for ${storeName}`);
  console.log(`Date range: ${START_DATE} to ${END_DATE}\n`);

  for (const params of PARAM_VARIATIONS) {
    const paramStr = JSON.stringify(params);
    process.stdout.write(`  ${paramStr.substring(0, 70)}... `);

    try {
      const response = await client.get('/reporting/transactions', { params, timeout: 60000 });
      const count = Array.isArray(response.data) ? response.data.length : 'N/A';
      console.log(`✓ ${response.status} - ${count} records`);

      if (Array.isArray(response.data) && response.data.length > 0) {
        console.log(`\n${'='.repeat(60)}`);
        console.log('SUCCESS!');
        console.log('='.repeat(60));
        console.log(`Working params: ${JSON.stringify(params, null, 2)}`);
        console.log(`Total records: ${response.data.length}`);
        console.log(`\nAvailable fields:`);
        console.log(Object.keys(response.data[0]).join(', '));

        console.log(`\nSample transaction:`);
        const sample = response.data[0];
        console.log(JSON.stringify(sample, null, 2).substring(0, 2000));

        return { success: true, params, data: response.data };
      } else if (Array.isArray(response.data)) {
        console.log('  (empty array - params work but no data in range)');
      }
    } catch (error) {
      const status = error.response?.status || 'ERR';
      const errMsg = error.response?.data?.errors?.[0]?.errorMessage ||
                     error.response?.data?.message ||
                     error.message;
      console.log(`✗ ${status} - ${errMsg.substring(0, 50)}`);
    }
  }

  return { success: false };
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

    await testTransactions(client, store.name);

  } catch (error) {
    console.error('Failed:', error.message);
  }
}

main();
