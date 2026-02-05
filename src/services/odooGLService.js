/**
 * Odoo GL Journal Service
 * Posts daily GL journal entries to Odoo account.move
 */

const OdooClient = require('../api/odoo');

// GL Code to Odoo Account mapping
// These are populated on initialization from Odoo
const GL_ACCOUNT_MAP = {
  '40001': { name: 'Product Sales', odooId: null },
  '40002': { name: 'Sales Discounts', odooId: null },
  '40003': { name: 'Sales Returns', odooId: null },
  '40004': { name: 'Loyalty Redemptions', odooId: null },
  '23500': { name: 'Taxes Payable', odooId: null },
  '10000': { name: 'Cash on Hand', odooId: null },
  '11010': { name: 'Debit Card Receivable', odooId: null },
  '70260': { name: 'Overage/Shortage', odooId: null },
  '50000': { name: 'Cost of Goods Sold', odooId: null },
  '12250': { name: 'Inventory - Finished Goods', odooId: null },
};

// Alternative account codes that might exist in Odoo
const ACCOUNT_CODE_ALTERNATIVES = {
  '40001': ['40001', '400010', '4000'],    // Income
  '40002': ['40002', '400020'],            // Discounts
  '40003': ['40003', '400030'],            // Returns
  '40004': ['40004', '400040'],            // Loyalty
  '23500': ['23500', '235000', '2150'],    // Tax liability
  '10000': ['10000', '100000', '1000'],    // Cash
  '11010': ['11010', '110100'],            // Debit receivable
  '70260': ['70260', '702600'],            // Overage
  '50000': ['50000', '500000', '5000'],    // COGS
  '12250': ['12250', '122500', '1220'],    // Inventory
};

class OdooGLService {
  constructor() {
    this.odoo = new OdooClient();
    this.enabled = !!(process.env.ODOO_URL && process.env.ODOO_USERNAME && process.env.ODOO_API_KEY);
    this.journalId = null;  // POS Journal ID
    this.accountsLoaded = false;
  }

  isEnabled() {
    return this.enabled;
  }

  async initialize() {
    if (!this.enabled) {
      console.log('Odoo GL sync disabled - missing credentials');
      return false;
    }

    try {
      await this.odoo.authenticate();
      await this.loadAccountMappings();
      await this.loadJournal();
      return true;
    } catch (error) {
      console.error('Odoo GL initialization failed:', error.message);
      return false;
    }
  }

  /**
   * Load Odoo account IDs for our GL codes
   */
  async loadAccountMappings() {
    console.log('  Loading Odoo account mappings...');

    // Get all accounts from Odoo
    const accounts = await this.odoo.searchRead(
      'account.account',
      [],
      ['id', 'code', 'name']
    );

    const accountByCode = new Map();
    for (const acc of accounts || []) {
      accountByCode.set(acc.code, acc);
    }

    // Map our GL codes to Odoo account IDs
    let mapped = 0;
    let missing = [];

    for (const [glCode, config] of Object.entries(GL_ACCOUNT_MAP)) {
      // Try alternative codes
      const alternatives = ACCOUNT_CODE_ALTERNATIVES[glCode] || [glCode];
      let found = false;

      for (const altCode of alternatives) {
        if (accountByCode.has(altCode)) {
          config.odooId = accountByCode.get(altCode).id;
          config.odooCode = altCode;
          mapped++;
          found = true;
          break;
        }
      }

      if (!found) {
        missing.push(glCode);
      }
    }

    console.log(`  Mapped ${mapped}/${Object.keys(GL_ACCOUNT_MAP).length} GL accounts`);
    if (missing.length > 0) {
      console.log(`  Missing accounts: ${missing.join(', ')}`);
    }

    this.accountsLoaded = true;
    return { mapped, missing };
  }

  /**
   * Load or create the POS journal for GL entries
   */
  async loadJournal() {
    // Look for existing POS or Miscellaneous journal
    const journals = await this.odoo.searchRead(
      'account.journal',
      [['type', '=', 'general']],
      ['id', 'name', 'code']
    );

    // Prefer "Point of Sale" or "Daily Sales" journal
    let journal = journals.find(j => j.code === 'POSS' || j.name.includes('Point of Sale'));
    if (!journal) {
      journal = journals.find(j => j.code === 'DSALES' || j.name.includes('Daily Sales'));
    }
    if (!journal) {
      journal = journals.find(j => j.code === 'MISC' || j.name.includes('Miscellaneous'));
    }
    if (!journal && journals.length > 0) {
      journal = journals[0];
    }

    if (journal) {
      this.journalId = journal.id;
      console.log(`  Using journal: ${journal.name} (ID: ${journal.id})`);
    } else {
      console.log('  WARNING: No suitable journal found');
    }

    return this.journalId;
  }

  /**
   * Get Odoo account ID for a GL code
   */
  getOdooAccountId(glCode) {
    const config = GL_ACCOUNT_MAP[glCode];
    return config ? config.odooId : null;
  }

  /**
   * Parse currency string to number
   */
  parseCurrency(value) {
    if (typeof value === 'number') return value;
    if (!value) return 0;
    const cleaned = String(value).replace(/[$,\s]/g, '');
    const num = parseFloat(cleaned);
    return isNaN(num) ? 0 : num;
  }

  /**
   * Check if a journal entry already exists for this date/store
   */
  async findExistingEntry(reportDate, storeName) {
    const ref = `${reportDate} DS - ${storeName}`;
    const existing = await this.odoo.searchRead(
      'account.move',
      [
        ['ref', '=', ref],
        ['journal_id', '=', this.journalId]
      ],
      ['id', 'name', 'state']
    );
    return existing && existing.length > 0 ? existing[0] : null;
  }

