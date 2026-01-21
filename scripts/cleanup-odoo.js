/**
 * Cleanup Odoo cannabis products
 *
 * Deletes all product templates with x_is_cannabis=true to allow a fresh sync.
 * Run with: node scripts/cleanup-odoo.js
 */

require('dotenv').config();
const OdooClient = require('../src/api/odoo');

async function main() {
  const odoo = new OdooClient();

  console.log('Authenticating with Odoo...');
  await odoo.authenticate();
  console.log(`Authenticated as uid=${odoo.uid}`);

  // Find all cannabis product templates
  console.log('Finding cannabis product templates...');
  const templates = await odoo.search('product.template', [
    ['x_is_cannabis', '=', true]
  ]);

  console.log(`Found ${templates.length} cannabis templates to delete`);

  if (templates.length === 0) {
    console.log('No templates to delete');
    return;
  }

  // Delete in batches
  const batchSize = 100;
  for (let i = 0; i < templates.length; i += batchSize) {
    const batch = templates.slice(i, i + batchSize);
    console.log(`Deleting batch ${Math.floor(i/batchSize) + 1}: templates ${i+1}-${i+batch.length}`);

    try {
      await odoo.unlink('product.template', batch);
    } catch (error) {
      console.error(`Error deleting batch: ${error.message}`);
    }
  }

  console.log('Cleanup complete!');

  // Verify
  const remaining = await odoo.search('product.template', [
    ['x_is_cannabis', '=', true]
  ]);
  console.log(`Remaining cannabis templates: ${remaining.length}`);
}

main().catch(console.error);
