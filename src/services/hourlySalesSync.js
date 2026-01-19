/**
 * Hourly Sales Sync Service
 * Fetches transactions from the last hour and stores aggregates in PostgreSQL
 * Runs every hour via scheduler
 */

const axios = require('axios');
const db = require('../db');

const DUTCHIE_API_URL = process.env.DUTCHIE_API_URL || 'https://api.pos.dutchie.com';

// Branch code mapping (reused from GL export)
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
  'Mint Mt Pleasant': 'MID-MT',
  'Mint Mount Pleasant': 'MID-MT',
  // Arizona (AZD-/AZV-)
  'Mint Mesa': 'AZD-4245IN',
  'Mint Mesa ': 'AZD-4245IN',
  'Mint Bell Road Phoenix': 'AZD-UH',
  'Mint 75th Ave Phoenix': 'AZV-ENCANT',
  'Mint Buckeye/Verado': 'AZD-BUCK',
  'Mint El Mirage': 'AZD-ELMIRA',
  'Mint Northern Phoenix': 'AZV-GTL',
  'Mint Scottsdale': 'AZV-EBA',
  'Mint Tempe': 'AZV-SWT',
  'Mint Power Road': 'AZD-120PR',
  'Mint Gilbert': 'AZD-120PR',
  // Nevada (NVD-)
  'Mint Spring Valley': 'NVD-RAIN',
  'Mint Las Vegas Strip': 'NVD-PARA',
  'Mint Las Vegas Strip ': 'NVD-PARA',
  // Missouri (MOD-)
  'Mint St. Peters': 'MOD-MO4',
  // Illinois (ILD-)
  'Mint Willowbrook': 'ILD-WILLOW'
};

