/**
 * Odoo XML-RPC Client
 *
 * Handles authentication and CRUD operations with Odoo via XML-RPC protocol.
 * Odoo uses XML-RPC endpoints at:
 *   - /xmlrpc/2/common - Authentication
 *   - /xmlrpc/2/object - Model operations (CRUD)
 */

const http = require('http');
const https = require('https');

class OdooClient {
  constructor(config = {}) {
    this.url = config.url || process.env.ODOO_URL;
    this.database = config.database || process.env.ODOO_DATABASE || 'odoo';
    this.username = config.username || process.env.ODOO_USERNAME;
    this.password = config.password || process.env.ODOO_API_KEY; // API key or password

    this.uid = null;
    this.authenticated = false;

    // Parse URL
    if (this.url) {
      const parsed = new URL(this.url);
      this.host = parsed.hostname;
      this.port = parsed.port || (parsed.protocol === 'https:' ? 443 : 80);
      this.protocol = parsed.protocol === 'https:' ? https : http;
    }
  }

  /**
   * Make an XML-RPC call to Odoo
   */
  async xmlRpcCall(endpoint, method, params) {
    return new Promise((resolve, reject) => {
      const xmlBody = this.buildXmlRpcRequest(method, params);

      const options = {
        hostname: this.host,
        port: this.port,
        path: endpoint,
        method: 'POST',
        headers: {
          'Content-Type': 'text/xml',
          'Content-Length': Buffer.byteLength(xmlBody),
        },
      };

      const req = this.protocol.request(options, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const result = this.parseXmlRpcResponse(data);
            resolve(result);
          } catch (error) {
            reject(new Error(`XML-RPC parse error: ${error.message}`));
          }
        });
      });

      req.on('error', reject);
      req.write(xmlBody);
      req.end();
    });
  }

  /**
   * Build XML-RPC request body
   */
  buildXmlRpcRequest(method, params) {
    const paramXml = params.map(p => `<param>${this.valueToXml(p)}</param>`).join('');
    return `<?xml version="1.0"?>
<methodCall>
  <methodName>${method}</methodName>
  <params>${paramXml}</params>
</methodCall>`;
  }

  /**
   * Convert JavaScript value to XML-RPC value
   */
  valueToXml(value) {
    if (value === null || value === undefined) {
      return '<value><boolean>0</boolean></value>';
    }
    if (typeof value === 'boolean') {
      return `<value><boolean>${value ? 1 : 0}</boolean></value>`;
    }
    if (typeof value === 'number') {
      if (Number.isInteger(value)) {
        return `<value><int>${value}</int></value>`;
      }
      return `<value><double>${value}</double></value>`;
    }
    if (typeof value === 'string') {
      const escaped = value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
      return `<value><string>${escaped}</string></value>`;
    }
    if (Array.isArray(value)) {
      const items = value.map(v => this.valueToXml(v)).join('');
      return `<value><array><data>${items}</data></array></value>`;
    }
    if (typeof value === 'object') {
      const members = Object.entries(value)
        .map(([k, v]) => `<member><name>${k}</name>${this.valueToXml(v)}</member>`)
        .join('');
      return `<value><struct>${members}</struct></value>`;
    }
    return `<value><string>${String(value)}</string></value>`;
  }

  /**
   * Parse XML-RPC response
   */
  parseXmlRpcResponse(xml) {
    // Check for fault
    const faultMatch = xml.match(/<fault>[\s\S]*?<string>([^<]+)<\/string>/);
    if (faultMatch) {
      throw new Error(`Odoo fault: ${faultMatch[1]}`);
    }

    // Extract value from response
    return this.extractValue(xml);
  }

  /**
   * Extract value from XML
   */
  extractValue(xml) {
    // Boolean
    const boolMatch = xml.match(/<boolean>(\d)<\/boolean>/);
    if (boolMatch) return boolMatch[1] === '1';

    // Integer
    const intMatch = xml.match(/<int>(-?\d+)<\/int>/) || xml.match(/<i4>(-?\d+)<\/i4>/);
    if (intMatch) return parseInt(intMatch[1], 10);

    // Double
    const doubleMatch = xml.match(/<double>(-?[\d.]+)<\/double>/);
    if (doubleMatch) return parseFloat(doubleMatch[1]);

    // String
    const stringMatch = xml.match(/<string>([^<]*)<\/string>/);
    if (stringMatch) {
      return stringMatch[1]
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&');
    }

    // Array
    const arrayMatch = xml.match(/<array><data>([\s\S]*?)<\/data><\/array>/);
    if (arrayMatch) {
      const values = [];
      const valueRegex = /<value>([\s\S]*?)<\/value>/g;
      let match;
      while ((match = valueRegex.exec(arrayMatch[1])) !== null) {
        values.push(this.extractValue(match[1]));
      }
      return values;
    }

    // Struct
    const structMatch = xml.match(/<struct>([\s\S]*?)<\/struct>/);
    if (structMatch) {
      const obj = {};
      const memberRegex = /<member><name>([^<]+)<\/name><value>([\s\S]*?)<\/value><\/member>/g;
      let match;
      while ((match = memberRegex.exec(structMatch[1])) !== null) {
        obj[match[1]] = this.extractValue(match[2]);
      }
      return obj;
    }

    // Nil/None
    if (xml.includes('<nil/>') || xml.includes('<nil />')) {
      return null;
    }

    // Default: try to extract any value
    const valueMatch = xml.match(/<value>([^<]+)<\/value>/);
    if (valueMatch) return valueMatch[1];

    return null;
  }

  /**
   * Authenticate with Odoo
   */
  async authenticate() {
    if (!this.url || !this.username || !this.password) {
      throw new Error('Odoo credentials not configured. Set ODOO_URL, ODOO_USERNAME, ODOO_API_KEY');
    }

    try {
      const uid = await this.xmlRpcCall('/xmlrpc/2/common', 'authenticate', [
        this.database,
        this.username,
        this.password,
        {},
      ]);

      if (!uid || uid === false) {
        throw new Error('Authentication failed - invalid credentials');
      }

      this.uid = uid;
      this.authenticated = true;
      console.log(`Odoo authenticated: uid=${uid}, database=${this.database}`);
      return uid;
    } catch (error) {
      this.authenticated = false;
      throw new Error(`Odoo authentication failed: ${error.message}`);
    }
  }

  /**
   * Ensure authenticated before operations
   */
  async ensureAuthenticated() {
    if (!this.authenticated) {
      await this.authenticate();
    }
  }

  /**
   * Execute a method on an Odoo model
   */
  async execute(model, method, args = [], kwargs = {}) {
    await this.ensureAuthenticated();

    return this.xmlRpcCall('/xmlrpc/2/object', 'execute_kw', [
      this.database,
      this.uid,
      this.password,
      model,
      method,
      args,
      kwargs,
    ]);
  }

  /**
   * Search for records
   */
  async search(model, domain = [], options = {}) {
    return this.execute(model, 'search', [domain], options);
  }

  /**
   * Read records by IDs
   */
  async read(model, ids, fields = []) {
    const kwargs = fields.length > 0 ? { fields } : {};
    return this.execute(model, 'read', [ids], kwargs);
  }

  /**
   * Search and read in one call
   */
  async searchRead(model, domain = [], fields = [], options = {}) {
    const kwargs = { ...options };
    if (fields.length > 0) {
      kwargs.fields = fields;
    }
    return this.execute(model, 'search_read', [domain], kwargs);
  }

  /**
   * Create a record
   */
  async create(model, values) {
    return this.execute(model, 'create', [values]);
  }

  /**
   * Update records
   */
  async write(model, ids, values) {
    const idArray = Array.isArray(ids) ? ids : [ids];
    return this.execute(model, 'write', [idArray, values]);
  }

  /**
   * Delete records
   */
  async unlink(model, ids) {
    const idArray = Array.isArray(ids) ? ids : [ids];
    return this.execute(model, 'unlink', [idArray]);
  }

  /**
   * Search or create - find existing record or create new one
   */
  async searchOrCreate(model, domain, values) {
    const existing = await this.search(model, domain, { limit: 1 });
    if (existing && existing.length > 0) {
      return { id: existing[0], created: false };
    }
    const newId = await this.create(model, values);
    return { id: newId, created: true };
  }

  /**
   * Upsert - update if exists, create if not
   */
  async upsert(model, domain, values) {
    const existing = await this.search(model, domain, { limit: 1 });
    if (existing && existing.length > 0) {
      await this.write(model, existing[0], values);
      return { id: existing[0], created: false };
    }
    const newId = await this.create(model, values);
    return { id: newId, created: true };
  }

  /**
   * Get version info (useful for testing connection)
   */
  async version() {
    return this.xmlRpcCall('/xmlrpc/2/common', 'version', []);
  }
}

module.exports = OdooClient;
