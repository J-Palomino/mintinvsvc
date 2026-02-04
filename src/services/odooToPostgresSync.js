/**
 * Odoo to PostgreSQL Sync Service
 *
 * Syncs inventory data FROM Odoo TO PostgreSQL.
 * This enables Odoo to be the inventory master.
 *
 * Data flow: Odoo → PostgreSQL → Redis cache → API
 */

const OdooClient = require('../api/odoo');
const db = require('../db');

/**
 * Field mapping: Odoo product.product → PostgreSQL inventory
 */
const fieldMapping = {
  // Odoo field → PostgreSQL column
  'id': 'source_external_id',           // Stored as 'odoo:product.product:{id}'
  'default_code': 'sku',
  'name': 'product_name',
  'list_price': 'price',
  'standard_price': 'unit_cost',
  'barcode': 'barcode',
  'weight': 'net_weight',
  'description_sale': 'description',
  'qty_available': 'quantity_available',
  'categ_id': '_category_id',           // Needs lookup
  'image_1920': 'image_url',            // Base64 or URL
};

class OdooToPostgresSync {
  constructor() {
    this.odoo = new OdooClient();
    this.enabled = !!(process.env.ODOO_URL && process.env.ODOO_USERNAME && process.env.ODOO_API_KEY);
    this.lastSyncKey = 'odoo_to_postgres_last_sync';

    // Cache for lookups
    this.categoryCache = new Map();
    this.warehouseToLocationMap = new Map(); // Odoo warehouse → our location_id
  }

  isEnabled() {
    return this.enabled;
  }

