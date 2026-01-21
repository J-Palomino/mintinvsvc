/**
 * Test /reporting/transactions with CORRECT parameter names from OpenAPI spec
 *
 * Parameters:
 * - FromDateUTC / ToDateUTC - transaction date range (UTC datetime)
 * - FromLastModifiedDateUTC / ToLastModifiedDateUTC - last modified range
 * - IncludeDetail - include line item details
 * - IncludeTaxes - include tax breakdown
 * - IncludeOrderIds - include order IDs
 */

const axios = require('axios');

const STORES_API_URL = process.env.STORES_API_URL || 'https://mintdealsbackend-production.up.railway.app/api/stores';
const DUTCHIE_API_URL = process.env.DUTCHIE_API_URL || 'https://api.pos.dutchie.com';

// January 2026 date range in UTC
const FROM_DATE = '2026-01-01T00:00:00Z';
const TO_DATE = '2026-01-14T23:59:59Z';

async function testTransactions(client, storeName) {
  console.log(`Testing /reporting/transactions for ${storeName}`);
  console.log(`Date range: ${FROM_DATE} to ${TO_DATE}\n`);

  const params = {
    FromDateUTC: FROM_DATE,
    ToDateUTC: TO_DATE,
    IncludeDetail: true,
    IncludeTaxes: true,
    IncludeOrderIds: true
  };

  console.log(`Params: ${JSON.stringify(params, null, 2)}\n`);

  try {
    console.log('Fetching transactions (this may take a moment)...\n');
    const response = await client.get('/reporting/transactions', { params, timeout: 120000 });

    if (Array.isArray(response.data)) {
      console.log(`${'='.repeat(60)}`);
      console.log('SUCCESS!');
      console.log('='.repeat(60));
      console.log(`Total transactions: ${response.data.length}`);

      if (response.data.length > 0) {
        console.log(`\nAvailable fields:`);
        console.log(Object.keys(response.data[0]).join(', '));

        // Calculate totals
        let totalSales = 0;
        let totalTax = 0;
        let totalTransactions = response.data.length;

        response.data.forEach(t => {
          totalSales += t.total || t.grandTotal || t.subTotal || 0;
          totalTax += t.totalTax || t.tax || 0;
        });

        console.log(`\n${'='.repeat(60)}`);
        console.log('SUMMARY FOR JANUARY 2026');
        console.log('='.repeat(60));
        console.log(`Total Transactions: ${totalTransactions}`);
        console.log(`Total Sales: $${totalSales.toFixed(2)}`);
        console.log(`Total Tax: $${totalTax.toFixed(2)}`);

        console.log(`\nSample transaction:`);
        console.log(JSON.stringify(response.data[0], null, 2));
      }

      return { success: true, data: response.data };
    } else {
      console.log('Response is not an array:', typeof response.data);
      console.log(JSON.stringify(response.data, null, 2).substring(0, 500));
    }
  } catch (error) {
    console.log('ERROR:', error.response?.status || error.message);
    if (error.response?.data) {
      console.log('Response:', JSON.stringify(error.response.data, null, 2));
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
