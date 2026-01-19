const axios = require('axios');

const DUTCHIE_PLUS_URL = 'https://plus.dutchie.com/plus/2021-07/graphql';
const DUTCHIE_PLUS_API_KEY = process.env.DUTCHIE_PLUS_API_KEY;

// Request up to 500 products per menu (pagination supported via first/after)
const MENU_QUERY = `
query MenuQuery($retailerId: ID!, $first: Int) {
  menu(retailerId: $retailerId) {
    products(first: $first) {
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

const RETAILER_BANNER_QUERY = `
query RetailerBannerQuery($retailerId: ID!) {
  retailer(id: $retailerId) {
    banner {
      html
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

  async getMenuProducts(retailerId, limit = 500) {
    if (!DUTCHIE_PLUS_API_KEY) {
      return [];
    }

    try {
      console.log(`  Fetching menu products for retailer: ${retailerId}`);

      const response = await this.client.post('', {
        query: MENU_QUERY,
        variables: { retailerId, first: limit }
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

  async getRetailerBanner(retailerId) {
    if (!DUTCHIE_PLUS_API_KEY) {
      return null;
    }

    try {
      console.log(`  Fetching banner for retailer: ${retailerId}`);

      const response = await this.client.post('', {
        query: RETAILER_BANNER_QUERY,
        variables: { retailerId }
      });

      if (response.data.errors) {
        console.error('  GraphQL errors:', response.data.errors[0]?.message);
        return null;
      }

      const bannerHtml = response.data.data?.retailer?.banner?.html || null;
      if (bannerHtml) {
        console.log(`  Fetched banner for retailer ${retailerId}`);
      } else {
        console.log(`  No banner found for retailer ${retailerId}`);
      }
      return bannerHtml;
    } catch (error) {
      if (error.response) {
        console.error('  Dutchie Plus API Error:', error.response.status);
      } else {
        console.error('  Dutchie Plus API Error:', error.message);
      }
      return null;
    }
  }
}

module.exports = DutchiePlusClient;
