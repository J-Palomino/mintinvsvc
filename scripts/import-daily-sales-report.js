/**
 * Import Daily Sales National Report from Odoo Inbox
 *
 * Fetches the report from mail.message, parses the HTML table,
 * and stores as JSON attachment in Odoo
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

  async create(model, values) {
    return this.execute(model, 'create', [values]);
  }
}

/**
 * Parse HTML table from Looker report
 */
function parseHtmlTable(html) {
  const rows = [];

  // Extract table content
  const tableMatch = html.match(/<table[^>]*>([\s\S]*?)<\/table>/i);
  if (!tableMatch) {
    console.log('No table found in HTML');
    return rows;
  }

  const tableContent = tableMatch[1];

  // Extract headers
  const headerMatch = tableContent.match(/<thead[^>]*>([\s\S]*?)<\/thead>/i) ||
                      tableContent.match(/<tr[^>]*>([\s\S]*?)<\/tr>/i);

  let headers = [];
  if (headerMatch) {
    const headerCells = headerMatch[1].match(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi) || [];
    headers = headerCells.map(cell => {
      return cell.replace(/<[^>]+>/g, '').trim();
    });
  }

  // Extract data rows
  const tbodyMatch = tableContent.match(/<tbody[^>]*>([\s\S]*?)<\/tbody>/i);
  const rowsHtml = tbodyMatch ? tbodyMatch[1] : tableContent;

  const rowMatches = rowsHtml.match(/<tr[^>]*>([\s\S]*?)<\/tr>/gi) || [];

  // Skip first row if it was headers
  const startIdx = headerMatch && !tbodyMatch ? 1 : 0;

  for (let i = startIdx; i < rowMatches.length; i++) {
    const rowHtml = rowMatches[i];
    const cellMatches = rowHtml.match(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi) || [];

    const rowData = {};
    cellMatches.forEach((cell, idx) => {
      const value = cell.replace(/<[^>]+>/g, '').trim();
      const header = headers[idx] || `column_${idx}`;
      rowData[header] = value;
    });

    if (Object.keys(rowData).length > 0) {
      rows.push(rowData);
    }
  }

  return rows;
}

/**
 * Clean and normalize parsed data
 */
function normalizeData(rows) {
  return rows.map(row => {
    const normalized = {};
    for (const [key, value] of Object.entries(row)) {
      // Clean key
      const cleanKey = key.toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_|_$/g, '');

      // Clean value - remove currency symbols, parse numbers
      let cleanValue = value;
      if (typeof value === 'string') {
        // Check if it's a currency value
        if (value.match(/^\$[\d,.-]+$/)) {
          cleanValue = parseFloat(value.replace(/[$,]/g, '')) || 0;
        }
        // Check if it's a percentage
        else if (value.match(/^[\d.-]+%$/)) {
          cleanValue = parseFloat(value.replace('%', '')) || 0;
        }
        // Check if it's a plain number
        else if (value.match(/^[\d,.-]+$/) && value !== '') {
          cleanValue = parseFloat(value.replace(/,/g, '')) || value;
        }
      }

      normalized[cleanKey] = cleanValue;
    }
    return normalized;
  });
}

