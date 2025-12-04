require('dotenv').config();

const InventorySyncService = require('./services/inventorySync');
const StoreConfigService = require('./services/storeConfig');

const SYNC_INTERVAL_MINUTES = parseInt(process.env.SYNC_INTERVAL_MINUTES, 10) || 5;
const SYNC_INTERVAL_MS = SYNC_INTERVAL_MINUTES * 60 * 1000;

async function syncAllLocations(syncServices) {
  console.log(`\n--- Starting sync for ${syncServices.length} location(s) ---`);
  const startTime = Date.now();

  const results = [];
  for (const service of syncServices) {
    try {
      const result = await service.syncInventory();
      results.push(result);
    } catch (error) {
      console.error(`Sync failed for location:`, error.message);
      results.push({ error: error.message });
    }
  }

  const totalSynced = results.reduce((sum, r) => sum + (r.synced || 0), 0);
  const totalErrors = results.reduce((sum, r) => sum + (r.errors || 0), 0);
  const duration = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
  console.log(`--- Sync complete: ${totalSynced} items synced, ${totalErrors} errors (${duration} min) ---\n`);

  return results;
}

async function main() {
  console.log('Mint Inventory Sync Service starting...');
  console.log(`Sync interval: ${SYNC_INTERVAL_MINUTES} minutes\n`);

  // Fetch store configurations from backend API
  const storeConfigService = new StoreConfigService();
  let locationConfigs;

  try {
    locationConfigs = await storeConfigService.getLocationConfigs();
  } catch (error) {
    console.error('Failed to fetch store configurations:', error.message);
    process.exit(1);
  }

  if (locationConfigs.length === 0) {
    console.error('No valid location configurations found!');
    process.exit(1);
  }

  console.log(`\nLocations to sync:`);
  locationConfigs.forEach(loc => console.log(`  - [${loc.id}] ${loc.name} (${loc.city}, ${loc.state})`));

  // Create sync services for each location
  const syncServices = locationConfigs.map(
    loc => new InventorySyncService(loc.id, loc.name, loc.apiKey)
  );

  // Run initial sync
  console.log('\n');
  try {
    await syncAllLocations(syncServices);
  } catch (error) {
    console.error('Initial sync failed:', error.message);
  }

  // Schedule recurring syncs
  setInterval(async () => {
    try {
      await syncAllLocations(syncServices);
    } catch (error) {
      console.error('Scheduled sync failed:', error.message);
    }
  }, SYNC_INTERVAL_MS);

  console.log('Service running. Press Ctrl+C to stop.');
}

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.log('\nShutting down...');
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\nShutting down...');
  process.exit(0);
});

main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
