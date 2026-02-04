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

  async getDiscountsReport() {
    try {
      console.log('Fetching discounts report from Dutchie...');

      const response = await this.client.get('/reporting/discounts');

      console.log(`Fetched ${response.data?.length || 0} discounts`);
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

  // ==================== WRITE METHODS ====================

  /**
   * Create a new product in Dutchie
   * @param {object} product - Product data
   * @returns {object} Created product with ID
   */
  async createProduct(product) {
    try {
      console.log(`  Creating product: ${product.name}`);
      const response = await this.client.post('/inventory', product);
      return response.data;
    } catch (error) {
      this.handleError('createProduct', error);
      throw error;
    }
  }

  /**
   * Update an existing product in Dutchie
   * @param {string} productId - Dutchie product ID
   * @param {object} updates - Fields to update
   * @returns {object} Updated product
   */
  async updateProduct(productId, updates) {
    try {
      const response = await this.client.put(`/inventory/${productId}`, updates);
      return response.data;
    } catch (error) {
      this.handleError('updateProduct', error);
      throw error;
    }
  }

  /**
   * Adjust inventory quantity for a product
   * @param {string} productId - Dutchie product ID
   * @param {number} quantity - New quantity (or adjustment amount)
   * @param {string} reason - Reason for adjustment
   * @returns {object} Adjustment result
   */
  async adjustInventory(productId, quantity, reason = 'Sync from Odoo') {
    try {
      const response = await this.client.post('/inventory/adjust', {
        productId,
        quantity,
        reason
      });
      return response.data;
    } catch (error) {
      this.handleError('adjustInventory', error);
      throw error;
    }
  }

  /**
   * Batch update multiple products
   * @param {array} products - Array of {id, ...updates}
   * @returns {object} Batch result
   */
  async batchUpdateProducts(products) {
    try {
      console.log(`  Batch updating ${products.length} products`);
      const response = await this.client.post('/inventory/batch', { products });
      return response.data;
    } catch (error) {
      this.handleError('batchUpdateProducts', error);
      throw error;
    }
  }

  /**
   * Handle API errors consistently
   */
  handleError(method, error) {
    if (error.response) {
      console.error(`Dutchie ${method} Error:`, {
        status: error.response.status,
        statusText: error.response.statusText,
        data: error.response.data
      });
    } else if (error.request) {
      console.error(`No response from Dutchie (${method}):`, error.message);
    } else {
      console.error(`Error in ${method}:`, error.message);
    }
  }

  // ==================== READ METHODS ====================

  /**
   * Get discounts using v2 API with full restriction/eligibility data
   * This endpoint provides calculationMethod, thresholdMin, and product restrictions
   */
  async getDiscountsV2() {
    try {
      console.log('Fetching discounts from Dutchie v2 API...');

      const response = await this.client.get('/discounts/v2/list', {
        params: {
          includeInactive: false,
          includeInclusionExclusionData: true
        }
      });

      console.log(`Fetched ${response.data?.length || 0} discounts from v2 API`);
      return response.data;
    } catch (error) {
      if (error.response) {
        console.error('Dutchie v2 API Error:', {
          status: error.response.status,
          statusText: error.response.statusText,
          data: error.response.data
        });
      } else if (error.request) {
        console.error('No response from Dutchie v2 API:', error.message);
      } else {
        console.error('Error setting up request:', error.message);
      }
      throw error;
    }
  }
}

module.exports = DutchieClient;
