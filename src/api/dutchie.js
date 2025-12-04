const axios = require('axios');

class DutchieClient {
  constructor(apiUrl, apiKey) {
    this.apiUrl = apiUrl || process.env.DUTCHIE_API_URL;
    this.apiKey = apiKey || process.env.DUTCHIE_API_KEY;

    this.client = axios.create({
      baseURL: this.apiUrl,
      headers: {
        'Content-Type': 'application/json'
      },
      auth: {
        username: this.apiKey,
        password: ''
      }
    });
  }

  async getInventoryReport() {
    try {
      console.log('Fetching inventory report from Dutchie...');

      const response = await this.client.get('/reporting/inventory');

      console.log(`Fetched ${response.data?.length || 0} inventory items`);
      return response.data;
    } catch (error) {
      if (error.response) {
        console.error('Dutchie API Error:', {
          status: error.response.status,
          statusText: error.response.statusText,
          data: error.response.data
        });
      } else if (error.request) {
        console.error('No response from Dutchie API:', error.message);
      } else {
        console.error('Error setting up request:', error.message);
      }
      throw error;
    }
  }
}

module.exports = DutchieClient;
