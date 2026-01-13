const db = require('../db');
const DutchieClient = require('../api/dutchie');

// Map API fields (camelCase) to database columns (snake_case)
const fieldMapping = {
  productId: 'product_id',
  inventoryId: 'inventory_id',
  id: 'id',
  sku: 'sku',
  internalName: 'internal_name',
  productName: 'product_name',
  name: 'name',
  description: 'description',
  descriptionHtml: 'description_html',
  masterCategory: 'master_category',
  categoryId: 'category_id',
  category: 'category',
  imageUrl: 'image_url',
  imageUrls: 'image_urls',
  images: 'images',
  strainId: 'strain_id',
  strain: 'strain',
  strainType: 'strain_type',
  size: 'size',
  netWeight: 'net_weight',
  netWeightUnitId: 'net_weight_unit_id',
  netWeightUnit: 'net_weight_unit',
  unitWeight: 'unit_weight',
  unitWeightUnit: 'unit_weight_unit',
  brandId: 'brand_id',
  brandName: 'brand_name',
  vendorId: 'vendor_id',
  vendorName: 'vendor_name',
  vendor: 'vendor',
  producerId: 'producer_id',
  producerName: 'producer_name',
  producer: 'producer',
  isCannabis: 'is_cannabis',
  isActive: 'is_active',
  isCoupon: 'is_coupon',
  isMedicalOnly: 'is_medical_only',
  medicalOnly: 'medical_only',
  isTestProduct: 'is_test_product',
  isFinished: 'is_finished',
  isTaxable: 'is_taxable',
  onlineProduct: 'online_product',
  onlineAvailable: 'online_available',
  posProducts: 'pos_products',
  tags: 'tags',
  effects: 'effects',
  pricingTier: 'pricing_tier',
  pricingTierName: 'pricing_tier_name',
  pricingTierDescription: 'pricing_tier_description',
  price: 'price',
  medPrice: 'med_price',
  recPrice: 'rec_price',
  unitCost: 'unit_cost',
  unitPrice: 'unit_price',
  medUnitPrice: 'med_unit_price',
  recUnitPrice: 'rec_unit_price',
  unitType: 'unit_type',
  onlineTitle: 'online_title',
  onlineDescription: 'online_description',
  lowInventoryThreshold: 'low_inventory_threshold',
  maxPurchaseablePerTransaction: 'max_purchaseable_per_transaction',
  alternateName: 'alternate_name',
  flavor: 'flavor',
  lineageName: 'lineage_name',
  distillationName: 'distillation_name',
  dosage: 'dosage',
  instructions: 'instructions',
  allergens: 'allergens',
  standardAllergens: 'standard_allergens',
  defaultUnit: 'default_unit',
  createdDate: 'created_date',
  lastModifiedDateUTC: 'last_modified_date_utc',
  lastModifiedDateUtc: 'last_modified_date_utc',
  grossWeight: 'gross_weight',
  taxCategories: 'tax_categories',
  upc: 'upc',
  regulatoryCategory: 'regulatory_category',
  ndc: 'ndc',
  daysSupply: 'days_supply',
  illinoisTaxCategory: 'illinois_tax_category',
  externalCategory: 'external_category',
  externalId: 'external_id',
  syncExternally: 'sync_externally',
  regulatoryName: 'regulatory_name',
  administrationMethod: 'administration_method',
  unitCBDContentDose: 'unit_cbd_content_dose',
  unitTHCContentDose: 'unit_thc_content_dose',
  oilVolume: 'oil_volume',
  ingredientList: 'ingredient_list',
  expirationDays: 'expiration_days',
  abbreviation: 'abbreviation',
  allowAutomaticDiscounts: 'allow_automatic_discounts',
  servingSize: 'serving_size',
  servingSizePerUnit: 'serving_size_per_unit',
  isNutrient: 'is_nutrient',
  approvalDateUTC: 'approval_date_utc',
  ecomCategory: 'ecom_category',
  ecomSubcategory: 'ecom_subcategory',
  customMetadata: 'custom_metadata',
  allocatedQuantity: 'allocated_quantity',
  quantityAvailable: 'quantity_available',
  quantityUnits: 'quantity_units',
  flowerEquivalent: 'flower_equivalent',
  recFlowerEquivalent: 'rec_flower_equivalent',
  flowerEquivalentUnits: 'flower_equivalent_units',
  batchId: 'batch_id',
  batchName: 'batch_name',
  productBatchId: 'product_batch_id',
  packageId: 'package_id',
  packageStatus: 'package_status',
  externalPackageId: 'external_package_id',
  packageNDC: 'package_ndc',
  labResults: 'lab_results',
  labTestStatus: 'lab_test_status',
  testedDate: 'tested_date',
  sampleDate: 'sample_date',
  packagedDate: 'packaged_date',
  manufacturingDate: 'manufacturing_date',
  expirationDate: 'expiration_date',
  roomQuantities: 'room_quantities',
  lineage: 'lineage',
  potencyIndicator: 'potency_indicator',
  effectivePotencyMg: 'effective_potency_mg',
  labResultUrl: 'lab_result_url',
  potencyCbdFormatted: 'potency_cbd_formatted',
  potencyThcFormatted: 'potency_thc_formatted',
  slug: 'slug',
  staffPick: 'staff_pick',
  broadcastedResponses: 'broadcasted_responses'
};

