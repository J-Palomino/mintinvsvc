const axios = require('axios');
const DutchiePlusClient = require('../api/dutchiePlus');

const STORES_API_URL = process.env.STORES_API_URL || 'https://mintdealsbackend-production.up.railway.app/api/stores';
const STRAPI_API_TOKEN = process.env.STRAPI_API_TOKEN;

class BannerSyncService {
  constructor(locationId, locationName, storeId) {
    this.locationId = locationId;  // DutchieStoreID (retailerId for GraphQL)
    this.locationName = locationName;
    this.storeId = storeId;  // Strapi store ID for PUT request
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

    if (!this.storeId) {
      console.log(`  Skipping ${this.locationName} - no store ID configured`);
      return { updated: false, skipped: true };
    }

    if (!STRAPI_API_TOKEN) {
      console.log(`  Skipping ${this.locationName} - STRAPI_API_TOKEN not set`);
      return { updated: false, skipped: true };
    }

    try {
      const bannerHtml = await this.plusClient.getRetailerBanner(this.locationId);

      // Update the store's tickertape field in Strapi
      const response = await axios.put(`${STORES_API_URL}/${this.storeId}`, {
        data: {
          tickertape: bannerHtml
        }
      }, {
        headers: {
          'Authorization': `Bearer ${STRAPI_API_TOKEN}`,
          'Content-Type': 'application/json'
        }
      });

      const duration = ((Date.now() - startTime) / 1000).toFixed(2);

      if (response.status === 200) {
        console.log(`  Banner sync complete in ${duration}s: tickertape ${bannerHtml ? 'updated' : 'cleared'}`);
        return { updated: true, hasContent: !!bannerHtml, duration, locationId: this.locationId };
      } else {
        console.log(`  Banner sync complete in ${duration}s: unexpected status ${response.status}`);
        return { updated: false, duration, locationId: this.locationId };
      }
    } catch (error) {
      const errorDetails = error.response?.data || error.message;
      console.error(`  Banner sync failed for ${this.locationName}:`, JSON.stringify(errorDetails));
      return { updated: false, error: error.message, locationId: this.locationId };
    }
  }
}

module.exports = BannerSyncService;
