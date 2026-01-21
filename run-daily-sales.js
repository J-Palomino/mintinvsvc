// Quick script to run daily sales report for a specific date
require('dotenv').config();

const axios = require('axios');
const GLExportService = require('./src/services/glExportService');

const STORES_API_URL = process.env.STORES_API_URL || 'https://mintdealsbackend-production.up.railway.app/api/stores';

async function run() {
  const reportDate = process.argv[2] || '2026-01-06';

  console.log(`Fetching store configurations...`);

  // Fetch store configs
  const response = await axios.get(`${STORES_API_URL}?pagination[limit]=100`);
  const stores = response.data.data || response.data;
  const activeStores = stores.filter(s => s.dutchieApiKey && s.is_active);

  console.log(`Found ${activeStores.length} active stores\n`);

  // Build location configs
  const locationConfigs = activeStores.map(store => ({
    id: store.DutchieStoreID,
    name: store.name,
    apiKey: store.dutchieApiKey
  }));

  // Create GL export service and run
  const glExportService = new GLExportService(locationConfigs);
  const result = await glExportService.exportForDate(reportDate);

  console.log('\n--- Result ---');
  console.log(JSON.stringify(result, null, 2));
}

run().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
