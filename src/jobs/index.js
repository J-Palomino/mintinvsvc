/**
 * BullMQ Job System Initialization
 *
 * Main entry point for the job queue system.
 * Initializes queues, workers, and schedules repeatable jobs.
 */

const { getClient } = require('../cache');
const { initQueues, scheduleRepeatableJobs, closeQueues, addJob, QUEUE_NAMES } = require('./queues');
const { initWorkers, closeWorkers, updateContext } = require('./workers');

let isInitialized = false;

/**
 * Initialize the BullMQ job system
 * @param {object} locationConfigs - Location configurations from StoreConfigService
 */
async function initJobSystem(locationConfigs) {
  if (isInitialized) {
    console.warn('Job system already initialized');
    return;
  }

  console.log('\nInitializing BullMQ job system...');

  // Get Redis connection from existing cache module
  const redisClient = getClient();

  // BullMQ needs connection options, not the client instance
  // Extract connection details from the client
  const connection = {
    host: redisClient.options.host,
    port: redisClient.options.port,
    password: redisClient.options.password,
    username: redisClient.options.username || 'default',
    maxRetriesPerRequest: null // Required for BullMQ
  };

  // Initialize queues
  initQueues(connection);

  // Initialize workers with context
  const context = { locationConfigs };
  initWorkers(connection, context);

  // Schedule repeatable jobs
  console.log('Scheduling repeatable jobs:');
  await scheduleRepeatableJobs();

  isInitialized = true;
  console.log('BullMQ job system ready\n');
}

/**
 * Run initial sync jobs immediately (on startup)
 */
async function runInitialJobs() {
  console.log('Running initial sync jobs...\n');

  // Add immediate inventory sync job
  await addJob(QUEUE_NAMES.INVENTORY_SYNC, {}, { priority: 1 });

  // Add immediate banner sync job
  await addJob(QUEUE_NAMES.BANNER_SYNC, {}, { priority: 1 });
}

/**
 * Gracefully shutdown the job system
 */
async function shutdownJobSystem() {
  if (!isInitialized) {
    return;
  }

  console.log('\nShutting down job system...');

  // Close workers first (waits for current jobs to finish)
  await closeWorkers();

  // Then close queues
  await closeQueues();

  isInitialized = false;
  console.log('Job system shutdown complete');
}

/**
 * Update location configs in workers (for dynamic reloading)
 */
function updateLocationConfigs(locationConfigs) {
  updateContext({ locationConfigs });
}

module.exports = {
  initJobSystem,
  runInitialJobs,
  shutdownJobSystem,
  updateLocationConfigs,
  addJob,
  QUEUE_NAMES
};
