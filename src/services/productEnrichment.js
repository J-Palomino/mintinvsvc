const db = require('../db');
const DutchiePlusClient = require('../api/dutchiePlus');

class ProductEnrichmentService {
  constructor(locationId, locationName) {
    this.locationId = locationId; // DutchieStoreID - used as both location_id and retailerId
    this.locationName = locationName;
    this.plusClient = new DutchiePlusClient();
  }

  async enrichProducts() {
    const startTime = Date.now();
    console.log(`Starting product enrichment for ${this.locationName}...`);

    if (!this.locationId) {
      console.log(`  Skipping - no location ID configured`);
      return { enriched: 0, errors: 0, skipped: true };
    }

    try {
      const products = await this.plusClient.getMenuProducts(this.locationId);

      if (!products || products.length === 0) {
        console.log('  No products received from menu');
        return { enriched: 0, errors: 0, locationId: this.locationId };
      }

      let enriched = 0;
      let errors = 0;
      let notFound = 0;

      for (const product of products) {
        try {
          // Use posMetaData.sku to match with inventory sku field
          const posSku = product.posMetaData?.sku;
          if (!posSku) {
            continue;
          }

          // Update inventory records matching this SKU and location
          const result = await db.query(`
            UPDATE inventory SET
              slug = $1,
              effects = $2,
              tags = $3,
              images = $4,
              staff_pick = $5,
              potency_cbd_formatted = $6,
              potency_thc_formatted = $7,
              description = COALESCE(NULLIF($8, ''), description),
              description_html = COALESCE(NULLIF($9, ''), description_html),
              synced_at = CURRENT_TIMESTAMP
            WHERE location_id = $10
              AND sku = $11
          `, [
            product.slug,
            JSON.stringify(product.effects || []),
            JSON.stringify(product.tags || []),
            JSON.stringify(product.images || []),
            product.staffPick || false,
            product.potencyCbd?.formatted || null,
            product.potencyThc?.formatted || null,
            product.description || '',
            product.descriptionHtml || '',
            this.locationId,
            posSku
          ]);

          if (result.rowCount > 0) {
            enriched += result.rowCount;
          } else {
            notFound++;
          }
        } catch (error) {
          console.error(`  Error enriching SKU ${product.posMetaData?.sku}:`, error.message);
          errors++;
        }
      }

      const duration = ((Date.now() - startTime) / 1000).toFixed(2);
      console.log(`  Enrichment complete in ${duration}s: ${enriched} updated, ${notFound} not found, ${errors} errors`);

      return { enriched, errors, notFound, duration, locationId: this.locationId };
    } catch (error) {
      console.error(`  Enrichment failed for ${this.locationName}:`, error.message);
      return { enriched: 0, errors: 1, locationId: this.locationId };
    }
  }
}

module.exports = ProductEnrichmentService;