// JSONB fields that need to be stringified
const jsonFields = [
  'image_urls', 'images', 'vendor', 'producer', 'pos_products', 'tags',
  'effects', 'standard_allergens', 'tax_categories', 'custom_metadata',
  'lab_results', 'room_quantities', 'lineage', 'broadcasted_responses'
];

class InventorySyncService {
  constructor(locationId, locationName, apiKey) {
    this.locationId = locationId || process.env.DUTCHIE_LOCATION_ID;
    this.locationName = locationName || process.env.DUTCHIE_LOCATION_NAME;
    this.dutchieClient = new DutchieClient(null, apiKey);
  }

  transformItem(item) {
    const transformed = {};

    for (const [apiField, dbColumn] of Object.entries(fieldMapping)) {
      if (item[apiField] !== undefined) {
        let value = item[apiField];

        // Handle JSONB fields
        if (jsonFields.includes(dbColumn) && value !== null) {
          value = JSON.stringify(value);
        }

        transformed[dbColumn] = value;
      }
    }

    // Add location_id
    transformed.location_id = this.locationId;

    // Default is_active to true if not provided (Dutchie API doesn't always return this)
    if (transformed.is_active === undefined || transformed.is_active === null) {
      transformed.is_active = true;
    }

    // Generate unique id: locationId_inventoryId
    if (transformed.inventory_id) {
      transformed.id = `${this.locationId}_${transformed.inventory_id}`;
    }

    return transformed;
  }

  buildUpsertQuery(item) {
    const columns = Object.keys(item);
    const values = Object.values(item);
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

    return { query, values };
  }

  async ensureLocation() {
    if (!this.locationId) {
      throw new Error('Location ID is required');
    }

    const query = `
      INSERT INTO locations (id, name)
      VALUES ($1, $2)
      ON CONFLICT (id) DO UPDATE SET name = $2
    `;

    await db.query(query, [this.locationId, this.locationName || this.locationId]);
    console.log(`Location registered: ${this.locationId} (${this.locationName || 'unnamed'})`);
  }

  async syncInventory() {
    const startTime = Date.now();
    console.log(`Starting inventory sync for location: ${this.locationId}...`);

    try {
      // Ensure location exists in database
      await this.ensureLocation();

      const inventoryData = await this.dutchieClient.getInventoryReport();

      if (!inventoryData || !Array.isArray(inventoryData)) {
        console.log('No inventory data received');
        return { synced: 0, errors: 0, locationId: this.locationId };
      }

      let synced = 0;
      let errors = 0;

      for (const item of inventoryData) {
        try {
          const transformed = this.transformItem(item);

          if (!transformed.id) {
            console.warn('Skipping item without inventory_id');
            errors++;
            continue;
          }

          const { query, values } = this.buildUpsertQuery(transformed);
          await db.query(query, values);
          synced++;
        } catch (error) {
          console.error('Error syncing item:', item.inventoryId || 'unknown', error.message);
          errors++;
        }
      }

      const duration = ((Date.now() - startTime) / 1000).toFixed(2);
      console.log(`Location ${this.locationId} sync completed in ${duration}s: ${synced} synced, ${errors} errors`);

      return { synced, errors, duration, locationId: this.locationId };
    } catch (error) {
      console.error(`Inventory sync failed for location ${this.locationId}:`, error);
      throw error;
    }
  }
}

module.exports = InventorySyncService;
