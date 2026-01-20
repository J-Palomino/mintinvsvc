// Only load .env file in development (Railway/production sets env vars directly)
const isProduction = process.env.NODE_ENV === 'production' || process.env.RAILWAY_ENVIRONMENT;
if (!isProduction) {
  require('dotenv').config();
}

const InventorySyncService = require('./services/inventorySync');
const ProductEnrichmentService = require('./services/productEnrichment');
const DiscountSyncService = require('./services/discountSync');
const BannerSyncService = require('./services/bannerSync');
const CacheSyncService = require('./services/cacheSync');
const GLExportService = require('./services/glExportService');
const HourlySalesSyncService = require('./services/hourlySalesSync');
const OdooSyncService = require('./services/odooSync');
const StoreConfigService = require('./services/storeConfig');
const { startServer } = require('./api/server');

const SYNC_INTERVAL_MINUTES = parseInt(process.env.SYNC_INTERVAL_MINUTES, 10) || 10;
const SYNC_INTERVAL_MS = SYNC_INTERVAL_MINUTES * 60 * 1000;
const BANNER_SYNC_HOUR = 5; // 5 AM daily
const GL_EXPORT_HOUR = 8; // 8 AM daily

async function syncAllLocations(inventoryServices, enrichmentServices, discountServices, cacheSyncService, odooSyncService, locationConfigs) {
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

  // Phase 3: Discount sync from POS API
  console.log('\n--- Phase 3: Discount Sync (POS API) ---');
  let totalDiscounts = 0;

  for (const service of discountServices) {
    try {
      const result = await service.syncDiscounts();
      totalDiscounts += result.synced || 0;
    } catch (error) {
      console.error(`Discount sync failed:`, error.message);
    }
  }

  // Phase 4: Refresh Redis cache
  let totalCached = 0;
  try {
    const cacheResult = await cacheSyncService.refreshAllCaches(locationConfigs);
    totalCached = cacheResult.totalInventory || 0;
  } catch (error) {
    console.error(`Cache refresh failed:`, error.message);
  }

  // Phase 5: Sync to Odoo (if configured)
  let totalOdoo = 0;
  if (odooSyncService && odooSyncService.isEnabled()) {
    try {
      const odooResult = await odooSyncService.syncAllLocations(locationConfigs);
      totalOdoo = odooResult.total || 0;
    } catch (error) {
      console.error(`Odoo sync failed:`, error.message);
    }
  }

  const duration = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
  console.log(`\n=== Sync complete: ${totalSynced} inventory, ${totalEnriched} enriched, ${totalDiscounts} discounts, ${totalCached} cached, ${totalOdoo} to Odoo, ${totalErrors} errors (${duration} min) ===\n`);

  return { totalSynced, totalEnriched, totalDiscounts, totalCached, totalOdoo, totalErrors, duration };
}

async function syncBanners(bannerServices) {
  console.log('\n=== Starting daily banner sync ===');
  const startTime = Date.now();
  let totalBanners = 0;

  for (const service of bannerServices) {
    try {
      const result = await service.syncBanner();
      if (result.updated && result.hasContent) {
        totalBanners++;
      }
    } catch (error) {
      console.error(`Banner sync failed:`, error.message);
    }
  }

  const duration = ((Date.now() - startTime) / 1000).toFixed(2);
  console.log(`=== Banner sync complete: ${totalBanners} banners updated (${duration}s) ===\n`);

  return { totalBanners, duration };
}

function scheduleDailyBannerSync(bannerServices) {
  const checkAndRunBannerSync = async () => {
    const now = new Date();
    const hours = now.getHours();
    const minutes = now.getMinutes();

    // Run at 5:00 AM (within the first minute of the hour)
    if (hours === BANNER_SYNC_HOUR && minutes === 0) {
      console.log(`\n[${now.toISOString()}] Running scheduled daily banner sync...`);
      await syncBanners(bannerServices);
    }
  };

  // Check every minute
  setInterval(checkAndRunBannerSync, 60 * 1000);
  console.log(`Banner sync scheduled daily at ${BANNER_SYNC_HOUR}:00 AM`);
}

