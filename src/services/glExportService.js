/**
 * GL Journal Export Service
 * Generates daily GL journal entries for accounting system import
 * Source of Truth: Dutchie POS API (/reporting/transactions)
 */

const axios = require('axios');
const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');
const { parse: csvParse } = require('csv-parse/sync');

const DUTCHIE_API_URL = process.env.DUTCHIE_API_URL || 'https://api.pos.dutchie.com';
const DUTCHIE_BACKOFFICE_URL = 'https://themint.backoffice.dutchie.com';
const OUTPUT_DIR = process.env.GL_EXPORT_DIR || './exports';

// Dutchie Backoffice location IDs for closing-report API (prepaid sales)
// These are needed for non-FL stores where accounting export shows $0 for debit
const STORE_LOC_IDS = {
  // Arizona
  'Mint Tempe': 1568,
  'Mint 75th Ave Phoenix': 2679,
  'Mint Scottsdale': 2725,
  'Mint Northern Phoenix': 2272,
  'Mint Mesa': 2350,
  'Mint Buckeye/Verado': 2551,
  'Mint El Mirage': 2669,
  // Nevada
  'Mint Las Vegas Strip': 2866,
  'Mint Spring Valley': 2865,
  // Missouri
  'Mint St. Peters': 2194,
  // Michigan
  'Mint New Buffalo': 2859,
  'Mint Roseville': 2860,
  'Mint Coldwater': 2680,
  'Mint Monroe': 2736,
  'Mint Kalamazoo': 2784,
  // Illinois
  'Mint Willowbrook': 2784
};

// Store timezone mapping (IANA timezone names)
// Used to convert local business day to UTC for Dutchie API queries
const STORE_TIMEZONES = {
  // Florida - Eastern Time
  'Mint Bonita Springs': 'America/New_York',
  'Mint Bonita Springs ': 'America/New_York',
  'Mint Bradenton': 'America/New_York',
  'Mint Brandon': 'America/New_York',
  'Mint Cape Coral': 'America/New_York',
  'Mint Delray Beach': 'America/New_York',
  'Mint Gainesville': 'America/New_York',
  'Mint Jacksonville': 'America/New_York',
  'Mint Longwood': 'America/New_York',
  'Mint Melbourne': 'America/New_York',
  'Mint Miami': 'America/New_York',
  'Mint Orlando': 'America/New_York',
  'Mint Orlando ': 'America/New_York',
  'Mint Sarasota': 'America/New_York',
  'Mint St. Augustine': 'America/New_York',
  'Mint Stuart': 'America/New_York',
  // Michigan - Eastern Time
  'Mint Kalamazoo': 'America/Detroit',
  'Mint Portage': 'America/Detroit',
  'Mint Roseville': 'America/Detroit',
  'Mint Coldwater': 'America/Detroit',
  'Mint Monroe': 'America/Detroit',
  'Mint New Buffalo': 'America/Detroit',
  // Arizona - Mountain Time (no DST)
  'Mint Mesa': 'America/Phoenix',
  'Mint Mesa ': 'America/Phoenix',
  'Mint Bell Road Phoenix': 'America/Phoenix',
  'Mint 75th Ave Phoenix': 'America/Phoenix',
  'Mint Buckeye/Verado': 'America/Phoenix',
  'Mint El Mirage': 'America/Phoenix',
  'Mint Northern Phoenix': 'America/Phoenix',
  'Mint Scottsdale': 'America/Phoenix',
  'Mint Tempe': 'America/Phoenix',
  // Nevada - Pacific Time
  'Mint Spring Valley': 'America/Los_Angeles',
  'Mint Las Vegas Strip': 'America/Los_Angeles',
  'Mint Las Vegas Strip ': 'America/Los_Angeles',
  // Missouri - Central Time
  'Mint St. Peters': 'America/Chicago',
  // Illinois - Central Time
  'Mint Willowbrook': 'America/Chicago'
};

// Dashboard location name to internal store name mapping
// Used when importing from dashboard CSV exports
const DASHBOARD_NAME_MAP = {
  // Florida
  'The Mint Bonita Springs': 'Mint Bonita Springs',
  'The Mint Bradenton': 'Mint Bradenton',
  'The Mint Brandon': 'Mint Brandon',
  'The Mint Cape Coral': 'Mint Cape Coral',
  'The Mint Delray Beach': 'Mint Delray Beach',
  'The Mint Gainesville': 'Mint Gainesville',
  'The Mint Jacksonville': 'Mint Jacksonville',
  'The Mint Longwood': 'Mint Longwood',
  'The Mint Melbourne': 'Mint Melbourne',
  'The Mint Miami': 'Mint Miami',
  'The Mint Orlando': 'Mint Orlando',
  'The Mint Sarasota': 'Mint Sarasota',
  'The Mint St. Augustine': 'Mint St. Augustine',
  'The Mint Stuart': 'Mint Stuart',
  // Nevada
  'The Mint - Paradise': 'Mint Las Vegas Strip',
  'The Mint - Spring Valley': 'Mint Spring Valley',
  // Missouri
  'The Mint - St Peters Retail': 'Mint St. Peters',
  // Michigan
  'Mint Cannabis - New Buffalo': 'Mint New Buffalo',
  'Mint Cannabis - Roseville': 'Mint Roseville',
  'Coldwater Retail': 'Mint Coldwater',
  'Monroe Retail': 'Mint Monroe',
  'Portage Retail': 'Mint Portage',
  'Kalamazoo Retail': 'Mint Kalamazoo',
  // Arizona
  'Tempe - Swallowtail 3 LLC': 'Mint Tempe',
  '75th Ave - M&T Retail Facility 1 LLC': 'Mint 75th Ave Phoenix',
  'Scottsdale - EBA Holdings Inc': 'Mint Scottsdale',
  'Cave Creek - Uncle Harry Inc': 'Mint Bell Road Phoenix',
  'Mesa - 4245 Investments LLC': 'Mint Mesa',
  'Northern - GTL LLC': 'Mint Northern Phoenix',
  'Buckeye - Woodstock 1': 'Mint Buckeye/Verado',
  'El Mirage - MCD-SE Venture 25 LLC': 'Mint El Mirage',
  // Illinois
  'Mint IL, LLC': 'Mint Willowbrook'
};

// Dutchie to Accumatica branch code mapping
const BRANCH_CODES = {
  // Florida (FLD-)
  'Mint Bonita Springs': 'FLD-BONITA',
  'Mint Bonita Springs ': 'FLD-BONITA',
  'Mint Bradenton': 'FLD-BRADEN',
  'Mint Brandon': 'FLD-BRANDO',
  'Mint Cape Coral': 'FLD-CAPECO',
  'Mint Delray Beach': 'FLD-DELRAY',
  'Mint Gainesville': 'FLD-GAINES',
  'Mint Jacksonville': 'FLD-JA4332',
  'Mint Longwood': 'FLD-LONGWO',
  'Mint Melbourne': 'FLD-MELBOU',
  'Mint Miami': 'FLD-MIAMI',
  'Mint Orlando': 'FLD-O10615',
  'Mint Orlando ': 'FLD-O10615',
  'Mint Sarasota': 'FLD-SARASO',
  'Mint St. Augustine': 'FLD-STAUGU',
  'Mint Stuart': 'FLD-STUART',
  // Michigan (MID-)
  'Mint Kalamazoo': 'MID-KALAMA',
  'Mint Portage': 'MI-GB2',
  'Mint Roseville': 'MID-ROSE',
  'Mint Coldwater': 'MID-COLDWA',
  'Mint Monroe': 'MID-MONROE',
  'Mint New Buffalo': 'MID-NB',
  // Arizona (AZD-/AZV-)
  'Mint Mesa': 'AZD-4245IN',
  'Mint Mesa ': 'AZD-4245IN',
  'Mint Bell Road Phoenix': 'AZD-UH',
  'Mint 75th Ave Phoenix': 'AZV-ENCANT',
  'Mint Buckeye/Verado': 'AZD-BUCK',
  'Mint El Mirage': 'AZD-ELMIRA',
  'El Mirage - MCD-SE Venture 25 LLC': 'AZD-ELMIRA',
  'Mint Northern Phoenix': 'AZV-GTL',
  'Mint Scottsdale': 'AZV-EBA',
  'Mint Tempe': 'AZV-SWT',
  // Nevada (NVD-)
  'Mint Spring Valley': 'NVD-RAIN',
  'Mint Las Vegas Strip': 'NVD-PARA',
  'Mint Las Vegas Strip ': 'NVD-PARA',
  // Missouri (MOD-)
  'Mint St. Peters': 'MOD-MO4',
  // Illinois (ILD-)
  'Mint Willowbrook': 'ILD-WILLOW'
};

