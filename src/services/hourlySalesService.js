/**
 * Hourly Sales Report Service
 * Generates weekly sales reports aggregated by hour and store
 * Source of Truth: Dutchie POS API (/reporting/transactions)
 */

const axios = require('axios');
const fs = require('fs');
const path = require('path');

const DUTCHIE_API_URL = process.env.DUTCHIE_API_URL || 'https://api.pos.dutchie.com';
const OUTPUT_DIR = process.env.GL_EXPORT_DIR || './exports';

// Dutchie to Accumatica branch code mapping (reused from GLExportService)
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

// Timezone offsets from UTC (standard time, not DST)
// transactionDate from Dutchie is in local store time, need to convert to UTC
// Positive offset means behind UTC (e.g., EST is UTC-5, so offset is 5)
const TIMEZONE_OFFSETS = {
  // Florida - Eastern (UTC-5, UTC-4 DST)
  'FLD-': 5,
  // Michigan - Eastern (UTC-5, UTC-4 DST)
  'MID-': 5,
  'MI-': 5,
  // Arizona - Mountain, no DST (UTC-7 year-round)
  'AZD-': 7,
  'AZV-': 7,
  // Nevada - Pacific (UTC-8, UTC-7 DST)
  'NVD-': 8,
  // Missouri - Central (UTC-6, UTC-5 DST)
  'MOD-': 6,
  // Illinois - Central (UTC-6, UTC-5 DST)
  'ILD-': 6
};

