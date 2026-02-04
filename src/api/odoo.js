/**
 * Odoo JSON-RPC Client
 *
 * Fast JSON-RPC client with batch operation support.
 * Endpoints:
 *   - /web/session/authenticate - Session auth
 *   - /jsonrpc - JSON-RPC 2.0 operations
 */

const https = require('https');
const http = require('http');

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
      this.port = parsed.port || (parsed.protocol === 'https:' ? 443 : 80);
      this.protocol = parsed.protocol === 'https:' ? https : http;
      this.baseUrl = this.url;
    }
  }

  /**
   * Make a JSON-RPC call
   */
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

      const req = this.protocol.request(options, (res) => {
        // Capture session cookie
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
      req.setTimeout(30000, () => {
        req.destroy();
        reject(new Error('Request timeout'));
      });
      req.write(body);
      req.end();
    });
  }

  /**
   * Authenticate with Odoo
   */
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
    console.log(`Odoo authenticated: uid=${uid}, database=${this.database}`);
    return uid;
  }

  /**
   * Ensure authenticated
   */
  async ensureAuthenticated() {
    if (!this.authenticated) {
      await this.authenticate();
    }
  }

  /**
   * Execute a model method
   */
  async execute(model, method, args = [], kwargs = {}) {
    await this.ensureAuthenticated();
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

  /**
   * Search for records
   */
  async search(model, domain, options = {}) {
    return this.execute(model, 'search', [domain], options);
  }

  /**
   * Read records by IDs
   */
  async read(model, ids, fields = []) {
    return this.execute(model, 'read', [ids, fields]);
  }

  /**
   * Search and read in one call
   */
  async searchRead(model, domain, fields = [], options = {}) {
    return this.execute(model, 'search_read', [domain], { fields, ...options });
  }

  /**
   * Create a single record
   */
  async create(model, values) {
    return this.execute(model, 'create', [values]);
  }

  /**
   * Batch create multiple records - returns list of IDs
   */
  async createBatch(model, valuesList) {
    if (!valuesList || valuesList.length === 0) return [];
    return this.execute(model, 'create', [valuesList]);
  }

  /**
   * Update a single record
   */
  async write(model, id, values) {
    return this.execute(model, 'write', [[id], values]);
  }

  /**
   * Batch update multiple records with same values
   */
  async writeBatch(model, ids, values) {
    if (!ids || ids.length === 0) return true;
    return this.execute(model, 'write', [ids, values]);
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
   * Batch upsert - efficient bulk create/update
   * Returns { created: number, updated: number, ids: number[] }
   */
  async upsertBatch(model, records, matchField = 'name') {
    if (!records || records.length === 0) {
      return { created: 0, updated: 0, ids: [] };
    }

    // Get all match values
    const matchValues = records.map(r => r[matchField]).filter(Boolean);

    // Find existing records in one query
    const existing = await this.searchRead(
      model,
      [[matchField, 'in', matchValues]],
      ['id', matchField]
    );

    // Build lookup map
    const existingMap = new Map();
    for (const rec of existing) {
      existingMap.set(rec[matchField], rec.id);
    }

    // Separate creates and updates
    const toCreate = [];
    const toUpdate = []; // { id, values }

    for (const record of records) {
      const matchValue = record[matchField];
      const existingId = existingMap.get(matchValue);

      if (existingId) {
        toUpdate.push({ id: existingId, values: record });
      } else {
        toCreate.push(record);
      }
    }

    const ids = [];
    let created = 0;
    let updated = 0;

    // Batch create new records
    if (toCreate.length > 0) {
      const newIds = await this.createBatch(model, toCreate);
      if (Array.isArray(newIds)) {
        ids.push(...newIds);
        created = newIds.length;
      } else if (typeof newIds === 'number') {
        ids.push(newIds);
        created = 1;
      }
    }

    // Update existing records (have to do individually for different values)
    for (const { id, values } of toUpdate) {
      try {
        await this.write(model, id, values);
        ids.push(id);
        updated++;
      } catch (e) {
        console.error(`  Failed to update ${model} ${id}: ${e.message}`);
      }
    }

    return { created, updated, ids };
  }

  /**
   * Delete records
   */
  async unlink(model, ids) {
    return this.execute(model, 'unlink', [ids]);
  }

  /**
   * Get version info
   */
  async version() {
    return this.jsonRpcCall('/jsonrpc', 'common', 'version', []);
  }
}

module.exports = OdooClient;
