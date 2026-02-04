#!/usr/bin/env node
/**
 * Create custom Dutchie tracking fields on product.product model in Odoo
 *
 * Creates three custom fields via ir.model.fields:
 * - x_dutchie_product_id
 * - x_dutchie_inventory_id
 * - x_dutchie_location_id
 *
 * Usage:
 *   node scripts/create-odoo-dutchie-fields.js
 *
 * Required environment variables:
 *   ODOO_URL      - Odoo server URL (e.g., https://mycompany.odoo.com)
 *   ODOO_USERNAME - Odoo username/email
 *   ODOO_API_KEY  - Odoo API key or password
 *   ODOO_DATABASE - (optional) Odoo database name (default: odoo)
 */

// Load .env file if it exists
try {
  require('dotenv').config();
} catch (e) {
  // dotenv not installed or no .env file - that's ok
}

const OdooClient = require('../src/api/odoo');

async function createDutchieFields() {
  // Check for required credentials
  const missingVars = [];
  if (!process.env.ODOO_URL) missingVars.push('ODOO_URL');
  if (!process.env.ODOO_USERNAME) missingVars.push('ODOO_USERNAME');
  if (!process.env.ODOO_API_KEY) missingVars.push('ODOO_API_KEY');

  if (missingVars.length > 0) {
    console.error('Missing required environment variables:');
    for (const v of missingVars) {
      console.error(`  - ${v}`);
    }
    console.error('\nPlease set these variables and try again.');
    console.error('Example:');
    console.error('  ODOO_URL=https://mycompany.odoo.com ODOO_USERNAME=admin ODOO_API_KEY=xxx node scripts/create-odoo-dutchie-fields.js');
    process.exit(1);
  }

  const odoo = new OdooClient();

  console.log(`Connecting to Odoo at ${process.env.ODOO_URL}...`);
  console.log(`Database: ${process.env.ODOO_DATABASE || 'odoo'}`);
  console.log(`Username: ${process.env.ODOO_USERNAME}`);
  console.log('');

  console.log('Authenticating with Odoo...');
  await odoo.authenticate();
  console.log(`Authenticated as uid=${odoo.uid}\n`);

  // Step 1: Get the model ID for product.product
  console.log('Finding product.product model ID...');
  const models = await odoo.searchRead(
    'ir.model',
    [['model', '=', 'product.product']],
    ['id', 'name', 'model']
  );

  if (!models || models.length === 0) {
    throw new Error('Could not find product.product model in ir.model');
  }

  const productModelId = models[0].id;
  console.log(`Found product.product model: id=${productModelId}, name="${models[0].name}"\n`);

  // Step 2: Define the fields to create
  const fieldsToCreate = [
    {
      name: 'x_dutchie_product_id',
      field_description: 'Dutchie Product ID',
      model_id: productModelId,
      ttype: 'char',
      state: 'manual',
      help: 'Product ID from Dutchie POS system for bidirectional tracking',
    },
    {
      name: 'x_dutchie_inventory_id',
      field_description: 'Dutchie Inventory ID',
      model_id: productModelId,
      ttype: 'char',
      state: 'manual',
      help: 'Inventory ID from Dutchie POS system for bidirectional tracking',
    },
    {
      name: 'x_dutchie_location_id',
      field_description: 'Dutchie Location ID',
      model_id: productModelId,
      ttype: 'char',
      state: 'manual',
      help: 'Location ID from Dutchie POS system',
    },
  ];

  // Step 3: Check for existing fields
  console.log('Checking for existing fields...');
  const fieldNames = fieldsToCreate.map(f => f.name);
  const existingFields = await odoo.searchRead(
    'ir.model.fields',
    [
      ['model', '=', 'product.product'],
      ['name', 'in', fieldNames],
    ],
    ['id', 'name', 'field_description']
  );

  const existingFieldNames = new Set(existingFields.map(f => f.name));
  if (existingFields.length > 0) {
    console.log('Existing fields found:');
    for (const f of existingFields) {
      console.log(`  - ${f.name} (id=${f.id}): "${f.field_description}"`);
    }
    console.log('');
  }

  // Step 4: Create missing fields
  const createdFieldIds = [];

  for (const fieldDef of fieldsToCreate) {
    if (existingFieldNames.has(fieldDef.name)) {
      console.log(`Skipping ${fieldDef.name} - already exists`);
      // Find the existing ID
      const existing = existingFields.find(f => f.name === fieldDef.name);
      if (existing) {
        createdFieldIds.push({ name: fieldDef.name, id: existing.id, status: 'existing' });
      }
      continue;
    }

    console.log(`Creating field: ${fieldDef.name}`);
    try {
      const fieldId = await odoo.create('ir.model.fields', fieldDef);
      console.log(`  Created with id=${fieldId}`);
      createdFieldIds.push({ name: fieldDef.name, id: fieldId, status: 'created' });
    } catch (error) {
      console.error(`  Error creating ${fieldDef.name}: ${error.message}`);
      createdFieldIds.push({ name: fieldDef.name, id: null, status: 'error', error: error.message });
    }
  }

  // Step 5: Verify the fields exist
  console.log('\nVerifying created fields...');
  const verifiedFields = await odoo.searchRead(
    'ir.model.fields',
    [
      ['model', '=', 'product.product'],
      ['name', 'in', fieldNames],
    ],
    ['id', 'name', 'field_description', 'ttype', 'state', 'help']
  );

  console.log('\n=== Field Creation Summary ===\n');
  for (const field of verifiedFields) {
    console.log(`Field: ${field.name}`);
    console.log(`  ID: ${field.id}`);
    console.log(`  Label: ${field.field_description}`);
    console.log(`  Type: ${field.ttype}`);
    console.log(`  State: ${field.state}`);
    console.log(`  Help: ${field.help || '(none)'}`);
    console.log('');
  }

  // Return results
  return {
    success: verifiedFields.length === 3,
    fields: createdFieldIds,
    verified: verifiedFields,
  };
}

// Run the script
createDutchieFields()
  .then(result => {
    console.log('=== Result ===');
    console.log(JSON.stringify(result, null, 2));

    if (result.success) {
      console.log('\nAll 3 fields created/verified successfully!');
      console.log('\nYou can now uncomment the x_dutchie_* lines in src/services/odooSync.js');
      process.exit(0);
    } else {
      console.log('\nWarning: Not all fields were created');
      process.exit(1);
    }
  })
  .catch(error => {
    console.error('Error:', error.message);
    process.exit(1);
  });
