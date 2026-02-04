/**
 * Odoo Sync Job Processor
 *
 * Syncs inventory FROM Odoo TO PostgreSQL.
 * This enables Odoo to be the inventory master.
 *
 * Flow: Odoo → PostgreSQL → Redis cache
 */

const OdooToPostgresSync = require('../../services/odooToPostgresSync');
const CacheSyncService = require('../../services/cacheSync');

/**
 * Process Odoo sync job
 * @param {Job} job - BullMQ job instance
 * @param {object} context - Context with services and configs
 */
async function process(job, context) {
  const startTime = Date.now();

  console.log(`\n=== Starting Odoo→Postgres Sync [Job ${job.id}] ===`);

  const odooToPostgresSync = new OdooToPostgresSync();
  const cacheSyncService = new CacheSyncService();

  // Check if Odoo sync is enabled
  if (!odooToPostgresSync.isEnabled()) {
    console.log('Odoo sync not configured - skipping');
    return {
      skipped: true,
      reason: 'Odoo credentials not configured',
      duration: 0
    };
  }

  await job.updateProgress(10);

  // Initialize Odoo connection
  const initialized = await odooToPostgresSync.initialize();
  if (!initialized) {
    throw new Error('Failed to initialize Odoo connection');
  }

  await job.updateProgress(20);

  // Sync from Odoo to PostgreSQL
  console.log('\n--- Syncing Odoo → PostgreSQL ---');
  const syncResult = await odooToPostgresSync.syncAll();

  await job.updateProgress(70);

  // Refresh Redis cache for affected locations
  if (syncResult.total > 0) {
    console.log('\n--- Refreshing Redis Cache ---');
    const { locationConfigs } = context;

    // Only refresh cache for locations that have Odoo warehouse mappings
    for (const [, locationId] of odooToPostgresSync.warehouseToLocationMap) {
      const loc = locationConfigs.find(l => l.id === locationId);
      if (loc) {
        try {
          await cacheSyncService.refreshLocationCache(locationId);
          console.log(`  Refreshed cache for ${loc.name}`);
        } catch (e) {
          console.error(`  Failed to refresh cache for ${loc.name}: ${e.message}`);
        }
      }
    }
  }

  await job.updateProgress(100);

  const duration = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n=== Odoo sync complete: ${syncResult.total} products, ${syncResult.errors} errors (${duration}s) ===\n`);

  return {
    synced: syncResult.total,
    errors: syncResult.errors,
    duration: parseFloat(duration)
  };
}

module.exports = { process };
