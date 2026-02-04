/**
 * PostgreSQL to Dutchie Sync Service
 *
 * Pushes inventory updates FROM PostgreSQL TO Dutchie POS.
 * This enables Odoo-created/modified products to appear in the POS.
 *
 * Data flow: Odoo → PostgreSQL → Dutchie POS
 *
 * Only syncs products where source='odoo' or that have been modified
 * since last Dutchie sync.
 */

const DutchieClient = require('../api/dutchie');
const db = require('../db');

/**
 * Field mapping: PostgreSQL inventory → Dutchie API
 */
const fieldMapping = {
  // PostgreSQL column → Dutchie field
  'sku': 'sku',
  'product_name': 'name',
  'brand_name': 'brandName',
  'category': 'category',
  'description': 'description',
  'price': 'price',
  'unit_cost': 'unitCost',
  'quantity_available': 'quantityAvailable',
  'net_weight': 'netWeight',
  'strain': 'strain',
  'strain_type': 'strainType',
  'potency_thc_formatted': 'thcContent',
  'potency_cbd_formatted': 'cbdContent',
  'is_active': 'isActive',
};

class PostgresToDutchieSync {
  constructor(locationId, locationName, apiKey) {
    this.locationId = locationId;
    this.locationName = locationName;
    this.dutchie = new DutchieClient(null, apiKey);
    this.lastSyncKey = `postgres_to_dutchie_${locationId}_last_sync`;
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
   * Fetch products from PostgreSQL that need to be synced to Dutchie
   * - Products with source='odoo' (Odoo-created)
   * - Products modified since last Dutchie sync
   */
  async fetchProductsToSync() {
    const lastSync = await this.getLastSyncTime();

    let query = `
      SELECT
        id, inventory_id, product_id, sku, product_name, brand_name,
        category, description, price, unit_cost, quantity_available,
        net_weight, strain, strain_type, potency_thc_formatted, potency_cbd_formatted,
        is_active, source, source_external_id, source_synced_at, synced_at
      FROM inventory
      WHERE location_id = $1
        AND is_active = true
        AND (
          source = 'odoo'
          ${lastSync ? `OR synced_at > $2` : ''}
        )
      ORDER BY product_name
    `;

    const params = lastSync ? [this.locationId, lastSync] : [this.locationId];
    const result = await db.query(query, params);

    return result.rows;
  }

  /**
   * Transform PostgreSQL record to Dutchie API format
   */
  transformToDutchie(record) {
    const dutchieProduct = {};

    for (const [pgColumn, dutchieField] of Object.entries(fieldMapping)) {
      if (record[pgColumn] !== undefined && record[pgColumn] !== null) {
        dutchieProduct[dutchieField] = record[pgColumn];
      }
    }

    // Ensure required fields
    if (!dutchieProduct.sku) {
      dutchieProduct.sku = record.inventory_id || `ODOO-${record.id}`;
    }

    return dutchieProduct;
  }

  /**
   * Determine if product exists in Dutchie (has a Dutchie product_id)
   */
  isDutchieProduct(record) {
    // If product_id doesn't start with 'odoo-', it's a Dutchie product
    return record.product_id && !record.product_id.startsWith('odoo-');
  }

  /**
   * Sync a single product to Dutchie
   */
  async syncProduct(record) {
    const dutchieData = this.transformToDutchie(record);

    if (this.isDutchieProduct(record)) {
      // Update existing Dutchie product
      await this.dutchie.updateProduct(record.product_id, dutchieData);
      return { action: 'updated', productId: record.product_id };
    } else {
      // Create new product in Dutchie
      const result = await this.dutchie.createProduct(dutchieData);

      // Store the new Dutchie product ID back in PostgreSQL
      if (result && result.id) {
        await this.updateDutchieId(record.id, result.id);
      }

      return { action: 'created', productId: result?.id };
    }
  }

  /**
   * Update the Dutchie product ID in PostgreSQL after creation
   */
  async updateDutchieId(inventoryId, dutchieProductId) {
    await db.query(`
      UPDATE inventory
      SET product_id = $1
      WHERE id = $2
    `, [dutchieProductId, inventoryId]);
  }

  /**
   * Sync all pending products to Dutchie
   */
  async syncAll() {
    const startTime = Date.now();
    console.log(`\n--- PostgreSQL → Dutchie Sync (${this.locationName}) ---`);

    try {
      const products = await this.fetchProductsToSync();
      console.log(`  Found ${products.length} products to sync`);

      if (products.length === 0) {
        return { synced: 0, created: 0, updated: 0, errors: 0 };
      }

      let created = 0;
      let updated = 0;
      let errors = 0;

      // Process in batches to avoid overwhelming the API
      const batchSize = 50;
      for (let i = 0; i < products.length; i += batchSize) {
        const batch = products.slice(i, i + batchSize);

        for (const product of batch) {
          try {
            const result = await this.syncProduct(product);
            if (result.action === 'created') created++;
            else if (result.action === 'updated') updated++;
          } catch (error) {
            console.error(`    Error syncing ${product.sku}: ${error.message}`);
            errors++;
          }
        }

        // Progress update
        if ((i + batchSize) % 100 === 0 || i + batchSize >= products.length) {
          console.log(`    Progress: ${Math.min(i + batchSize, products.length)}/${products.length}`);
        }
      }

      // Update last sync time
      await this.setLastSyncTime(new Date());

      const duration = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(`  Done: ${created} created, ${updated} updated, ${errors} errors (${duration}s)`);

      return {
        synced: created + updated,
        created,
        updated,
        errors,
        duration: parseFloat(duration)
      };
    } catch (error) {
      console.error(`  Sync failed: ${error.message}`);
      return { synced: 0, created: 0, updated: 0, errors: 1, error: error.message };
    }
  }

  /**
   * Sync quantity adjustments only (faster than full sync)
   * Use when only stock levels changed
   */
  async syncQuantities() {
    console.log(`\n--- Quantity Sync → Dutchie (${this.locationName}) ---`);

    const products = await this.fetchProductsToSync();
    const dutchieProducts = products.filter(p => this.isDutchieProduct(p));

    console.log(`  Found ${dutchieProducts.length} products for quantity sync`);

    let synced = 0;
    let errors = 0;

    for (const product of dutchieProducts) {
      try {
        await this.dutchie.adjustInventory(
          product.product_id,
          product.quantity_available,
          'Sync from Odoo'
        );
        synced++;
      } catch (error) {
        console.error(`    Error adjusting ${product.sku}: ${error.message}`);
        errors++;
      }
    }

    console.log(`  Done: ${synced} adjusted, ${errors} errors`);
    return { synced, errors };
  }
}

/**
 * Sync all locations to Dutchie
 */
async function syncAllLocations(locationConfigs) {
  console.log('\n=== PostgreSQL → Dutchie Sync ===');
  const startTime = Date.now();

  let totalCreated = 0;
  let totalUpdated = 0;
  let totalErrors = 0;

  for (const loc of locationConfigs) {
    try {
      const service = new PostgresToDutchieSync(loc.id, loc.name, loc.apiKey);
      const result = await service.syncAll();

      totalCreated += result.created || 0;
      totalUpdated += result.updated || 0;
      totalErrors += result.errors || 0;
    } catch (error) {
      console.error(`Sync failed for ${loc.name}: ${error.message}`);
      totalErrors++;
    }
  }

  const duration = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
  console.log(`\nTotal: ${totalCreated} created, ${totalUpdated} updated, ${totalErrors} errors (${duration} min)`);

  return { created: totalCreated, updated: totalUpdated, errors: totalErrors };
}

module.exports = PostgresToDutchieSync;
module.exports.syncAllLocations = syncAllLocations;
