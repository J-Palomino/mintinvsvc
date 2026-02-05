/**
 * Create Missing GL Accounts in Odoo
 *
 * Creates accounts needed for daily sales journal export:
 * - 40002: Sales Discounts (contra-revenue)
 * - 40003: Sales Returns (contra-revenue)
 * - 40004: Loyalty Redemptions (contra-revenue)
 * - 11010: Debit Card Receivable
 * - 70260: Tips Payable
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

  async fieldsGet(model, attributes = ['string', 'type', 'selection']) {
    return this.execute(model, 'fields_get', [], { attributes });
  }

  async create(model, values) {
    return this.execute(model, 'create', [values]);
  }
}

async function main() {
  const odoo = new OdooClient();

  console.log('='.repeat(60));
  console.log('CREATE MISSING GL ACCOUNTS IN ODOO');
  console.log('='.repeat(60));

  try {
    // Step 1: Authenticate
    console.log('\n1. Authenticating...');
    await odoo.authenticate();
    console.log('   Authenticated successfully (uid=' + odoo.uid + ')');

    // Step 2: Get available fields on account.account
    console.log('\n2. Getting account.account field definitions...');
    const allFields = await odoo.fieldsGet('account.account', ['string', 'type', 'selection', 'required']);

    // Determine which fields exist
    const hasField = (name) => allFields[name] !== undefined;

    // Build the base fields list
    const baseFields = ['id', 'code', 'name', 'account_type', 'reconcile'];

    console.log('   Key fields available:');
    console.log(`   - code: ${hasField('code')}`);
    console.log(`   - name: ${hasField('name')}`);
    console.log(`   - account_type: ${hasField('account_type')}`);
    console.log(`   - reconcile: ${hasField('reconcile')}`);
    console.log(`   - company_id: ${hasField('company_id')}`);

    // Step 3: Get available account types
    console.log('\n3. Getting available account types...');
    const accountTypeField = allFields['account_type'];
    let accountTypes = [];
    if (accountTypeField && accountTypeField.selection) {
      accountTypes = accountTypeField.selection;
      console.log('   Available account types:');
      for (const [value, label] of accountTypes) {
        console.log(`   - ${value}: ${label}`);
      }
    } else {
      console.log('   Could not retrieve account type options');
    }

    // Find appropriate types
    const findType = (keywords) => {
      for (const kw of keywords) {
        const found = accountTypes.find(([v]) => v.includes(kw));
        if (found) return found[0];
      }
      return null;
    };

    const incomeType = findType(['income']) || 'income';
    const receivableType = findType(['receivable']) || 'asset_receivable';
    const currentAssetType = findType(['asset_current', 'asset']) || 'asset_current';
    const liabilityType = findType(['liability_current', 'liability']) || 'liability_current';

    console.log('\n   Selected types for new accounts:');
    console.log(`   - Income/Contra-revenue: ${incomeType}`);
    console.log(`   - Receivable: ${receivableType}`);
    console.log(`   - Current Asset: ${currentAssetType}`);
    console.log(`   - Current Liability: ${liabilityType}`);

    // Step 4: Look at an existing account for reference
    console.log('\n4. Examining existing accounts...');
    const existingAny = await odoo.searchRead(
      'account.account',
      [],
      baseFields,
      { limit: 3 }
    );

    if (existingAny.length > 0) {
      console.log('   Sample existing accounts:');
      for (const acc of existingAny) {
        console.log(`   - [${acc.id}] ${acc.code}: ${acc.name} (${acc.account_type})`);
      }
    }

    // Also look at income accounts specifically
    const incomeAccounts = await odoo.searchRead(
      'account.account',
      [['account_type', '=', incomeType]],
      baseFields,
      { limit: 2 }
    );

    let referenceType = incomeType;
    if (incomeAccounts.length > 0) {
      console.log('   Income accounts found:');
      for (const acc of incomeAccounts) {
        console.log(`   - [${acc.id}] ${acc.code}: ${acc.name} (${acc.account_type})`);
      }
      referenceType = incomeAccounts[0].account_type;
    }

    // Step 5: Check which accounts already exist
    console.log('\n5. Checking target account codes...');
    const targetCodes = ['40002', '40003', '40004', '11010', '70260'];
    const existingAccounts = await odoo.searchRead(
      'account.account',
      [['code', 'in', targetCodes]],
      baseFields
    );

    const existingCodes = new Set(existingAccounts.map(a => a.code));
    const existingById = {};
    for (const acc of existingAccounts) {
      existingById[acc.code] = acc;
    }

    console.log('   Existing target accounts:');
    if (existingAccounts.length === 0) {
      console.log('   - None of the target accounts exist');
    } else {
      for (const acc of existingAccounts) {
        console.log(`   - ${acc.code}: ${acc.name} (${acc.account_type}) [ID: ${acc.id}]`);
      }
    }

    // Step 6: Define accounts to create
    // For contra-revenue accounts (discounts, returns, loyalty), use income type
    const accountsToCreate = [
      {
        code: '40002',
        name: 'Sales Discounts',
        account_type: referenceType,
        reconcile: false,
      },
      {
        code: '40003',
        name: 'Sales Returns',
        account_type: referenceType,
        reconcile: false,
      },
      {
        code: '40004',
        name: 'Loyalty Redemptions',
        account_type: referenceType,
        reconcile: false,
      },
      {
        code: '11010',
        name: 'Debit Card Receivable',
        account_type: receivableType,
        reconcile: true,
      },
      {
        code: '70260',
        name: 'Tips Payable',
        account_type: liabilityType,
        reconcile: false,
      },
    ];

    // Step 7: Create missing accounts
    console.log('\n6. Creating missing accounts...');
    const createdAccounts = [];

    for (const account of accountsToCreate) {
      if (existingCodes.has(account.code)) {
        console.log(`   SKIP ${account.code}: Already exists (ID: ${existingById[account.code].id})`);
        createdAccounts.push({ ...account, id: existingById[account.code].id, existed: true });
        continue;
      }

      try {
        console.log(`   Creating ${account.code} (${account.name}) with type=${account.account_type}...`);
        const newId = await odoo.create('account.account', account);
        console.log(`   SUCCESS: Created account ${account.code} with ID ${newId}`);
        createdAccounts.push({ ...account, id: newId, existed: false });
      } catch (error) {
        console.log(`   ERROR creating ${account.code}: ${error.message}`);
      }
    }

    // Step 8: Summary
    console.log('\n' + '='.repeat(60));
    console.log('SUMMARY');
    console.log('='.repeat(60));

    const existed = createdAccounts.filter(a => a.existed);
    const created = createdAccounts.filter(a => !a.existed);

    console.log(`\nAccounts that already existed: ${existed.length}`);
    for (const acc of existed) {
      console.log(`  - ${acc.code}: ${acc.name} (ID: ${acc.id})`);
    }

    console.log(`\nAccounts created: ${created.length}`);
    for (const acc of created) {
      console.log(`  - ${acc.code}: ${acc.name} (ID: ${acc.id})`);
    }

    if (createdAccounts.length === targetCodes.length) {
      console.log('\nAll required GL accounts are now available in Odoo!');
    } else {
      const accountedFor = new Set(createdAccounts.map(a => a.code));
      const missing = targetCodes.filter(c => !accountedFor.has(c));
      if (missing.length > 0) {
        console.log(`\nWARNING: Some accounts could not be created: ${missing.join(', ')}`);
      }
    }

    // Return the account IDs for reference
    console.log('\nAccount IDs:');
    for (const acc of createdAccounts) {
      console.log(`  ${acc.code} -> ${acc.id}`);
    }

  } catch (error) {
    console.error('\nError:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

main().catch(console.error);