class HourlySalesService {
  constructor(locationConfigs) {
    this.locationConfigs = locationConfigs;
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

  async fetchTransactions(apiKey, storeName, fromDate, toDate, attempt = 1) {
    const client = axios.create({
      baseURL: DUTCHIE_API_URL,
      auth: { username: apiKey, password: '' }
    });

    const params = {
      FromDateUTC: fromDate,
      ToDateUTC: toDate,
      IncludeDetail: false,
      IncludeTaxes: true,
      IncludeOrderIds: false
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
   * Get timezone offset for a store based on branch code prefix
   * @param {string} branchCode - Store branch code (e.g., "MID-KALAMA")
   * @returns {number} Hours offset from UTC (positive = behind UTC)
   */
  getTimezoneOffset(branchCode) {
    for (const [prefix, offset] of Object.entries(TIMEZONE_OFFSETS)) {
      if (branchCode.startsWith(prefix)) {
        return offset;
      }
    }
    return 5; // Default to Eastern
  }

  /**
   * Check if a date is in US Daylight Saving Time
   * DST starts: Second Sunday in March at 2am
   * DST ends: First Sunday in November at 2am
   * @param {Date} date
   * @returns {boolean}
   */
  isDST(date) {
    const year = date.getFullYear();

    // Second Sunday in March
    const marchFirst = new Date(year, 2, 1);
    const dstStart = new Date(year, 2, 14 - marchFirst.getDay(), 2);

    // First Sunday in November
    const novFirst = new Date(year, 10, 1);
    const dstEnd = new Date(year, 10, 7 - novFirst.getDay(), 2);

    return date >= dstStart && date < dstEnd;
  }

  /**
   * Parse transaction timestamp to extract UTC date and hour
   * transactionDate from Dutchie is in local store time, not UTC
   * @param {string} transactionDate - ISO timestamp in LOCAL store time (e.g., "2026-01-12T19:02:15.477")
   * @param {string} branchCode - Store branch code for timezone lookup
   * @returns {{ dayKey: string, hour: number }}
   */
  parseDayAndHour(transactionDate, branchCode) {
    // Parse the timestamp components directly (don't rely on JS Date timezone handling)
    // Format: "2026-01-12T19:02:15.477"
    const [datePart, timePart] = transactionDate.split('T');
    const [year, month, day] = datePart.split('-').map(Number);
    const [hourStr] = timePart.split(':');
    const localHour = parseInt(hourStr, 10);

    // Get base timezone offset for the store (hours behind UTC)
    let offsetHours = this.getTimezoneOffset(branchCode);

    // Check for DST (Arizona doesn't observe it)
    const isArizona = branchCode.startsWith('AZ');
    const localDate = new Date(year, month - 1, day);
    if (!isArizona && this.isDST(localDate)) {
      offsetHours -= 1; // DST: clocks move forward, so offset is 1 hour less
    }

    // Convert local hour to UTC by adding offset
    let utcHour = localHour + offsetHours;
    let utcDay = day;
    let utcMonth = month;
    let utcYear = year;

    // Handle day overflow
    if (utcHour >= 24) {
      utcHour -= 24;
      utcDay += 1;
      // Handle month overflow (simplified - doesn't handle all edge cases but good enough)
      const daysInMonth = new Date(utcYear, utcMonth, 0).getDate();
      if (utcDay > daysInMonth) {
        utcDay = 1;
        utcMonth += 1;
        if (utcMonth > 12) {
          utcMonth = 1;
          utcYear += 1;
        }
      }
    }

    const dayKey = `${utcYear}-${String(utcMonth).padStart(2, '0')}-${String(utcDay).padStart(2, '0')}`;

    return {
      dayKey,
      hour: utcHour
    };
  }

  /**
   * Create empty hourly structure for a single day
   */
  createEmptyHourlyData() {
    const hourly = {};
    for (let h = 0; h < 24; h++) {
      hourly[h] = {
        sales: 0,
        transactions: 0,
        discounts: 0,
        tax: 0,
        returns: 0
      };
    }
    return hourly;
  }

  /**
   * Aggregate transactions by day and hour (168 data points for 7 days)
   * @param {Array} transactions - Array of transaction objects
   * @param {Array<string>} days - Array of day keys (YYYY-MM-DD) in UTC
   * @param {string} branchCode - Store branch code for timezone conversion
   * @returns {Object} { "YYYY-MM-DD": { 0: {...}, 1: {...}, ... 23: {...} } }
   */
  aggregateByDayAndHour(transactions, days, branchCode) {
    // Initialize structure with zeros for all days/hours
    const dayHourData = {};
    for (const day of days) {
      dayHourData[day] = this.createEmptyHourlyData();
    }

    // Aggregate transactions
    for (const t of transactions) {
      if (t.isVoid) continue;

      // Convert local store time to UTC
      const { dayKey, hour } = this.parseDayAndHour(t.transactionDate, branchCode);

      // Skip if transaction is outside our date range
      if (!dayHourData[dayKey]) continue;

      if (t.isReturn) {
        dayHourData[dayKey][hour].returns += Math.abs(t.total || 0);
      } else {
        dayHourData[dayKey][hour].sales += t.subtotal || 0;
        dayHourData[dayKey][hour].transactions += 1;
        dayHourData[dayKey][hour].discounts += t.totalDiscount || 0;
        dayHourData[dayKey][hour].tax += t.tax || 0;
      }
    }

    return dayHourData;
  }

  /**
   * Combine day-hour data into 24 hourly totals (sum across all days)
   * @param {Object} dayHourData - From aggregateByDayAndHour
   * @returns {Object} { 0: {...}, 1: {...}, ... 23: {...} }
   */
  combineWeeklyHours(dayHourData) {
    const hourlyTotals = this.createEmptyHourlyData();

    for (const dayKey of Object.keys(dayHourData)) {
      for (let h = 0; h < 24; h++) {
        hourlyTotals[h].sales += dayHourData[dayKey][h].sales;
        hourlyTotals[h].transactions += dayHourData[dayKey][h].transactions;
        hourlyTotals[h].discounts += dayHourData[dayKey][h].discounts;
        hourlyTotals[h].tax += dayHourData[dayKey][h].tax;
        hourlyTotals[h].returns += dayHourData[dayKey][h].returns;
      }
    }

    return hourlyTotals;
  }

  /**
   * Calculate summary totals for a store
   */
  calculateSummary(dayHourData) {
    const summary = {
      totalSales: 0,
      totalTransactions: 0,
      totalDiscounts: 0,
      totalTax: 0,
      totalReturns: 0
    };

    for (const dayKey of Object.keys(dayHourData)) {
      for (let h = 0; h < 24; h++) {
        summary.totalSales += dayHourData[dayKey][h].sales;
        summary.totalTransactions += dayHourData[dayKey][h].transactions;
        summary.totalDiscounts += dayHourData[dayKey][h].discounts;
        summary.totalTax += dayHourData[dayKey][h].tax;
        summary.totalReturns += dayHourData[dayKey][h].returns;
      }
    }

    summary.netSales = summary.totalSales - summary.totalDiscounts - summary.totalReturns;
    return summary;
  }

  /**
   * Calculate date range and list of days
   * @param {string} startDate - YYYY-MM-DD
   * @param {string} endDate - YYYY-MM-DD (optional, defaults to startDate + 6 days)
   */
  calculateDateRange(startDate, endDate = null) {
    const start = new Date(startDate + 'T00:00:00Z');

    let end;
    if (endDate) {
      end = new Date(endDate + 'T23:59:59Z');
    } else {
      end = new Date(start);
      end.setUTCDate(end.getUTCDate() + 6);
      end.setUTCHours(23, 59, 59, 999);
    }

    // Generate list of days for aggregation
    // Include one extra day at the end to capture transactions that fall on
    // the next UTC day due to timezone conversion (e.g., 11pm MST = 6am UTC next day)
    const days = [];
    const current = new Date(start);
    const endPlusBuffer = new Date(end);
    endPlusBuffer.setUTCDate(endPlusBuffer.getUTCDate() + 1);

    while (current <= endPlusBuffer) {
      days.push(current.toISOString().split('T')[0]);
      current.setUTCDate(current.getUTCDate() + 1);
    }

    return {
      fromDate: start.toISOString(),
      toDate: end.toISOString(),
      startDate: start.toISOString().split('T')[0],
      endDate: end.toISOString().split('T')[0],
      days,  // Includes buffer day for timezone handling
      reportDays: days.slice(0, -1)  // Actual days to report (without buffer)
    };
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
   * Format number for CSV (no thousands separator)
   */
  formatCSVNumber(num) {
    return num.toFixed(2);
  }

  /**
   * Generate CSV rows for aggregated view (24 rows per store)
   */
  generateAggregatedRows(branchCode, storeName, hourlyTotals) {
    const rows = [];
    for (let h = 0; h < 24; h++) {
      const data = hourlyTotals[h];
      const netSales = data.sales - data.discounts - data.returns;
      rows.push([
        this.escapeCSV(branchCode),
        this.escapeCSV(storeName),
        h,
        this.formatCSVNumber(data.sales),
        data.transactions,
        this.formatCSVNumber(data.discounts),
        this.formatCSVNumber(data.tax),
        this.formatCSVNumber(data.returns),
        this.formatCSVNumber(netSales)
      ].join(','));
    }
    return rows;
  }

  /**
   * Generate CSV rows for detailed view (168 rows per store for 7 days)
   */
  generateDetailedRows(branchCode, storeName, dayHourData, days) {
    const rows = [];
    for (const day of days) {
      for (let h = 0; h < 24; h++) {
        const data = dayHourData[day][h];
        const netSales = data.sales - data.discounts - data.returns;
        rows.push([
          this.escapeCSV(branchCode),
          this.escapeCSV(storeName),
          day,
          h,
          this.formatCSVNumber(data.sales),
          data.transactions,
          this.formatCSVNumber(data.discounts),
          this.formatCSVNumber(data.tax),
          this.formatCSVNumber(data.returns),
          this.formatCSVNumber(netSales)
        ].join(','));
      }
    }
    return rows;
  }

  /**
   * Export data to CSV/TSV files
   */
  async exportToFiles(storesData, dateRange) {
    if (!fs.existsSync(OUTPUT_DIR)) {
      fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    }

    const { startDate, endDate, reportDays } = dateRange;
    const fileSuffix = `${startDate}_to_${endDate}`;

    // Aggregated file
    const aggHeaders = 'Branch,Store Name,Hour (UTC),Sales,Transactions,Discounts,Tax,Returns,Net Sales';
    const aggRows = [];
    for (const store of storesData) {
      aggRows.push(...this.generateAggregatedRows(store.branchCode, store.storeName, store.aggregatedHourly));
    }
    const aggCsvPath = path.join(OUTPUT_DIR, `hourly_sales_aggregated_${fileSuffix}.csv`);
    const aggTsvPath = path.join(OUTPUT_DIR, `hourly_sales_aggregated_${fileSuffix}.tsv`);
    fs.writeFileSync(aggCsvPath, [aggHeaders, ...aggRows].join('\n'));
    fs.writeFileSync(aggTsvPath, [aggHeaders.replace(/,/g, '\t'), ...aggRows.map(r => r.replace(/,/g, '\t'))].join('\n'));

    // Detailed file - only include requested days (not buffer day)
    const detHeaders = 'Branch,Store Name,Date,Hour (UTC),Sales,Transactions,Discounts,Tax,Returns,Net Sales';
    const detRows = [];
    for (const store of storesData) {
      detRows.push(...this.generateDetailedRows(store.branchCode, store.storeName, store.detailedByDayHour, reportDays));
    }
    const detCsvPath = path.join(OUTPUT_DIR, `hourly_sales_detailed_${fileSuffix}.csv`);
    const detTsvPath = path.join(OUTPUT_DIR, `hourly_sales_detailed_${fileSuffix}.tsv`);
    fs.writeFileSync(detCsvPath, [detHeaders, ...detRows].join('\n'));
    fs.writeFileSync(detTsvPath, [detHeaders.replace(/,/g, '\t'), ...detRows.map(r => r.replace(/,/g, '\t'))].join('\n'));

    return {
      aggregated: { csv: aggCsvPath, tsv: aggTsvPath },
      detailed: { csv: detCsvPath, tsv: detTsvPath }
    };
  }

  /**
   * Generate weekly hourly sales report
   * @param {string} startDate - YYYY-MM-DD
   * @param {string} endDate - YYYY-MM-DD (optional)
   * @param {string} storeId - Optional filter to single store
   */
  async generateWeeklyReport(startDate, endDate = null, storeId = null) {
    const dateRange = this.calculateDateRange(startDate, endDate);
    const { fromDate, toDate, days } = dateRange;

    console.log(`\n=== Weekly Hourly Sales Report: ${dateRange.startDate} to ${dateRange.endDate} ===`);

    // Filter stores if storeId provided
    let stores = this.locationConfigs;
    if (storeId) {
      stores = stores.filter(s => s.id === storeId);
      if (stores.length === 0) {
        return { success: false, error: `Store not found: ${storeId}` };
      }
    }

    const storesData = [];
    const failedStores = [];
    const grandTotals = {
      totalSales: 0,
      totalTransactions: 0,
      totalDiscounts: 0,
      totalTax: 0,
      totalReturns: 0
    };

    for (const loc of stores) {
      const branchCode = this.getBranchCode(loc.name);
      process.stdout.write(`  ${loc.name} (${branchCode})... `);

      const result = await this.fetchTransactions(loc.apiKey, loc.name, fromDate, toDate);

      if (!result.success) {
        console.log(`FAILED: ${result.error}`);
        failedStores.push({ store: loc.name, storeId: loc.id, error: result.error });
        continue;
      }

      const transactions = result.data;
      const detailedByDayHour = this.aggregateByDayAndHour(transactions, days, branchCode);
      const aggregatedHourly = this.combineWeeklyHours(detailedByDayHour);
      const summary = this.calculateSummary(detailedByDayHour);

      // Accumulate grand totals
      grandTotals.totalSales += summary.totalSales;
      grandTotals.totalTransactions += summary.totalTransactions;
      grandTotals.totalDiscounts += summary.totalDiscounts;
      grandTotals.totalTax += summary.totalTax;
      grandTotals.totalReturns += summary.totalReturns;

      storesData.push({
        storeId: loc.id,
        storeName: loc.name,
        branchCode,
        aggregatedHourly,
        detailedByDayHour,
        summary,
        transactionCount: transactions.length
      });

      console.log(`${transactions.length} txns, $${this.formatNumber(summary.totalSales)}`);
    }

    grandTotals.netSales = grandTotals.totalSales - grandTotals.totalDiscounts - grandTotals.totalReturns;

    // Export to files
    const files = await this.exportToFiles(storesData, dateRange);

    console.log(`\nWeekly report complete: ${storesData.length}/${stores.length} stores`);
    console.log(`Total sales: $${this.formatNumber(grandTotals.totalSales)}`);
    console.log(`Files: ${files.aggregated.csv}, ${files.detailed.csv}`);

    if (failedStores.length > 0) {
      console.error(`WARNING: ${failedStores.length} store(s) failed:`);
      failedStores.forEach(f => console.error(`  - ${f.store}: ${f.error}`));
    }

    return {
      success: failedStores.length === 0,
      dateRange: {
        startDate: dateRange.startDate,
        endDate: dateRange.endDate
      },
      generatedAt: new Date().toISOString(),
      stores: storesData,
      grandTotals,
      files,
      failedStores: failedStores.length > 0 ? failedStores : undefined
    };
  }
}

module.exports = HourlySalesService;
