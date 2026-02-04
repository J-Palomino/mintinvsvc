/**
 * Dutchie Sync Job Processor
 *
 * Pushes inventory FROM PostgreSQL TO Dutchie POS.
 * This enables Odoo-created products to be sellable at the register.
 *
 * Flow: PostgreSQL → Dutchie POS
 */

const { syncAllLocations } = require('../../services/postgresToDutchieSync');

/**
 * Process Dutchie sync job
 * @param {Job} job - BullMQ job instance
 * @param {object} context - Context with services and configs
 */
async function process(job, context) {
  const { locationConfigs } = context;
  const startTime = Date.now();

  console.log(`\n=== Starting PostgreSQL→Dutchie Sync [Job ${job.id}] ===`);

  // Check if we have any Odoo-sourced products to sync
  const db = require('../../db');
  const countResult = await db.query(`
    SELECT COUNT(*) as count FROM inventory WHERE source = 'odoo'
  `);
  const odooProductCount = parseInt(countResult.rows[0].count);

  if (odooProductCount === 0) {
    console.log('No Odoo-sourced products to sync - skipping');
    return {
      skipped: true,
      reason: 'No Odoo-sourced products',
      duration: 0
    };
  }

  await job.updateProgress(10);

  // Sync all locations
  const result = await syncAllLocations(locationConfigs);

  await job.updateProgress(100);

  const duration = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n=== Dutchie sync complete: ${result.created} created, ${result.updated} updated (${duration}s) ===\n`);

  return {
    created: result.created,
    updated: result.updated,
    errors: result.errors,
    duration: parseFloat(duration)
  };
}

module.exports = { process };
