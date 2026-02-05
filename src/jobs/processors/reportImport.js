/**
 * Report Import Job Processor
 *
 * Imports Daily Sales and Mel reports from Odoo inbox
 * and stores them as JSON attachments.
 *
 * Runs nightly at 6:00 AM.
 */

const OdooReportImportService = require('../../services/odooReportImportService');

async function processReportImport(job, context) {
  console.log(`\n=== Report Import [Job ${job.id}] ===`);
  const startTime = Date.now();

  const service = new OdooReportImportService();

  if (!service.isEnabled()) {
    console.log('Report import disabled - Odoo not configured');
    return { skipped: true, reason: 'Odoo not configured' };
  }

  try {
    const result = await service.runImportsNow();

    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`Report import complete in ${duration}s`);

    return result;
  } catch (error) {
    console.error('Report import failed:', error.message);
    throw error;
  }
}

module.exports = processReportImport;
