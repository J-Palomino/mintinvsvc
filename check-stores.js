/**
 * Check all stores and verify coverage
 */
const axios = require('axios');
const fs = require('fs');

const STORES_API_URL = 'https://mintdealsbackend-production.up.railway.app/api/stores';

async function main() {
  console.log('='.repeat(60));
  console.log('STORE COVERAGE CHECK');
  console.log('='.repeat(60));

  // Fetch all stores from backend
  const response = await axios.get(`${STORES_API_URL}?pagination[limit]=100`);
  const stores = response.data.data || response.data;

  console.log(`\nTotal stores in backend: ${stores.length}\n`);

  const active = stores.filter(s => s.is_active && s.dutchieApiKey);
  const inactive = stores.filter(s => !s.is_active);
  const noApiKey = stores.filter(s => s.is_active && !s.dutchieApiKey);

  console.log('ACTIVE WITH API KEY (' + active.length + '):');
  active.forEach(s => console.log(`  ✓ ${s.name}`));

  if (inactive.length > 0) {
    console.log('\nINACTIVE (' + inactive.length + '):');
    inactive.forEach(s => console.log(`  ✗ ${s.name} - INACTIVE`));
  }

  if (noApiKey.length > 0) {
    console.log('\nMISSING API KEY (' + noApiKey.length + '):');
    noApiKey.forEach(s => console.log(`  ⚠ ${s.name} - NO API KEY`));
  }

  // Check exported summary
  console.log('\n' + '='.repeat(60));
  console.log('EXPORT VERIFICATION');
  console.log('='.repeat(60));

  if (fs.existsSync('./exports/SUMMARY.csv')) {
    const summary = fs.readFileSync('./exports/SUMMARY.csv', 'utf8');
    const lines = summary.trim().split('\n').slice(1); // Skip header
    const exportedStores = lines.map(l => l.split(',')[0]);

    console.log(`\nStores exported: ${exportedStores.length}`);
    console.log(`Stores expected: ${active.length}`);

    // Check for missing
    const missing = active.filter(s => !exportedStores.includes(s.name));
    const extra = exportedStores.filter(name => !active.find(s => s.name === name));

    if (missing.length === 0 && extra.length === 0) {
      console.log('\n✓ ALL STORES ACCOUNTED FOR');
    } else {
      if (missing.length > 0) {
        console.log('\n⚠ MISSING FROM EXPORT:');
        missing.forEach(s => console.log(`  - ${s.name}`));
      }
      if (extra.length > 0) {
        console.log('\n⚠ EXTRA IN EXPORT (not in backend):');
        extra.forEach(name => console.log(`  - ${name}`));
      }
    }

    // Check for zero transactions
    console.log('\n' + '='.repeat(60));
    console.log('STORES WITH ZERO TRANSACTIONS');
    console.log('='.repeat(60));
    const zeroTx = lines.filter(l => l.split(',')[1] === '0');
    if (zeroTx.length === 0) {
      console.log('\n✓ All stores have transactions');
    } else {
      console.log(`\n⚠ ${zeroTx.length} stores with 0 transactions:`);
      zeroTx.forEach(l => console.log(`  - ${l.split(',')[0]}`));
    }
  } else {
    console.log('\nNo export found. Run export-transactions-all.js first.');
  }
}

main().catch(console.error);
