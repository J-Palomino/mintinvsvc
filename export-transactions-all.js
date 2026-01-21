/**
 * Export January 2026 transactions for ALL stores to CSV
 */

const axios = require('axios');
const fs = require('fs');
const path = require('path');

const STORES_API_URL = process.env.STORES_API_URL || 'https://mintdealsbackend-production.up.railway.app/api/stores';
const DUTCHIE_API_URL = process.env.DUTCHIE_API_URL || 'https://api.pos.dutchie.com';

// Single day: January 13, 2026
const FROM_DATE = '2026-01-13T00:00:00Z';
const TO_DATE = '2026-01-13T23:59:59Z';

const OUTPUT_DIR = './exports';

function escapeCSV(value) {
  if (value === null || value === undefined) return '';
  const str = String(value);
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function transactionToRow(t, storeName) {
  return [
    storeName,
    t.transactionId,
    t.transactionDate,
    t.transactionType,
    t.orderType,
    t.orderSource,
    t.customerId,
    t.customerTypeId,
    t.isMedical ? 'Yes' : 'No',
    t.employeeId,
    t.completedByUser,
    t.terminalName,
    t.subtotal,
    t.totalDiscount,
    t.totalBeforeTax,
    t.tax,
    t.tipAmount,
    t.total,
    t.totalItems,
    t.cashPaid,
    t.debitPaid,
    t.creditPaid,
    t.giftPaid,
    t.electronicPaid || 0,
    t.paid,
    t.changeDue,
    t.loyaltyEarned,
    t.loyaltySpent,
    t.isVoid ? 'Yes' : 'No',
    t.isReturn ? 'Yes' : 'No',
    t.wasPreOrdered ? 'Yes' : 'No',
    t.invoiceNumber || '',
    t.referenceId || '',
    t.globalId
  ].map(escapeCSV).join(',');
}

function itemToRow(item, t, storeName) {
  return [
    storeName,
    t.transactionId,
    t.transactionDate,
    item.transactionItemId,
    item.productId,
    item.inventoryId,
    item.quantity,
    item.unitPrice,
    item.unitCost,
    item.totalPrice,
    item.totalDiscount,
    item.unitWeight,
    item.unitWeightUnit,
    item.packageId,
    item.batchName,
    item.vendor,
    item.isReturned ? 'Yes' : 'No',
    item.isCoupon ? 'Yes' : 'No',
    // Flatten discounts
    (item.discounts || []).map(d => d.discountName).join('; '),
    (item.discounts || []).map(d => d.amount).join('; '),
    // Flatten taxes
    (item.taxes || []).map(tx => `${tx.rateName}:${tx.amount}`).join('; ')
  ].map(escapeCSV).join(',');
}

const TRANSACTION_HEADERS = [
  'Store', 'TransactionID', 'TransactionDate', 'TransactionType', 'OrderType', 'OrderSource',
  'CustomerID', 'CustomerTypeID', 'IsMedical', 'EmployeeID', 'CompletedByUser', 'TerminalName',
  'Subtotal', 'TotalDiscount', 'TotalBeforeTax', 'Tax', 'TipAmount', 'Total', 'TotalItems',
  'CashPaid', 'DebitPaid', 'CreditPaid', 'GiftPaid', 'ElectronicPaid', 'TotalPaid', 'ChangeDue',
  'LoyaltyEarned', 'LoyaltySpent', 'IsVoid', 'IsReturn', 'WasPreOrdered', 'InvoiceNumber', 'ReferenceID', 'GlobalID'
].join(',');

const ITEM_HEADERS = [
  'Store', 'TransactionID', 'TransactionDate', 'ItemID', 'ProductID', 'InventoryID',
  'Quantity', 'UnitPrice', 'UnitCost', 'TotalPrice', 'TotalDiscount',
  'UnitWeight', 'UnitWeightUnit', 'PackageID', 'BatchName', 'Vendor',
  'IsReturned', 'IsCoupon', 'Discounts', 'DiscountAmounts', 'Taxes'
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
      await new Promise(r => setTimeout(r, 2000)); // Wait 2 seconds before retry
      return fetchTransactions(client, storeName, 2);
    }
    return { success: false, error: errorMsg };
  }
}

