/**
 * Dutchie Sync Job Processor
 *
 * NOTE: This sync is currently disabled because Dutchie's API does not support
 * external product creation (405 Method Not Allowed) or updates (404 Not Found).
 * Products must be created through Dutchie's compliance integration.
 *
 * When/if Dutchie adds write API support, this can be re-enabled.
 *
 * Original intent: Push Odoo-created products TO Dutchie POS
 * Flow: PostgreSQL → Dutchie POS
 */

/**
 * Process Dutchie sync job
 * @param {Job} job - BullMQ job instance
 * @param {object} context - Context with services and configs
 */
async function process(job, context) {
  console.log(`\n=== PostgreSQL→Dutchie Sync [Job ${job.id}] - DISABLED ===`);
  console.log('  Dutchie API does not support external product creation/updates');
  console.log('  Products must be created through Dutchie compliance integration');

  return {
    skipped: true,
    reason: 'Dutchie API does not support external writes',
    duration: 0
  };
}

module.exports = { process };