class HourlySalesSyncService {
  constructor(locationConfigs) {
    this.locationConfigs = locationConfigs;
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
   * Calculate the previous hour's time range in UTC
   * @returns {{ hourStart: Date, hourEnd: Date, fromDateUTC: string, toDateUTC: string }}
   */
  getPreviousHourRange() {
    const now = new Date();

    // Start of the previous hour
    const hourStart = new Date(now);
    hourStart.setUTCMinutes(0, 0, 0);
    hourStart.setUTCHours(hourStart.getUTCHours() - 1);

    // End of the previous hour (start of current hour - 1ms)
    const hourEnd = new Date(hourStart);
    hourEnd.setUTCHours(hourEnd.getUTCHours() + 1);
    hourEnd.setUTCMilliseconds(hourEnd.getUTCMilliseconds() - 1);

    return {
      hourStart,
      hourEnd,
      fromDateUTC: hourStart.toISOString(),
      toDateUTC: hourEnd.toISOString()
    };
  }

  /**
   * Fetch transactions for a specific hour from Dutchie API
   */
  async fetchTransactions(apiKey, storeName, fromDateUTC, toDateUTC, attempt = 1) {
    const client = axios.create({
      baseURL: DUTCHIE_API_URL,
      auth: { username: apiKey, password: '' }
    });

    const params = {
      FromDateUTC: fromDateUTC,
      ToDateUTC: toDateUTC,
      IncludeDetail: false,
      IncludeTaxes: true,
      IncludeOrderIds: false
    };

    try {
      const response = await client.get('/reporting/transactions', { params, timeout: 60000 });
      return { success: true, data: response.data || [] };
    } catch (error) {
      const errorMsg = error.response?.status || error.message;
      if (attempt === 1) {
        await new Promise(r => setTimeout(r, 2000));
        return this.fetchTransactions(apiKey, storeName, fromDateUTC, toDateUTC, 2);
      }
      return { success: false, error: errorMsg };
    }
  }

  /**
   * Aggregate transactions into hourly totals
   */
  aggregateTransactions(transactions) {
    const totals = {
      grossSales: 0,
      discounts: 0,
      returns: 0,
      tax: 0,
      transactionCount: 0,
      cashPaid: 0,
      debitPaid: 0,
      loyaltySpent: 0
    };

    for (const t of transactions) {
      if (t.isVoid) continue;

      if (t.isReturn) {
        totals.returns += Math.abs(t.total || 0);
      } else {
        totals.grossSales += t.subtotal || 0;
        totals.discounts += t.totalDiscount || 0;
        totals.tax += t.tax || 0;
        totals.cashPaid += (t.cashPaid || 0) - (t.changeDue || 0);
        totals.debitPaid += t.debitPaid || 0;
        totals.loyaltySpent += t.loyaltySpent || 0;
        totals.transactionCount += 1;
      }
    }

    totals.netSales = totals.grossSales - totals.discounts - totals.returns;

    return totals;
  }

  /**
   * Upsert hourly sales data to PostgreSQL
   */
  async upsertHourlySales(locationId, branchCode, storeName, hourStart, hourEnd, totals) {
    const query = `
      INSERT INTO hourly_sales (
        location_id, branch_code, store_name, hour_start, hour_end,
        gross_sales, discounts, returns, net_sales, tax,
        transaction_count, cash_paid, debit_paid, loyalty_spent,
        updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, NOW())
      ON CONFLICT (location_id, hour_start)
      DO UPDATE SET
        gross_sales = EXCLUDED.gross_sales,
        discounts = EXCLUDED.discounts,
        returns = EXCLUDED.returns,
        net_sales = EXCLUDED.net_sales,
        tax = EXCLUDED.tax,
        transaction_count = EXCLUDED.transaction_count,
        cash_paid = EXCLUDED.cash_paid,
        debit_paid = EXCLUDED.debit_paid,
        loyalty_spent = EXCLUDED.loyalty_spent,
        updated_at = NOW()
    `;

    const values = [
      locationId,
      branchCode,
      storeName,
      hourStart,
      hourEnd,
      totals.grossSales,
      totals.discounts,
      totals.returns,
      totals.netSales,
      totals.tax,
      totals.transactionCount,
      totals.cashPaid,
      totals.debitPaid,
      totals.loyaltySpent
    ];

    await db.query(query, values);
  }

  /**
   * Sync hourly sales for all stores
   * @param {Date} hourStart - Optional specific hour to sync (defaults to previous hour)
   * @param {Date} hourEnd - Optional end time
   */
  async syncHourlySales(hourStart = null, hourEnd = null) {
    let timeRange;

    if (hourStart && hourEnd) {
      timeRange = {
        hourStart,
        hourEnd,
        fromDateUTC: hourStart.toISOString(),
        toDateUTC: hourEnd.toISOString()
      };
    } else {
      timeRange = this.getPreviousHourRange();
    }

    const { fromDateUTC, toDateUTC } = timeRange;
    const hourLabel = timeRange.hourStart.toISOString().slice(0, 16).replace('T', ' ');

    console.log(`\n[Hourly Sales Sync] Fetching data for hour: ${hourLabel} UTC`);

    const results = {
      success: 0,
      failed: 0,
      totalTransactions: 0,
      totalSales: 0,
      errors: []
    };

    for (const loc of this.locationConfigs) {
      if (!loc.dutchieApiKey || !loc.is_active) continue;

      const branchCode = this.getBranchCode(loc.name);

      try {
        const result = await this.fetchTransactions(
          loc.dutchieApiKey,
          loc.name,
          fromDateUTC,
          toDateUTC
        );

        if (!result.success) {
          console.log(`  ${loc.name}: FAILED - ${result.error}`);
          results.failed++;
          results.errors.push({ store: loc.name, error: result.error });
          continue;
        }

        const totals = this.aggregateTransactions(result.data);

        await this.upsertHourlySales(
          loc.id,
          branchCode,
          loc.name,
          timeRange.hourStart,
          timeRange.hourEnd,
          totals
        );

        results.success++;
        results.totalTransactions += totals.transactionCount;
        results.totalSales += totals.grossSales;

        if (totals.transactionCount > 0) {
          console.log(`  ${loc.name}: ${totals.transactionCount} txns, $${totals.grossSales.toFixed(2)}`);
        }
      } catch (error) {
        console.log(`  ${loc.name}: ERROR - ${error.message}`);
        results.failed++;
        results.errors.push({ store: loc.name, error: error.message });
      }
    }

    console.log(`[Hourly Sales Sync] Complete: ${results.success} stores, ${results.totalTransactions} txns, $${results.totalSales.toFixed(2)} sales`);

    if (results.failed > 0) {
      console.log(`[Hourly Sales Sync] WARNING: ${results.failed} store(s) failed`);
    }

    return results;
  }

  /**
   * Backfill hourly sales for a date range
   * @param {string} startDate - YYYY-MM-DD
   * @param {string} endDate - YYYY-MM-DD (optional, defaults to startDate)
   */
  async backfill(startDate, endDate = null) {
    const start = new Date(startDate + 'T00:00:00Z');
    const end = endDate ? new Date(endDate + 'T23:59:59Z') : new Date(startDate + 'T23:59:59Z');

    console.log(`\n[Hourly Sales Backfill] ${startDate} to ${endDate || startDate}`);

    let currentHour = new Date(start);
    let hoursProcessed = 0;

    while (currentHour < end) {
      const hourStart = new Date(currentHour);
      const hourEnd = new Date(currentHour);
      hourEnd.setUTCHours(hourEnd.getUTCHours() + 1);
      hourEnd.setUTCMilliseconds(hourEnd.getUTCMilliseconds() - 1);

      await this.syncHourlySales(hourStart, hourEnd);

      hoursProcessed++;
      currentHour.setUTCHours(currentHour.getUTCHours() + 1);
    }

    console.log(`[Hourly Sales Backfill] Complete: ${hoursProcessed} hours processed`);
    return { hoursProcessed };
  }
}

module.exports = HourlySalesSyncService;
