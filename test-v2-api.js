/**
 * Test script for v2 discounts API
 * Tests the new getDiscountsV2() method with eligibility data
 */

require('dotenv').config();
const DutchieClient = require('./src/api/dutchie');

const API_KEY = process.env.DUTCHIE_API_KEY || 'b0d5458684d24f48bb4c927be754a855';

async function testV2Api() {
  console.log('Testing Dutchie v2 Discounts API...\n');

  const client = new DutchieClient(process.env.DUTCHIE_API_URL, API_KEY);

  try {
    const discounts = await client.getDiscountsV2();

    console.log(`\n=== RESULTS ===`);
    console.log(`Total discounts: ${discounts.length}\n`);

    // Find discounts with eligibility rules
    const withThreshold = discounts.filter(d => d.reward?.thresholdMin > 1);
    const withRestrictions = discounts.filter(d => {
      const r = d.reward?.restrictions;
      return r && (r.Product || r.Brand || r.Category);
    });

    console.log(`Discounts with threshold (bundle deals): ${withThreshold.length}`);
    console.log(`Discounts with product restrictions: ${withRestrictions.length}\n`);

    // Show first 3 discounts with eligibility data
    console.log('=== SAMPLE DISCOUNTS WITH ELIGIBILITY DATA ===\n');

    const samples = withThreshold.slice(0, 3);
    samples.forEach((d, i) => {
      console.log(`--- ${i + 1}. ${d.onlineName || d.discountDescription} ---`);
      console.log(`  ID: ${d.id}`);
      console.log(`  Calculation Method: ${d.reward?.calculationMethod}`);
      console.log(`  Discount Value: ${d.reward?.discountValue}`);
      console.log(`  Threshold Type: ${d.reward?.thresholdType}`);
      console.log(`  Threshold Min: ${d.reward?.thresholdMin}`);
      console.log(`  Is Bundled: ${d.isBundledDiscount}`);

      if (d.reward?.restrictions) {
        const r = d.reward.restrictions;
        if (r.Product) {
          console.log(`  Product IDs: ${r.Product.restrictionIds?.length || 0} products (isExclusion: ${r.Product.isExclusion})`);
        }
        if (r.Brand) {
          console.log(`  Brand IDs: ${r.Brand.restrictionIds?.join(', ')}`);
        }
      }
      console.log('');
    });

    // Show calculation method breakdown
    console.log('=== CALCULATION METHODS ===');
    const methods = {};
    discounts.forEach(d => {
      const method = d.reward?.calculationMethod || 'UNKNOWN';
      methods[method] = (methods[method] || 0) + 1;
    });
    Object.entries(methods).sort((a, b) => b[1] - a[1]).forEach(([method, count]) => {
      console.log(`  ${method}: ${count}`);
    });

  } catch (error) {
    console.error('Error:', error.message);
    if (error.response) {
      console.error('Response:', error.response.data);
    }
  }
}

testV2Api();
