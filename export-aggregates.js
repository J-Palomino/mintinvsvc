/**
 * Export aggregated sales by category and location
 * Format: Accounting journal entry style
 */

const axios = require('axios');
const fs = require('fs');
const path = require('path');

const STORES_API_URL = process.env.STORES_API_URL || 'https://mintdealsbackend-production.up.railway.app/api/stores';
const DUTCHIE_API_URL = process.env.DUTCHIE_API_URL || 'https://api.pos.dutchie.com';

// Single day: January 13, 2026
const FROM_DATE = '2026-01-13T00:00:00Z';
const TO_DATE = '2026-01-13T23:59:59Z';
const REPORT_DATE = '2026-01-13';

const OUTPUT_DIR = './exports';

function escapeCSV(value) {
  if (value === null || value === undefined) return '';
  const str = String(value);
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

const HEADERS = [
  'Branch',
  'Account',
  'Description',
  'Subaccount',
  'Ref. Number',
  'Quantity',
  'UOM',
  'Debit Amount',
  'Credit Amount',
  'Transaction Description',
  'Customer/Vendor'
].join(',');

async function fetchTransactions(client, storeName, attempt = 1) {
  const params = {
    FromDateUTC: FROM_DATE,
    ToDateUTC: TO_DATE,
    IncludeDetail: true,
    IncludeTaxes: true,
    IncludeOrderIds: true
  };

  try {
    const response = await client.get('/reporting/transactions', { params, timeout: 180000 });
    return { success: true, data: response.data || [] };
  } catch (error) {
    const errorMsg = error.response?.status || error.message;
    if (attempt === 1) {
      console.log(`FAILED (${errorMsg}) - retrying...`);
      await new Promise(r => setTimeout(r, 2000));
      return fetchTransactions(client, storeName, 2);
    }
    return { success: false, error: errorMsg };
  }
}

function aggregateByCategory(transactions, storeName) {
  const aggregates = {};

  for (const t of transactions) {
    if (t.isVoid || !t.items) continue;

    for (const item of t.items) {
      // Use category as the key, fallback to 'Uncategorized'
      const category = item.category || 'Uncategorized';

      if (!aggregates[category]) {
        aggregates[category] = {
          quantity: 0,
          salesAmount: 0,
          costAmount: 0,
          discountAmount: 0,
          taxAmount: 0,
          returnQuantity: 0,
          returnAmount: 0
        };
      }

      if (item.isReturned || t.isReturn) {
        aggregates[category].returnQuantity += item.quantity || 0;
        aggregates[category].returnAmount += item.totalPrice || 0;
      } else {
        aggregates[category].quantity += item.quantity || 0;
        aggregates[category].salesAmount += item.totalPrice || 0;
        aggregates[category].costAmount += (item.unitCost || 0) * (item.quantity || 0);
        aggregates[category].discountAmount += item.totalDiscount || 0;

        // Sum taxes
        if (item.taxes) {
          for (const tax of item.taxes) {
            aggregates[category].taxAmount += tax.amount || 0;
          }
        }
      }
    }
  }

  return aggregates;
}

function generateRows(storeName, aggregates, refNumber) {
  const rows = [];

  for (const [category, data] of Object.entries(aggregates).sort()) {
    // Sales row (Debit to Cash/AR, Credit to Revenue)
    if (data.salesAmount > 0) {
      rows.push([
        storeName,                                    // Branch
        'Sales Revenue',                              // Account
        category,                                     // Description
        '',                                           // Subaccount
        refNumber,                                    // Ref. Number
        data.quantity,                                // Quantity
        'EA',                                         // UOM
        '',                                           // Debit Amount (blank for revenue)
        data.salesAmount.toFixed(2),                  // Credit Amount
        `${category} Sales - ${REPORT_DATE}`,         // Transaction Description
        'Various'                                     // Customer/Vendor
      ].map(escapeCSV).join(','));
    }

    // Returns row (if any)
    if (data.returnAmount > 0) {
      rows.push([
        storeName,                                    // Branch
        'Sales Returns',                              // Account
        category,                                     // Description
        '',                                           // Subaccount
        refNumber,                                    // Ref. Number
        data.returnQuantity,                          // Quantity
        'EA',                                         // UOM
        data.returnAmount.toFixed(2),                 // Debit Amount (returns reduce revenue)
        '',                                           // Credit Amount
        `${category} Returns - ${REPORT_DATE}`,       // Transaction Description
        'Various'                                     // Customer/Vendor
      ].map(escapeCSV).join(','));
    }

    // Tax collected row
    if (data.taxAmount > 0) {
      rows.push([
        storeName,                                    // Branch
        'Sales Tax Payable',                          // Account
        category,                                     // Description
        '',                                           // Subaccount
        refNumber,                                    // Ref. Number
        '',                                           // Quantity
        '',                                           // UOM
        '',                                           // Debit Amount
        data.taxAmount.toFixed(2),                    // Credit Amount
        `${category} Tax Collected - ${REPORT_DATE}`, // Transaction Description
        'State Tax Authority'                         // Customer/Vendor
      ].map(escapeCSV).join(','));
    }

    // Discounts row
    if (data.discountAmount > 0) {
      rows.push([
        storeName,                                    // Branch
        'Sales Discounts',                            // Account
        category,                                     // Description
        '',                                           // Subaccount
        refNumber,                                    // Ref. Number
        '',                                           // Quantity
        '',                                           // UOM
        data.discountAmount.toFixed(2),               // Debit Amount (contra-revenue)
        '',                                           // Credit Amount
        `${category} Discounts - ${REPORT_DATE}`,     // Transaction Description
        'Various'                                     // Customer/Vendor
      ].map(escapeCSV).join(','));
    }
  }

  return rows;
}

async function main() {
  console.log('='.repeat(60));
  console.log('EXPORTING AGGREGATED SALES BY CATEGORY & LOCATION');
  console.log('='.repeat(60));
  console.log(`Date: ${REPORT_DATE}\n`);

  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  console.log('Fetching store configurations...\n');
  const response = await axios.get(`${STORES_API_URL}?pagination[limit]=100`);
  const stores = response.data.data || response.data;
  const activeStores = stores.filter(s => s.dutchieApiKey && s.is_active);

  console.log(`Found ${activeStores.length} active stores\n`);

  const allRows = [HEADERS];
  const failedStores = [];
  const summary = [];

  for (const store of activeStores) {
    const storeName = store.name;
    process.stdout.write(`Fetching ${storeName}... `);

    const client = axios.create({
      baseURL: DUTCHIE_API_URL,
      auth: { username: store.dutchieApiKey, password: '' }
    });

    const result = await fetchTransactions(client, storeName);

    if (!result.success) {
      console.log(`FAILED after retry: ${result.error}`);
      failedStores.push({ store: storeName, error: result.error });
      continue;
    }

    const transactions = result.data;
    const aggregates = aggregateByCategory(transactions, storeName);
    const refNumber = `SALES-${REPORT_DATE.replace(/-/g, '')}-${store.DutchieStoreID || store.id}`;
    const rows = generateRows(storeName, aggregates, refNumber);

    allRows.push(...rows);

    // Calculate store totals
    let totalQty = 0, totalSales = 0, totalTax = 0;
    for (const data of Object.values(aggregates)) {
      totalQty += data.quantity;
      totalSales += data.salesAmount;
      totalTax += data.taxAmount;
    }

    console.log(`${Object.keys(aggregates).length} categories, ${totalQty} units, $${totalSales.toFixed(2)}`);
    summary.push({ store: storeName, categories: Object.keys(aggregates).length, quantity: totalQty, sales: totalSales, tax: totalTax });
  }

  // Write combined file
  fs.writeFileSync(
    path.join(OUTPUT_DIR, `aggregates_${REPORT_DATE}.csv`),
    allRows.join('\n')
  );

  // Print summary
  console.log('\n' + '='.repeat(60));
  console.log('SUMMARY');
  console.log('='.repeat(60));

  let grandQty = 0, grandSales = 0, grandTax = 0;
  for (const s of summary) {
    grandQty += s.quantity;
    grandSales += s.sales;
    grandTax += s.tax;
  }

  console.log(`\nTotal Stores: ${summary.length}`);
  console.log(`Total Units Sold: ${grandQty.toLocaleString()}`);
  console.log(`Total Sales: $${grandSales.toLocaleString('en-US', { minimumFractionDigits: 2 })}`);
  console.log(`Total Tax: $${grandTax.toLocaleString('en-US', { minimumFractionDigits: 2 })}`);

  console.log('\n' + '='.repeat(60));
  console.log('EXPORTED FILE');
  console.log('='.repeat(60));
  console.log(`\n${path.resolve(OUTPUT_DIR, `aggregates_${REPORT_DATE}.csv`)}`);

  // Validation
  if (failedStores.length > 0) {
    console.log('\n' + '='.repeat(60));
    console.log('ERROR: FAILED STORES');
    console.log('='.repeat(60));
    failedStores.forEach(f => console.log(`  ✗ ${f.store}: ${f.error}`));
    throw new Error(`Export incomplete: ${failedStores.length} store(s) failed after retry`);
  }

  if (summary.length !== activeStores.length) {
    throw new Error(`Export incomplete: Expected ${activeStores.length} stores, got ${summary.length}`);
  }

  console.log('\n' + '='.repeat(60));
  console.log('✓ EXPORT COMPLETE - ALL STORES SUCCESSFUL');
  console.log('='.repeat(60));
}

main().catch(err => {
  console.error('\n' + '!'.repeat(60));
  console.error('EXPORT FAILED:', err.message);
  console.error('!'.repeat(60));
  process.exit(1);
});
