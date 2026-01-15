const db = require('../db');
const DutchieClient = require('../api/dutchie');

// Map v2 API fields to database columns
// v2 API has nested structure: discount.reward.calculationMethod, etc.
const fieldMapping = {
  // Top-level discount fields
  id: 'discount_id',
  discountDescription: 'discount_name',
  discountCode: 'discount_code',
  applicationMethod: 'application_method',
  externalId: 'external_id',
  isActive: 'is_active',
  isBundledDiscount: 'is_bundled_discount',
  validDateFrom: 'valid_from',
  validDateTo: 'valid_until',
  firstTimeCustomerOnly: 'first_time_customer_only',
  canStackAutomatically: 'stack_on_other_discounts',
  onlineName: 'online_name',
  // Weekly recurrence (top-level booleans)
  monday: 'monday',
  tuesday: 'tuesday',
  wednesday: 'wednesday',
  thursday: 'thursday',
  friday: 'friday',
  saturday: 'saturday',
  sunday: 'sunday',
  startTime: 'start_time',
  endTime: 'end_time',
};

// Fields from reward object
const rewardFieldMapping = {
  calculationMethod: 'calculation_method',
  discountValue: 'discount_amount',
  thresholdType: 'threshold_type',
  thresholdMin: 'threshold_min',
  thresholdMax: 'threshold_max',
  includeNonCannabis: 'include_non_cannabis',
  applyToOnlyOneItem: 'apply_to_only_one_item',
};

// JSONB fields that need to be stringified
const jsonFields = [
  'weekly_recurrence_info',
  'products',
  'product_categories',
  'brands',
  'menu_display',
  'constraints',
];

class DiscountSyncService {
  constructor(locationId, locationName, apiKey) {
    this.locationId = locationId;
    this.locationName = locationName;
    this.dutchieClient = new DutchieClient(null, apiKey);
    this.inventoryCache = null; // Cache inventory for product lookups
  }

  /**
   * Load inventory data for product enrichment lookups
   * Creates a map of product_id -> product details
   */
  async loadInventoryCache() {
    if (this.inventoryCache) return this.inventoryCache;

    const result = await db.query(`
      SELECT product_id, product_name, brand_name, category, image_url, unit_price
      FROM inventory
      WHERE location_id = $1 AND is_active = true
    `, [this.locationId]);

    this.inventoryCache = new Map();
    for (const row of result.rows) {
      this.inventoryCache.set(row.product_id, {
        product_name: row.product_name,
        brand_name: row.brand_name,
        category: row.category,
        image_url: row.image_url,
        unit_price: row.unit_price
      });
    }

    return this.inventoryCache;
  }

  /**
   * Enrich discount with product details from inventory
   * For discounts with specific product restrictions, populate product fields
   */
  async enrichWithProductData(transformed, restrictions) {
    if (!restrictions?.Product) return transformed;

    const productRestriction = restrictions.Product;
    const productIds = productRestriction.restrictionIds || [];
    const isExclusion = productRestriction.isExclusion || false;

    // Only enrich if this is an inclusion (not exclusion) with specific products
    if (isExclusion || productIds.length === 0) return transformed;

    await this.loadInventoryCache();

    // Collect details for all applicable products
    const productDetails = [];
    for (const productId of productIds) {
      const product = this.inventoryCache.get(String(productId));
      if (product) {
        productDetails.push({
          product_id: productId,
          ...product
        });
      }
    }

    if (productDetails.length > 0) {
      // Set primary product fields from first matching product
      const primary = productDetails[0];
      transformed.product_name = primary.product_name;
      transformed.brand_name = primary.brand_name;
      transformed.category = primary.category;
      transformed.image_url = primary.image_url;
      transformed.unit_price = primary.unit_price;

      // Store all product details as JSONB
      transformed.product_details = JSON.stringify(productDetails);
    }

    return transformed;
  }

