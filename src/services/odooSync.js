/**
 * Odoo Sync Service
 *
 * Syncs inventory data from PostgreSQL to Odoo.
 * Handles products, brands, strains, and stock quantities.
 */

const OdooClient = require('../api/odoo');
const db = require('../db');

class OdooSyncService {
  constructor() {
    this.odoo = new OdooClient();
    this.enabled = !!(process.env.ODOO_URL && process.env.ODOO_USERNAME && process.env.ODOO_API_KEY);

    // Cache for Odoo IDs to reduce lookups
    this.brandCache = new Map(); // brand_name -> odoo_id
    this.strainCache = new Map(); // strain_name -> odoo_id
    this.categoryCache = new Map(); // category_name -> odoo_id
    this.warehouseCache = new Map(); // location_id -> warehouse_id
  }

  /**
   * Check if Odoo sync is enabled
   */
  isEnabled() {
    return this.enabled;
  }

  /**
   * Initialize connection and caches
   */
  async initialize() {
    if (!this.enabled) {
      console.log('Odoo sync disabled - missing credentials');
      return false;
    }

    try {
      await this.odoo.authenticate();
      await this.loadCaches();
      return true;
    } catch (error) {
      console.error('Odoo initialization failed:', error.message);
      return false;
    }
  }

  /**
   * Load reference data caches from Odoo
   * Note: Caches are optional - sync will still work without them (just slower)
   */
  async loadCaches() {
    try {
      // Load brands
      const brands = await this.odoo.searchRead('cannabis.brand', [], ['id', 'name']);
      if (Array.isArray(brands)) {
        for (const brand of brands) {
          if (brand && brand.name) {
            this.brandCache.set(brand.name.toLowerCase(), brand.id);
          }
        }
      }
    } catch (e) {
      console.log('Could not load brand cache:', e.message);
    }

    try {
      // Load strains
      const strains = await this.odoo.searchRead('cannabis.strain', [], ['id', 'name']);
      if (Array.isArray(strains)) {
        for (const strain of strains) {
          if (strain && strain.name) {
            this.strainCache.set(strain.name.toLowerCase(), strain.id);
          }
        }
      }
    } catch (e) {
      console.log('Could not load strain cache:', e.message);
    }

    try {
      // Load product categories
      const categories = await this.odoo.searchRead('product.category', [], ['id', 'name', 'complete_name']);
      if (Array.isArray(categories)) {
        for (const cat of categories) {
          if (cat && cat.name) {
            this.categoryCache.set(cat.name.toLowerCase(), cat.id);
            if (cat.complete_name) {
              this.categoryCache.set(cat.complete_name.toLowerCase(), cat.id);
            }
          }
        }
      }
    } catch (e) {
      console.log('Could not load category cache:', e.message);
    }

    try {
      // Load warehouses
      const warehouses = await this.odoo.searchRead('stock.warehouse', [], ['id', 'name', 'code']);
      if (Array.isArray(warehouses)) {
        for (const wh of warehouses) {
          if (wh && wh.code) {
            this.warehouseCache.set(wh.code, wh.id);
          }
        }
      }
    } catch (e) {
      console.log('Could not load warehouse cache:', e.message);
    }

    console.log(`Odoo caches loaded: ${this.brandCache.size} brands, ${this.strainCache.size} strains, ${this.categoryCache.size} categories`);
  }

  /**
   * Sync all inventory for a location to Odoo
   */
  async syncLocationInventory(locationId, locationName) {
    if (!this.enabled) return { synced: 0, errors: 0, skipped: true };

    console.log(`  Syncing ${locationName} to Odoo...`);
    const startTime = Date.now();
    let synced = 0;
    let errors = 0;
    let created = 0;
    let updated = 0;

    try {
      // Ensure warehouse exists for this location
      const warehouseId = await this.ensureWarehouse(locationId, locationName);

      // Fetch inventory from PostgreSQL
      const inventory = await this.fetchInventory(locationId);
      console.log(`    Found ${inventory.length} products in database`);

      // Process in batches
      const batchSize = 50;
      for (let i = 0; i < inventory.length; i += batchSize) {
        const batch = inventory.slice(i, i + batchSize);

        for (const item of batch) {
          try {
            const result = await this.syncProduct(item, warehouseId);
            synced++;
            if (result.created) created++;
            else updated++;
          } catch (error) {
            console.error(`    Error syncing ${item.sku}: ${error.message}`);
            errors++;
          }
        }

        // Progress update
        if ((i + batchSize) % 200 === 0 || i + batchSize >= inventory.length) {
          console.log(`    Progress: ${Math.min(i + batchSize, inventory.length)}/${inventory.length}`);
        }
      }

      const duration = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(`    Odoo sync complete: ${created} created, ${updated} updated, ${errors} errors (${duration}s)`);

      return { synced, created, updated, errors };
    } catch (error) {
      console.error(`  Odoo sync failed for ${locationName}: ${error.message}`);
      return { synced: 0, errors: 1, error: error.message };
    }
  }

