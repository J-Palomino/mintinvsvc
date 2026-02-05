/**
 * Odoo Report Import Service
 *
 * Imports daily reports from Odoo inbox:
 * - Daily Sales National Report
 * - Mel Report
 *
 * Runs as a Railway job, stores results as JSON attachments in Odoo.
 */

const OdooClient = require('../api/odoo');

class OdooReportImportService {
  constructor() {
    this.odoo = new OdooClient();
    this.enabled = !!(process.env.ODOO_URL && process.env.ODOO_USERNAME && process.env.ODOO_API_KEY);
  }

  isEnabled() {
    return this.enabled;
  }

  async initialize() {
    if (!this.enabled) {
      console.log('Odoo report import disabled - missing credentials');
      return false;
    }

    try {
      await this.odoo.authenticate();
      return true;
    } catch (error) {
      console.error('Odoo initialization failed:', error.message);
      return false;
    }
  }

  /**
   * Parse HTML table from Looker report email
   */
  parseHtmlTable(html) {
    const rows = [];

    // Extract table content
    const tableMatch = html.match(/<table[^>]*>([\s\S]*?)<\/table>/i);
    if (!tableMatch) {
      return { headers: [], rows: [] };
    }

    const tableContent = tableMatch[1];

    // Extract headers from thead or first row
    let headers = [];
    const theadMatch = tableContent.match(/<thead[^>]*>([\s\S]*?)<\/thead>/i);
    if (theadMatch) {
      const headerCells = theadMatch[1].match(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi) || [];
      headers = headerCells.map(cell => cell.replace(/<[^>]+>/g, '').trim());
    }

    // Extract data rows from tbody or table
    const tbodyMatch = tableContent.match(/<tbody[^>]*>([\s\S]*?)<\/tbody>/i);
    const rowsHtml = tbodyMatch ? tbodyMatch[1] : tableContent;
    const rowMatches = rowsHtml.match(/<tr[^>]*>([\s\S]*?)<\/tr>/gi) || [];

    for (let i = 0; i < rowMatches.length; i++) {
      const rowHtml = rowMatches[i];
      const cellMatches = rowHtml.match(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi) || [];
      const cellValues = cellMatches.map(cell => cell.replace(/<[^>]+>/g, '').trim());

      // First row becomes headers if we don't have them
      if (headers.length === 0 && i === 0) {
        headers = cellValues;
        continue;
      }

      if (cellValues.length > 0) {
        rows.push(cellValues);
      }
    }

    return { headers, rows };
  }

  /**
   * Parse value (currency, percentage, number)
   */
  parseValue(val) {
    if (!val || typeof val !== 'string') return val;
    val = val.trim();

    // Currency
    if (val.startsWith('$')) {
      const num = parseFloat(val.replace(/[$,]/g, ''));
      return isNaN(num) ? val : num;
    }

    // Percentage
    if (val.endsWith('%')) {
      const num = parseFloat(val.replace('%', ''));
      return isNaN(num) ? val : num;
    }

    // Plain number
    if (/^[\d,.-]+$/.test(val) && val !== '') {
      const num = parseFloat(val.replace(/,/g, ''));
      return isNaN(num) ? val : num;
    }

    return val;
  }

