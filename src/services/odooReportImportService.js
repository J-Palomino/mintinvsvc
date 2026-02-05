/**
 * Odoo Report Import Service
 *
 * Creates scheduled actions in Odoo to import daily reports:
 * - Daily Sales National Report
 * - Mel Report
 *
 * These run nightly within Odoo itself.
 */

const OdooClient = require('../api/odoo');

// Python code for Daily Sales National Report import
const DAILY_SALES_PYTHON_CODE = `
# Daily Sales Report Import - Runs nightly in Odoo
import json
import re
import base64
from datetime import datetime, timedelta
from html.parser import HTMLParser

class TableParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.rows = []
        self.current_row = []
        self.current_cell = ""
        self.in_cell = False
        self.headers = []
        self.in_header = False

    def handle_starttag(self, tag, attrs):
        if tag in ('th', 'td'):
            self.in_cell = True
            self.current_cell = ""
            if tag == 'th':
                self.in_header = True

    def handle_endtag(self, tag):
        if tag in ('th', 'td'):
            self.in_cell = False
            cell_value = self.current_cell.strip()
            self.current_row.append(cell_value)
            if tag == 'th':
                self.in_header = False
        elif tag == 'tr':
            if self.current_row:
                if not self.headers or len(self.current_row) == len(self.headers):
                    if not self.headers:
                        self.headers = self.current_row
                    else:
                        self.rows.append(self.current_row)
            self.current_row = []

    def handle_data(self, data):
        if self.in_cell:
            self.current_cell += data

def parse_value(val):
    """Parse currency/number strings"""
    if not val or not isinstance(val, str):
        return val
    val = val.strip()
    if val.startswith('$'):
        try:
            return float(val.replace('$', '').replace(',', ''))
        except:
            return val
    if val.endswith('%'):
        try:
            return float(val.replace('%', ''))
        except:
            return val
    if re.match(r'^[\\d,.-]+$', val):
        try:
            return float(val.replace(',', ''))
        except:
            return val
    return val

def normalize_key(key):
    """Convert header to snake_case"""
    key = key.lower()
    key = re.sub(r'[^a-z0-9]+', '_', key)
    return key.strip('_')

# Find recent Daily Sales National Report emails
Message = env['mail.message']
Attachment = env['ir.attachment']

date_from = (datetime.now() - timedelta(days=2)).strftime('%Y-%m-%d')
messages = Message.search([
    ('subject', 'ilike', 'Daily Sales National'),
    ('message_type', '=', 'email'),
    ('date', '>=', date_from),
], order='date desc', limit=5)

for msg in messages:
    if not msg.body:
        continue

    existing = Attachment.search([
        ('res_model', '=', 'mail.message'),
        ('res_id', '=', msg.id),
        ('name', 'ilike', 'daily_sales_national'),
        ('mimetype', '=', 'application/json'),
    ], limit=1)

    if existing:
        continue

    parser = TableParser()
    try:
        parser.feed(msg.body)
    except:
        continue

    if not parser.headers or not parser.rows:
        continue

    data = []
    for row in parser.rows:
        row_dict = {}
        for i, val in enumerate(row):
            if i < len(parser.headers):
                key = normalize_key(parser.headers[i])
                row_dict[key] = parse_value(val)
        if row_dict:
            data.append(row_dict)

    if not data:
        continue

    report_date = msg.date.strftime('%Y-%m-%d') if msg.date else datetime.now().strftime('%Y-%m-%d')
    report = {
        'report_type': 'daily_sales_national',
        'source_message_id': msg.id,
        'source_date': str(msg.date),
        'imported_at': datetime.now().isoformat(),
        'row_count': len(data),
        'columns': parser.headers,
        'data': data,
    }

    json_content = json.dumps(report, indent=2, default=str)
    filename = f"daily_sales_national_{report_date}.json"

    Attachment.create({
        'name': filename,
        'type': 'binary',
        'datas': base64.b64encode(json_content.encode('utf-8')),
        'mimetype': 'application/json',
        'res_model': 'mail.message',
        'res_id': msg.id,
        'description': f'Daily Sales National Report imported from email',
    })

    env.cr.commit()
`;

