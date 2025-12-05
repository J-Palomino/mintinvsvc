// Only load .env file in development (Railway/production sets env vars directly)
const isProduction = process.env.NODE_ENV === 'production' || process.env.RAILWAY_ENVIRONMENT;
if (!isProduction) {
  require('dotenv').config();
}

const InventorySyncService = require('./services/inventorySync');
const ProductEnrichmentService = require('./services/productEnrichment');
const StoreConfigService = require('./services/storeConfig');

const SYNC_INTERVAL_MINUTES = parseInt(process.env.SYNC_INTERVAL_MINUTES, 10) || 10;
const SYNC_INTERVAL_MS = SYNC_INTERVAL_MINUTES * 60 * 1000;

async function syncAllLocations(inventoryServices, enrichmentServices) {
  console.log(`\n=== Starting sync for ${inventoryServices.length} location(s) ===`);
  const startTime = Date.now();

  // Phase 1: Inventory sync from POS API
  console.log('\n--- Phase 1: Inventory Sync (POS API) ---');
  let totalSynced = 0;
  let totalErrors = 0;

  for (const service of inventoryServices) {
    try {
      const result = await service.syncInventory();
      totalSynced += result.synced || 0;
      totalErrors += result.errors || 0;
    } catch (error) {
      console.error(`Inventory sync failed:`, error.message);
      totalErrors++;
    }
  }

  // Phase 2: Product enrichment from Plus GraphQL API
  console.log('\n--- Phase 2: Product Enrichment (Plus API) ---');
  let totalEnriched = 0;

  for (const service of enrichmentServices) {
    try {
      const result = await service.enrichProducts();
      totalEnriched += result.enriched || 0;
    } catch (error) {
      console.error(`Enrichment failed:`, error.message);
    }
  }

  const duration = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
  console.log(`\n=== Sync complete: ${totalSynced} synced, ${totalEnriched} enriched, ${totalErrors} errors (${duration} min) ===\n`);

  return { totalSynced, totalEnriched, totalErrors, duration };
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
  locationConfigs.forEach(loc => {
    console.log(`  - [${loc.id}] ${loc.name} (${loc.city}, ${loc.state})`);
  });

  // Create sync services for each location
  // loc.id is now the DutchieStoreID (UUID) used for both inventory and enrichment
  const inventoryServices = locationConfigs.map(
    loc => new InventorySyncService(loc.id, loc.name, loc.apiKey)
  );

  const enrichmentServices = locationConfigs.map(
    loc => new ProductEnrichmentService(loc.id, loc.name)
  );

  // Run initial sync
  console.log('\n');
  try {
    await syncAllLocations(inventoryServices, enrichmentServices);
  } catch (error) {
    console.error('Initial sync failed:', error.message);
  }

  // Schedule recurring syncs
  setInterval(async () => {
    try {
      await syncAllLocations(inventoryServices, enrichmentServices);
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