async function main() {
  const odoo = new OdooClient();

  console.log('='.repeat(60));
  console.log('IMPORT DAILY SALES NATIONAL REPORT FROM ODOO INBOX');
  console.log('='.repeat(60));

  try {
    // Step 1: Authenticate
    console.log('\n1. Authenticating...');
    await odoo.authenticate();
    console.log('   Authenticated (uid=' + odoo.uid + ')');

    // Step 2: Find the Daily Sales National Report message
    console.log('\n2. Searching for Daily Sales National Report...');

    const messages = await odoo.searchRead(
      'mail.message',
      [
        ['subject', 'ilike', 'Daily Sales National'],
        ['message_type', '=', 'email'],
      ],
      ['id', 'subject', 'date', 'body', 'author_id', 'attachment_ids'],
      { limit: 5, order: 'date desc' }
    );

    if (!messages || messages.length === 0) {
      console.log('   No Daily Sales National Report found in inbox');
      return;
    }

    console.log(`   Found ${messages.length} matching messages:`);
    for (const msg of messages) {
      console.log(`   - [${msg.id}] ${msg.subject} (${msg.date})`);
    }

    // Use the most recent one
    const message = messages[0];
    console.log(`\n3. Processing message ID ${message.id}: "${message.subject}"`);

    // Step 3: Parse the HTML body
    console.log('\n4. Parsing HTML table from email body...');

    if (!message.body) {
      console.log('   No body content in message');
      return;
    }

    const rows = parseHtmlTable(message.body);
    console.log(`   Extracted ${rows.length} data rows`);

    if (rows.length === 0) {
      console.log('   No data found in table');
      // Show a snippet of the body for debugging
      console.log('   Body preview:', message.body.substring(0, 500));
      return;
    }

    // Show sample data
    console.log('\n   Sample row:');
    console.log('   ', JSON.stringify(rows[0], null, 2).substring(0, 300));

    // Step 4: Normalize the data
    console.log('\n5. Normalizing data...');
    const normalizedData = normalizeData(rows);

    // Create JSON structure
    const reportData = {
      report_type: 'daily_sales_national',
      source_message_id: message.id,
      source_date: message.date,
      generated_at: new Date().toISOString(),
      row_count: normalizedData.length,
      data: normalizedData,
    };

    const jsonContent = JSON.stringify(reportData, null, 2);
    console.log(`   JSON size: ${jsonContent.length} bytes`);

    // Step 5: Create JSON attachment in Odoo
    console.log('\n6. Creating JSON attachment in Odoo...');

    // Extract date from message for filename
    const reportDate = message.date.split(' ')[0];
    const filename = `daily_sales_national_${reportDate}.json`;

    const attachmentId = await odoo.create('ir.attachment', {
      name: filename,
      type: 'binary',
      datas: Buffer.from(jsonContent).toString('base64'),
      mimetype: 'application/json',
      res_model: 'mail.message',
      res_id: message.id,
      description: `Daily Sales National Report parsed from email ${message.id}`,
    });

    console.log(`   Created attachment ID: ${attachmentId}`);
    console.log(`   Filename: ${filename}`);

    // Step 6: Also attach to a project.task for easy access
    console.log('\n7. Attaching to project task...');

    // Find or create a task for reports
    const tasks = await odoo.searchRead(
      'project.task',
      [['name', 'ilike', 'Daily Reports']],
      ['id', 'name'],
      { limit: 1 }
    );

    let taskId;
    if (tasks && tasks.length > 0) {
      taskId = tasks[0].id;
      console.log(`   Found existing task: ${tasks[0].name} (ID: ${taskId})`);
    } else {
      // Create a new task
      const projects = await odoo.searchRead(
        'project.project',
        [],
        ['id', 'name'],
        { limit: 1 }
      );

      if (projects && projects.length > 0) {
        taskId = await odoo.create('project.task', {
          name: 'Daily Reports - Imported',
          project_id: projects[0].id,
          description: 'Container for imported daily sales reports',
        });
        console.log(`   Created new task ID: ${taskId}`);
      }
    }

    if (taskId) {
      // Create another attachment linked to the task
      const taskAttachmentId = await odoo.create('ir.attachment', {
        name: filename,
        type: 'binary',
        datas: Buffer.from(jsonContent).toString('base64'),
        mimetype: 'application/json',
        res_model: 'project.task',
        res_id: taskId,
        description: `Daily Sales National Report ${reportDate}`,
      });
      console.log(`   Attached to task as ID: ${taskAttachmentId}`);
    }

    // Step 7: Summary
    console.log('\n' + '='.repeat(60));
    console.log('IMPORT COMPLETE');
    console.log('='.repeat(60));
    console.log(`\nReport: Daily Sales National`);
    console.log(`Date: ${reportDate}`);
    console.log(`Rows: ${normalizedData.length}`);
    console.log(`Attachment ID: ${attachmentId}`);
    console.log(`\nData columns:`);
    if (normalizedData.length > 0) {
      Object.keys(normalizedData[0]).forEach(col => {
        console.log(`  - ${col}`);
      });
    }

    // Show aggregate totals if available
    console.log('\nStore totals:');
    for (const row of normalizedData.slice(0, 10)) {
      const store = row.store || row.location || row.store_name || Object.values(row)[0];
      const sales = row.net_sales || row.total_sales || row.sales || Object.values(row)[1];
      console.log(`  ${store}: ${typeof sales === 'number' ? '$' + sales.toLocaleString() : sales}`);
    }
    if (normalizedData.length > 10) {
      console.log(`  ... and ${normalizedData.length - 10} more stores`);
    }

  } catch (error) {
    console.error('\nError:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

main().catch(console.error);
