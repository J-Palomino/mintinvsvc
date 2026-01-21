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
   * Extract value from XML using a simple recursive parser
   */
  extractValue(xml) {
    const trimmed = xml.trim();

    // Boolean
    if (trimmed.includes('<boolean>')) {
      const match = trimmed.match(/<boolean>(\d)<\/boolean>/);
      if (match) return match[1] === '1';
    }

    // Integer
    if (trimmed.includes('<int>') || trimmed.includes('<i4>')) {
      const match = trimmed.match(/<int>(-?\d+)<\/int>/) || trimmed.match(/<i4>(-?\d+)<\/i4>/);
      if (match) return parseInt(match[1], 10);
    }

    // Double
    if (trimmed.includes('<double>')) {
      const match = trimmed.match(/<double>(-?[\d.]+)<\/double>/);
      if (match) return parseFloat(match[1]);
    }

    // Nil/None
    if (trimmed.includes('<nil/>') || trimmed.includes('<nil />')) {
      return null;
    }

    // String - check before array/struct since those may contain strings
    if (trimmed.startsWith('<string>') || (trimmed.includes('<string>') && !trimmed.includes('<array>') && !trimmed.includes('<struct>'))) {
      const match = trimmed.match(/<string>([\s\S]*?)<\/string>/);
      if (match) {
        return match[1]
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&amp;/g, '&');
      }
    }

    // Array - parse recursively
    if (trimmed.includes('<array>')) {
      const arrayStart = trimmed.indexOf('<data>');
      const arrayEnd = trimmed.lastIndexOf('</data>');
      if (arrayStart !== -1 && arrayEnd !== -1) {
        const dataContent = trimmed.substring(arrayStart + 6, arrayEnd);
        return this.parseArrayValues(dataContent);
      }
    }

    // Struct - parse recursively
    if (trimmed.includes('<struct>')) {
      const structStart = trimmed.indexOf('<struct>');
      const structEnd = trimmed.lastIndexOf('</struct>');
      if (structStart !== -1 && structEnd !== -1) {
        const structContent = trimmed.substring(structStart + 8, structEnd);
        return this.parseStructMembers(structContent);
      }
    }

    // Try to extract raw value
    const valueMatch = trimmed.match(/<value>([^<]+)<\/value>/);
    if (valueMatch) return valueMatch[1];

    return null;
  }

  /**
   * Parse array values from XML data content
   */
  parseArrayValues(dataContent) {
    const values = [];
    let depth = 0;
    let valueStart = -1;
    let i = 0;

    while (i < dataContent.length) {
      if (dataContent.substring(i, i + 7) === '<value>') {
        if (depth === 0) valueStart = i + 7;
        depth++;
        i += 7;
      } else if (dataContent.substring(i, i + 8) === '</value>') {
        depth--;
        if (depth === 0 && valueStart !== -1) {
          const valueContent = dataContent.substring(valueStart, i);
          values.push(this.extractValue(valueContent));
          valueStart = -1;
        }
        i += 8;
      } else {
        i++;
      }
    }

    return values;
  }

  /**
   * Parse struct members from XML struct content
   */
  parseStructMembers(structContent) {
    const obj = {};
    let i = 0;

    while (i < structContent.length) {
      const memberStart = structContent.indexOf('<member>', i);
      if (memberStart === -1) break;

      const memberEnd = this.findClosingTag(structContent, memberStart, 'member');
      if (memberEnd === -1) break;

      const memberContent = structContent.substring(memberStart + 8, memberEnd);

      // Extract name
      const nameMatch = memberContent.match(/<name>([^<]+)<\/name>/);
      if (nameMatch) {
        const name = nameMatch[1];

        // Extract value
        const valueStart = memberContent.indexOf('<value>');
        const valueEnd = memberContent.lastIndexOf('</value>');
        if (valueStart !== -1 && valueEnd !== -1) {
          const valueContent = memberContent.substring(valueStart + 7, valueEnd);
          obj[name] = this.extractValue(valueContent);
        }
      }

      i = memberEnd + 9;
    }

    return obj;
  }

  /**
   * Find the closing tag position accounting for nesting
   */
  findClosingTag(xml, start, tagName) {
    const openTag = `<${tagName}>`;
    const closeTag = `</${tagName}>`;
    let depth = 1;
    let i = start + openTag.length;

    while (i < xml.length && depth > 0) {
      if (xml.substring(i, i + openTag.length) === openTag) {
        depth++;
        i += openTag.length;
      } else if (xml.substring(i, i + closeTag.length) === closeTag) {
        depth--;
        if (depth === 0) return i;
        i += closeTag.length;
      } else {
        i++;
      }
    }

    return -1;
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
