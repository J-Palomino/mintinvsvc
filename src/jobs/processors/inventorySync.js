/**
 * Inventory Sync Job Processor
 *
 * Wraps the existing sync logic from index.js:
 * 1. Inventory sync from POS API
 * 2. Product enrichment from Plus GraphQL
 * 3. Discount sync from POS API
 * 4. Redis cache refresh
 * 5. Odoo sync (if enabled)
 */

const InventorySyncService = require('../../services/inventorySync');
const ProductEnrichmentService = require('../../services/productEnrichment');
const DiscountSyncService = require('../../services/discountSync');
const CacheSyncService = require('../../services/cacheSync');
const OdooSyncService = require('../../services/odooSync');

// Odoo sync enabled - requires ODOO_URL, ODOO_USERNAME, ODOO_API_KEY env vars
const ODOO_SYNC_ENABLED = true;

/**
 * Process inventory sync job
 * @param {Job} job - BullMQ job instance
 * @param {object} context - Context with services and configs
 */
async function process(job, context) {
  const { locationConfigs } = context;
  const startTime = Date.now();

  console.log(`\n=== Starting sync for ${locationConfigs.length} location(s) [Job ${job.id}] ===`);

  // Create services for each location
  const inventoryServices = locationConfigs.map(
    loc => new InventorySyncService(loc.id, loc.name, loc.apiKey)
  );

  const enrichmentServices = locationConfigs.map(
    loc => new ProductEnrichmentService(loc.id, loc.name)
  );

  const discountServices = locationConfigs.map(
    loc => new DiscountSyncService(loc.id, loc.name, loc.apiKey)
  );

  const cacheSyncService = new CacheSyncService();
  const odooSyncService = new OdooSyncService();

  // Phase 1: Inventory sync from POS API
  console.log('\n--- Phase 1: Inventory Sync (POS API) ---');
  await job.updateProgress(10);

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
  await job.updateProgress(30);

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
  await job.updateProgress(50);

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
  console.log('\n--- Phase 4: Cache Refresh ---');
  await job.updateProgress(70);

  let totalCached = 0;
  try {
    const cacheResult = await cacheSyncService.refreshAllCaches(locationConfigs);
    totalCached = cacheResult.totalInventory || 0;
  } catch (error) {
    console.error(`Cache refresh failed:`, error.message);
  }

  // Phase 5: Sync to Odoo (if enabled)
  await job.updateProgress(90);

  let totalOdoo = 0;
  if (ODOO_SYNC_ENABLED && odooSyncService.isEnabled()) {
    console.log('\n--- Phase 5: Odoo Sync ---');
    try {
      await odooSyncService.initialize();
      const odooResult = await odooSyncService.syncAllLocations(locationConfigs);
      totalOdoo = odooResult.total || 0;
    } catch (error) {
      console.error(`Odoo sync failed:`, error.message);
    }
  }

  const duration = ((Date.now() - startTime) / 1000 / 60).toFixed(1);

  console.log(`\n=== Sync complete: ${totalSynced} inventory, ${totalEnriched} enriched, ${totalDiscounts} discounts, ${totalCached} cached, ${totalOdoo} to Odoo, ${totalErrors} errors (${duration} min) [Job ${job.id}] ===\n`);

  await job.updateProgress(100);

  return {
    totalSynced,
    totalEnriched,
    totalDiscounts,
    totalCached,
    totalOdoo,
    totalErrors,
    duration,
    locations: locationConfigs.length
  };
}

module.exports = { process };
