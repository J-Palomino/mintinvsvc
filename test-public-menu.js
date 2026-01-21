/**
 * Test Dutchie public menu endpoints for images
 */
const axios = require('axios');

const STORES_API_URL = 'https://mintdealsbackend-production.up.railway.app/api/stores';

// Dutchie public menu endpoints
const PUBLIC_ENDPOINTS = [
  // Dutchie Plus public GraphQL (no auth required for public menus)
  {
    name: 'Dutchie Plus GraphQL (public)',
    url: 'https://plus.dutchie.com/plus/2021-07/graphql',
    method: 'POST',
    getBody: (retailerId) => ({
      query: `query { menu(retailerId: "${retailerId}") { products(first: 5) { id name images { url } } } }`
    })
  },
  // Dutchie embeddable menu
  {
    name: 'Dutchie Embedded Menu API',
    url: (retailerId) => `https://dutchie.com/api/v2/embed/${retailerId}/menu`,
    method: 'GET'
  },
  // Dutchie dispensary page
  {
    name: 'Dutchie Dispensary API',
    url: (retailerId) => `https://dutchie.com/api/v3/dispensaries/${retailerId}/menu`,
    method: 'GET'
  },
  // IHeartJane (another cannabis menu platform)
  {
    name: 'IHeartJane Search',
    url: 'https://api.iheartjane.com/v1/products',
    method: 'GET'
  }
];

async function main() {
  // Get store info
  const response = await axios.get(`${STORES_API_URL}?pagination[limit]=100`);
  const stores = response.data.data || response.data;
  const store = stores.find(s => s.DutchieStoreID && s.is_active);

  if (!store) {
    console.log('No store with DutchieStoreID found');
    return;
  }

  console.log(`Store: ${store.name}`);
  console.log(`DutchieStoreID: ${store.DutchieStoreID}`);
  console.log();

  // Test Dutchie Plus public GraphQL
  console.log('=== Testing Dutchie Plus Public GraphQL ===');
  try {
    const graphqlResponse = await axios.post(
      'https://plus.dutchie.com/plus/2021-07/graphql',
      {
        query: `
          query MenuQuery($retailerId: ID!) {
            menu(retailerId: $retailerId) {
              products(first: 10) {
                id
                name
                images {
                  url
                }
              }
            }
          }
        `,
        variables: { retailerId: store.DutchieStoreID }
      },
      {
        headers: { 'Content-Type': 'application/json' }
      }
    );

    if (graphqlResponse.data.errors) {
      console.log('GraphQL Error:', graphqlResponse.data.errors[0]?.message);
    } else {
      const products = graphqlResponse.data.data?.menu?.products || [];
      console.log(`Found ${products.length} products`);

      const withImages = products.filter(p => p.images?.length > 0);
      console.log(`With images: ${withImages.length}`);

      withImages.slice(0, 3).forEach(p => {
        console.log(`  ${p.name}: ${p.images[0]?.url?.substring(0, 60)}...`);
      });
    }
  } catch (error) {
    console.log('Error:', error.response?.status, error.response?.data?.errors?.[0]?.message || error.message);
  }

  // Test Dutchie public dispensary endpoint
  console.log('\n=== Testing Dutchie Public Dispensary API ===');
  const dispensaryUrls = [
    `https://dutchie.com/api/v2/dispensaries/${store.DutchieStoreID}`,
    `https://api.dutchie.com/v1/dispensaries/${store.DutchieStoreID}/menu`,
    `https://dutchie.com/embedded-menu/${store.DutchieStoreID}/stores/${store.DutchieStoreID}/menu`
  ];

  for (const url of dispensaryUrls) {
    try {
      const resp = await axios.get(url, { timeout: 5000 });
      console.log(`✓ ${url.substring(0, 60)}... -> ${resp.status}`);
      if (resp.data?.products) {
        console.log(`  Products: ${resp.data.products.length}`);
      }
    } catch (error) {
      console.log(`✗ ${url.substring(0, 60)}... -> ${error.response?.status || error.message}`);
    }
  }
}

main().catch(console.error);
