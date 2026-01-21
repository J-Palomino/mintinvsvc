/**
 * Test Dutchie CDN image URL patterns
 */
const axios = require('axios');

const STORES_API_URL = 'https://mintdealsbackend-production.up.railway.app/api/stores';
const DUTCHIE_API_URL = 'https://api.pos.dutchie.com';

// Potential image URL patterns to test
const URL_PATTERNS = [
  (id) => `https://images.dutchie.com/products/${id}/default.jpg`,
  (id) => `https://images.dutchie.com/product/${id}/default.jpg`,
  (id) => `https://images.dutchie.com/${id}.jpg`,
  (id) => `https://images.dutchie.com/product-images/${id}.jpg`,
  (id) => `https://dutchie-images.imgix.net/${id}.jpg`,
  (id) => `https://leaflogixmedia.blob.core.windows.net/product-image/${id}.jpg`,
];

async function testImageUrl(url) {
  try {
    const response = await axios.head(url, { timeout: 5000 });
    return { url, status: response.status, success: true, contentType: response.headers['content-type'] };
  } catch (error) {
    return { url, status: error.response?.status || 'ERR', success: false };
  }
}

async function main() {
  // Get a store API key
  const response = await axios.get(`${STORES_API_URL}?pagination[limit]=100`);
  const stores = response.data.data || response.data;
  const store = stores.find(s => s.dutchieApiKey && s.is_active);

  console.log(`Using: ${store.name}\n`);

  const client = axios.create({
    baseURL: DUTCHIE_API_URL,
    auth: { username: store.dutchieApiKey, password: '' }
  });

  // Get some products with and without images
  const products = await client.get('/products?limit=50');

  // Get products with existing images to understand the ID format
  const withImages = products.data.filter(p => p.imageUrl).slice(0, 3);
  const withoutImages = products.data.filter(p => !p.imageUrl).slice(0, 5);

  console.log('=== Products WITH existing imageUrl ===');
  for (const p of withImages) {
    console.log(`\n${p.productName}`);
    console.log(`  productId: ${p.productId}`);
    console.log(`  sku: ${p.sku}`);
    console.log(`  existing imageUrl: ${p.imageUrl}`);

    // Extract ID from existing URL if possible
    const match = p.imageUrl?.match(/([a-f0-9-]{36})/);
    if (match) {
      console.log(`  extracted UUID: ${match[1]}`);
    }
  }

  console.log('\n\n=== Products WITHOUT imageUrl - Testing patterns ===');
  for (const p of withoutImages) {
    console.log(`\n${p.productName}`);
    console.log(`  productId: ${p.productId}`);
    console.log(`  sku: ${p.sku}`);

    // Test each URL pattern with productId
    for (const pattern of URL_PATTERNS) {
      const url = pattern(p.productId);
      const result = await testImageUrl(url);
      const status = result.success ? `✓ ${result.status}` : `✗ ${result.status}`;
      console.log(`  ${status} ${url.substring(0, 70)}...`);
    }
  }

  // Also test with a known working product
  console.log('\n\n=== Testing patterns with product that HAS image ===');
  if (withImages.length > 0) {
    const p = withImages[0];
    console.log(`${p.productName} (productId: ${p.productId})`);
    console.log(`Known working URL: ${p.imageUrl}`);

    for (const pattern of URL_PATTERNS) {
      const url = pattern(p.productId);
      const result = await testImageUrl(url);
      const status = result.success ? `✓ ${result.status}` : `✗ ${result.status}`;
      console.log(`  ${status} ${url.substring(0, 70)}...`);
    }
  }
}

main().catch(console.error);
