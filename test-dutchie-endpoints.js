/**
 * Explore available Dutchie API endpoints
 * Tests various endpoint paths to discover what's available
 */

const axios = require('axios');

const STORES_API_URL = process.env.STORES_API_URL || 'https://mintdealsbackend-production.up.railway.app/api/stores';
const DUTCHIE_API_URL = process.env.DUTCHIE_API_URL || 'https://api.pos.dutchie.com';

// Potential Dutchie API endpoints to test
const ENDPOINTS_TO_TEST = [
  // Reporting endpoints
  { path: '/reporting/inventory', method: 'GET', description: 'Inventory report' },
  { path: '/reporting/discounts', method: 'GET', description: 'Discounts report' },
  { path: '/reporting/sales', method: 'GET', description: 'Sales report' },
  { path: '/reporting/transactions', method: 'GET', description: 'Transactions report' },
  { path: '/reporting/orders', method: 'GET', description: 'Orders report' },
  { path: '/reporting/customers', method: 'GET', description: 'Customers report' },
  { path: '/reporting/products', method: 'GET', description: 'Products report' },

  // V2 endpoints
  { path: '/discounts/v2/list', method: 'GET', description: 'Discounts v2 list' },
  { path: '/inventory/v2/list', method: 'GET', description: 'Inventory v2 list' },
  { path: '/products/v2/list', method: 'GET', description: 'Products v2 list' },
  { path: '/sales/v2/list', method: 'GET', description: 'Sales v2 list' },
  { path: '/orders/v2/list', method: 'GET', description: 'Orders v2 list' },

  // Standard REST endpoints
  { path: '/inventory', method: 'GET', description: 'Inventory' },
  { path: '/products', method: 'GET', description: 'Products' },
  { path: '/discounts', method: 'GET', description: 'Discounts' },
  { path: '/sales', method: 'GET', description: 'Sales' },
  { path: '/orders', method: 'GET', description: 'Orders' },
  { path: '/transactions', method: 'GET', description: 'Transactions' },
  { path: '/customers', method: 'GET', description: 'Customers' },
  { path: '/employees', method: 'GET', description: 'Employees' },
  { path: '/registers', method: 'GET', description: 'Registers' },
  { path: '/categories', method: 'GET', description: 'Categories' },
  { path: '/brands', method: 'GET', description: 'Brands' },
  { path: '/vendors', method: 'GET', description: 'Vendors' },

  // Info/meta endpoints
  { path: '/whoami', method: 'GET', description: 'Account info' },
  { path: '/me', method: 'GET', description: 'Current user' },
  { path: '/location', method: 'GET', description: 'Location info' },
  { path: '/locations', method: 'GET', description: 'All locations' },
  { path: '/api', method: 'GET', description: 'API info' },
  { path: '/api/v1', method: 'GET', description: 'API v1 info' },
  { path: '/api/v2', method: 'GET', description: 'API v2 info' },
  { path: '/', method: 'GET', description: 'Root endpoint' },

  // Menu endpoints
  { path: '/menu', method: 'GET', description: 'Menu' },
  { path: '/menus', method: 'GET', description: 'Menus' },

  // Compliance/regulatory
  { path: '/compliance', method: 'GET', description: 'Compliance' },
  { path: '/metrc', method: 'GET', description: 'METRC integration' },

  // Loyalty
  { path: '/loyalty', method: 'GET', description: 'Loyalty' },
  { path: '/loyalty/customers', method: 'GET', description: 'Loyalty customers' },
  { path: '/loyalty/rewards', method: 'GET', description: 'Loyalty rewards' },
];

async function testEndpoint(client, endpoint) {
  try {
    const response = await client.request({
      method: endpoint.method,
      url: endpoint.path,
      timeout: 10000
    });
    return {
      ...endpoint,
      status: response.status,
      success: true,
      dataType: Array.isArray(response.data) ? `array[${response.data.length}]` : typeof response.data,
      sample: Array.isArray(response.data) ? response.data.slice(0, 1) : response.data
    };
  } catch (error) {
    return {
      ...endpoint,
      status: error.response?.status || 'ERR',
      success: false,
      error: error.response?.statusText || error.message
    };
  }
}

async function main() {
  console.log('Fetching a store API key to test endpoints...\n');

  try {
    const response = await axios.get(`${STORES_API_URL}?pagination[limit]=100`);
    const stores = response.data.data || response.data;

    // Find first active store with API key
    const store = stores.find(s => s.dutchieApiKey && s.is_active);
    if (!store) {
      console.error('No active store with API key found');
      return;
    }

    console.log(`Using: ${store.name}\n`);
    console.log('Testing Dutchie API endpoints...\n');

    const client = axios.create({
      baseURL: DUTCHIE_API_URL,
      auth: { username: store.dutchieApiKey, password: '' }
    });

    const results = {
      available: [],
      unauthorized: [],
      notFound: [],
      errors: []
    };

    for (const endpoint of ENDPOINTS_TO_TEST) {
      process.stdout.write(`Testing ${endpoint.path}... `);
      const result = await testEndpoint(client, endpoint);

      if (result.success) {
        console.log(`✓ ${result.status} (${result.dataType})`);
        results.available.push(result);
      } else if (result.status === 401 || result.status === 403) {
        console.log(`🔒 ${result.status} Unauthorized`);
        results.unauthorized.push(result);
      } else if (result.status === 404) {
        console.log(`✗ 404 Not Found`);
        results.notFound.push(result);
      } else {
        console.log(`⚠ ${result.status} ${result.error}`);
        results.errors.push(result);
      }
    }

    // Summary
    console.log('\n' + '='.repeat(60));
    console.log('AVAILABLE ENDPOINTS');
    console.log('='.repeat(60));

    if (results.available.length === 0) {
      console.log('None found beyond tested endpoints');
    } else {
      for (const r of results.available) {
        console.log(`\n✓ ${r.method} ${r.path}`);
        console.log(`  Description: ${r.description}`);
        console.log(`  Response: ${r.dataType}`);
        if (r.sample && typeof r.sample === 'object') {
          const keys = Array.isArray(r.sample) && r.sample[0]
            ? Object.keys(r.sample[0]).slice(0, 10).join(', ')
            : Object.keys(r.sample).slice(0, 10).join(', ');
          console.log(`  Fields: ${keys}...`);
        }
      }
    }

    if (results.unauthorized.length > 0) {
      console.log('\n' + '='.repeat(60));
      console.log('UNAUTHORIZED (may need different permissions)');
      console.log('='.repeat(60));
      for (const r of results.unauthorized) {
        console.log(`  🔒 ${r.method} ${r.path} - ${r.description}`);
      }
    }

    console.log('\n' + '='.repeat(60));
    console.log('SUMMARY');
    console.log('='.repeat(60));
    console.log(`Available: ${results.available.length}`);
    console.log(`Unauthorized: ${results.unauthorized.length}`);
    console.log(`Not Found: ${results.notFound.length}`);
    console.log(`Errors: ${results.errors.length}`);

  } catch (error) {
    console.error('Failed:', error.message);
  }
}

main();
