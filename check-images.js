/**
 * Check which Dutchie endpoints have image URLs
 */
const axios = require('axios');

const STORES_API_URL = 'https://mintdealsbackend-production.up.railway.app/api/stores';
const DUTCHIE_API_URL = 'https://api.pos.dutchie.com';

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

  // Check /reporting/inventory
  console.log('=== /reporting/inventory ===');
  const invReport = await client.get('/reporting/inventory');
  const invWithImages = invReport.data.filter(i => i.imageUrl);
  console.log(`Total: ${invReport.data.length}, With imageUrl: ${invWithImages.length}`);
  if (invWithImages.length > 0) {
    console.log('Sample:', invWithImages[0].productName, '->', invWithImages[0].imageUrl?.substring(0, 80));
  }

  // Check /inventory
  console.log('\n=== /inventory ===');
  const inv = await client.get('/inventory');
  const inv2WithImages = inv.data.filter(i => i.imageUrl);
  console.log(`Total: ${inv.data.length}, With imageUrl: ${inv2WithImages.length}`);
  if (inv2WithImages.length > 0) {
    console.log('Sample:', inv2WithImages[0].productName, '->', inv2WithImages[0].imageUrl?.substring(0, 80));
  }

  // Check /products
  console.log('\n=== /products ===');
  const products = await client.get('/products');
  const prodWithImages = products.data.filter(p => p.imageUrl);
  console.log(`Total: ${products.data.length}, With imageUrl: ${prodWithImages.length}`);
  if (prodWithImages.length > 0) {
    console.log('Sample:', prodWithImages[0].productName, '->', prodWithImages[0].imageUrl?.substring(0, 80));
  }

  // Check /reporting/products
  console.log('\n=== /reporting/products ===');
  const prodReport = await client.get('/reporting/products');
  const prodReportWithImages = prodReport.data.filter(p => p.imageUrl);
  console.log(`Total: ${prodReport.data.length}, With imageUrl: ${prodReportWithImages.length}`);
  if (prodReportWithImages.length > 0) {
    console.log('Sample:', prodReportWithImages[0].productName, '->', prodReportWithImages[0].imageUrl?.substring(0, 80));
  }

  // Show sample image URLs
  console.log('\n=== Sample Image URLs ===');
  const allWithImages = [...prodWithImages.slice(0, 5)];
  allWithImages.forEach(p => {
    console.log(`${p.productName}:`);
    console.log(`  imageUrl: ${p.imageUrl}`);
    if (p.imageUrls) console.log(`  imageUrls: ${JSON.stringify(p.imageUrls)}`);
  });
}

main().catch(console.error);
