/**
 * Hourly Sales Sync Job Processor
 *
 * Syncs hourly sales data to PostgreSQL for reporting.
 */

const HourlySalesSyncService = require('../../services/hourlySalesSync');

/**
 * Process hourly sales sync job
 * @param {Job} job - BullMQ job instance
 * @param {object} context - Context with services and configs
 */
async function process(job, context) {
  const { locationConfigs } = context;
  const startTime = Date.now();

  console.log(`\n=== Starting hourly sales sync [Job ${job.id}] ===`);

  await job.updateProgress(10);

  const hourlySalesSyncService = new HourlySalesSyncService(locationConfigs);

  try {
    const result = await hourlySalesSyncService.syncHourlySales();

    await job.updateProgress(100);

    const duration = ((Date.now() - startTime) / 1000).toFixed(2);

    console.log(`=== Hourly sales sync complete (${duration}s) [Job ${job.id}] ===\n`);

    return {
      success: true,
      duration,
      ...result
    };
  } catch (error) {
    console.error(`Hourly sales sync failed [Job ${job.id}]:`, error.message);
    throw error; // Re-throw to trigger retry
  }
}

module.exports = { process };