// GL Account codes per specification
// Sub-Acct: 20-00 for revenue/expense accounts, 00-00 for balance sheet accounts
const ACCOUNTS = [
  { code: '40001', desc: 'Sales Income - Retail Sales', type: 'credit', field: 'grossSales', subacct: '20-00' },           // Total Price (J)
  { code: '40002', desc: 'Retail Income: Discounts and Coupons', type: 'debit', field: 'discounts', subacct: '20-00' },    // Amount (K)
  { code: '40003', desc: 'Retail Income: Sales Return', type: 'debit', field: 'returns', subacct: '20-00' },               // (unused)
  { code: '40004', desc: 'Loyalty Discounts', type: 'debit', field: 'loyaltySpent', subacct: '20-00' },                    // Sum Total Loyalty Paid (M)
  { code: '23500', desc: 'Taxes Payable - Sales & Use', type: 'credit', field: 'tax', subacct: '00-00' },                  // Total Tax (N)
  { code: '10000', desc: 'Cash on Hand', type: 'debit', field: 'netCash', subacct: '00-00' },                              // Cash Paid (P)
  { code: '11010', desc: 'Debit Card Receivable', type: 'debit', field: 'debitPaid', subacct: '00-00' },                   // Debit Paid (O) + Electronic Paid (Q)
  { code: '70260', desc: 'Overage/Shortage: Cash Ledger Adj', type: 'balance', field: 'overage', subacct: '20-00' },       // (Amount+Loyalty+Cash+Debit+Electronic) - (TotalPrice+Tax)
  { code: '50000', desc: 'Retail COG - Consumable Products for Resale', type: 'debit', field: 'cogs', subacct: '20-00' },  // Total Cost (S)
  { code: '12250', desc: 'Inventory - Finished Goods', type: 'credit', field: 'cogs', subacct: '00-00' }                   // Total Cost (S)
];

class GLExportService {
  constructor(locationConfigs) {
    this.locationConfigs = locationConfigs;
  }

  /**
   * Check if a store is a non-FL store that needs prepaid sales data
   * FL stores have accurate Debit Paid/Electronic Paid in accounting export
   * Non-FL stores show $0 and need to use closing-report API prepaid sales
   * @param {string} storeName - Store name
   * @returns {boolean} True if store needs prepaid sales from closing-report API
   */
  needsPrepaidSales(storeName) {
    const branchCode = this.getBranchCode(storeName);
    // Florida stores (FLD-*) don't need prepaid sales - their debit data is in accounting export
    return !branchCode.startsWith('FLD-');
  }

  /**
   * Fetch prepaid sales from Dutchie closing-report API
   * This is used for non-FL stores where the accounting export shows $0 for debit
   * @param {string} storeName - Store name
   * @param {string} reportDate - Date in YYYY-MM-DD format
   * @returns {Promise<number>} Prepaid sales amount
   */
  async fetchPrepaidSales(storeName, reportDate) {
    const locId = STORE_LOC_IDS[storeName];
    if (!locId) {
      console.log(`  [Prepaid] No LocId for ${storeName}, skipping prepaid fetch`);
      return 0;
    }

    // Get session credentials from environment
    const sessionId = process.env.DUTCHIE_SESSION_ID;
    const lspId = process.env.DUTCHIE_LSP_ID || '575';
    const orgId = process.env.DUTCHIE_ORG_ID || '5134';
    const userId = process.env.DUTCHIE_USER_ID || '26146';

    if (!sessionId) {
      console.log(`  [Prepaid] DUTCHIE_SESSION_ID not set, skipping prepaid fetch for ${storeName}`);
      return 0;
    }

    // Format dates for closing-report API: "MM/DD/YYYY 12:00 am"
    const [year, month, day] = reportDate.split('-');
    const startDate = `${month}/${day}/${year} 12:00 am`;
    // Calculate next day using UTC to avoid timezone issues
    const nextDay = new Date(Date.UTC(parseInt(year), parseInt(month) - 1, parseInt(day) + 1));
    const endYear = nextDay.getUTCFullYear();
    const endMonth = String(nextDay.getUTCMonth() + 1).padStart(2, '0');
    const endDay = String(nextDay.getUTCDate()).padStart(2, '0');
    const endDate = `${endMonth}/${endDay}/${endYear} 12:00 am`;

    try {
      const response = await axios.post(
        `${DUTCHIE_BACKOFFICE_URL}/api/posv3/reports/closing-report`,
        {
          Date: startDate,
          EndDate: endDate,
          IncludeDetail: true,
          SessionId: sessionId,
          LspId: parseInt(lspId),
          LocId: locId,
          OrgId: parseInt(orgId),
          UserId: parseInt(userId)
        },
        {
          headers: {
            'Content-Type': 'application/json; charset=UTF-8',
            'Accept': 'application/json',
            'appname': 'Backoffice',
            'Cookie': `LLSession=${sessionId}`
          },
          timeout: 30000
        }
      );

      if (response.data?.Result && response.data?.Data?.Registers) {
        const prepaidTotal = response.data.Data.Registers.reduce(
          (sum, reg) => sum + (reg['Prepaid Sales'] || 0),
          0
        );
        return prepaidTotal;
      }
      return 0;
    } catch (error) {
      const msg = error.response?.data?.Message || error.message;
      console.log(`  [Prepaid] Error fetching for ${storeName}: ${msg}`);
      return 0;
    }
  }

  /**
   * Fetch prepaid sales for all non-FL stores in the export
   * @param {Map<string, object>} storeData - Store data map from CSV/JSON parsing
   * @param {string} reportDate - Date in YYYY-MM-DD format
   * @returns {Promise<Map<string, number>>} Map of store name to prepaid sales
   */
  async fetchAllPrepaidSales(storeData, reportDate) {
    const prepaidData = new Map();
    const nonFLStores = [...storeData.keys()].filter(name => this.needsPrepaidSales(name));

    if (nonFLStores.length === 0) {
      return prepaidData;
    }

    console.log(`\nFetching prepaid sales for ${nonFLStores.length} non-FL stores...`);

    // Fetch one at a time with delay to respect rate limits (20 req/min)
    for (let i = 0; i < nonFLStores.length; i++) {
      const storeName = nonFLStores[i];
      const prepaid = await this.fetchPrepaidSales(storeName, reportDate);
      prepaidData.set(storeName, prepaid);

      if (prepaid > 0) {
        console.log(`  ${storeName}: $${this.formatNumber(prepaid)} prepaid`);
      }

      // Rate limit: 3 second delay between requests
      if (i < nonFLStores.length - 1) {
        await new Promise(r => setTimeout(r, 3000));
      }
    }

    return prepaidData;
  }

  formatNumber(num) {
    return num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  getBranchCode(storeName) {
    if (BRANCH_CODES[storeName]) return BRANCH_CODES[storeName];
    const trimmed = storeName.trim();
    if (BRANCH_CODES[trimmed]) return BRANCH_CODES[trimmed];
    const parts = storeName.replace('Mint ', '').trim().split(' ');
    const code = parts[0].substring(0, 6).toUpperCase();
    return `UNK-${code}`;
  }

  /**
   * Get the IANA timezone for a store
   * @param {string} storeName - The store name
   * @returns {string} IANA timezone name (defaults to America/New_York)
   */
  getStoreTimezone(storeName) {
    if (STORE_TIMEZONES[storeName]) return STORE_TIMEZONES[storeName];
    const trimmed = storeName.trim();
    if (STORE_TIMEZONES[trimmed]) return STORE_TIMEZONES[trimmed];
    // Default to Eastern Time if unknown
    return 'America/New_York';
  }

  /**
   * Calculate the UTC offset in hours for a given timezone and date
   * Handles DST automatically using JavaScript's Intl API
   * @param {string} timezone - IANA timezone name (e.g., 'America/Phoenix')
   * @param {string} dateStr - Date string in YYYY-MM-DD format
   * @returns {number} UTC offset in hours (negative for west of UTC)
   */
  getUTCOffsetHours(timezone, dateStr) {
    // Create a date at noon local time to avoid DST transition edge cases
    const date = new Date(`${dateStr}T12:00:00`);

    // Get the timezone offset using Intl.DateTimeFormat
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      timeZoneName: 'shortOffset'
    });

    const parts = formatter.formatToParts(date);
    const tzPart = parts.find(p => p.type === 'timeZoneName');

    if (tzPart && tzPart.value) {
      // Parse offset like "GMT-7" or "GMT-8"
      const match = tzPart.value.match(/GMT([+-]?\d+)/);
      if (match) {
        return parseInt(match[1], 10);
      }
    }

