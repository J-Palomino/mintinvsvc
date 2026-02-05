/**
 * Setup Odoo Scheduled Action for Report Import
 *
 * Creates an ir.cron job in Odoo that:
 * 1. Searches inbox for Daily Sales National Report
 * 2. Parses HTML table to JSON
 * 3. Stores as attachment
 *
 * Run once to create the scheduled action, then it runs nightly in Odoo.
 */

const https = require('https');

class OdooClient {
  constructor(config = {}) {
    this.url = config.url || process.env.ODOO_URL;
    this.database = config.database || process.env.ODOO_DATABASE || 'odoo';
    this.username = config.username || process.env.ODOO_USERNAME;
    this.password = config.password || process.env.ODOO_API_KEY;

    this.uid = null;
    this.authenticated = false;
    this.sessionId = null;

    if (this.url) {
      const parsed = new URL(this.url);
      this.host = parsed.hostname;
      this.port = parsed.port || 443;
    }
  }

  async jsonRpcCall(endpoint, service, method, args) {
    return new Promise((resolve, reject) => {
      const body = JSON.stringify({
        jsonrpc: '2.0',
        method: 'call',
        params: { service, method, args },
        id: Date.now(),
      });

      const options = {
        hostname: this.host,
        port: this.port,
        path: endpoint,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          ...(this.sessionId && { Cookie: `session_id=${this.sessionId}` }),
        },
      };

      const req = https.request(options, (res) => {
        const cookies = res.headers['set-cookie'];
        if (cookies) {
          for (const cookie of cookies) {
            const match = cookie.match(/session_id=([^;]+)/);
            if (match) this.sessionId = match[1];
          }
        }

        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const result = JSON.parse(data);
            if (result.error) {
              const errMsg = result.error.data?.message || result.error.message || JSON.stringify(result.error);
              reject(new Error(errMsg));
            } else {
              resolve(result.result);
            }
          } catch (error) {
            reject(new Error(`JSON parse error: ${error.message}`));
          }
        });
      });

      req.on('error', reject);
      req.setTimeout(60000, () => {
        req.destroy();
        reject(new Error('Request timeout'));
      });
      req.write(body);
      req.end();
    });
  }

  async authenticate() {
    if (!this.url || !this.username || !this.password) {
      throw new Error('Odoo credentials not configured');
    }

    const uid = await this.jsonRpcCall('/jsonrpc', 'common', 'authenticate', [
      this.database,
      this.username,
      this.password,
      {},
    ]);

    if (!uid) {
      throw new Error('Authentication failed');
    }

    this.uid = uid;
    this.authenticated = true;
    return uid;
  }

  async execute(model, method, args = [], kwargs = {}) {
    if (!this.authenticated) {
      await this.authenticate();
    }
    return this.jsonRpcCall('/jsonrpc', 'object', 'execute_kw', [
      this.database,
      this.uid,
      this.password,
      model,
      method,
      args,
      kwargs,
    ]);
  }

  async searchRead(model, domain, fields = [], options = {}) {
    return this.execute(model, 'search_read', [domain], { fields, ...options });
  }

  async search(model, domain, options = {}) {
    return this.execute(model, 'search', [domain], options);
  }

  async create(model, values) {
    return this.execute(model, 'create', [values]);
  }

  async write(model, ids, values) {
    return this.execute(model, 'write', [ids, values]);
  }

  async unlink(model, ids) {
    return this.execute(model, 'unlink', [ids]);
  }
}

