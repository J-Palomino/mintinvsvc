/**
 * Odoo Sync Service
 *
 * Syncs inventory data from PostgreSQL to Odoo using batch operations.
 * Uses JSON-RPC for faster performance.
 */

const OdooClient = require('../api/odoo');
const db = require('../db');

class OdooSyncService {
  constructor() {
    this.odoo = new OdooClient();
    this.enabled = !!(process.env.ODOO_URL && process.env.ODOO_USERNAME && process.env.ODOO_API_KEY);

    // Stock sync is slow (3 API calls per product) - disable for faster initial sync
    this.syncStock = process.env.ODOO_SYNC_STOCK === 'true';

    // Cache for Odoo IDs
    this.categoryCache = new Map();
    this.warehouseCache = new Map();
    this.productCache = new Map(); // product_name -> template_id
  }

  isEnabled() {
    return this.enabled;
  }

  async initialize() {
    if (!this.enabled) {
      console.log('Odoo sync disabled - missing credentials');
      return false;
    }

    try {
      await this.odoo.authenticate();
      await this.loadCaches();
      console.log(`Stock sync: ${this.syncStock ? 'enabled' : 'disabled (set ODOO_SYNC_STOCK=true to enable)'}`);
      return true;
    } catch (error) {
      console.error('Odoo initialization failed:', error.message);
      return false;
    }
  }

  async loadCaches() {
    try {
      const categories = await this.odoo.searchRead('product.category', [], ['id', 'name']);
      for (const cat of categories || []) {
        if (cat?.name) {
          this.categoryCache.set(cat.name.toLowerCase(), cat.id);
        }
      }
    } catch (e) {
      console.log('Could not load category cache:', e.message);
    }

    try {
      const warehouses = await this.odoo.searchRead('stock.warehouse', [], ['id', 'name', 'code']);
      for (const wh of warehouses || []) {
        if (wh?.name) {
          this.warehouseCache.set(wh.name, wh.id);
        }
      }
    } catch (e) {
      console.log('Could not load warehouse cache:', e.message);
    }

    console.log(`Odoo caches: ${this.categoryCache.size} categories, ${this.warehouseCache.size} warehouses`);
  }

  async syncLocationInventory(locationId, locationName) {
    if (!this.enabled) return { synced: 0, errors: 0, skipped: true };

    console.log(`  Syncing ${locationName} to Odoo...`);
    const startTime = Date.now();

    try {
      // Ensure warehouse exists
      const warehouseId = await this.ensureWarehouse(locationId, locationName);

      // Fetch inventory
      const inventory = await this.fetchInventory(locationId);
      console.log(`    Found ${inventory.length} products`);

      if (inventory.length === 0) {
        return { synced: 0, errors: 0 };
      }

      // Process in batches of 100
      const batchSize = 100;
      let synced = 0;
      let errors = 0;

      for (let i = 0; i < inventory.length; i += batchSize) {
        const batch = inventory.slice(i, i + batchSize);

        try {
          const result = await this.syncBatch(batch, warehouseId);
          synced += result.synced;
          errors += result.errors;
        } catch (error) {
          console.error(`    Batch error: ${error.message}`);
          errors += batch.length;
        }

        // Progress every 200 items
        if ((i + batchSize) % 200 === 0 || i + batchSize >= inventory.length) {
          console.log(`    Progress: ${Math.min(i + batchSize, inventory.length)}/${inventory.length}`);
        }
      }

      const duration = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(`    Done: ${synced} synced, ${errors} errors (${duration}s)`);

      return { synced, errors };
    } catch (error) {
      console.error(`  Sync failed for ${locationName}: ${error.message}`);
      return { synced: 0, errors: 1, error: error.message };
    }
  }

