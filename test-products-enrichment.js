/**
 * Check if we can enrich inventory with images from /products endpoint
 */
const axios = require('axios');

const STORES_API_URL = 'https://mintdealsbackend-production.up.railway.app/api/stores';
const DUTCHIE_API_URL = 'https://api.pos.dutchie.com';

async function main() {
  const response = await axios.get(`${STORES_API_URL}?pagination[limit]=100`);
  const stores = response.data.data || response.data;
  const store = stores.find(s => s.dutchieApiKey && s.is_active);

  console.log(`Using: ${store.name}\n`);

  const client = axios.create({
    baseURL: DUTCHIE_API_URL,
    auth: { username: store.dutchieApiKey, password: '' }
  });

  // Get inventory and products
  console.log('Fetching data...');
  const [invResp, prodResp] = await Promise.all([
    client.get('/reporting/inventory'),
    client.get('/products')
  ]);

  const inventory = invResp.data;
  const products = prodResp.data;

  console.log(`Inventory: ${inventory.length} items`);
  console.log(`Products: ${products.length} items`);

  // Build product lookup by productId
  const productById = new Map();
  const productBySku = new Map();

  for (const p of products) {
    if (p.productId) productById.set(String(p.productId), p);
    if (p.sku) productBySku.set(String(p.sku), p);
  }

  // Check how many inventory items can get images from products
  let matchedById = 0;
  let matchedBySku = 0;
  let canGetImage = 0;
  let alreadyHasImage = 0;

  for (const inv of inventory) {
    if (inv.imageUrl) {
      alreadyHasImage++;
      continue;
    }

    // Try to find matching product
    let product = productById.get(String(inv.productId));
    if (product) matchedById++;

    if (!product && inv.sku) {
      product = productBySku.get(String(inv.sku));
      if (product) matchedBySku++;
    }

    if (product?.imageUrl) {
      canGetImage++;
    }
  }

  console.log(`\nInventory items already with imageUrl: ${alreadyHasImage}`);
  console.log(`Inventory items WITHOUT imageUrl: ${inventory.length - alreadyHasImage}`);
  console.log(`\nMatches found:`);
  console.log(`  By productId: ${matchedById}`);
  console.log(`  By SKU: ${matchedBySku}`);
  console.log(`\nCAN get imageUrl from /products: ${canGetImage}`);
  console.log(`\nTotal potential with images: ${alreadyHasImage + canGetImage} (${((alreadyHasImage + canGetImage) / inventory.length * 100).toFixed(1)}%)`);

  // Show samples
  console.log('\n=== Sample matches that would get images ===');
  let shown = 0;
  for (const inv of inventory) {
    if (inv.imageUrl || shown >= 5) continue;
    const product = productById.get(String(inv.productId)) || productBySku.get(String(inv.sku));
    if (product?.imageUrl) {
      console.log(`${inv.productName}:`);
      console.log(`  inv.productId: ${inv.productId}, prod.productId: ${product.productId}`);
      console.log(`  imageUrl: ${product.imageUrl}`);
      shown++;
    }
  }
}

main().catch(console.error);