// Python code that will run inside Odoo
const PYTHON_CODE = `
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
                if any(self.in_header for _ in [1]) or not self.headers:
                    # First row or header row
                    if not self.rows:
                        self.headers = self.current_row
                    else:
                        self.rows.append(self.current_row)
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
    # Currency
    if val.startswith('$'):
        try:
            return float(val.replace('$', '').replace(',', ''))
        except:
            return val
    # Percentage
    if val.endswith('%'):
        try:
            return float(val.replace('%', ''))
        except:
            return val
    # Number
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

# Search for messages from last 2 days
date_from = (datetime.now() - timedelta(days=2)).strftime('%Y-%m-%d')
messages = Message.search([
    ('subject', 'ilike', 'Daily Sales National'),
    ('message_type', '=', 'email'),
    ('date', '>=', date_from),
], order='date desc', limit=5)

for msg in messages:
    if not msg.body:
        continue

    # Check if already processed
    existing = Attachment.search([
        ('res_model', '=', 'mail.message'),
        ('res_id', '=', msg.id),
        ('name', 'ilike', 'daily_sales_national'),
        ('mimetype', '=', 'application/json'),
    ], limit=1)

    if existing:
        continue  # Already processed

    # Parse HTML table
    parser = TableParser()
    try:
        parser.feed(msg.body)
    except:
        continue

    if not parser.headers or not parser.rows:
        continue

    # Build JSON data
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

    # Create report structure
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

    # Save as JSON attachment
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

    # Log success
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

async function main() {
  const odoo = new OdooClient();

  console.log('='.repeat(60));
  console.log('SETUP ODOO SCHEDULED ACTIONS FOR REPORT IMPORTS');
  console.log('='.repeat(60));

  try {
    console.log('\n1. Authenticating...');
    await odoo.authenticate();
    console.log('   Authenticated (uid=' + odoo.uid + ')');

    // Step 2: Create Server Actions
    console.log('\n2. Creating server actions...');

    // Check for existing server actions
    const existingActions = await odoo.searchRead(
      'ir.actions.server',
      [['name', 'in', ['Import Daily Sales Report', 'Import Mel Report']]],
      ['id', 'name']
    );

    const existingNames = new Set(existingActions.map(a => a.name));

    // Get base model ID for ir.actions.server (mail.message)
    const models = await odoo.searchRead(
      'ir.model',
      [['model', '=', 'mail.message']],
      ['id']
    );
    const modelId = models[0]?.id;

    if (!modelId) {
      throw new Error('Could not find mail.message model');
    }

    // Create Daily Sales Report server action
    let dailySalesActionId;
    if (!existingNames.has('Import Daily Sales Report')) {
      dailySalesActionId = await odoo.create('ir.actions.server', {
        name: 'Import Daily Sales Report',
        model_id: modelId,
        state: 'code',
        code: PYTHON_CODE,
      });
      console.log(`   Created server action: Import Daily Sales Report (ID: ${dailySalesActionId})`);
    } else {
      dailySalesActionId = existingActions.find(a => a.name === 'Import Daily Sales Report').id;
      // Update the code
      await odoo.write('ir.actions.server', [dailySalesActionId], {
        code: PYTHON_CODE,
      });
      console.log(`   Updated existing server action: Import Daily Sales Report (ID: ${dailySalesActionId})`);
    }

    // Create Mel Report server action
    let melReportActionId;
    if (!existingNames.has('Import Mel Report')) {
      melReportActionId = await odoo.create('ir.actions.server', {
        name: 'Import Mel Report',
        model_id: modelId,
        state: 'code',
        code: MEL_REPORT_PYTHON_CODE,
      });
      console.log(`   Created server action: Import Mel Report (ID: ${melReportActionId})`);
    } else {
      melReportActionId = existingActions.find(a => a.name === 'Import Mel Report').id;
      await odoo.write('ir.actions.server', [melReportActionId], {
        code: MEL_REPORT_PYTHON_CODE,
      });
      console.log(`   Updated existing server action: Import Mel Report (ID: ${melReportActionId})`);
    }

    // Step 3: Create Scheduled Actions (ir.cron)
    console.log('\n3. Creating scheduled actions...');

    const existingCrons = await odoo.searchRead(
      'ir.cron',
      [['name', 'in', ['Import Daily Sales Report (Nightly)', 'Import Mel Report (Nightly)']]],
      ['id', 'name']
    );

    const existingCronNames = new Set(existingCrons.map(c => c.name));

    // Create Daily Sales cron
    if (!existingCronNames.has('Import Daily Sales Report (Nightly)')) {
      const cronId = await odoo.create('ir.cron', {
        name: 'Import Daily Sales Report (Nightly)',
        model_id: modelId,
        state: 'code',
        code: PYTHON_CODE,
        interval_number: 1,
        interval_type: 'days',
        numbercall: -1,  // Run indefinitely
        active: true,
        priority: 10,
      });
      console.log(`   Created cron: Import Daily Sales Report (Nightly) (ID: ${cronId})`);
    } else {
      const cronId = existingCrons.find(c => c.name === 'Import Daily Sales Report (Nightly)').id;
      await odoo.write('ir.cron', [cronId], {
        code: PYTHON_CODE,
        active: true,
      });
      console.log(`   Updated existing cron: Import Daily Sales Report (Nightly) (ID: ${cronId})`);
    }

    // Create Mel Report cron
    if (!existingCronNames.has('Import Mel Report (Nightly)')) {
      const cronId = await odoo.create('ir.cron', {
        name: 'Import Mel Report (Nightly)',
        model_id: modelId,
        state: 'code',
        code: MEL_REPORT_PYTHON_CODE,
        interval_number: 1,
        interval_type: 'days',
        numbercall: -1,
        active: true,
        priority: 10,
      });
      console.log(`   Created cron: Import Mel Report (Nightly) (ID: ${cronId})`);
    } else {
      const cronId = existingCrons.find(c => c.name === 'Import Mel Report (Nightly)').id;
      await odoo.write('ir.cron', [cronId], {
        code: MEL_REPORT_PYTHON_CODE,
        active: true,
      });
      console.log(`   Updated existing cron: Import Mel Report (Nightly) (ID: ${cronId})`);
    }

    // Step 4: Run the imports now
    console.log('\n4. Running imports now (one-time execution)...');

    // Execute the server actions
    try {
      await odoo.execute('ir.actions.server', 'run', [[dailySalesActionId]]);
      console.log('   Daily Sales Report import executed');
    } catch (e) {
      console.log('   Daily Sales Report: ' + e.message);
    }

    try {
      await odoo.execute('ir.actions.server', 'run', [[melReportActionId]]);
      console.log('   Mel Report import executed');
    } catch (e) {
      console.log('   Mel Report: ' + e.message);
    }

    // Step 5: Check for created attachments
    console.log('\n5. Checking for created attachments...');

    const recentAttachments = await odoo.searchRead(
      'ir.attachment',
      [
        ['create_date', '>=', new Date(Date.now() - 3600000).toISOString().replace('T', ' ').substring(0, 19)],
        ['mimetype', '=', 'application/json'],
        '|',
        ['name', 'ilike', 'daily_sales'],
        ['name', 'ilike', 'mel_report'],
      ],
      ['id', 'name', 'res_model', 'res_id', 'create_date'],
      { order: 'create_date desc', limit: 10 }
    );

    if (recentAttachments && recentAttachments.length > 0) {
      console.log('   Recent JSON attachments:');
      for (const att of recentAttachments) {
        console.log(`   - [${att.id}] ${att.name} (${att.res_model}:${att.res_id})`);
      }
    } else {
      console.log('   No new attachments created in the last hour');
    }

    // Summary
    console.log('\n' + '='.repeat(60));
    console.log('SETUP COMPLETE');
    console.log('='.repeat(60));
    console.log('\nScheduled Actions Created:');
    console.log('  1. Import Daily Sales Report (Nightly) - runs daily');
    console.log('  2. Import Mel Report (Nightly) - runs daily');
    console.log('\nThese jobs will:');
    console.log('  - Search inbox for report emails from last 2 days');
    console.log('  - Parse HTML tables to JSON');
    console.log('  - Store as ir.attachment linked to the email');
    console.log('  - Skip already-processed emails');
    console.log('\nTo manually trigger, go to:');
    console.log('  Settings > Technical > Automation > Scheduled Actions');

  } catch (error) {
    console.error('\nError:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

main().catch(console.error);