  /**
   * Sync a batch of products efficiently
   */
  async syncBatch(items, warehouseId) {
    let synced = 0;
    let errors = 0;

    // Step 1: Get unique product names and check which exist
    const productNames = [...new Set(items.map(i => i.product_name))];

    // Find existing templates by name
    console.log(`      Searching for ${productNames.length} unique product names...`);
    const existingTemplates = await this.odoo.searchRead(
      'product.template',
      [['name', 'in', productNames]],
      ['id', 'name']
    );
    console.log(`      Search returned ${existingTemplates?.length || 0} existing templates`);

    const templateMap = new Map();
    for (const t of existingTemplates || []) {
      templateMap.set(t.name, t.id);
    }

    // Step 2: Create missing templates in batch
    const templatesToCreate = [];
    for (const item of items) {
      if (!templateMap.has(item.product_name)) {
        templatesToCreate.push({
          name: item.product_name,
          sale_ok: true,
          purchase_ok: true,
          description_sale: item.description || '',
        });
      }
    }

    if (templatesToCreate.length > 0) {
      try {
        // Remove duplicates
        const uniqueTemplates = [];
        const seen = new Set();
        for (const t of templatesToCreate) {
          if (!seen.has(t.name)) {
            seen.add(t.name);
            uniqueTemplates.push(t);
          }
        }

        console.log(`      Creating ${uniqueTemplates.length} new templates (${existingTemplates?.length || 0} existing)`);
        const newIds = await this.odoo.createBatch('product.template', uniqueTemplates);
        console.log(`      Batch create returned: ${JSON.stringify(newIds).substring(0, 100)}`);

        // Map new IDs back to names
        if (Array.isArray(newIds)) {
          for (let i = 0; i < newIds.length; i++) {
            templateMap.set(uniqueTemplates[i].name, newIds[i]);
          }
        } else if (typeof newIds === 'number') {
          // Single ID returned for single create
          templateMap.set(uniqueTemplates[0].name, newIds);
        }
      } catch (e) {
        console.error(`    Template batch create failed: ${e.message}`);
        errors += templatesToCreate.length;
      }
    }

    // Step 3: Find existing variants by SKU
    const skus = items.map(i => i.sku).filter(Boolean);
    const existingVariants = await this.odoo.searchRead(
      'product.product',
      [['default_code', 'in', skus]],
      ['id', 'default_code', 'product_tmpl_id']
    );

    const variantMap = new Map();
    for (const v of existingVariants || []) {
      variantMap.set(v.default_code, { id: v.id, tmplId: v.product_tmpl_id[0] });
    }

    console.log(`      Found ${existingVariants?.length || 0} existing variants, templateMap size: ${templateMap.size}`);

    // Step 4: Update or create variants
    for (const item of items) {
      try {
        const templateId = templateMap.get(item.product_name);
        if (!templateId) {
          errors++;
          continue;
        }

        const variantData = {
          default_code: item.sku,
          barcode: item.sku,
          list_price: item.price || 0,
          standard_price: item.unit_cost || 0,
        };

        // Store Dutchie IDs as custom fields for bidirectional tracking
        // Note: These x_* fields must be created in Odoo first via Settings → Technical → Fields
        // Uncomment after creating fields in Odoo:
        // variantData.x_dutchie_product_id = item.product_id || null;
        // variantData.x_dutchie_inventory_id = item.inventory_id || null;
        // variantData.x_dutchie_location_id = item.location_id || null;

        if (item.net_weight) {
          variantData.weight = parseFloat(item.net_weight) || 0;
        }

        const existing = variantMap.get(item.sku);

        if (existing) {
          // Update existing variant
          await this.odoo.write('product.product', existing.id, variantData);
          if (this.syncStock) {
            await this.updateStock(existing.id, warehouseId, item.quantity_available);
          }
        } else {
          // Find the template's auto-created variant
          const templateVariants = await this.odoo.search(
            'product.product',
            [['product_tmpl_id', '=', templateId]],
            { limit: 1 }
          );

          if (templateVariants && templateVariants.length > 0) {
            const variantId = templateVariants[0];
            await this.odoo.write('product.product', variantId, variantData);
            if (this.syncStock) {
              await this.updateStock(variantId, warehouseId, item.quantity_available);
            }
            variantMap.set(item.sku, { id: variantId, tmplId: templateId });
          } else {
            errors++;
            continue;
          }
        }

        // Store Odoo ID back in PostgreSQL for bidirectional tracking
        const odooVariantId = existing ? existing.id : variantMap.get(item.sku)?.id;
        if (odooVariantId) {
          await this.updateSourceExternalId(item.inventory_id, item.location_id, odooVariantId);
        }

        synced++;
      } catch (e) {
        console.error(`      Error syncing ${item.sku}: ${e.message}`);
        errors++;
      }
    }

    return { synced, errors };
  }

