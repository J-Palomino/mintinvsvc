const axios = require('axios');

const STORES_API_URL = process.env.STORES_API_URL || 'https://mintdealsbackend-production.up.railway.app/api/stores';
const DUTCHIE_API_URL = process.env.DUTCHIE_API_URL || 'https://api.pos.dutchie.com';

class StoreConfigService {

  async fetchStores() {
    try {
      console.log('Fetching store configurations...');
      const response = await axios.get(STORES_API_URL);

      const stores = response.data.data || response.data;
      console.log(`Found ${stores.length} stores in backend`);

      return stores;
    } catch (error) {
      console.error('Failed to fetch stores:', error.message);
      throw error;
    }
  }

  async getDutchieLocationId(apiKey) {
    try {
      const response = await axios.get(`${DUTCHIE_API_URL}/whoami`, {
        auth: { username: apiKey, password: '' }
      });
      return {
        locationId: response.data.locationId,
        locationName: response.data.locationName,
        address: response.data.address,
        city: response.data.city,
        state: response.data.state
      };
    } catch (error) {
      console.error('Failed to get Dutchie location info:', error.message);
      return null;
    }
  }

  async getLocationConfigs() {
    const stores = await this.fetchStores();
    const configs = [];

    for (const store of stores) {
      // Skip stores without API key or inactive stores
      if (!store.dutchieApiKey || !store.is_active) {
        console.log(`Skipping ${store.name}: ${!store.dutchieApiKey ? 'no API key' : 'inactive'}`);
        continue;
      }

      // Get the Dutchie POS location ID
      const dutchieInfo = await this.getDutchieLocationId(store.dutchieApiKey);

      if (!dutchieInfo || !dutchieInfo.locationId) {
        console.log(`Skipping ${store.name}: could not get Dutchie location ID`);
        continue;
      }

      configs.push({
        id: String(dutchieInfo.locationId),
        name: store.name,
        apiKey: store.dutchieApiKey,
        retailerId: store.DutchieStoreID, // For Plus GraphQL API
        dutchieLocationName: dutchieInfo.locationName,
        city: dutchieInfo.city,
        state: dutchieInfo.state,
        storeId: store.id,
        slug: store.slug
      });

      console.log(`  ✓ ${store.name} -> Location ${dutchieInfo.locationId}`);
    }

    console.log(`\nConfigured ${configs.length} locations for sync`);
    return configs;
  }
}

module.exports = StoreConfigService;
