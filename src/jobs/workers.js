/**
 * BullMQ Worker Definitions
 *
 * All workers run with concurrency=1 to prevent overlapping jobs.
 */

const { Worker } = require('bullmq');
const { QUEUE_NAMES } = require('./queues');

// Import processors
const inventorySyncProcessor = require('./processors/inventorySync');
const glExportProcessor = require('./processors/glExport');
const bannerSyncProcessor = require('./processors/bannerSync');
const hourlySalesProcessor = require('./processors/hourlySales');
const odooSyncProcessor = require('./processors/odooSync');

let workers = {};
let context = null;

/**
 * Initialize all workers with the given Redis connection and context
 * @param {object} connection - Redis connection options
 * @param {object} ctx - Context with locationConfigs and other shared data
 */
function initWorkers(connection, ctx) {
  context = ctx;

  const workerOptions = {
    connection,
    concurrency: 1, // Prevents overlapping jobs
    removeOnComplete: { count: 100 },
    removeOnFail: { count: 50 }
  };

  // Inventory Sync Worker
  workers.inventorySync = new Worker(
    QUEUE_NAMES.INVENTORY_SYNC,
    async (job) => inventorySyncProcessor.process(job, context),
    workerOptions
  );

  // GL Export Worker
  workers.glExport = new Worker(
    QUEUE_NAMES.GL_EXPORT,
    async (job) => glExportProcessor.process(job, context),
    workerOptions
  );

  // Banner Sync Worker
  workers.bannerSync = new Worker(
    QUEUE_NAMES.BANNER_SYNC,
    async (job) => bannerSyncProcessor.process(job, context),
    workerOptions
  );

  // Hourly Sales Worker
  workers.hourlySales = new Worker(
    QUEUE_NAMES.HOURLY_SALES,
    async (job) => hourlySalesProcessor.process(job, context),
    workerOptions
  );

  // Odoo Sync Worker (Odoo → PostgreSQL)
  workers.odooSync = new Worker(
    QUEUE_NAMES.ODOO_SYNC,
    async (job) => odooSyncProcessor.process(job, context),
    workerOptions
  );

  // Set up event handlers for all workers
  Object.entries(workers).forEach(([name, worker]) => {
    worker.on('completed', (job, result) => {
      console.log(`[${name}] Job ${job.id} completed`);
    });

    worker.on('failed', (job, error) => {
      console.error(`[${name}] Job ${job?.id} failed:`, error.message);
      if (job?.attemptsMade < job?.opts?.attempts) {
        console.log(`[${name}] Will retry (attempt ${job.attemptsMade + 1}/${job.opts.attempts})`);
      }
    });

    worker.on('error', (error) => {
      console.error(`[${name}] Worker error:`, error.message);
    });

    worker.on('stalled', (jobId) => {
      console.warn(`[${name}] Job ${jobId} stalled`);
    });
  });

  console.log('BullMQ workers initialized');
  return workers;
}

/**
 * Get all worker instances
 */
function getWorkers() {
  return workers;
}

/**
 * Update the shared context (e.g., when location configs change)
 */
function updateContext(newContext) {
  context = { ...context, ...newContext };
}

/**
 * Close all workers gracefully (waits for current jobs to complete)
 */
async function closeWorkers() {
  const closePromises = Object.entries(workers).map(async ([name, worker]) => {
    console.log(`Closing ${name} worker...`);
    await worker.close();
  });

  await Promise.all(closePromises);
  console.log('All workers closed');
}

/**
 * Pause all workers (stop accepting new jobs)
 */
async function pauseWorkers() {
  for (const worker of Object.values(workers)) {
    await worker.pause();
  }
  console.log('All workers paused');
}

/**
 * Resume all workers
 */
async function resumeWorkers() {
  for (const worker of Object.values(workers)) {
    await worker.resume();
  }
  console.log('All workers resumed');
}

module.exports = {
  initWorkers,
  getWorkers,
  updateContext,
  closeWorkers,
  pauseWorkers,
  resumeWorkers
};
