// Only load .env file in development (Railway/production sets env vars directly)
const isProduction = process.env.NODE_ENV === 'production' || process.env.RAILWAY_ENVIRONMENT;
if (!isProduction) {
  require('dotenv').config();
}

const StoreConfigService = require('./services/storeConfig');
const { startServer } = require('./api/server');
const { initJobSystem, runInitialJobs, shutdownJobSystem } = require('./jobs');
const cache = require('./cache');
const db = require('./db');

async function main() {
  console.log('Mint Inventory Sync Service starting...');
  console.log('Using BullMQ for job scheduling\n');

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

  // Start API server
  await startServer();

  // Initialize BullMQ job system
  await initJobSystem(locationConfigs);

  // Run initial sync jobs
  await runInitialJobs();

  console.log('Service running. Press Ctrl+C to stop.');
}

// Handle graceful shutdown
async function gracefulShutdown(signal) {
  console.log(`\n${signal} received. Starting graceful shutdown...`);

  try {
    // Shutdown job system (waits for current jobs to complete)
    await shutdownJobSystem();

    // Close Redis connection
    await cache.close();

    // Close database pool
    await db.pool.end();

    console.log('Shutdown complete. Goodbye!');
    process.exit(0);
  } catch (error) {
    console.error('Error during shutdown:', error.message);
    process.exit(1);
  }
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