async function main() {
  console.log('='.repeat(60));
  console.log('EXPORTING JANUARY 2026 TRANSACTIONS FOR ALL STORES');
  console.log('='.repeat(60));
  console.log(`Date range: ${FROM_DATE} to ${TO_DATE}\n`);

  // Create output directory
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  // Fetch stores
  console.log('Fetching store configurations...\n');
  const response = await axios.get(`${STORES_API_URL}?pagination[limit]=100`);
  const stores = response.data.data || response.data;
  const activeStores = stores.filter(s => s.dutchieApiKey && s.is_active);

  console.log(`Found ${activeStores.length} active stores\n`);

  // Combined files
  const allTransactionRows = [TRANSACTION_HEADERS];
  const allItemRows = [ITEM_HEADERS];

  const summary = [];
  const failedStores = [];

  for (const store of activeStores) {
    const storeName = store.name;
    const safeStoreName = storeName.replace(/[^a-zA-Z0-9]/g, '_');

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

    if (transactions.length === 0) {
      console.log('0 transactions');
      summary.push({ store: storeName, transactions: 0, items: 0, total: 0, tax: 0 });
      continue;
    }

    // Calculate totals
    let totalSales = 0;
    let totalTax = 0;
    let totalItems = 0;

    // Process transactions
    const storeTransactionRows = [TRANSACTION_HEADERS];
    const storeItemRows = [ITEM_HEADERS];

    for (const t of transactions) {
      totalSales += t.total || 0;
      totalTax += t.tax || 0;

      const txRow = transactionToRow(t, storeName);
      storeTransactionRows.push(txRow);
      allTransactionRows.push(txRow);

      // Process line items
      if (t.items && t.items.length > 0) {
        for (const item of t.items) {
          totalItems++;
          const itemRow = itemToRow(item, t, storeName);
          storeItemRows.push(itemRow);
          allItemRows.push(itemRow);
        }
      }
    }

    // Write store-specific files
    fs.writeFileSync(
      path.join(OUTPUT_DIR, `${safeStoreName}_transactions.csv`),
      storeTransactionRows.join('\n')
    );
    fs.writeFileSync(
      path.join(OUTPUT_DIR, `${safeStoreName}_items.csv`),
      storeItemRows.join('\n')
    );

    console.log(`${transactions.length} transactions, ${totalItems} items, $${totalSales.toFixed(2)}`);

    summary.push({
      store: storeName,
      transactions: transactions.length,
      items: totalItems,
      total: totalSales,
      tax: totalTax
    });
  }

  // Write combined files
  fs.writeFileSync(
    path.join(OUTPUT_DIR, 'ALL_STORES_transactions.csv'),
    allTransactionRows.join('\n')
  );
  fs.writeFileSync(
    path.join(OUTPUT_DIR, 'ALL_STORES_items.csv'),
    allItemRows.join('\n')
  );

  // Write summary
  const summaryRows = [
    'Store,Transactions,Items,TotalSales,TotalTax',
    ...summary.map(s => `${escapeCSV(s.store)},${s.transactions},${s.items},${s.total.toFixed(2)},${s.tax.toFixed(2)}`)
  ];
  fs.writeFileSync(
    path.join(OUTPUT_DIR, 'SUMMARY.csv'),
    summaryRows.join('\n')
  );

  // Print summary
  console.log('\n' + '='.repeat(60));
  console.log('SUMMARY');
  console.log('='.repeat(60));

  let grandTotal = 0;
  let grandTax = 0;
  let grandTransactions = 0;
  let grandItems = 0;

  for (const s of summary) {
    grandTotal += s.total;
    grandTax += s.tax;
    grandTransactions += s.transactions;
    grandItems += s.items;
  }

  console.log(`\nTotal Stores: ${summary.length}`);
  console.log(`Total Transactions: ${grandTransactions.toLocaleString()}`);
  console.log(`Total Line Items: ${grandItems.toLocaleString()}`);
  console.log(`Total Sales: $${grandTotal.toLocaleString('en-US', { minimumFractionDigits: 2 })}`);
  console.log(`Total Tax: $${grandTax.toLocaleString('en-US', { minimumFractionDigits: 2 })}`);

  console.log('\n' + '='.repeat(60));
  console.log('EXPORTED FILES');
  console.log('='.repeat(60));
  console.log(`\nDirectory: ${path.resolve(OUTPUT_DIR)}\n`);
  console.log('Combined files:');
  console.log('  - ALL_STORES_transactions.csv');
  console.log('  - ALL_STORES_items.csv');
  console.log('  - SUMMARY.csv');
  console.log(`\nPer-store files: ${summary.length * 2} files`);
  console.log('  - {StoreName}_transactions.csv');
  console.log('  - {StoreName}_items.csv');

  // Validation: check for failed stores
  if (failedStores.length > 0) {
    console.log('\n' + '='.repeat(60));
    console.log('ERROR: FAILED STORES');
    console.log('='.repeat(60));
    failedStores.forEach(f => console.log(`  ✗ ${f.store}: ${f.error}`));
    throw new Error(`Export incomplete: ${failedStores.length} store(s) failed after retry: ${failedStores.map(f => f.store).join(', ')}`);
  }

  // Validation: check all stores accounted for
  const expectedCount = activeStores.length;
  const actualCount = summary.length;
  if (actualCount !== expectedCount) {
    throw new Error(`Export incomplete: Expected ${expectedCount} stores, got ${actualCount}`);
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