  /**
   * Fetch inventory from PostgreSQL for a location
   */
  async fetchInventory(locationId) {
    const result = await db.query(`
      SELECT
        inventory_id,
        product_id,
        sku,
        product_name,
        brand_name,
        category,
        strain,
        strain_type,
        description,
        price,
        med_price,
        rec_price,
        unit_cost,
        quantity_available,
        allocated_quantity,
        potency_thc_formatted,
        potency_cbd_formatted,
        net_weight,
        net_weight_unit,
        size,
        batch_id,
        package_id,
        expiration_date,
        image_url,
        images,
        effects,
        tags,
        staff_pick,
        medical_only,
        slug,
        location_id
      FROM inventory
      WHERE location_id = $1
        AND quantity_available > 0
      ORDER BY product_name
    `, [locationId]);

    return result.rows;
  }

  /**
   * Ensure warehouse exists for location
   */
  async ensureWarehouse(locationId, locationName) {
    // Check cache first
    if (this.warehouseCache.has(locationId)) {
      return this.warehouseCache.get(locationId);
    }

    // Generate a unique warehouse code from location name + id
    // Use first 3 chars of name + first 5 chars of id = 8 chars max
    const namePrefix = locationName.replace(/[^A-Za-z]/g, '').substring(0, 3).toUpperCase();
    const idSuffix = locationId.replace(/-/g, '').substring(0, 5).toUpperCase();
    const warehouseCode = (namePrefix + idSuffix).substring(0, 8);

    // Search for existing warehouse by name (more reliable than code)
    const existing = await this.odoo.search('stock.warehouse', [
      ['name', '=', locationName]
    ], { limit: 1 });

    if (existing && Array.isArray(existing) && existing.length > 0) {
      this.warehouseCache.set(locationId, existing[0]);
      return existing[0];
    }

    // Create new warehouse
    const newId = await this.odoo.create('stock.warehouse', {
      name: locationName,
      code: warehouseCode,
    });

    this.warehouseCache.set(locationId, newId);
    console.log(`    Created warehouse: ${locationName} (${warehouseCode})`);
    return newId;
  }

  /**
   * Sync a single product to Odoo
   */
  async syncProduct(item, warehouseId) {
    // First, ensure brand exists
    let brandId = null;
    if (item.brand_name) {
      brandId = await this.ensureBrand(item.brand_name);
    }

    // Ensure strain exists
    let strainId = null;
    if (item.strain) {
      strainId = await this.ensureStrain(item.strain, item.strain_type);
    }

    // Get category ID
    let categoryId = null;
    if (item.category) {
      categoryId = this.categoryCache.get(item.category.toLowerCase());
    }

    // Prepare product template values
    const templateVals = {
      name: item.product_name,
      x_is_cannabis: true,
      x_dutchie_product_id: item.product_id,
      x_brand_id: brandId,
      x_strain_id: strainId,
      x_strain_type: this.mapStrainType(item.strain_type),
      x_product_category: item.category,
      x_effects: item.effects ? JSON.stringify(item.effects) : null,
      x_tags: item.tags ? JSON.stringify(item.tags) : null,
      x_staff_pick: item.staff_pick || false,
      x_medical_only: item.medical_only || false,
      x_special_sale: item.special_sale || false,
      x_slug: item.slug,
      description_sale: item.description,
      x_synced_at: new Date().toISOString(),
      x_sync_source: 'dutchie_pos',
    };

    if (categoryId) {
      templateVals.categ_id = categoryId;
    }

    // Upsert product template
    const templateResult = await this.odoo.upsert(
      'product.template',
      [['x_dutchie_product_id', '=', item.product_id]],
      templateVals
    );

    // Prepare product variant values
    const variantVals = {
      product_tmpl_id: templateResult.id,
      default_code: item.sku,
      x_dutchie_inventory_id: item.inventory_id,
      x_dutchie_sku: item.sku,
      x_dutchie_location_id: item.location_id,
      list_price: item.price || 0,
      standard_price: item.unit_cost || 0,
      x_price_rec: item.rec_price,
      x_price_med: item.med_price,
      x_unit_cost: item.unit_cost,
      x_potency_thc_formatted: item.potency_thc_formatted,
      x_potency_cbd_formatted: item.potency_cbd_formatted,
      x_net_weight: item.net_weight,
      x_weight_unit: item.net_weight_unit,
      x_size: item.size,
      x_batch_id: item.batch_id,
      x_package_id: item.package_id,
      x_expiration_date: item.expiration_date,
      x_image_url: item.image_url,
      x_images: item.images ? JSON.stringify(item.images) : null,
      x_quantity_available: item.quantity_available,
      x_quantity_reserved: item.allocated_quantity,
      x_synced_at: new Date().toISOString(),
    };

    // Set warehouse reference for store filtering
    variantVals.x_warehouse_id = warehouseId;

    // Upsert product variant
    const variantResult = await this.odoo.upsert(
      'product.product',
      [
        ['x_dutchie_sku', '=', item.sku],
        ['x_dutchie_location_id', '=', item.location_id]
      ],
      variantVals
    );

    // Update stock quantity
    await this.updateStock(variantResult.id, warehouseId, item.quantity_available);

    return {
      templateId: templateResult.id,
      variantId: variantResult.id,
      created: templateResult.created || variantResult.created,
    };
  }