  /**
   * Normalize header to snake_case
   */
  normalizeKey(key) {
    return key.toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_|_$/g, '');
  }

  /**
   * Import a specific report type from inbox
   */
  async importReport(subjectFilter, reportType) {
    if (!this.odoo.authenticated) {
      const ok = await this.initialize();
      if (!ok) return { success: false, error: 'Initialization failed' };
    }

    console.log(`Importing ${reportType} reports...`);

    // Search for recent emails matching the subject
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000)
      .toISOString()
      .replace('T', ' ')
      .substring(0, 19);

    const messages = await this.odoo.searchRead(
      'mail.message',
      [
        ['subject', 'ilike', subjectFilter],
        ['message_type', '=', 'email'],
        ['date', '>=', twoDaysAgo],
      ],
      ['id', 'subject', 'date', 'body'],
      { order: 'date desc', limit: 5 }
    );

    if (!messages || messages.length === 0) {
      console.log(`  No ${reportType} emails found in last 2 days`);
      return { success: true, processed: 0, message: 'No emails found' };
    }

    console.log(`  Found ${messages.length} emails`);

    let processed = 0;
    let skipped = 0;

    for (const msg of messages) {
      // Check if already processed
      const existing = await this.odoo.searchRead(
        'ir.attachment',
        [
          ['res_model', '=', 'mail.message'],
          ['res_id', '=', msg.id],
          ['name', 'ilike', reportType],
          ['mimetype', '=', 'application/json'],
        ],
        ['id'],
        { limit: 1 }
      );

      if (existing && existing.length > 0) {
        console.log(`  Skipping message ${msg.id} - already processed`);
        skipped++;
        continue;
      }

      if (!msg.body) {
        console.log(`  Skipping message ${msg.id} - no body`);
        continue;
      }

      // Parse the HTML table
      const { headers, rows } = this.parseHtmlTable(msg.body);

      if (headers.length === 0 || rows.length === 0) {
        console.log(`  Skipping message ${msg.id} - no table data found`);
        continue;
      }

      // Convert to JSON objects
      const data = rows.map(row => {
        const obj = {};
        row.forEach((val, i) => {
          if (i < headers.length) {
            const key = this.normalizeKey(headers[i]);
            obj[key] = this.parseValue(val);
          }
        });
        return obj;
      });

      // Build report structure
      const reportDate = msg.date.split(' ')[0];
      const report = {
        report_type: reportType,
        source_message_id: msg.id,
        source_date: msg.date,
        imported_at: new Date().toISOString(),
        row_count: data.length,
        columns: headers,
        data: data,
      };

      const jsonContent = JSON.stringify(report, null, 2);
      const filename = `${reportType}_${reportDate}.json`;

      // Create attachment in Odoo
      const attachmentId = await this.odoo.create('ir.attachment', {
        name: filename,
        type: 'binary',
        datas: Buffer.from(jsonContent).toString('base64'),
        mimetype: 'application/json',
        res_model: 'mail.message',
        res_id: msg.id,
        description: `${reportType} imported from email`,
      });

      console.log(`  Created attachment ${attachmentId}: ${filename} (${data.length} rows)`);
      processed++;
    }

    return {
      success: true,
      processed,
      skipped,
      message: `Imported ${processed} reports, skipped ${skipped} already processed`,
    };
  }

  /**
   * Run all report imports
   */
  async runImportsNow() {
    if (!this.enabled) {
      return { success: false, error: 'Odoo not configured' };
    }

    console.log('\n=== Odoo Report Import ===');

    const results = {
      dailySales: null,
      melReport: null,
    };

    // Import Daily Sales National Report
    try {
      results.dailySales = await this.importReport('Daily Sales National', 'daily_sales_national');
    } catch (e) {
      console.error('Daily Sales import error:', e.message);
      results.dailySales = { success: false, error: e.message };
    }

    // Import Mel Report
    try {
      results.melReport = await this.importReport('mel', 'mel_report');
    } catch (e) {
      console.error('Mel Report import error:', e.message);
      results.melReport = { success: false, error: e.message };
    }

    // Get recent attachments for verification
    const oneHourAgo = new Date(Date.now() - 3600000)
      .toISOString()
      .replace('T', ' ')
      .substring(0, 19);

    const recentAttachments = await this.odoo.searchRead(
      'ir.attachment',
      [
        ['create_date', '>=', oneHourAgo],
        ['mimetype', '=', 'application/json'],
        '|',
        ['name', 'ilike', 'daily_sales'],
        ['name', 'ilike', 'mel_report'],
      ],
      ['id', 'name', 'res_model', 'res_id', 'create_date'],
      { order: 'create_date desc', limit: 10 }
    );

    console.log('=== Import Complete ===\n');

    return {
      success: true,
      imports: results,
      recentAttachments: recentAttachments || [],
    };
  }

  /**
   * Setup info (no longer creates Odoo crons, runs on Railway instead)
   */
  async setupScheduledActions() {
    return {
      success: true,
      message: 'Report imports run as Railway job (not Odoo cron due to Python restrictions)',
      howToSchedule: 'Add to BullMQ scheduler or call POST /api/odoo/import-reports',
    };
  }
}

module.exports = OdooReportImportService;
