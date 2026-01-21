/**
 * Test script to verify API key access to Dutchie reporting endpoints
 * Fetches store configs from backend and tests each key
 */

const axios = require('axios');

const STORES_API_URL = process.env.STORES_API_URL || 'https://mintdealsbackend-production.up.railway.app/api/stores';
const DUTCHIE_API_URL = process.env.DUTCHIE_API_URL || 'https://api.pos.dutchie.com';

async function testApiKey(storeName, apiKey) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Testing: ${storeName}`);
  console.log('='.repeat(60));

  const client = axios.create({
    baseURL: DUTCHIE_API_URL,
    auth: { username: apiKey, password: '' },
    timeout: 30000
  });

  const results = {
    whoami: { success: false, data: null, error: null },
    inventory: { success: false, count: 0, error: null },
    discounts: { success: false, count: 0, error: null },
    discountsV2: { success: false, count: 0, error: null },
    sales: { success: false, count: 0, error: null }
  };

  // Test /whoami
  try {
    const response = await client.get('/whoami');
    results.whoami.success = true;
    results.whoami.data = response.data;
    console.log(`\n✓ /whoami - Location: ${response.data.locationName} (ID: ${response.data.locationId})`);
    console.log(`  Address: ${response.data.city}, ${response.data.state}`);
  } catch (error) {
    results.whoami.error = error.response?.status || error.message;
    console.log(`\n✗ /whoami - Error: ${results.whoami.error}`);
  }

  // Test /reporting/inventory
  try {
    const response = await client.get('/reporting/inventory');
    results.inventory.success = true;
    results.inventory.count = response.data?.length || 0;
    console.log(`✓ /reporting/inventory - ${results.inventory.count} items`);
  } catch (error) {
    results.inventory.error = error.response?.status || error.message;
    console.log(`✗ /reporting/inventory - Error: ${results.inventory.error}`);
  }

  // Test /reporting/discounts
  try {
    const response = await client.get('/reporting/discounts');
    results.discounts.success = true;
    results.discounts.count = response.data?.length || 0;
    console.log(`✓ /reporting/discounts - ${results.discounts.count} discounts`);
  } catch (error) {
    results.discounts.error = error.response?.status || error.message;
    console.log(`✗ /reporting/discounts - Error: ${results.discounts.error}`);
  }

  // Test /discounts/v2/list
  try {
    const response = await client.get('/discounts/v2/list', {
      params: { includeInactive: false, includeInclusionExclusionData: true }
    });
    results.discountsV2.success = true;
    results.discountsV2.count = response.data?.length || 0;
    console.log(`✓ /discounts/v2/list - ${results.discountsV2.count} discounts (with eligibility data)`);
  } catch (error) {
    results.discountsV2.error = error.response?.status || error.message;
    console.log(`✗ /discounts/v2/list - Error: ${results.discountsV2.error}`);
  }

  // Test /reporting/sales (if available)
  try {
    const response = await client.get('/reporting/sales');
    results.sales.success = true;
    results.sales.count = response.data?.length || 0;
    console.log(`✓ /reporting/sales - ${results.sales.count} sales records`);
  } catch (error) {
    results.sales.error = error.response?.status || error.message;
    const errorMsg = error.response?.status === 404 ? '404 (endpoint not available)' : results.sales.error;
    console.log(`✗ /reporting/sales - ${errorMsg}`);
  }

  return results;
}

async function main() {
  console.log('Fetching store configurations from backend...\n');

  try {
    const response = await axios.get(`${STORES_API_URL}?pagination[limit]=100`);
    const stores = response.data.data || response.data;

    console.log(`Found ${stores.length} stores\n`);

    const allResults = [];

    for (const store of stores) {
      if (!store.dutchieApiKey) {
        console.log(`\nSkipping ${store.name}: No API key configured`);
        continue;
      }

      if (!store.is_active) {
        console.log(`\nSkipping ${store.name}: Inactive`);
        continue;
      }

      const results = await testApiKey(store.name, store.dutchieApiKey);
      allResults.push({ store: store.name, results });
    }

    // Summary
    console.log(`\n${'='.repeat(60)}`);
    console.log('SUMMARY');
    console.log('='.repeat(60));

    for (const { store, results } of allResults) {
      const endpoints = ['whoami', 'inventory', 'discounts', 'discountsV2', 'sales'];
      const passed = endpoints.filter(e => results[e].success).length;
      const status = passed === endpoints.length ? '✓ ALL PASS' :
                     passed === 0 ? '✗ ALL FAIL' : `⚠ ${passed}/${endpoints.length}`;
      console.log(`${store}: ${status}`);
    }

  } catch (error) {
    console.error('Failed to fetch stores:', error.message);
  }
}

main();