async function runGLExport(glExportService) {
  console.log('\n=== Starting daily GL journal export ===');
  const startTime = Date.now();

  try {
    const result = await glExportService.exportAndEmail();
    const duration = ((Date.now() - startTime) / 1000).toFixed(2);

    if (result.success) {
      console.log(`=== GL export complete: ${result.stores} stores, $${glExportService.formatNumber(result.totalSales)} (${duration}s) ===`);
      if (result.email?.sent) {
        console.log(`=== Email sent to: ${result.email.recipients.join(', ')} ===\n`);
      }
    } else {
      console.error(`=== GL export completed with errors (${duration}s) ===\n`);
    }

    return result;
  } catch (error) {
    console.error('GL export failed:', error.message);
    return { success: false, error: error.message };
  }
}

function scheduleDailyGLExport(glExportService) {
  const checkAndRunGLExport = async () => {
    const now = new Date();
    const hours = now.getHours();
    const minutes = now.getMinutes();

    // Run at 3:00 AM (within the first minute of the hour)
    if (hours === GL_EXPORT_HOUR && minutes === 0) {
      console.log(`\n[${now.toISOString()}] Running scheduled daily GL export...`);
      await runGLExport(glExportService);
    }
  };

  // Check every minute
  setInterval(checkAndRunGLExport, 60 * 1000);
  console.log(`GL journal export scheduled daily at ${GL_EXPORT_HOUR}:00 AM`);
}

function scheduleHourlySalesSync(hourlySalesSyncService) {
  const runHourlySalesSync = async () => {
    const now = new Date();
    const minutes = now.getMinutes();

    // Run at the start of each hour (within first minute)
    if (minutes === 0) {
      console.log(`\n[${now.toISOString()}] Running hourly sales sync...`);
      try {
        await hourlySalesSyncService.syncHourlySales();
      } catch (error) {
        console.error('Hourly sales sync failed:', error.message);
      }
    }
  };

  // Check every minute
  setInterval(runHourlySalesSync, 60 * 1000);
  console.log('Hourly sales sync scheduled at the top of each hour');
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

  const discountServices = locationConfigs.map(
    loc => new DiscountSyncService(loc.id, loc.name, loc.apiKey)
  );

  const bannerServices = locationConfigs.map(
    loc => new BannerSyncService(loc.id, loc.name, loc.storeDocumentId)
  );

  const cacheSyncService = new CacheSyncService();
  const glExportService = new GLExportService(locationConfigs);
  const hourlySalesSyncService = new HourlySalesSyncService(locationConfigs);
  const odooSyncService = new OdooSyncService();

  // Initialize Odoo sync if configured
  if (odooSyncService.isEnabled()) {
    console.log('\nOdoo sync enabled - initializing...');
    await odooSyncService.initialize();
  } else {
    console.log('\nOdoo sync disabled (set ODOO_URL, ODOO_USERNAME, ODOO_API_KEY to enable)');
  }

  // Start API server
  await startServer();

  // Run initial sync
  console.log('\n');
  try {
    await syncAllLocations(inventoryServices, enrichmentServices, discountServices, cacheSyncService, odooSyncService, locationConfigs);
  } catch (error) {
    console.error('Initial sync failed:', error.message);
  }

  // Run initial banner sync on startup
  try {
    await syncBanners(bannerServices);
  } catch (error) {
    console.error('Initial banner sync failed:', error.message);
  }

  // Schedule recurring inventory/discount syncs
  setInterval(async () => {
    try {
      await syncAllLocations(inventoryServices, enrichmentServices, discountServices, cacheSyncService, odooSyncService, locationConfigs);
    } catch (error) {
      console.error('Scheduled sync failed:', error.message);
    }
  }, SYNC_INTERVAL_MS);

  // Schedule daily banner sync at 5 AM
  scheduleDailyBannerSync(bannerServices);

  // Schedule daily GL export at 8 AM
  scheduleDailyGLExport(glExportService);

  // Schedule hourly sales sync
  scheduleHourlySalesSync(hourlySalesSyncService);

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
