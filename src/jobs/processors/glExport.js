/**
 * GL Export Job Processor
 *
 * Generates and emails daily GL journal export for previous day's transactions.
 */

const GLExportService = require('../../services/glExportService');

/**
 * Process GL export job
 * @param {Job} job - BullMQ job instance
 * @param {object} context - Context with services and configs
 */
async function process(job, context) {
  const { locationConfigs } = context;
  const startTime = Date.now();

  // Get the date to export (defaults to yesterday)
  const exportDate = job.data.date || null;

  console.log(`\n=== Starting daily GL journal export [Job ${job.id}] ===`);
  if (exportDate) {
    console.log(`Export date: ${exportDate}`);
  }

  await job.updateProgress(10);

  const glExportService = new GLExportService(locationConfigs);

  try {
    const result = await glExportService.exportAndEmail(exportDate);

    await job.updateProgress(100);

    const duration = ((Date.now() - startTime) / 1000).toFixed(2);

    if (result.success) {
      console.log(`=== GL export complete: ${result.stores} stores, $${glExportService.formatNumber(result.totalSales)} (${duration}s) [Job ${job.id}] ===`);
      if (result.email?.sent) {
        console.log(`=== Email sent to: ${result.email.recipients.join(', ')} ===\n`);
      }
    } else {
      console.error(`=== GL export completed with errors (${duration}s) [Job ${job.id}] ===\n`);
    }

    return {
      success: result.success,
      stores: result.stores || 0,
      totalSales: result.totalSales || 0,
      emailSent: result.email?.sent || false,
      duration,
      date: exportDate || 'yesterday'
    };
  } catch (error) {
    console.error(`GL export failed [Job ${job.id}]:`, error.message);
    throw error; // Re-throw to trigger retry
  }
}

module.exports = { process };