// Python code for Mel Report import
const MEL_REPORT_PYTHON_CODE = `
# Mel Report Import - Runs nightly in Odoo
import json
import re
import base64
from datetime import datetime, timedelta
from html.parser import HTMLParser

class TableParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.rows = []
        self.current_row = []
        self.current_cell = ""
        self.in_cell = False
        self.headers = []

    def handle_starttag(self, tag, attrs):
        if tag in ('th', 'td'):
            self.in_cell = True
            self.current_cell = ""

    def handle_endtag(self, tag):
        if tag in ('th', 'td'):
            self.in_cell = False
            self.current_row.append(self.current_cell.strip())
        elif tag == 'tr':
            if self.current_row:
                if not self.headers:
                    self.headers = self.current_row
                else:
                    self.rows.append(self.current_row)
            self.current_row = []

    def handle_data(self, data):
        if self.in_cell:
            self.current_cell += data

def parse_value(val):
    if not val or not isinstance(val, str):
        return val
    val = val.strip()
    if val.startswith('$'):
        try:
            return float(val.replace('$', '').replace(',', ''))
        except:
            return val
    if val.endswith('%'):
        try:
            return float(val.replace('%', ''))
        except:
            return val
    if re.match(r'^[\\d,.-]+$', val):
        try:
            return float(val.replace(',', ''))
        except:
            return val
    return val

def normalize_key(key):
    key = key.lower()
    key = re.sub(r'[^a-z0-9]+', '_', key)
    return key.strip('_')

Message = env['mail.message']
Attachment = env['ir.attachment']

date_from = (datetime.now() - timedelta(days=2)).strftime('%Y-%m-%d')
messages = Message.search([
    ('subject', 'ilike', 'mel'),
    ('message_type', '=', 'email'),
    ('date', '>=', date_from),
], order='date desc', limit=5)

for msg in messages:
    if not msg.body:
        continue

    existing = Attachment.search([
        ('res_model', '=', 'mail.message'),
        ('res_id', '=', msg.id),
        ('name', 'ilike', 'mel_report'),
        ('mimetype', '=', 'application/json'),
    ], limit=1)

    if existing:
        continue

    parser = TableParser()
    try:
        parser.feed(msg.body)
    except:
        continue

    if not parser.headers or not parser.rows:
        continue

    data = []
    for row in parser.rows:
        row_dict = {}
        for i, val in enumerate(row):
            if i < len(parser.headers):
                key = normalize_key(parser.headers[i])
                row_dict[key] = parse_value(val)
        if row_dict:
            data.append(row_dict)

    if not data:
        continue

    report_date = msg.date.strftime('%Y-%m-%d') if msg.date else datetime.now().strftime('%Y-%m-%d')
    report = {
        'report_type': 'mel_report',
        'source_message_id': msg.id,
        'source_date': str(msg.date),
        'imported_at': datetime.now().isoformat(),
        'row_count': len(data),
        'columns': parser.headers,
        'data': data,
    }

    json_content = json.dumps(report, indent=2, default=str)
    filename = f"mel_report_{report_date}.json"

    Attachment.create({
        'name': filename,
        'type': 'binary',
        'datas': base64.b64encode(json_content.encode('utf-8')),
        'mimetype': 'application/json',
        'res_model': 'mail.message',
        'res_id': msg.id,
        'description': f'Mel Report imported from email',
    })

    env.cr.commit()
`;

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
   * Create or update scheduled actions in Odoo
   */
  async setupScheduledActions() {
    if (!this.enabled) {
      return { success: false, error: 'Odoo not configured' };
    }

    if (!this.odoo.authenticated) {
      const ok = await this.initialize();
      if (!ok) return { success: false, error: 'Initialization failed' };
    }

    console.log('Setting up Odoo scheduled actions for report imports...');

    const results = {
      dailySales: null,
      melReport: null,
    };

    // Get base model ID for mail.message
    const models = await this.odoo.searchRead(
      'ir.model',
      [['model', '=', 'mail.message']],
      ['id']
    );
    const modelId = models[0]?.id;

    if (!modelId) {
      return { success: false, error: 'Could not find mail.message model' };
    }

    // Check for existing crons
    const existingCrons = await this.odoo.searchRead(
      'ir.cron',
      [['name', 'in', ['Import Daily Sales Report (Nightly)', 'Import Mel Report (Nightly)']]],
      ['id', 'name']
    );

    const existingCronNames = new Map(existingCrons.map(c => [c.name, c.id]));

    // Create/update Daily Sales cron
    const dailySalesName = 'Import Daily Sales Report (Nightly)';
    if (existingCronNames.has(dailySalesName)) {
      const cronId = existingCronNames.get(dailySalesName);
      await this.odoo.write('ir.cron', cronId, {
        code: DAILY_SALES_PYTHON_CODE,
        active: true,
      });
      results.dailySales = { id: cronId, status: 'updated' };
      console.log(`  Updated cron: ${dailySalesName} (ID: ${cronId})`);
    } else {
      const cronId = await this.odoo.create('ir.cron', {
        name: dailySalesName,
        model_id: modelId,
        state: 'code',
        code: DAILY_SALES_PYTHON_CODE,
        interval_number: 1,
        interval_type: 'days',
        numbercall: -1,
        active: true,
        priority: 10,
      });
      results.dailySales = { id: cronId, status: 'created' };
      console.log(`  Created cron: ${dailySalesName} (ID: ${cronId})`);
    }

    // Create/update Mel Report cron
    const melReportName = 'Import Mel Report (Nightly)';
    if (existingCronNames.has(melReportName)) {
      const cronId = existingCronNames.get(melReportName);
      await this.odoo.write('ir.cron', cronId, {
        code: MEL_REPORT_PYTHON_CODE,
        active: true,
      });
      results.melReport = { id: cronId, status: 'updated' };
      console.log(`  Updated cron: ${melReportName} (ID: ${cronId})`);
    } else {
      const cronId = await this.odoo.create('ir.cron', {
        name: melReportName,
        model_id: modelId,
        state: 'code',
        code: MEL_REPORT_PYTHON_CODE,
        interval_number: 1,
        interval_type: 'days',
        numbercall: -1,
        active: true,
        priority: 10,
      });
      results.melReport = { id: cronId, status: 'created' };
      console.log(`  Created cron: ${melReportName} (ID: ${cronId})`);
    }

    console.log('Scheduled actions setup complete');

    return {
      success: true,
      scheduledActions: results,
      message: 'Nightly imports scheduled in Odoo',
    };
  }

  /**
   * Run the imports now (one-time execution)
   */
  async runImportsNow() {
    if (!this.enabled) {
      return { success: false, error: 'Odoo not configured' };
    }

    if (!this.odoo.authenticated) {
      const ok = await this.initialize();
      if (!ok) return { success: false, error: 'Initialization failed' };
    }

    console.log('Running Odoo report imports now...');

    const results = {
      dailySales: null,
      melReport: null,
      attachments: [],
    };

    // Find or create server actions
    const existingActions = await this.odoo.searchRead(
      'ir.actions.server',
      [['name', 'in', ['Import Daily Sales Report', 'Import Mel Report']]],
      ['id', 'name']
    );

    const actionMap = new Map(existingActions.map(a => [a.name, a.id]));

    // Get model ID
    const models = await this.odoo.searchRead(
      'ir.model',
      [['model', '=', 'mail.message']],
      ['id']
    );
    const modelId = models[0]?.id;

    if (!modelId) {
      return { success: false, error: 'Could not find mail.message model' };
    }

    // Create/get Daily Sales server action
    let dailySalesActionId = actionMap.get('Import Daily Sales Report');
    if (!dailySalesActionId) {
      dailySalesActionId = await this.odoo.create('ir.actions.server', {
        name: 'Import Daily Sales Report',
        model_id: modelId,
        state: 'code',
        code: DAILY_SALES_PYTHON_CODE,
      });
      console.log(`  Created server action: Import Daily Sales Report (ID: ${dailySalesActionId})`);
    } else {
      await this.odoo.write('ir.actions.server', dailySalesActionId, {
        code: DAILY_SALES_PYTHON_CODE,
      });
      console.log(`  Updated server action: Import Daily Sales Report (ID: ${dailySalesActionId})`);
    }

    // Create/get Mel Report server action
    let melReportActionId = actionMap.get('Import Mel Report');
    if (!melReportActionId) {
      melReportActionId = await this.odoo.create('ir.actions.server', {
        name: 'Import Mel Report',
        model_id: modelId,
        state: 'code',
        code: MEL_REPORT_PYTHON_CODE,
      });
      console.log(`  Created server action: Import Mel Report (ID: ${melReportActionId})`);
    } else {
      await this.odoo.write('ir.actions.server', melReportActionId, {
        code: MEL_REPORT_PYTHON_CODE,
      });
      console.log(`  Updated server action: Import Mel Report (ID: ${melReportActionId})`);
    }

    // Execute the server actions
    try {
      await this.odoo.execute('ir.actions.server', 'run', [[dailySalesActionId]]);
      results.dailySales = { status: 'executed', actionId: dailySalesActionId };
      console.log('  Daily Sales Report import executed');
    } catch (e) {
      results.dailySales = { status: 'error', error: e.message };
      console.log('  Daily Sales Report: ' + e.message);
    }

    try {
      await this.odoo.execute('ir.actions.server', 'run', [[melReportActionId]]);
      results.melReport = { status: 'executed', actionId: melReportActionId };
      console.log('  Mel Report import executed');
    } catch (e) {
      results.melReport = { status: 'error', error: e.message };
      console.log('  Mel Report: ' + e.message);
    }

    // Check for created attachments
    const oneHourAgo = new Date(Date.now() - 3600000).toISOString().replace('T', ' ').substring(0, 19);
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

    results.attachments = recentAttachments || [];
    console.log(`  Found ${results.attachments.length} recent JSON attachments`);

    return {
      success: true,
      imports: results,
      message: 'Report imports completed',
    };
  }
}

module.exports = OdooReportImportService;
