const db = require('../db');
const cache = require('../cache');

class CacheSyncService {
  // Refresh cache for a specific location
  async refreshLocationCache(locationId, locationName) {
    console.log(`  Caching data for ${locationName}...`);

    try {
      // Get inventory from Postgres (treat NULL is_active as true)
      const inventoryResult = await db.query(`
        SELECT * FROM inventory
        WHERE location_id = $1 AND (is_active = true OR is_active IS NULL)
        ORDER BY product_name
      `, [locationId]);

      // Get discounts from Postgres
      const discountsResult = await db.query(`
        SELECT * FROM discounts
        WHERE location_id = $1
          AND is_active = true
          AND (valid_until IS NULL OR valid_until > NOW())
        ORDER BY discount_name
      `, [locationId]);

      // Cache to Redis
      const inventoryCached = await cache.cacheInventory(locationId, inventoryResult.rows);
      const discountsCached = await cache.cacheDiscounts(locationId, discountsResult.rows);

      console.log(`  Cached ${inventoryCached} inventory, ${discountsCached} discounts`);

      return {
        inventory: inventoryCached,
        discounts: discountsCached,
        locationId
      };
    } catch (error) {
      console.error(`  Cache sync failed for ${locationName}:`, error.message);
      return { inventory: 0, discounts: 0, error: error.message };
    }
  }

  // Refresh cache for all locations
  async refreshAllCaches(locationConfigs) {
    console.log('\n--- Phase 4: Refreshing Redis Cache ---');
    const startTime = Date.now();

    let totalInventory = 0;
    let totalDiscounts = 0;

    // Cache locations list with tickertape from store configs
    const locationsData = locationConfigs.map(loc => ({
      id: loc.id,
      name: loc.name,
      city: loc.city,
      state: loc.state,
      slug: loc.slug,
      tickertape: loc.tickertape || null
    }));
    await cache.cacheLocations(locationsData);

    // Cache each location's data
    for (const loc of locationConfigs) {
      if (!loc.id) continue;

      const result = await this.refreshLocationCache(loc.id, loc.name);
      totalInventory += result.inventory || 0;
      totalDiscounts += result.discounts || 0;
    }

    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log(`  Cache refresh complete in ${duration}s: ${totalInventory} inventory, ${totalDiscounts} discounts`);

    return { totalInventory, totalDiscounts, duration };
  }
}

module.exports = CacheSyncService;