    // Fallback: calculate offset by comparing local and UTC representations
    const utcDate = new Date(date.toLocaleString('en-US', { timeZone: 'UTC' }));
    const tzDate = new Date(date.toLocaleString('en-US', { timeZone: timezone }));
    return Math.round((tzDate - utcDate) / (1000 * 60 * 60));
  }

  /**
   * Get UTC boundaries for a local business day
   * Converts local midnight-to-midnight into UTC timestamps for Dutchie API
   * @param {string} reportDate - Date in YYYY-MM-DD format (local date)
   * @param {string} timezone - IANA timezone name
   * @returns {{ fromDateUTC: string, toDateUTC: string }} UTC timestamps
   */
  getLocalDayBoundariesUTC(reportDate, timezone) {
    const offsetHours = this.getUTCOffsetHours(timezone, reportDate);

    // Local midnight in UTC: if offset is -7, local midnight = 07:00 UTC
    const utcStartHour = -offsetHours;

    // Calculate the UTC date/time for local midnight
    const [year, month, day] = reportDate.split('-').map(Number);

    // Start: local midnight = reportDate at 00:00 local = reportDate at (utcStartHour):00 UTC
    // If utcStartHour >= 24, it rolls into the next UTC day
    // If utcStartHour < 0, it rolls into the previous UTC day (shouldn't happen for US timezones)

    let startDate = new Date(Date.UTC(year, month - 1, day, utcStartHour, 0, 0, 0));
    let endDate = new Date(Date.UTC(year, month - 1, day + 1, utcStartHour, 0, 0, 0));
    // End is exclusive, so we use the next day's midnight, then subtract 1 second for the query
    endDate.setUTCSeconds(-1);

    const fromDateUTC = startDate.toISOString().replace('.000Z', 'Z');
    const toDateUTC = endDate.toISOString().replace('.000Z', 'Z');

    return { fromDateUTC, toDateUTC };
  }

  /**
   * Get extended UTC boundaries that capture all possible local-time transactions.
   * This fetches a wider range (day before to day after) to ensure edge-case transactions
   * are captured, with filtering by transactionDateLocalTime done afterward.
   */
  getExtendedBoundariesUTC(reportDate, timezone) {
    const [year, month, day] = reportDate.split('-').map(Number);

    // Start 1 day before at midnight UTC
    const startDate = new Date(Date.UTC(year, month - 1, day - 1, 0, 0, 0, 0));
    // End 1 day after at 23:59:59 UTC
    const endDate = new Date(Date.UTC(year, month - 1, day + 1, 23, 59, 59, 0));

    const fromDateUTC = startDate.toISOString().replace('.000Z', 'Z');
    const toDateUTC = endDate.toISOString().replace('.000Z', 'Z');

    return { fromDateUTC, toDateUTC };
  }

  async fetchTransactions(apiKey, storeName, fromDate, toDate, attempt = 1) {
    const client = axios.create({
      baseURL: DUTCHIE_API_URL,
      auth: { username: apiKey, password: '' }
    });

    const params = {
      FromDateUTC: fromDate,
      ToDateUTC: toDate,
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
        console.log(`  ${storeName}: FAILED (${errorMsg}) - retrying...`);
        await new Promise(r => setTimeout(r, 2000));
        return this.fetchTransactions(apiKey, storeName, fromDate, toDate, 2);
      }
      return { success: false, error: errorMsg };
    }
  }

  /**
   * Check if an item return should be excluded from the report
   * A return should be excluded if it was processed on or before the report date
   * @param {string} returnDate - Item return date (ISO format)
   * @param {string} reportDate - Report date in YYYY-MM-DD format
   * @returns {boolean} True if the return should be excluded from gross sales
   */
  shouldExcludeReturn(returnDate, reportDate) {
    if (!returnDate) return false;

    // Extract YYYY-MM-DD from returnDate
    const retDateStr = String(returnDate).slice(0, 10);

    // Exclude return if it happened on or before the report date
    return retDateStr <= reportDate;
  }

  aggregateTransactions(transactions, reportDate = null, storeName = '') {
    // Return handling: Returned items are excluded from gross sales if the return
    // was processed ON or BEFORE the report date. Items returned AFTER the report date
    // are still counted (auditor wouldn't know about future returns).
    // Account 40003 (Sales Return) stays at $0 since we don't record returns separately.

    const totals = {
      grossSales: 0,
      discounts: 0,        // Non-loyalty discounts only (totalDiscount - loyaltySpent)
      loyaltySpent: 0,
      returns: 0,          // Always 0 - returns are backdated to original sale
      tax: 0,
      cashPaid: 0,
      debitPaid: 0,
      creditPaid: 0,
      totalPaid: 0,
      changeDue: 0,
      cashOnlyChangeDue: 0,  // Change given on cash-only transactions (not debit cash-back)
      cogs: 0,
      netCash: 0,
      overage: 0
    };

    // Track debit components separately for accurate calculation
    let rawDebit = 0;        // Sum of debitPaid field values
    let electronicDebit = 0; // Sum of electronicPaid field values (different payment processor)
    let prePaidDebit = 0;    // prePaymentAmount for prepaid/online orders
    let unpaidDue = 0;       // Calculated due for transactions with no payment recorded

    for (const t of transactions) {
      // Skip voided transactions
      if (t.isVoid) continue;

      // Skip return transactions (isReturn === true)
      // Returns are handled by backdating - excluding items with isReturned=true
      // from the original sale transaction. This matches auditor methodology.
      if (t.isReturn) continue;

      // Skip non-retail transactions (wholesale orders, transfers, etc.)
      // These are B2B transactions that shouldn't be in retail GL entries
      const txnType = t.transactionType || 'Retail';
      if (txnType !== 'Retail') continue;

      // For regular sales, calculate grossSales at the ITEM level
      // Items returned ON or BEFORE reportDate are excluded (backdate methodology)
      // Items returned AFTER reportDate are included (auditor wouldn't know about future returns)
      //
      // IMPORTANT: Some transactions have subtotal=0 but items with prices - these are
      // inventory transfers/adjustments, NOT customer sales. Use subtotal for such transactions.
      if (t.items && t.items.length > 0 && (t.subtotal || 0) !== 0) {
        for (const item of t.items) {
          // Exclude returned items only if return was on or before report date
          const excludeReturn = this.shouldExcludeReturn(item.returnDate, reportDate);
          if (!excludeReturn) {
            totals.grossSales += item.totalPrice || 0;
            // Include COGS for ALL items, including zero-price items (freebies/samples)
            // COGS represents actual inventory cost consumed, regardless of selling price
            // This matches auditor methodology
            totals.cogs += (item.unitCost || 0) * (item.quantity || 0);
          }
        }
      } else {
        // Use transaction subtotal for:
        // - Transactions without items array
        // - Transactions with subtotal=0 (inventory transfers)
        totals.grossSales += t.subtotal || 0;
      }

      // Add discounts, payments, etc. for non-return transactions
      // Calculate discounts at item level to exclude returned items
      let totalDiscount = 0;

      // If we have items, sum discounts excluding returned items (backdate methodology)
      // Same logic: only exclude if return was on or before report date
      if (t.items && t.items.length > 0 && (t.subtotal || 0) !== 0) {
        for (const item of t.items) {
          const excludeReturn = this.shouldExcludeReturn(item.returnDate, reportDate);
          if (!excludeReturn) {
            totalDiscount += item.totalDiscount || 0;
          }
        }
      } else {
        // Fallback to transaction-level discount if no items
        totalDiscount = t.totalDiscount || 0;
      }

      // LOYALTY CALCULATION:
      // Some stores have loyaltySpent field populated, others store loyalty in discounts array.
      // Missouri stores (St. Peters) use "* Loyalty 10", "* Loyalty 20" in discounts.
      // Illinois stores (Willowbrook) use "Dutchie Loyalty X points" in discounts.
      // Florida stores use "X Loyalty Points" which auditor treats as discounts, NOT loyalty.
      //
      // IMPORTANT: For stores with loyaltySpent field, the auditor subtracts loyalty from discounts.
      // For stores with loyalty in discounts array (MO, IL), the auditor does NOT subtract -
      // they report both discounts (including loyalty) AND loyalty separately.
      let loyaltyAmount = t.loyaltySpent || 0;
      let loyaltyFromDiscountsArray = false;

      if (loyaltyAmount === 0 && t.discounts && t.discounts.length > 0) {
        // Extract loyalty from discounts array using specific patterns
        // Match: "* Loyalty X" (Missouri) or "Dutchie Loyalty X points" (Illinois)
        // Exclude: "X Loyalty Points" (Florida) - auditor treats as discount
        for (const d of t.discounts) {
          const reason = (d.discountReason || d.discountName || '').trim();
          const upper = reason.toUpperCase();
          // Match patterns that auditor classifies as loyalty redemptions
          if (upper.startsWith('* LOYALTY') || upper.startsWith('DUTCHIE LOYALTY') ||
              upper === 'LOYALTY APPLIED') {
            loyaltyAmount += d.amount || 0;
            loyaltyFromDiscountsArray = true;
          }
        }
      }

      // For loyaltySpent field stores: subtract loyalty from discounts
      // For discounts-array loyalty stores: do NOT subtract (auditor includes both)
      if (loyaltyFromDiscountsArray) {
        totals.discounts += totalDiscount;  // Full discount including loyalty
      } else {
        totals.discounts += totalDiscount - loyaltyAmount;  // Non-loyalty discounts only
      }
      totals.loyaltySpent += loyaltyAmount;
      totals.tax += t.tax || 0;

      // Check if all items in this transaction are returned (on or before report date)
      // If so, exclude cash since it would have been refunded (backdate methodology)
      let allItemsReturned = false;
      if (t.items && t.items.length > 0) {
        allItemsReturned = t.items.every(item => this.shouldExcludeReturn(item.returnDate, reportDate));
      }

      // Only count cash if not all items returned
      if (!allItemsReturned) {
        totals.cashPaid += t.cashPaid || 0;
        totals.changeDue += t.changeDue || 0;
      }
      totals.creditPaid += t.creditPaid || 0;
      totals.totalPaid += t.paid || 0;

      // Extract payment-related fields
      const cashAmount = allItemsReturned ? 0 : (t.cashPaid || 0);
      const debitAmount = t.debitPaid || 0;
      const electronicAmount = t.electronicPaid || 0;
      const prePaymentAmount = t.prePaymentAmount || 0;
      const changeAmount = allItemsReturned ? 0 : (t.changeDue || 0);

      // Only count changeDue as cash drawer change if it's a cash transaction (no debit/electronic)
      if (cashAmount > 0 && debitAmount === 0 && electronicAmount === 0) {
        totals.cashOnlyChangeDue += changeAmount;
      }

      // DEBIT CALCULATION:
      // The Dutchie API has inconsistent debitPaid field population across stores.
      // Some stores (Florida) have raw debitPaid values, others (AZ, MI, MO, IL, NV) don't.
      // Additionally, some stores use electronicPaid for non-cash payments.
      // We use a combined approach:
      // 1. Always add raw debitPaid and electronicPaid values
      // 2. For transactions with no cash/debit/electronic but HAS prePaymentAmount: use prePaymentAmount
      //    (These are prepaid/online orders - prePaymentAmount includes tips and fees)
      // 3. For transactions with no payment but HAS balance due: add the due
      //    (These are transactions where payment wasn't recorded but sale happened)

      rawDebit += debitAmount;
      electronicDebit += electronicAmount;

      // Skip calculations for transactions where all items are returned
      // (these would have been refunded)
      if (!allItemsReturned) {
        // Always add prepayment amounts - they represent online/debit payments made before pickup
        // These can exist even when customer also pays cash at pickup
        if (prePaymentAmount > 0) {
          prePaidDebit += prePaymentAmount;
        }

        // Only calculate unpaid due if there's no payment at all
        if (cashAmount === 0 && debitAmount === 0 && electronicAmount === 0 && prePaymentAmount === 0) {
          const subtotal = t.subtotal || 0;
          const tax = t.tax || 0;
          const discount = t.totalDiscount || 0;
          const loyalty = t.loyaltySpent || 0;
          const due = subtotal + tax - discount - loyalty;
          if (due > 0) {
            unpaidDue += due;
          }
        }
      }
    }

    // netCash = cash received minus change given on CASH transactions only
    totals.netCash = totals.cashPaid - totals.cashOnlyChangeDue;

    // Debit = raw debitPaid + electronicPaid + prepaid amounts + unpaid dues
    totals.debitPaid = rawDebit + electronicDebit + prePaidDebit + unpaidDue;

    // Overage calculation:
    // Total debits should equal total credits
    // Any difference shows up in overage
    const totalDebits = totals.discounts + totals.returns + totals.loyaltySpent +
                        totals.netCash + totals.debitPaid + totals.cogs;
    const totalCredits = totals.grossSales + totals.tax + totals.cogs;
    totals.overage = totalCredits - totalDebits;

    return totals;
  }

  escapeCSV(value) {
    if (value === null || value === undefined) return '';
    const str = String(value);
    if (str.includes(',') || str.includes('"') || str.includes('\n')) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  }

  /**
   * Parse a currency string like "$1,234.56" or "1234.56" to a number
   * @param {string|number} value - The value to parse
   * @returns {number} The parsed number (0 if invalid)
   */
  parseCurrency(value) {
    if (typeof value === 'number') return value;
    if (!value) return 0;
    // Remove $, commas, and whitespace
    const cleaned = String(value).replace(/[$,\s]/g, '');
    const num = parseFloat(cleaned);
    return isNaN(num) ? 0 : num;
  }

  /**
   * Map a dashboard location name to internal store name
   * @param {string} dashboardName - Location name from dashboard CSV
   * @returns {string} Internal store name
   */
  mapDashboardName(dashboardName) {
    const trimmed = (dashboardName || '').trim();
    if (DASHBOARD_NAME_MAP[trimmed]) return DASHBOARD_NAME_MAP[trimmed];
    // Try partial match for variations
    for (const [key, value] of Object.entries(DASHBOARD_NAME_MAP)) {
      if (trimmed.includes(key) || key.includes(trimmed)) return value;
    }
    // Return as-is if no mapping found
    return trimmed;
  }

  /**
   * Parse dashboard CSV and aggregate data by location for a specific date
   * @param {string} csvPath - Path to the dashboard CSV file
   * @param {string} reportDate - Date to filter (YYYY-MM-DD format)
   * @returns {Map<string, object>} Map of store name to aggregated totals
   */
  /**
   * Parse dashboard CSV and aggregate data by location for a specific date
   *
   * GL Account Mapping (per specification):
   * - 40001 Sales (Credit)    = Total Price (J)
   * - 40002 Discounts (Debit) = Amount (K) - the discount amount field directly
   * - 40004 Loyalty (Debit)   = Sum Total Loyalty Paid (M)
   * - 23500 Tax (Credit)      = Total Tax (N)
   * - 10000 Cash (Debit)      = Cash Paid (P)
   * - 11010 Debit (Debit)     = Debit Paid (O) + Electronic Paid (Q)
   * - 50000 COGS (Debit)      = Total Cost (S)
   * - 12250 Inventory (Credit)= Total Cost (S)
   * - 70260 Overage (Credit)  = (Amount + Loyalty + Cash + Debit + Electronic) - (Total Price + Tax)
   *
   * @param {string} csvPath - Path to the dashboard CSV file
   * @param {string} reportDate - Date to filter (YYYY-MM-DD format)
   * @returns {Map<string, object>} Map of store name to aggregated totals
   */
  parseCSVData(csvPath, reportDate) {
    const csvContent = fs.readFileSync(csvPath, 'utf-8');
    const records = csvParse(csvContent, {
      columns: true,
      skip_empty_lines: true,
      trim: true
    });

    // Aggregate by location
    const storeData = new Map();

    for (const row of records) {
      // Support multiple column naming conventions (dashboard vs accounting export)
      const txnDate = row['Transaction Date'] || row['Transactions Transaction Date'];
      // Filter by report date if specified
      if (reportDate && txnDate !== reportDate) continue;

      const dashboardName = row['Location Name'] || row['Lsp Location Location Name'];
      const storeName = this.mapDashboardName(dashboardName);

      if (!storeData.has(storeName)) {
        storeData.set(storeName, {
          dashboardName,
          // Raw sums from Dutchie report (column letters from spec)
          sumTotalPrice: 0,     // J - Total Price
          sumAmount: 0,         // K - Amount (discount amount)
          sumLoyaltyPaid: 0,    // M - Sum Total Loyalty Paid
          sumTotalTax: 0,       // N - Total Tax
          sumDebitPaid: 0,      // O - Debit Paid
          sumCashPaid: 0,       // P - Cash Paid
          sumElectronicPaid: 0, // Q - Electronic Paid
          sumTotalCost: 0,      // S - Total Cost
          // Calculated GL values (set after aggregation)
          grossSales: 0,        // 40001
          discounts: 0,         // 40002
          loyaltySpent: 0,      // 40004
          returns: 0,           // 40003 (unused)
          tax: 0,               // 23500
          netCash: 0,           // 10000
          debitPaid: 0,         // 11010
          cogs: 0,              // 50000 & 12250
          overage: 0            // 70260
        });
      }

      const totals = storeData.get(storeName);

      // Parse currency values from CSV - support multiple column naming conventions
      const totalPrice = this.parseCurrency(row['Total Price'] || row['Transaction Items Total Price']);
      const amount = this.parseCurrency(row['Amount'] || row['Transaction Item Discounts Amount']);
      const loyaltyPaid = this.parseCurrency(row['Sum Total Loyalty Paid'] || row['Transactions Sum Total Loyalty Paid']);
      const totalTax = this.parseCurrency(row['Total Tax'] || row['Transactions Total Tax']);
      const debitPaid = this.parseCurrency(row['Debit Paid'] || row['Transactions Debit Paid']);
      const cashPaid = this.parseCurrency(row['Cash Paid'] || row['Transactions Cash Paid']);
      const electronicPaid = this.parseCurrency(row['Electronic Paid'] || row['Transactions Electronic Paid']);
      const totalCost = this.parseCurrency(row['Total Cost'] || row['Transaction Items Total Cost']);

      // Aggregate raw values (negative values represent reversals)
      totals.sumTotalPrice += totalPrice;
      totals.sumAmount += amount;
      totals.sumLoyaltyPaid += loyaltyPaid;
      totals.sumTotalTax += totalTax;
      totals.sumDebitPaid += debitPaid;
      totals.sumCashPaid += cashPaid;
      totals.sumElectronicPaid += electronicPaid;
      totals.sumTotalCost += totalCost;
    }

    // Calculate GL account values per specification
    for (const [storeName, totals] of storeData) {
      // 40001 Sales (Credit) = Total Price (J)
      totals.grossSales = totals.sumTotalPrice;

      // 40002 Discounts (Debit) = Amount (K) directly
      totals.discounts = totals.sumAmount;

      // 40004 Loyalty (Debit) = Sum Total Loyalty Paid (M)
      totals.loyaltySpent = totals.sumLoyaltyPaid;

      // 23500 Tax (Credit) = Total Tax (N)
      totals.tax = totals.sumTotalTax;

      // 10000 Cash (Debit) = Cash Paid (P) only
      totals.netCash = totals.sumCashPaid;

      // 11010 Debit (Debit) = Debit Paid (O) + Electronic Paid (Q)
      totals.debitPaid = totals.sumDebitPaid + totals.sumElectronicPaid;

      // 50000 COGS (Debit) = Total Cost (S)
      // 12250 Inventory (Credit) = Total Cost (S)
      totals.cogs = totals.sumTotalCost;

      // 70260 Overage (Credit) = (Amount + Loyalty + Cash + Debit + Electronic) - (Total Price + Tax)
      const sumDebits = totals.sumAmount + totals.sumLoyaltyPaid + totals.sumCashPaid +
                        totals.sumDebitPaid + totals.sumElectronicPaid;
      const sumCredits = totals.sumTotalPrice + totals.sumTotalTax;
      totals.overage = sumDebits - sumCredits;
    }

    return storeData;
  }

  /**
   * Parse CSV text content and aggregate data by location
   * Same logic as parseCSVData but takes text instead of file path
   * @param {string} csvText - CSV content as text
   * @param {string} reportDate - Date to filter (YYYY-MM-DD format)
   * @returns {Map<string, object>} Map of store name to aggregated totals
   */
  parseCSVText(csvText, reportDate) {
    const records = csvParse(csvText, {
      columns: true,
      skip_empty_lines: true,
      trim: true
    });

    const storeData = new Map();

    for (const row of records) {
      const txnDate = row['Transaction Date'] || row['Transactions Transaction Date'];
      if (reportDate && txnDate !== reportDate) continue;

      const dashboardName = row['Location Name'] || row['Lsp Location Location Name'];
      const storeName = this.mapDashboardName(dashboardName);

      if (!storeData.has(storeName)) {
        storeData.set(storeName, {
          dashboardName,
          sumTotalPrice: 0,
          sumAmount: 0,
          sumLoyaltyPaid: 0,
          sumTotalTax: 0,
          sumDebitPaid: 0,
          sumCashPaid: 0,
          sumElectronicPaid: 0,
          sumTotalCost: 0,
          grossSales: 0,
          discounts: 0,
          loyaltySpent: 0,
          returns: 0,
          tax: 0,
          netCash: 0,
          debitPaid: 0,
          cogs: 0,
          overage: 0
        });
      }

      const totals = storeData.get(storeName);

      totals.sumTotalPrice += this.parseCurrency(row['Total Price'] || row['Transaction Items Total Price']);
      totals.sumAmount += this.parseCurrency(row['Amount'] || row['Transaction Item Discounts Amount']);
      totals.sumLoyaltyPaid += this.parseCurrency(row['Sum Total Loyalty Paid'] || row['Transactions Sum Total Loyalty Paid']);
      totals.sumTotalTax += this.parseCurrency(row['Total Tax'] || row['Transactions Total Tax']);
      totals.sumDebitPaid += this.parseCurrency(row['Debit Paid'] || row['Transactions Debit Paid']);
      totals.sumCashPaid += this.parseCurrency(row['Cash Paid'] || row['Transactions Cash Paid']);
      totals.sumElectronicPaid += this.parseCurrency(row['Electronic Paid'] || row['Transactions Electronic Paid']);
      totals.sumTotalCost += this.parseCurrency(row['Total Cost'] || row['Transaction Items Total Cost']);
    }

    for (const [storeName, totals] of storeData) {
      totals.grossSales = totals.sumTotalPrice;
      totals.discounts = totals.sumAmount;
      totals.loyaltySpent = totals.sumLoyaltyPaid;
      totals.tax = totals.sumTotalTax;
      totals.netCash = totals.sumCashPaid;
      totals.debitPaid = totals.sumDebitPaid + totals.sumElectronicPaid;
      totals.cogs = totals.sumTotalCost;

      const sumDebits = totals.sumAmount + totals.sumLoyaltyPaid + totals.sumCashPaid +
                        totals.sumDebitPaid + totals.sumElectronicPaid;
      const sumCredits = totals.sumTotalPrice + totals.sumTotalTax;
      totals.overage = sumDebits - sumCredits;
    }

    return storeData;
  }

  /**
   * Export GL journal from CSV text content
   * @param {string} csvText - CSV content as text
   * @param {string} reportDate - Optional date filter (YYYY-MM-DD)
   * @returns {object} Export result with file paths
   */
  async exportFromCSVText(csvText, reportDate = null) {
    // Detect date from CSV if not provided
    if (!reportDate) {
      const records = csvParse(csvText, { columns: true, skip_empty_lines: true });
      const dates = [...new Set(records.map(r =>
        r['Transaction Date'] || r['Transactions Transaction Date']
      ).filter(Boolean))];

      if (dates.length === 1) {
        reportDate = dates[0];
      } else if (dates.length > 1) {
        console.log(`Multiple dates found in CSV: ${dates.join(', ')}`);
        reportDate = dates[0];
      } else {
        throw new Error('No transaction dates found in CSV');
      }
    }

    const refNumber = `${reportDate} DS`;

    console.log(`\n=== GL Journal Export from CSV Text for ${reportDate} ===`);

    if (!fs.existsSync(OUTPUT_DIR)) {
      fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    }

    const headerColumns = [
      'Branch', 'Dutchie Store Name', 'Account', 'Description',
      'Subaccount', 'Ref. Number', 'Quantity', 'UOM', 'Debit Amount', 'Credit Amount'
    ];

    const tsvHeaders = headerColumns.join('\t');
    const csvHeaders = headerColumns.join(',');

    const note = [
      `# GL Journal Export - ${reportDate}`,
      `# Source: CSV Upload`,
      `# Generated: ${new Date().toISOString()}`,
      `#`
    ].join('\n');

    // Parse CSV and aggregate by store
    const storeData = this.parseCSVText(csvText, reportDate);

    // Fetch prepaid sales for non-FL stores
    const prepaidData = await this.fetchAllPrepaidSales(storeData, reportDate);

    // Apply prepaid sales to non-FL stores
    for (const [storeName, prepaid] of prepaidData) {
      if (prepaid > 0 && storeData.has(storeName)) {
        const totals = storeData.get(storeName);
        totals.debitPaid = prepaid;
        const sumDebits = totals.sumAmount + totals.sumLoyaltyPaid + totals.sumCashPaid + prepaid;
        const sumCredits = totals.sumTotalPrice + totals.sumTotalTax;
        totals.overage = sumDebits - sumCredits;
      }
    }

    const allRows = [];
    let grandSales = 0;

    for (const [storeName, totals] of storeData) {
      const branchCode = this.getBranchCode(storeName);
      console.log(`  ${storeName} (${branchCode}): $${this.formatNumber(totals.grossSales)}`);
      const rows = this.generateGLRows(branchCode, storeName, totals, refNumber);
      allRows.push(...rows);
      grandSales += totals.grossSales;
    }

    // Generate files
    const tsvFilename = `gl_journal_${reportDate}_upload.tsv`;
    const tsvFilepath = path.join(OUTPUT_DIR, tsvFilename);
    fs.writeFileSync(tsvFilepath, [note, tsvHeaders, ...allRows.map(r => this.rowToTSV(r))].join('\n'));

    const csvFilename = `gl_journal_${reportDate}_upload.csv`;
    const csvFilepath = path.join(OUTPUT_DIR, csvFilename);
    fs.writeFileSync(csvFilepath, [csvHeaders, ...allRows.map(r => this.rowToCSV(r))].join('\n'));

    console.log(`\nGL Export complete: ${storeData.size} stores, $${this.formatNumber(grandSales)} total sales`);

    return {
      success: true,
      date: reportDate,
      stores: storeData.size,
      totalSales: grandSales,
      tsvFilepath,
      csvFilepath,
      source: 'csv-upload'
    };
  }

  /**
   * Export GL journal from a dashboard CSV file instead of API
   * @param {string} csvPath - Path to the dashboard CSV file
   * @param {string} reportDate - Optional date filter (YYYY-MM-DD), uses all dates if not specified
   * @returns {object} Export result with file paths
   */
  async exportFromCSV(csvPath, reportDate = null) {
    // Detect date from CSV if not provided
    if (!reportDate) {
      const csvContent = fs.readFileSync(csvPath, 'utf-8');
      const records = csvParse(csvContent, { columns: true, skip_empty_lines: true });
      // Support multiple column naming conventions
      const dates = [...new Set(records.map(r =>
        r['Transaction Date'] || r['Transactions Transaction Date']
      ).filter(Boolean))];
      if (dates.length === 1) {
        reportDate = dates[0];
      } else if (dates.length > 1) {
        console.log(`Multiple dates found in CSV: ${dates.join(', ')}`);
        console.log('Using first date. Specify reportDate parameter for a specific date.');
        reportDate = dates[0];
      } else {
        throw new Error('No transaction dates found in CSV');
      }
    }

    const refNumber = `${reportDate} DS`;

    console.log(`\n=== GL Journal Export from CSV for ${reportDate} ===`);
    console.log(`Source: ${csvPath}`);

    if (!fs.existsSync(OUTPUT_DIR)) {
      fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    }

    const headerColumns = [
      'Branch',
      'Dutchie Store Name',
      'Account',
      'Description',
      'Subaccount',
      'Ref. Number',
      'Quantity',
      'UOM',
      'Debit Amount',
      'Credit Amount'
    ];

    const tsvHeaders = headerColumns.join('\t');
    const csvHeaders = headerColumns.join(',');

    const note = [
      `# GL Journal Export - ${reportDate}`,
      `# Source: Dashboard CSV (${path.basename(csvPath)})`,
      `# Generated: ${new Date().toISOString()}`,
      `# NOTE: Data imported from dashboard export, not Dutchie API.`,
      `#`
    ].join('\n');

    // Parse CSV and aggregate by store
    const storeData = this.parseCSVData(csvPath, reportDate);

    // Fetch prepaid sales for non-FL stores (where accounting export shows $0 for debit)
    const prepaidData = await this.fetchAllPrepaidSales(storeData, reportDate);

    // Apply prepaid sales to non-FL stores
    for (const [storeName, prepaid] of prepaidData) {
      if (prepaid > 0 && storeData.has(storeName)) {
        const totals = storeData.get(storeName);
        // Replace $0 debit with prepaid sales for non-FL stores
        totals.debitPaid = prepaid;
        // Recalculate overage with new debit value
        const sumDebits = totals.sumAmount + totals.sumLoyaltyPaid + totals.sumCashPaid + prepaid;
        const sumCredits = totals.sumTotalPrice + totals.sumTotalTax;
        totals.overage = sumDebits - sumCredits;
      }
    }

    const allRows = [];
    let grandSales = 0;

    for (const [storeName, totals] of storeData) {
      const branchCode = this.getBranchCode(storeName);

      console.log(`  ${storeName} (${branchCode}): $${this.formatNumber(totals.grossSales)}`);

      const rows = this.generateGLRows(branchCode, storeName, totals, refNumber);
      allRows.push(...rows);
      grandSales += totals.grossSales;
    }

    // Generate TSV file
    const tsvFilename = `gl_journal_${reportDate}_csv.tsv`;
    const tsvFilepath = path.join(OUTPUT_DIR, tsvFilename);
    const tsvContent = [note, tsvHeaders, ...allRows.map(r => this.rowToTSV(r))].join('\n');
    fs.writeFileSync(tsvFilepath, tsvContent);

    // Generate CSV file
    const csvFilename = `gl_journal_${reportDate}_csv.csv`;
    const csvFilepath = path.join(OUTPUT_DIR, csvFilename);
    const csvContent = [csvHeaders, ...allRows.map(r => this.rowToCSV(r))].join('\n');
    fs.writeFileSync(csvFilepath, csvContent);

    console.log(`\nGL Export complete: ${storeData.size} stores, $${this.formatNumber(grandSales)} total sales`);
    console.log(`Files: ${tsvFilepath}, ${csvFilepath}`);

    return {
      success: true,
      stores: storeData.size,
      totalSales: grandSales,
      tsvFilepath,
      csvFilepath,
      source: 'csv'
    };
  }

  /**
   * Parse JSON data and aggregate by location for a specific date
   * Supports both array format and object with 'data' key
   * Uses same GL mapping as parseCSVData
   *
   * @param {string} jsonPath - Path to the JSON file
   * @param {string} reportDate - Date to filter (YYYY-MM-DD format)
   * @returns {Map<string, object>} Map of store name to aggregated totals
   */
  parseJSONData(jsonPath, reportDate) {
    const jsonContent = fs.readFileSync(jsonPath, 'utf-8');
    const parsed = JSON.parse(jsonContent);

    // Support both array format and { data: [...] } format
    const records = Array.isArray(parsed) ? parsed : (parsed.data || []);

    // Aggregate by location
    const storeData = new Map();

    for (const row of records) {
      // Support multiple field naming conventions
      const txnDate = row['Transaction Date'] || row['Transactions Transaction Date'] || row.transactionDate || row.date;
      // Filter by report date if specified
      if (reportDate && txnDate !== reportDate) continue;

      const dashboardName = row['Location Name'] || row.locationName || row.storeName || row.location;
      const storeName = this.mapDashboardName(dashboardName);

      if (!storeData.has(storeName)) {
        storeData.set(storeName, {
          dashboardName,
          sumTotalPrice: 0,
          sumAmount: 0,
          sumLoyaltyPaid: 0,
          sumTotalTax: 0,
          sumDebitPaid: 0,
          sumCashPaid: 0,
          sumElectronicPaid: 0,
          sumTotalCost: 0,
          grossSales: 0,
          discounts: 0,
          loyaltySpent: 0,
          returns: 0,
          tax: 0,
          netCash: 0,
          debitPaid: 0,
          cogs: 0,
          overage: 0
        });
      }

      const totals = storeData.get(storeName);

      const totalPrice = this.parseCurrency(row['Total Price'] || row.totalPrice || 0);
      const amount = this.parseCurrency(row['Amount'] || row.amount || row.discountAmount || 0);
      const loyaltyPaid = this.parseCurrency(row['Sum Total Loyalty Paid'] || row.loyaltyPaid || 0);
      const totalTax = this.parseCurrency(row['Total Tax'] || row.totalTax || 0);
      const debitPaid = this.parseCurrency(row['Debit Paid'] || row.debitPaid || 0);
      const cashPaid = this.parseCurrency(row['Cash Paid'] || row.cashPaid || 0);
      const electronicPaid = this.parseCurrency(row['Electronic Paid'] || row.electronicPaid || 0);
      const totalCost = this.parseCurrency(row['Total Cost'] || row.totalCost || 0);

      totals.sumTotalPrice += totalPrice;
      totals.sumAmount += amount;
      totals.sumLoyaltyPaid += loyaltyPaid;
      totals.sumTotalTax += totalTax;
      totals.sumDebitPaid += debitPaid;
      totals.sumCashPaid += cashPaid;
      totals.sumElectronicPaid += electronicPaid;
      totals.sumTotalCost += totalCost;
    }

    // Calculate GL account values per specification
    for (const [storeName, totals] of storeData) {
      totals.grossSales = totals.sumTotalPrice;
      totals.discounts = totals.sumAmount;
      totals.loyaltySpent = totals.sumLoyaltyPaid;
      totals.tax = totals.sumTotalTax;
      totals.netCash = totals.sumCashPaid;
      totals.debitPaid = totals.sumDebitPaid + totals.sumElectronicPaid;
      totals.cogs = totals.sumTotalCost;

      // 70260 Overage = (Amount + Loyalty + Cash + Debit + Electronic) - (Total Price + Tax)
      const sumDebits = totals.sumAmount + totals.sumLoyaltyPaid + totals.sumCashPaid +
                        totals.sumDebitPaid + totals.sumElectronicPaid;
      const sumCredits = totals.sumTotalPrice + totals.sumTotalTax;
      totals.overage = sumDebits - sumCredits;
    }

    return storeData;
  }

  /**
   * Export GL journal from a JSON file instead of API
   * @param {string} jsonPath - Path to the JSON file
   * @param {string} reportDate - Optional date filter (YYYY-MM-DD), uses all dates if not specified
   * @returns {object} Export result with file paths
   */
  async exportFromJSON(jsonPath, reportDate = null) {
    // Detect date from JSON if not provided
    if (!reportDate) {
      const jsonContent = fs.readFileSync(jsonPath, 'utf-8');
      const parsed = JSON.parse(jsonContent);
      const records = Array.isArray(parsed) ? parsed : (parsed.data || []);
      const dates = [...new Set(records.map(r =>
        r['Transaction Date'] || r['Transactions Transaction Date'] || r.transactionDate || r.date
      ).filter(Boolean))];

      if (dates.length === 1) {
        reportDate = dates[0];
      } else if (dates.length > 1) {
        console.log(`Multiple dates found in JSON: ${dates.join(', ')}`);
        console.log('Using first date. Specify reportDate parameter for a specific date.');
        reportDate = dates[0];
      } else {
        throw new Error('No transaction dates found in JSON');
      }
    }

    const refNumber = `${reportDate} DS`;

    console.log(`\n=== GL Journal Export from JSON for ${reportDate} ===`);
    console.log(`Source: ${jsonPath}`);

    if (!fs.existsSync(OUTPUT_DIR)) {
      fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    }

    const headerColumns = [
      'Branch',
      'Dutchie Store Name',
      'Account',
      'Description',
      'Subaccount',
      'Ref. Number',
      'Quantity',
      'UOM',
      'Debit Amount',
      'Credit Amount'
    ];

    const tsvHeaders = headerColumns.join('\t');
    const csvHeaders = headerColumns.join(',');

    const note = [
      `# GL Journal Export - ${reportDate}`,
      `# Source: JSON (${path.basename(jsonPath)})`,
      `# Generated: ${new Date().toISOString()}`,
      `# NOTE: Data imported from JSON file, not Dutchie API.`,
      `#`
    ].join('\n');

    // Parse JSON and aggregate by store
    const storeData = this.parseJSONData(jsonPath, reportDate);

    // Fetch prepaid sales for non-FL stores (where accounting export shows $0 for debit)
    const prepaidData = await this.fetchAllPrepaidSales(storeData, reportDate);

    // Apply prepaid sales to non-FL stores
    for (const [storeName, prepaid] of prepaidData) {
      if (prepaid > 0 && storeData.has(storeName)) {
        const totals = storeData.get(storeName);
        // Replace $0 debit with prepaid sales for non-FL stores
        totals.debitPaid = prepaid;
        // Recalculate overage with new debit value
        const sumDebits = totals.sumAmount + totals.sumLoyaltyPaid + totals.sumCashPaid + prepaid;
        const sumCredits = totals.sumTotalPrice + totals.sumTotalTax;
        totals.overage = sumDebits - sumCredits;
      }
    }

    const allRows = [];
    let grandSales = 0;

    for (const [storeName, totals] of storeData) {
      const branchCode = this.getBranchCode(storeName);

      console.log(`  ${storeName} (${branchCode}): $${this.formatNumber(totals.grossSales)}`);

      const rows = this.generateGLRows(branchCode, storeName, totals, refNumber);
      allRows.push(...rows);
      grandSales += totals.grossSales;
    }

    // Generate TSV file
    const tsvFilename = `gl_journal_${reportDate}_json.tsv`;
    const tsvFilepath = path.join(OUTPUT_DIR, tsvFilename);
    const tsvContent = [note, tsvHeaders, ...allRows.map(r => this.rowToTSV(r))].join('\n');
    fs.writeFileSync(tsvFilepath, tsvContent);

    // Generate CSV file
    const csvFilename = `gl_journal_${reportDate}_json.csv`;
    const csvFilepath = path.join(OUTPUT_DIR, csvFilename);
    const csvContent = [csvHeaders, ...allRows.map(r => this.rowToCSV(r))].join('\n');
    fs.writeFileSync(csvFilepath, csvContent);

    console.log(`\nGL Export complete: ${storeData.size} stores, $${this.formatNumber(grandSales)} total sales`);
    console.log(`Files: ${tsvFilepath}, ${csvFilepath}`);

    return {
      success: true,
      stores: storeData.size,
      totalSales: grandSales,
      tsvFilepath,
      csvFilepath,
      source: 'json'
    };
  }

  /**
   * Parse data array and aggregate by location for a specific date
   * Works with in-memory data (from POST request body)
   * @param {Array} records - Array of sales records
   * @param {string} reportDate - Date to filter (YYYY-MM-DD format)
   * @returns {Map<string, object>} Map of store name to aggregated totals
   */
  /**
   * Parse in-memory data array and aggregate by location
   * Uses same GL mapping as parseCSVData
   */
  parseDataArray(records, reportDate) {
    // Aggregate by location
    const storeData = new Map();

    for (const row of records) {
      // Support multiple field naming conventions
      const txnDate = row['Transaction Date'] || row['Transactions Transaction Date'] || row.transactionDate || row.date;
      // Filter by report date if specified
      if (reportDate && txnDate !== reportDate) continue;

      const dashboardName = row['Location Name'] || row.locationName || row.storeName || row.location;
      const storeName = this.mapDashboardName(dashboardName);

      if (!storeData.has(storeName)) {
        storeData.set(storeName, {
          dashboardName,
          sumTotalPrice: 0,
          sumAmount: 0,
          sumLoyaltyPaid: 0,
          sumTotalTax: 0,
          sumDebitPaid: 0,
          sumCashPaid: 0,
          sumElectronicPaid: 0,
          sumTotalCost: 0,
          grossSales: 0,
          discounts: 0,
          loyaltySpent: 0,
          returns: 0,
          tax: 0,
          netCash: 0,
          debitPaid: 0,
          cogs: 0,
          overage: 0
        });
      }

      const totals = storeData.get(storeName);

      const totalPrice = this.parseCurrency(row['Total Price'] || row.totalPrice || 0);
      const amount = this.parseCurrency(row['Amount'] || row.amount || row.discountAmount || 0);
      const loyaltyPaid = this.parseCurrency(row['Sum Total Loyalty Paid'] || row.loyaltyPaid || 0);
      const totalTax = this.parseCurrency(row['Total Tax'] || row.totalTax || 0);
      const debitPaid = this.parseCurrency(row['Debit Paid'] || row.debitPaid || 0);
      const cashPaid = this.parseCurrency(row['Cash Paid'] || row.cashPaid || 0);
      const electronicPaid = this.parseCurrency(row['Electronic Paid'] || row.electronicPaid || 0);
      const totalCost = this.parseCurrency(row['Total Cost'] || row.totalCost || 0);

      totals.sumTotalPrice += totalPrice;
      totals.sumAmount += amount;
      totals.sumLoyaltyPaid += loyaltyPaid;
      totals.sumTotalTax += totalTax;
      totals.sumDebitPaid += debitPaid;
      totals.sumCashPaid += cashPaid;
      totals.sumElectronicPaid += electronicPaid;
      totals.sumTotalCost += totalCost;
    }

    // Calculate GL account values per specification
    for (const [storeName, totals] of storeData) {
      totals.grossSales = totals.sumTotalPrice;
      totals.discounts = totals.sumAmount;
      totals.loyaltySpent = totals.sumLoyaltyPaid;
      totals.tax = totals.sumTotalTax;
      totals.netCash = totals.sumCashPaid;
      totals.debitPaid = totals.sumDebitPaid + totals.sumElectronicPaid;
      totals.cogs = totals.sumTotalCost;

      // 70260 Overage = (Amount + Loyalty + Cash + Debit + Electronic) - (Total Price + Tax)
      const sumDebits = totals.sumAmount + totals.sumLoyaltyPaid + totals.sumCashPaid +
                        totals.sumDebitPaid + totals.sumElectronicPaid;
      const sumCredits = totals.sumTotalPrice + totals.sumTotalTax;
      totals.overage = sumDebits - sumCredits;
    }

    return storeData;
  }

  /**
   * Export GL journal from in-memory data (POST request body)
   * @param {Array|Object} data - Array of records or object with 'data' key
   * @param {string} reportDate - Optional date filter (YYYY-MM-DD)
   * @returns {object} Export result with file paths
   */
  async exportFromData(data, reportDate = null) {
    // Support both array format and { data: [...] } format
    const records = Array.isArray(data) ? data : (data.data || []);

    if (!records.length) {
      throw new Error('No records provided in data');
    }

    // Detect date from data if not provided
    if (!reportDate) {
      const dates = [...new Set(records.map(r =>
        r['Transaction Date'] || r['Transactions Transaction Date'] || r.transactionDate || r.date
      ).filter(Boolean))];

      if (dates.length === 1) {
        reportDate = dates[0];
      } else if (dates.length > 1) {
        console.log(`Multiple dates found in data: ${dates.join(', ')}`);
        console.log('Using first date. Specify reportDate parameter for a specific date.');
        reportDate = dates[0];
      } else {
        throw new Error('No transaction dates found in data');
      }
    }

    const refNumber = `${reportDate} DS`;

    console.log(`\n=== GL Journal Export from POST data for ${reportDate} ===`);
    console.log(`Records received: ${records.length}`);

    if (!fs.existsSync(OUTPUT_DIR)) {
      fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    }

    const headerColumns = [
      'Branch',
      'Dutchie Store Name',
      'Account',
      'Description',
      'Subaccount',
      'Ref. Number',
      'Quantity',
      'UOM',
      'Debit Amount',
      'Credit Amount'
    ];

    const tsvHeaders = headerColumns.join('\t');
    const csvHeaders = headerColumns.join(',');

    const note = [
      `# GL Journal Export - ${reportDate}`,
      `# Source: POST request data`,
      `# Generated: ${new Date().toISOString()}`,
      `# NOTE: Data imported from request body, not Dutchie API.`,
      `#`
    ].join('\n');

    // Parse data and aggregate by store
    const storeData = this.parseDataArray(records, reportDate);

    // Fetch prepaid sales for non-FL stores (where accounting export shows $0 for debit)
    const prepaidData = await this.fetchAllPrepaidSales(storeData, reportDate);

    // Apply prepaid sales to non-FL stores
    for (const [storeName, prepaid] of prepaidData) {
      if (prepaid > 0 && storeData.has(storeName)) {
        const totals = storeData.get(storeName);
        // Replace $0 debit with prepaid sales for non-FL stores
        totals.debitPaid = prepaid;
        // Recalculate overage with new debit value
        const sumDebits = totals.sumAmount + totals.sumLoyaltyPaid + totals.sumCashPaid + prepaid;
        const sumCredits = totals.sumTotalPrice + totals.sumTotalTax;
        totals.overage = sumDebits - sumCredits;
      }
    }

    const allRows = [];
    let grandSales = 0;

    for (const [storeName, totals] of storeData) {
      const branchCode = this.getBranchCode(storeName);

      console.log(`  ${storeName} (${branchCode}): $${this.formatNumber(totals.grossSales)}`);

      const rows = this.generateGLRows(branchCode, storeName, totals, refNumber);
      allRows.push(...rows);
      grandSales += totals.grossSales;
    }

    // Generate TSV file
    const tsvFilename = `gl_journal_${reportDate}_post.tsv`;
    const tsvFilepath = path.join(OUTPUT_DIR, tsvFilename);
    const tsvContent = [note, tsvHeaders, ...allRows.map(r => this.rowToTSV(r))].join('\n');
    fs.writeFileSync(tsvFilepath, tsvContent);

    // Generate CSV file
    const csvFilename = `gl_journal_${reportDate}_post.csv`;
    const csvFilepath = path.join(OUTPUT_DIR, csvFilename);
    const csvContent = [csvHeaders, ...allRows.map(r => this.rowToCSV(r))].join('\n');
    fs.writeFileSync(csvFilepath, csvContent);

    console.log(`\nGL Export complete: ${storeData.size} stores, $${this.formatNumber(grandSales)} total sales`);
    console.log(`Files: ${tsvFilepath}, ${csvFilepath}`);

    return {
      success: true,
      stores: storeData.size,
      totalSales: grandSales,
      tsvFilepath,
      csvFilepath,
      source: 'post'
    };
  }

  generateGLRows(branchCode, dutchieStoreName, totals, refNumber) {
    const rows = [];

    for (const account of ACCOUNTS) {
      let debit = 0;
      let credit = 0;
      const value = totals[account.field] || 0;

      if (account.code === '70260') {
        // Overage = (Amount + Loyalty + Cash + Debit + Electronic) - (Total Price + Tax)
        // Always put in credit column (can be negative for shortage) to match auditor format
        credit = totals.overage;
      } else if (account.type === 'debit') {
        debit = value;
      } else if (account.type === 'credit') {
        credit = value;
      }

      rows.push({
        branchCode,
        dutchieStoreName,
        accountCode: account.code,
        accountDesc: account.desc,
        subaccount: account.subacct || '00-00',
        refNumber,
        quantity: '1.00',
        uom: '',
        debit: this.formatNumber(debit),
        credit: this.formatNumber(credit)
      });
    }

    return rows;
  }

  rowToTSV(row) {
    return [
      row.branchCode,
      row.dutchieStoreName,
      row.accountCode,
      row.accountDesc,
      row.subaccount,
      row.refNumber,
      row.quantity,
      row.uom,
      row.debit,
      row.credit
    ].join('\t');
  }

  rowToCSV(row) {
    return [
      this.escapeCSV(row.branchCode),
      this.escapeCSV(row.dutchieStoreName),
      this.escapeCSV(row.accountCode),
      this.escapeCSV(row.accountDesc),
      this.escapeCSV(row.subaccount),
      this.escapeCSV(row.refNumber),
      this.escapeCSV(row.quantity),
      this.escapeCSV(row.uom),
      this.escapeCSV(row.debit),
      this.escapeCSV(row.credit)
    ].join(',');
  }

  async exportForDate(reportDate) {
    const refNumber = `${reportDate} DS`;

    console.log(`\n=== GL Journal Export for ${reportDate} (using local timezone boundaries) ===`);

    if (!fs.existsSync(OUTPUT_DIR)) {
      fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    }

    const headerColumns = [
      'Branch',
      'Dutchie Store Name',
      'Account',
      'Description',
      'Subaccount',
      'Ref. Number',
      'Quantity',
      'UOM',
      'Debit Amount',
      'Credit Amount'
    ];

    const tsvHeaders = headerColumns.join('\t');
    const csvHeaders = headerColumns.join(',');

    const note = [
      `# GL Journal Export - ${reportDate}`,
      `# Source of Truth: Dutchie POS API (/reporting/transactions)`,
      `# Generated: ${new Date().toISOString()}`,
      `# NOTE: Transactions are fetched using local timezone boundaries (midnight-to-midnight).`,
      `# Branch codes in this export are derived from Dutchie location names.`,
      `#`
    ].join('\n');

    const allRows = [];
    const failedStores = [];
    let grandSales = 0;
    let successCount = 0;

    for (const loc of this.locationConfigs) {
      const branchCode = this.getBranchCode(loc.name);
      const timezone = this.getStoreTimezone(loc.name);

      // Fetch with extended range to capture edge cases, then filter by local time
      // This ensures we don't miss transactions at day boundaries due to timezone differences
      const { fromDateUTC, toDateUTC } = this.getExtendedBoundariesUTC(reportDate, timezone);

      process.stdout.write(`  ${loc.name} (${branchCode})... `);

      const result = await this.fetchTransactions(loc.apiKey, loc.name, fromDateUTC, toDateUTC);

      if (!result.success) {
        console.log(`FAILED: ${result.error}`);
        failedStores.push({ store: loc.name, error: result.error });
        continue;
      }

      // Filter transactions by local time date (transactionDateLocalTime)
      // The auditor uses local time for day boundaries, not UTC
      // Some transactions may have null transactionDateLocalTime - convert from UTC as fallback
      const transactions = result.data.filter(t => {
        let localDate = (t.transactionDateLocalTime || '').slice(0, 10);
        // Fallback: convert UTC transactionDate to local timezone if localTime is missing
        if (!localDate && t.transactionDate) {
          localDate = new Date(t.transactionDate).toLocaleDateString('en-CA', { timeZone: timezone });
        }
        return localDate === reportDate;
      });
      const totals = this.aggregateTransactions(transactions, reportDate, loc.name);
      const rows = this.generateGLRows(branchCode, loc.name, totals, refNumber);

      allRows.push(...rows);
      grandSales += totals.grossSales;
      successCount++;

      console.log(`${transactions.length} txns, $${this.formatNumber(totals.grossSales)}`);
    }

    // Generate TSV file
    const tsvFilename = `gl_journal_${reportDate}.tsv`;
    const tsvFilepath = path.join(OUTPUT_DIR, tsvFilename);
    const tsvContent = [note, tsvHeaders, ...allRows.map(r => this.rowToTSV(r))].join('\n');
    fs.writeFileSync(tsvFilepath, tsvContent);

    // Generate CSV file
    const csvFilename = `gl_journal_${reportDate}.csv`;
    const csvFilepath = path.join(OUTPUT_DIR, csvFilename);
    const csvContent = [csvHeaders, ...allRows.map(r => this.rowToCSV(r))].join('\n');
    fs.writeFileSync(csvFilepath, csvContent);

    console.log(`\nGL Export complete: ${successCount}/${this.locationConfigs.length} stores, $${this.formatNumber(grandSales)} total sales`);
    console.log(`Files: ${tsvFilepath}, ${csvFilepath}`);

    if (failedStores.length > 0) {
      console.error(`WARNING: ${failedStores.length} store(s) failed:`);
      failedStores.forEach(f => console.error(`  - ${f.store}: ${f.error}`));
      return { success: false, failedStores, tsvFilepath, csvFilepath };
    }

    return { success: true, stores: successCount, totalSales: grandSales, tsvFilepath, csvFilepath };
  }

  async exportYesterday() {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const reportDate = yesterday.toISOString().split('T')[0];
    return this.exportForDate(reportDate);
  }

  async sendEmail(tsvFilepath, csvFilepath, reportDate, summary) {
    // Check if email is configured
    const smtpHost = process.env.SMTP_HOST;
    const smtpPort = process.env.SMTP_PORT || 587;
    const smtpUser = process.env.SMTP_USER;
    const smtpPass = process.env.SMTP_PASS;
    const emailTo = process.env.GL_EMAIL_TO;
    const emailFrom = process.env.GL_EMAIL_FROM || smtpUser;

    if (!smtpHost || !smtpUser || !emailTo) {
      console.log('Email not configured - skipping email delivery');
      console.log('Required env vars: SMTP_HOST, SMTP_USER, SMTP_PASS, GL_EMAIL_TO');
      return { sent: false, reason: 'not configured' };
    }

    const transporter = nodemailer.createTransport({
      host: smtpHost,
      port: smtpPort,
      secure: smtpPort === 465,
      auth: {
        user: smtpUser,
        pass: smtpPass
      }
    });

    const recipients = emailTo.split(',').map(e => e.trim());

    const mailOptions = {
      from: emailFrom,
      to: recipients,
      subject: `GL Journal Export - ${reportDate}`,
      text: `GL Journal Export for ${reportDate}

Source: Dutchie POS API
Generated: ${new Date().toISOString()}

Summary:
- Stores: ${summary.stores}
- Total Sales: $${this.formatNumber(summary.totalSales)}
- Status: ${summary.success ? 'SUCCESS' : 'COMPLETED WITH ERRORS'}

The GL journal file is attached (CSV format).

---
This is an automated report from Mint Inventory Sync Service.
`,
      html: `
<h2>GL Journal Export - ${reportDate}</h2>
<p><strong>Source:</strong> Dutchie POS API<br>
<strong>Generated:</strong> ${new Date().toISOString()}</p>

<h3>Summary</h3>
<table border="1" cellpadding="8" cellspacing="0">
  <tr><td><strong>Stores</strong></td><td>${summary.stores}</td></tr>
  <tr><td><strong>Total Sales</strong></td><td>$${this.formatNumber(summary.totalSales)}</td></tr>
  <tr><td><strong>Status</strong></td><td>${summary.success ? '✓ SUCCESS' : '⚠ COMPLETED WITH ERRORS'}</td></tr>
</table>

<p>The GL journal file is attached (CSV format).</p>

<hr>
<p style="color: #666; font-size: 12px;">This is an automated report from Mint Inventory Sync Service.</p>
`,
      attachments: [
        {
          filename: path.basename(csvFilepath),
          path: csvFilepath
        }
      ]
    };

    try {
      const info = await transporter.sendMail(mailOptions);
      console.log(`Email sent to ${recipients.join(', ')}: ${info.messageId}`);
      return { sent: true, messageId: info.messageId, recipients };
    } catch (error) {
      console.error('Failed to send email:', error.message);
      return { sent: false, error: error.message };
    }
  }

  async exportAndEmail(reportDate = null) {
    // If no date provided, use yesterday
    if (!reportDate) {
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      reportDate = yesterday.toISOString().split('T')[0];
    }

    const result = await this.exportForDate(reportDate);

    // Send email with both TSV and CSV attachments
    const emailResult = await this.sendEmail(result.tsvFilepath, result.csvFilepath, reportDate, {
      stores: result.stores || 0,
      totalSales: result.totalSales || 0,
      success: result.success
    });

    return { ...result, email: emailResult };
  }
}

module.exports = GLExportService;