  /**
   * Ensure brand exists in Odoo
   */
  async ensureBrand(brandName) {
    const key = brandName.toLowerCase();
    if (this.brandCache.has(key)) {
      return this.brandCache.get(key);
    }

    const result = await this.odoo.upsert(
      'cannabis.brand',
      [['name', '=ilike', brandName]],
      { name: brandName }
    );

    this.brandCache.set(key, result.id);
    return result.id;
  }

  /**
   * Ensure strain exists in Odoo
   */
  async ensureStrain(strainName, strainType) {
    const key = strainName.toLowerCase();
    if (this.strainCache.has(key)) {
      return this.strainCache.get(key);
    }

    const result = await this.odoo.upsert(
      'cannabis.strain',
      [['name', '=ilike', strainName]],
      {
        name: strainName,
        strain_type: this.mapStrainType(strainType) || 'hybrid',
      }
    );

    this.strainCache.set(key, result.id);
    return result.id;
  }

  /**
   * Map strain type string to Odoo selection value
   */
  mapStrainType(strainType) {
    if (!strainType) return null;

    const normalized = strainType.toLowerCase();
    const mapping = {
      'indica': 'indica',
      'sativa': 'sativa',
      'hybrid': 'hybrid',
      'cbd': 'cbd',
      'high cbd': 'high_cbd',
      'highcbd': 'high_cbd',
    };

    return mapping[normalized] || 'hybrid';
  }

  /**
   * Update stock quantity for a product in a warehouse
   */
  async updateStock(productId, warehouseId, quantity) {
    try {
      // Get the stock location for the warehouse
      const warehouse = await this.odoo.read('stock.warehouse', [warehouseId], ['lot_stock_id']);
      if (!warehouse || warehouse.length === 0) return;

      const locationId = warehouse[0].lot_stock_id[0];

      // Search for existing quant
      const quants = await this.odoo.search('stock.quant', [
        ['product_id', '=', productId],
        ['location_id', '=', locationId],
      ], { limit: 1 });

      if (quants && quants.length > 0) {
        // Update existing quant
        await this.odoo.write('stock.quant', quants[0], {
          quantity: quantity,
          inventory_quantity: quantity,
        });
      } else {
        // Create new quant
        await this.odoo.create('stock.quant', {
          product_id: productId,
          location_id: locationId,
          quantity: quantity,
          inventory_quantity: quantity,
        });
      }
    } catch (error) {
      // Stock update errors are non-fatal
      console.error(`    Stock update failed for product ${productId}: ${error.message}`);
    }
  }

  /**
   * Sync all locations to Odoo
   */
  async syncAllLocations(locationConfigs) {
    if (!this.enabled) {
      console.log('Odoo sync skipped - not configured');
      return { total: 0, errors: 0 };
    }

    console.log('\n--- Phase 5: Odoo Sync ---');
    const startTime = Date.now();
    let totalSynced = 0;
    let totalErrors = 0;

    // Initialize if needed
    if (!this.odoo.authenticated) {
      const initialized = await this.initialize();
      if (!initialized) {
        return { total: 0, errors: 1, skipped: true };
      }
    }

    for (const loc of locationConfigs) {
      try {
        const result = await this.syncLocationInventory(loc.id, loc.name);
        totalSynced += result.synced || 0;
        totalErrors += result.errors || 0;
      } catch (error) {
        console.error(`Odoo sync failed for ${loc.name}: ${error.message}`);
        totalErrors++;
      }
    }

    const duration = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
    console.log(`Odoo sync complete: ${totalSynced} products, ${totalErrors} errors (${duration} min)`);

    return { total: totalSynced, errors: totalErrors };
  }
}

module.exports = OdooSyncService;