  /**
   * Create a journal entry for one store's daily totals
   * @param {string} reportDate - Date in YYYY-MM-DD format
   * @param {string} storeName - Store name
   * @param {object} totals - Aggregated totals from GL export
   * @param {string} branchCode - Branch code for reference
   */
  async createJournalEntry(reportDate, storeName, totals, branchCode) {
    if (!this.journalId) {
      throw new Error('No journal configured');
    }

    // Check for existing entry
    const existing = await this.findExistingEntry(reportDate, storeName);
    if (existing) {
      console.log(`  Entry exists for ${storeName} on ${reportDate} (ID: ${existing.id}, state: ${existing.state})`);
      return { id: existing.id, status: 'exists', state: existing.state };
    }

    // Build journal entry lines
    const lines = [];

    // Helper to add a line
    const addLine = (glCode, description, debit, credit) => {
      const accountId = this.getOdooAccountId(glCode);
      if (!accountId) {
        console.log(`    Skipping ${glCode} - no Odoo account mapped`);
        return;
      }

      // Only add line if there's a non-zero amount
      const debitAmt = this.parseCurrency(debit) || 0;
      const creditAmt = this.parseCurrency(credit) || 0;
      if (debitAmt === 0 && creditAmt === 0) return;

      lines.push([0, 0, {
        account_id: accountId,
        name: description,
        debit: debitAmt,
        credit: creditAmt,
      }]);
    };

    // Add lines per GL account mapping
    // 40001 - Sales (Credit)
    addLine('40001', 'Sales Income - Retail Sales', 0, totals.grossSales || 0);

    // 40002 - Discounts (Debit)
    addLine('40002', 'Retail Income: Discounts and Coupons', totals.discounts || 0, 0);

    // 40003 - Returns (Debit) - usually 0
    addLine('40003', 'Retail Income: Sales Return', totals.returns || 0, 0);

    // 40004 - Loyalty (Debit)
    addLine('40004', 'Loyalty Discounts', totals.loyaltySpent || 0, 0);

    // 23500 - Tax (Credit)
    addLine('23500', 'Taxes Payable - Sales & Use', 0, totals.tax || 0);

    // 10000 - Cash (Debit)
    addLine('10000', 'Cash on Hand', totals.netCash || 0, 0);

    // 11010 - Debit (Debit)
    addLine('11010', 'Debit Card Receivable', totals.debitPaid || 0, 0);

    // 70260 - Overage (balance)
    const overage = totals.overage || 0;
    if (overage >= 0) {
      addLine('70260', 'Overage/Shortage: Cash Ledger Adj', 0, overage);
    } else {
      addLine('70260', 'Overage/Shortage: Cash Ledger Adj', Math.abs(overage), 0);
    }

    // 50000 - COGS (Debit)
    addLine('50000', 'Retail COG - Consumable Products for Resale', totals.cogs || 0, 0);

    // 12250 - Inventory (Credit)
    addLine('12250', 'Inventory - Finished Goods', 0, totals.cogs || 0);

    if (lines.length === 0) {
      console.log(`  No lines to post for ${storeName}`);
      return { status: 'empty' };
    }

    // Create the journal entry
    const moveData = {
      journal_id: this.journalId,
      date: reportDate,
      ref: `${reportDate} DS - ${storeName}`,
      move_type: 'entry',
      line_ids: lines,
    };

    try {
      const moveId = await this.odoo.create('account.move', moveData);
      console.log(`  Created journal entry for ${storeName}: ID ${moveId} (${lines.length} lines)`);
      return { id: moveId, status: 'created', lines: lines.length };
    } catch (error) {
      console.error(`  Failed to create entry for ${storeName}: ${error.message}`);
      return { status: 'error', error: error.message };
    }
  }

  /**
   * Post GL export data to Odoo
   * @param {Map<string, object>} storeData - Store name to totals map from GL export
   * @param {string} reportDate - Report date in YYYY-MM-DD format
   * @param {function} getBranchCode - Function to get branch code from store name
   */
  async postGLExport(storeData, reportDate, getBranchCode) {
    if (!this.enabled) {
      console.log('Odoo GL sync skipped - not configured');
      return { posted: 0, skipped: 0, errors: 0 };
    }

    console.log(`\n--- Posting GL Journal to Odoo for ${reportDate} ---`);

    if (!this.odoo.authenticated) {
      const ok = await this.initialize();
      if (!ok) {
        return { posted: 0, skipped: 0, errors: 1, error: 'initialization failed' };
      }
    }

    let posted = 0;
    let skipped = 0;
    let errors = 0;

    for (const [storeName, totals] of storeData) {
      const branchCode = getBranchCode ? getBranchCode(storeName) : storeName;

      try {
        const result = await this.createJournalEntry(reportDate, storeName, totals, branchCode);

        if (result.status === 'created') {
          posted++;
        } else if (result.status === 'exists' || result.status === 'empty') {
          skipped++;
        } else if (result.status === 'error') {
          errors++;
        }
      } catch (error) {
        console.error(`  Error posting ${storeName}: ${error.message}`);
        errors++;
      }
    }

    console.log(`Odoo GL sync complete: ${posted} posted, ${skipped} skipped, ${errors} errors`);
    return { posted, skipped, errors };
  }

  /**
   * Post GL export from parsed CSV/JSON data
   * This is called after GLExportService generates the export
   */
  async postFromGLExport(glExportService, storeData, reportDate) {
    return this.postGLExport(
      storeData,
      reportDate,
      (storeName) => glExportService.getBranchCode(storeName)
    );
  }
}

module.exports = OdooGLService;
