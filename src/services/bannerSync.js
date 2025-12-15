const db = require('../db');
const DutchiePlusClient = require('../api/dutchiePlus');

class BannerSyncService {
  constructor(locationId, locationName) {
    this.locationId = locationId;
    this.locationName = locationName;
    this.plusClient = new DutchiePlusClient();
  }

  async syncBanner() {
    const startTime = Date.now();
    console.log(`Starting banner sync for ${this.locationName}...`);

    if (!this.plusClient.apiKeySet) {
      console.log(`  Skipping ${this.locationName} - DUTCHIE_PLUS_API_KEY not set`);
      return { updated: false, skipped: true };
    }

    if (!this.locationId) {
      console.log(`  Skipping ${this.locationName} - no location ID configured`);
      return { updated: false, skipped: true };
    }

    try {
      const bannerHtml = await this.plusClient.getRetailerBanner(this.locationId);

      // Update the location's tickertape field
      const result = await db.query(`
        UPDATE locations SET
          tickertape = $1
        WHERE id = $2
      `, [bannerHtml, this.locationId]);

      const duration = ((Date.now() - startTime) / 1000).toFixed(2);

      if (result.rowCount > 0) {
        console.log(`  Banner sync complete in ${duration}s: tickertape ${bannerHtml ? 'updated' : 'cleared'}`);
        return { updated: true, hasContent: !!bannerHtml, duration, locationId: this.locationId };
      } else {
        console.log(`  Banner sync complete in ${duration}s: location not found`);
        return { updated: false, duration, locationId: this.locationId };
      }
    } catch (error) {
      console.error(`  Banner sync failed for ${this.locationName}:`, error.message);
      return { updated: false, error: error.message, locationId: this.locationId };
    }
  }
}

module.exports = BannerSyncService;
