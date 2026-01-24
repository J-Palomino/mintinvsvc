/**
 * Banner Sync Job Processor
 *
 * Syncs retailer banners from Dutchie Plus to Strapi tickertape.
 */

const BannerSyncService = require('../../services/bannerSync');

/**
 * Process banner sync job
 * @param {Job} job - BullMQ job instance
 * @param {object} context - Context with services and configs
 */
async function process(job, context) {
  const { locationConfigs } = context;
  const startTime = Date.now();

  console.log(`\n=== Starting daily banner sync [Job ${job.id}] ===`);

  await job.updateProgress(10);

  // Create banner services for each location
  const bannerServices = locationConfigs.map(
    loc => new BannerSyncService(loc.id, loc.name, loc.storeDocumentId)
  );

  let totalBanners = 0;
  let processed = 0;

  for (const service of bannerServices) {
    try {
      const result = await service.syncBanner();
      if (result.updated && result.hasContent) {
        totalBanners++;
      }
    } catch (error) {
      console.error(`Banner sync failed:`, error.message);
    }

    processed++;
    await job.updateProgress(10 + Math.floor((processed / bannerServices.length) * 80));
  }

  await job.updateProgress(100);

  const duration = ((Date.now() - startTime) / 1000).toFixed(2);
  console.log(`=== Banner sync complete: ${totalBanners} banners updated (${duration}s) [Job ${job.id}] ===\n`);

  return {
    totalBanners,
    totalLocations: locationConfigs.length,
    duration
  };
}

module.exports = { process };