  /**
   * Store Odoo product ID in PostgreSQL for bidirectional tracking
   */
  async updateSourceExternalId(inventoryId, locationId, odooProductId) {
    try {
      const id = `${locationId}_${inventoryId}`;
      await db.query(`
        UPDATE inventory
        SET source_external_id = $1
        WHERE id = $2
      `, [`odoo:product.product:${odooProductId}`, id]);
    } catch (e) {
      // Non-fatal - just log
      console.error(`      Failed to store Odoo ID for ${inventoryId}: ${e.message}`);
    }
  }

  async fetchInventory(locationId) {
    const result = await db.query(`
      SELECT
        inventory_id, product_id, sku, product_name, brand_name,
        category, strain, description, price, unit_cost,
        quantity_available, net_weight, image_url, location_id
      FROM inventory
      WHERE location_id = $1 AND quantity_available > 0
      ORDER BY product_name
    `, [locationId]);

    return result.rows;
  }

  async ensureWarehouse(locationId, locationName) {
    if (this.warehouseCache.has(locationName)) {
      return this.warehouseCache.get(locationName);
    }

    // Generate unique code
    const namePrefix = locationName.replace(/[^A-Za-z]/g, '').substring(0, 3).toUpperCase();
    const idSuffix = locationId.replace(/-/g, '').substring(0, 5).toUpperCase();
    const code = (namePrefix + idSuffix).substring(0, 8);

    // Check if exists
    const existing = await this.odoo.search('stock.warehouse', [['name', '=', locationName]], { limit: 1 });

    if (existing && existing.length > 0) {
      this.warehouseCache.set(locationName, existing[0]);
      return existing[0];
    }

    // Create new
    const newId = await this.odoo.create('stock.warehouse', { name: locationName, code });
    this.warehouseCache.set(locationName, newId);
    console.log(`    Created warehouse: ${locationName}`);
    return newId;
  }

  async updateStock(productId, warehouseId, quantity) {
    try {
      const warehouse = await this.odoo.read('stock.warehouse', [warehouseId], ['lot_stock_id']);
      if (!warehouse || warehouse.length === 0) return;

      const locationId = warehouse[0].lot_stock_id[0];

      const quants = await this.odoo.search('stock.quant', [
        ['product_id', '=', productId],
        ['location_id', '=', locationId],
      ], { limit: 1 });

      if (quants && quants.length > 0) {
        await this.odoo.write('stock.quant', quants[0], {
          quantity: quantity,
          inventory_quantity: quantity,
        });
      } else {
        await this.odoo.create('stock.quant', {
          product_id: productId,
          location_id: locationId,
          quantity: quantity,
          inventory_quantity: quantity,
        });
      }
    } catch (e) {
      // Non-fatal
    }
  }

  async syncAllLocations(locationConfigs) {
    if (!this.enabled) {
      console.log('Odoo sync skipped - not configured');
      return { total: 0, errors: 0 };
    }

    console.log('\n--- Phase 5: Odoo Sync ---');
    const startTime = Date.now();
    let totalSynced = 0;
    let totalErrors = 0;

    if (!this.odoo.authenticated) {
      const ok = await this.initialize();
      if (!ok) return { total: 0, errors: 1, skipped: true };
    }

    for (const loc of locationConfigs) {
      try {
        const result = await this.syncLocationInventory(loc.id, loc.name);
        totalSynced += result.synced || 0;
        totalErrors += result.errors || 0;
      } catch (error) {
        console.error(`Sync failed for ${loc.name}: ${error.message}`);
        totalErrors++;
      }
    }

    const duration = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
    console.log(`Odoo sync complete: ${totalSynced} products, ${totalErrors} errors (${duration} min)`);

    return { total: totalSynced, errors: totalErrors };
  }
}

module.exports = OdooSyncService;
