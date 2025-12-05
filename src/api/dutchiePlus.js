const axios = require('axios');

const DUTCHIE_PLUS_URL = 'https://plus.dutchie.com/plus/2021-07/graphql';
const DUTCHIE_PLUS_API_KEY = process.env.DUTCHIE_PLUS_API_KEY;

const MENU_QUERY = `
query MenuQuery($retailerId: ID!) {
  menu(retailerId: $retailerId) {
    products {
      id
      name
      slug
      description
      descriptionHtml
      brand {
        name
      }
      strainType
      effects
      tags
      staffPick
      productBatchId
      images {
        url
      }
      potencyCbd {
        formatted
      }
      potencyThc {
        formatted
      }
      posMetaData {
        id
        sku
      }
    }
  }
}
`;

class DutchiePlusClient {
  constructor() {
    this.apiKeySet = !!DUTCHIE_PLUS_API_KEY;

    this.client = axios.create({
      baseURL: DUTCHIE_PLUS_URL,
      headers: {
        'Content-Type': 'application/json',
        ...(DUTCHIE_PLUS_API_KEY && { 'Authorization': `Bearer ${DUTCHIE_PLUS_API_KEY}` })
      }
    });
  }

  async getMenuProducts(retailerId) {
    if (!DUTCHIE_PLUS_API_KEY) {
      return [];
    }

    try {
      console.log(`  Fetching menu products for retailer: ${retailerId}`);

      const response = await this.client.post('', {
        query: MENU_QUERY,
        variables: { retailerId }
      });

      if (response.data.errors) {
        console.error('  GraphQL errors:', response.data.errors[0]?.message);
        return [];
      }

      const products = response.data.data?.menu?.products || [];
      console.log(`  Fetched ${products.length} menu products`);
      return products;
    } catch (error) {
      if (error.response) {
        console.error('  Dutchie Plus API Error:', error.response.status);
      } else {
        console.error('  Dutchie Plus API Error:', error.message);
      }
      return [];
    }
  }
}

module.exports = DutchiePlusClient;