  async initialize() {
    if (!this.enabled) {
      console.log('Odoo→Postgres sync disabled - missing credentials');
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

  async loadCaches() {
    // Load category mappings
    try {
      const categories = await this.odoo.searchRead('product.category', [], ['id', 'name', 'complete_name']);
      for (const cat of categories || []) {
        this.categoryCache.set(cat.id, cat.name);
      }
      console.log(`  Loaded ${this.categoryCache.size} Odoo categories`);
    } catch (e) {
      console.log('  Could not load category cache:', e.message);
    }

    // Load warehouse → location mappings
    try {
      const warehouses = await this.odoo.searchRead('stock.warehouse', [], ['id', 'name', 'code']);

      // Match warehouses to our locations by name
      const locations = await db.query('SELECT id, name FROM locations');
      const locationMap = new Map();
      for (const loc of locations.rows) {
        locationMap.set(loc.name.toLowerCase(), loc.id);
      }

      for (const wh of warehouses || []) {
        const locationId = locationMap.get(wh.name.toLowerCase());
        if (locationId) {
          this.warehouseToLocationMap.set(wh.id, locationId);
          console.log(`  Mapped warehouse "${wh.name}" → location ${locationId}`);
        }
      }
    } catch (e) {
      console.log('  Could not load warehouse mappings:', e.message);
    }
  }

  /**
   * Get last sync timestamp from database
   */
  async getLastSyncTime() {
    try {
      const result = await db.query(
        `SELECT value FROM sync_metadata WHERE key = $1`,
        [this.lastSyncKey]
      );
      if (result.rows.length > 0) {
        return new Date(result.rows[0].value);
      }
    } catch (e) {
      // Table might not exist yet
    }
    return null;
  }

  /**
   * Save last sync timestamp
   */
  async setLastSyncTime(timestamp) {
    await db.query(`
      INSERT INTO sync_metadata (key, value, updated_at)
      VALUES ($1, $2, CURRENT_TIMESTAMP)
      ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = CURRENT_TIMESTAMP
    `, [this.lastSyncKey, timestamp.toISOString()]);
  }

  /**
   * Fetch products from Odoo modified since last sync
   */
  async fetchOdooProducts(since = null) {
    const domain = [['active', '=', true]];

    if (since) {
      // Odoo datetime format: 'YYYY-MM-DD HH:MM:SS'
      const sinceStr = since.toISOString().replace('T', ' ').substring(0, 19);
      domain.push(['write_date', '>', sinceStr]);
    }

    const fields = [
      'id', 'default_code', 'name', 'list_price', 'standard_price',
      'barcode', 'weight', 'description_sale', 'qty_available',
      'categ_id', 'active', 'write_date', 'product_tmpl_id',
    ];

    console.log(`  Fetching Odoo products${since ? ` modified since ${since.toISOString()}` : ''}...`);
    const products = await this.odoo.searchRead('product.product', domain, fields);
    console.log(`  Found ${products?.length || 0} products`);

    return products || [];
  }

  /**
   * Fetch stock quantities per warehouse
   */
  async fetchStockQuantities(productIds) {
    if (!productIds || productIds.length === 0) return new Map();

    const quants = await this.odoo.searchRead(
      'stock.quant',
      [
        ['product_id', 'in', productIds],
        ['location_id.usage', '=', 'internal'],
      ],
      ['product_id', 'location_id', 'quantity', 'warehouse_id']
    );

    // Group by product_id and warehouse
    const stockMap = new Map(); // "productId:warehouseId" → quantity
    for (const q of quants || []) {
      const productId = q.product_id[0];
      const warehouseId = q.warehouse_id?.[0];
      if (warehouseId) {
        const key = `${productId}:${warehouseId}`;
        stockMap.set(key, (stockMap.get(key) || 0) + q.quantity);
      }
    }

    return stockMap;
  }

  /**
   * Transform Odoo product to PostgreSQL inventory record
   */
  transformProduct(odooProduct, locationId, quantity) {
    const transformed = {
      source: 'odoo',
      source_synced_at: new Date().toISOString(),
      source_external_id: `odoo:product.product:${odooProduct.id}`,
      location_id: locationId,
      sku: odooProduct.default_code || `ODOO-${odooProduct.id}`,
      product_name: odooProduct.name,
      price: odooProduct.list_price || 0,
      unit_cost: odooProduct.standard_price || 0,
      net_weight: odooProduct.weight || null,
      description: odooProduct.description_sale || null,
      quantity_available: quantity || 0,
      is_active: odooProduct.active !== false,
    };

    // Map category
    if (odooProduct.categ_id) {
      const categoryId = Array.isArray(odooProduct.categ_id)
        ? odooProduct.categ_id[0]
        : odooProduct.categ_id;
      transformed.category = this.categoryCache.get(categoryId) || 'Uncategorized';
    }

    // Generate composite ID
    transformed.inventory_id = `odoo-${odooProduct.id}`;
    transformed.id = `${locationId}_${transformed.inventory_id}`;
    transformed.product_id = `odoo-tmpl-${odooProduct.product_tmpl_id?.[0] || odooProduct.id}`;

    return transformed;
  }

  /**
   * Upsert inventory record to PostgreSQL
   */
  async upsertInventory(record) {
    const columns = Object.keys(record);
    const values = Object.values(record);
    const placeholders = values.map((_, i) => `$${i + 1}`);

    const updateClauses = columns
      .filter(col => col !== 'id' && col !== 'location_id')
      .map(col => `${col} = EXCLUDED.${col}`);
    updateClauses.push('synced_at = CURRENT_TIMESTAMP');

    const query = `
      INSERT INTO inventory (${columns.join(', ')})
      VALUES (${placeholders.join(', ')})
      ON CONFLICT (id) DO UPDATE SET
        ${updateClauses.join(',\n        ')}
    `;

    await db.query(query, values);
  }

  /**
   * Sync products from Odoo to PostgreSQL for a specific warehouse/location
   *
   * Note: Since Odoo doesn't have stock.quant records (simplified inventory),
   * we sync ALL products with qty_available > 0 to each mapped location.
   * This is a temporary approach until warehouse-specific inventory is set up.
   */
  async syncWarehouse(warehouseId, locationId) {
    const startTime = Date.now();
    console.log(`  Syncing Odoo warehouse ${warehouseId} → location ${locationId}...`);

    try {
      // Get warehouse info for logging
      const warehouses = await this.odoo.read('stock.warehouse', [warehouseId], ['name']);
      const warehouseName = warehouses?.[0]?.name || `Warehouse ${warehouseId}`;
      console.log(`    Warehouse: ${warehouseName}`);

      // Query products directly with qty_available > 0
      // (stock.quant is empty in this Odoo instance)
      const products = await this.odoo.searchRead(
        'product.product',
        [
          ['qty_available', '>', 0],
          ['active', '=', true],
        ],
        ['id', 'default_code', 'name', 'list_price', 'standard_price',
         'barcode', 'weight', 'description_sale', 'qty_available',
         'categ_id', 'active', 'product_tmpl_id']
      );

      if (!products || products.length === 0) {
        console.log('    No products with stock found');
        return { synced: 0, errors: 0 };
      }

      console.log(`    Found ${products.length} products with stock`);

      let synced = 0;
      let errors = 0;

      for (const product of products) {
        try {
          const record = this.transformProduct(product, locationId, product.qty_available);
          await this.upsertInventory(record);
          synced++;
        } catch (e) {
          console.error(`    Error syncing product ${product.id}: ${e.message}`);
          errors++;
        }
      }

      const duration = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(`    Done: ${synced} synced, ${errors} errors (${duration}s)`);

      return { synced, errors };
    } catch (error) {
      console.error(`  Warehouse sync failed: ${error.message}`);
      return { synced: 0, errors: 1, error: error.message };
    }
  }

  /**
   * Sync all mapped warehouses
   *
   * Note: Since stock.quant is empty, we use a simplified approach:
   * - Sync all Odoo products to the FIRST mapped location only
   * - This avoids duplicate products across all locations
   * - Once Odoo has proper stock.quant records, switch to per-warehouse sync
   */
  async syncAll() {
    if (!this.enabled) {
      console.log('Odoo→Postgres sync skipped - not configured');
      return { total: 0, errors: 0 };
    }

    console.log('\n--- Odoo → PostgreSQL Sync ---');
    const startTime = Date.now();

    if (!this.odoo.authenticated) {
      const ok = await this.initialize();
      if (!ok) return { total: 0, errors: 1, skipped: true };
    }

    // Simplified mode: sync to first location only (no stock.quant data)
    const mappings = [...this.warehouseToLocationMap.entries()];
    if (mappings.length === 0) {
      console.log('  No warehouse→location mappings found');
      return { total: 0, errors: 0 };
    }

    // Use first mapping only to avoid duplicates
    const [warehouseId, locationId] = mappings[0];
    console.log(`  Simplified mode: syncing to first location only (${mappings.length} mappings available)`);

    let totalSynced = 0;
    let totalErrors = 0;

    try {
      const result = await this.syncWarehouse(warehouseId, locationId);
      totalSynced += result.synced || 0;
      totalErrors += result.errors || 0;
    } catch (error) {
      console.error(`Sync failed: ${error.message}`);
      totalErrors++;
    }

    // Update last sync time
    await this.setLastSyncTime(new Date());

    const duration = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
    console.log(`Odoo→Postgres sync complete: ${totalSynced} products, ${totalErrors} errors (${duration} min)`);

    return { total: totalSynced, errors: totalErrors };
  }

  /**
   * Sync a single product by Odoo ID (for webhooks/real-time updates)
   */
  async syncProduct(odooProductId, locationId) {
    if (!this.odoo.authenticated) {
      await this.initialize();
    }

    const products = await this.odoo.searchRead(
      'product.product',
      [['id', '=', odooProductId]],
      ['id', 'default_code', 'name', 'list_price', 'standard_price',
       'barcode', 'weight', 'description_sale', 'qty_available',
       'categ_id', 'active', 'product_tmpl_id']
    );

    if (!products || products.length === 0) {
      throw new Error(`Product ${odooProductId} not found in Odoo`);
    }

    const product = products[0];
    const record = this.transformProduct(product, locationId, product.qty_available);
    await this.upsertInventory(record);

    return record;
  }
}

module.exports = OdooToPostgresSync;