  /**
   * Transform v2 API discount item to database format
   */
  transformItem(item) {
    const transformed = {};

    // Map top-level fields
    for (const [apiField, dbColumn] of Object.entries(fieldMapping)) {
      if (item[apiField] !== undefined) {
        transformed[dbColumn] = item[apiField];
      }
    }

    // Map reward fields (nested under item.reward)
    if (item.reward) {
      for (const [apiField, dbColumn] of Object.entries(rewardFieldMapping)) {
        if (item.reward[apiField] !== undefined) {
          transformed[dbColumn] = item.reward[apiField];
        }
      }

      // Extract product restrictions from reward.restrictions
      if (item.reward.restrictions) {
        const restrictions = item.reward.restrictions;

        // Products restriction
        if (restrictions.Product) {
          transformed.products = JSON.stringify({
            ids: restrictions.Product.restrictionIds || [],
            isExclusion: restrictions.Product.isExclusion || false
          });
        }

        // Brands restriction
        if (restrictions.Brand) {
          transformed.brands = JSON.stringify({
            ids: restrictions.Brand.restrictionIds || [],
            isExclusion: restrictions.Brand.isExclusion || false
          });
        }

        // Category restriction
        if (restrictions.Category) {
          transformed.product_categories = JSON.stringify({
            ids: restrictions.Category.restrictionIds || [],
            isExclusion: restrictions.Category.isExclusion || false
          });
        }
      }
    }

    // Store constraints as JSONB
    if (item.constraints && item.constraints.length > 0) {
      transformed.constraints = JSON.stringify(item.constraints);
    }

    // Store menu display info
    if (item.menuDisplay) {
      transformed.menu_display = JSON.stringify(item.menuDisplay);
      // Also extract display name if available
      if (item.menuDisplay.menuDisplayName) {
        transformed.menu_display_name = item.menuDisplay.menuDisplayName;
      }
      if (item.menuDisplay.menuDisplayImageUrl) {
        transformed.menu_display_image_url = item.menuDisplay.menuDisplayImageUrl;
      }
    }

    // Build weekly recurrence info object
    const weeklyInfo = {};
    ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'].forEach(day => {
      if (item[day] !== undefined) weeklyInfo[day] = item[day];
    });
    if (item.startTime) weeklyInfo.startTime = item.startTime;
    if (item.endTime) weeklyInfo.endTime = item.endTime;
    if (Object.keys(weeklyInfo).length > 0) {
      transformed.weekly_recurrence_info = JSON.stringify(weeklyInfo);
    }

    // Add location_id
    transformed.location_id = this.locationId;

    // Generate unique id: locationId_discountId
    if (transformed.discount_id) {
      transformed.id = `${this.locationId}_${transformed.discount_id}`;
    }

    // Set is_available_online based on applicationMethod
    transformed.is_available_online = item.applicationMethod === 'Automatic' ||
                                       item.applicationMethod === 'Code';

    return transformed;
  }

  buildUpsertQuery(item) {
    const columns = Object.keys(item);
    const values = Object.values(item);
    const placeholders = values.map((_, i) => `$${i + 1}`);

    const updateClauses = columns
      .filter(col => col !== 'id' && col !== 'location_id' && col !== 'discount_id')
      .map(col => `${col} = EXCLUDED.${col}`);

    updateClauses.push('synced_at = CURRENT_TIMESTAMP');

    const query = `
      INSERT INTO discounts (${columns.join(', ')})
      VALUES (${placeholders.join(', ')})
      ON CONFLICT (id) DO UPDATE SET
        ${updateClauses.join(',\n        ')}
    `;

    return { query, values };
  }

  async syncDiscounts() {
    const startTime = Date.now();
    console.log(`Starting discount sync (v2 API) for ${this.locationName}...`);

    try {
      // Use v2 API with includeInclusionExclusionData
      const discountsData = await this.dutchieClient.getDiscountsV2();

      if (!discountsData || !Array.isArray(discountsData)) {
        console.log('  No discounts data received');
        return { synced: 0, errors: 0, locationId: this.locationId };
      }

      let synced = 0;
      let errors = 0;
      let skipped = 0;

      for (const item of discountsData) {
        try {
          // Skip inactive discounts
          if (!item.isActive) {
            skipped++;
            continue;
          }

          let transformed = this.transformItem(item);

          if (!transformed.id) {
            console.warn('  Skipping discount without discount_id');
            errors++;
            continue;
          }

          // Enrich with product data from inventory
          if (item.reward?.restrictions) {
            transformed = await this.enrichWithProductData(transformed, item.reward.restrictions);
          }

          const { query, values } = this.buildUpsertQuery(transformed);
          await db.query(query, values);
          synced++;
        } catch (error) {
          console.error(`  Error syncing discount ${item.id}:`, error.message);
          errors++;
        }
      }

      const duration = ((Date.now() - startTime) / 1000).toFixed(2);
      console.log(`  Discount sync complete in ${duration}s: ${synced} synced, ${skipped} skipped (inactive), ${errors} errors`);

      return { synced, skipped, errors, duration, locationId: this.locationId };
    } catch (error) {
      console.error(`  Discount sync failed for ${this.locationName}:`, error.message);
      return { synced: 0, errors: 1, locationId: this.locationId };
    }
  }
}

module.exports = DiscountSyncService;
