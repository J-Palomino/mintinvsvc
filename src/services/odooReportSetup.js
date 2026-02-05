/**
 * Odoo Report Setup Service
 *
 * Creates custom model, views, and menu for Daily Reports in Odoo
 */

const OdooClient = require('../api/odoo');

class OdooReportSetup {
  constructor() {
    this.odoo = new OdooClient();
    this.enabled = !!(process.env.ODOO_URL && process.env.ODOO_USERNAME && process.env.ODOO_API_KEY);
  }

  async initialize() {
    if (!this.enabled) {
      throw new Error('Odoo not configured');
    }
    await this.odoo.authenticate();
    return true;
  }

  /**
   * Create the x_daily_report model
   */
  async createModel() {
    console.log('Creating x_daily_report model...');

    // Check if model already exists
    const existingModel = await this.odoo.searchRead(
      'ir.model',
      [['model', '=', 'x_daily_report']],
      ['id']
    );

    if (existingModel && existingModel.length > 0) {
      console.log('  Model already exists (ID: ' + existingModel[0].id + ')');
      return existingModel[0].id;
    }

    // Create the model
    const modelId = await this.odoo.create('ir.model', {
      name: 'Daily Report',
      model: 'x_daily_report',
      state: 'manual',
      info: 'Stores imported daily sales reports from Looker/email',
    });

    console.log('  Created model (ID: ' + modelId + ')');
    return modelId;
  }

  /**
   * Create fields for the model
   */
  async createFields(modelId) {
    console.log('Creating fields...');

    const fields = [
      {
        name: 'x_name',
        field_description: 'Report Name',
        ttype: 'char',
        required: true,
      },
      {
        name: 'x_report_type',
        field_description: 'Report Type',
        ttype: 'selection',
        selection: "[('daily_sales_national', 'Daily Sales National'), ('mel_report', 'Mel Report'), ('other', 'Other')]",
      },
      {
        name: 'x_report_date',
        field_description: 'Report Date',
        ttype: 'date',
      },
      {
        name: 'x_source_email_id',
        field_description: 'Source Email ID',
        ttype: 'integer',
      },
      {
        name: 'x_imported_at',
        field_description: 'Imported At',
        ttype: 'datetime',
      },
      {
        name: 'x_row_count',
        field_description: 'Row Count',
        ttype: 'integer',
      },
      {
        name: 'x_total_sales',
        field_description: 'Total Sales',
        ttype: 'float',
      },
      {
        name: 'x_store_count',
        field_description: 'Store Count',
        ttype: 'integer',
      },
      {
        name: 'x_data_json',
        field_description: 'Data (JSON)',
        ttype: 'text',
      },
      {
        name: 'x_attachment_id',
        field_description: 'JSON Attachment',
        ttype: 'many2one',
        relation: 'ir.attachment',
      },
      {
        name: 'x_status',
        field_description: 'Status',
        ttype: 'selection',
        selection: "[('draft', 'Draft'), ('imported', 'Imported'), ('processed', 'Processed'), ('error', 'Error')]",
      },
      {
        name: 'x_notes',
        field_description: 'Notes',
        ttype: 'text',
      },
    ];

    for (const field of fields) {
      // Check if field exists
      const existing = await this.odoo.searchRead(
        'ir.model.fields',
        [['model_id', '=', modelId], ['name', '=', field.name]],
        ['id']
      );

      if (existing && existing.length > 0) {
        console.log(`  Field ${field.name} already exists`);
        continue;
      }

      try {
        await this.odoo.create('ir.model.fields', {
          ...field,
          model_id: modelId,
          state: 'manual',
        });
        console.log(`  Created field: ${field.name}`);
      } catch (e) {
        console.log(`  Error creating ${field.name}: ${e.message}`);
      }
    }
  }

  /**
   * Create tree view
   */
  async createTreeView(modelId) {
    console.log('Creating tree view...');

    const viewName = 'x_daily_report.tree';
    const existing = await this.odoo.searchRead(
      'ir.ui.view',
      [['name', '=', viewName]],
      ['id']
    );

    if (existing && existing.length > 0) {
      console.log('  Tree view already exists (ID: ' + existing[0].id + ')');
      return existing[0].id;
    }

    const arch = `<?xml version="1.0"?>
<tree string="Daily Reports">
  <field name="x_name"/>
  <field name="x_report_type"/>
  <field name="x_report_date"/>
  <field name="x_store_count"/>
  <field name="x_total_sales" widget="monetary"/>
  <field name="x_row_count"/>
  <field name="x_status"/>
  <field name="x_imported_at"/>
</tree>`;

    const viewId = await this.odoo.create('ir.ui.view', {
      name: viewName,
      model: 'x_daily_report',
      type: 'tree',
      arch: arch,
    });

    console.log('  Created tree view (ID: ' + viewId + ')');
    return viewId;
  }

  /**
   * Create form view
   */
  async createFormView(modelId) {
    console.log('Creating form view...');

    const viewName = 'x_daily_report.form';
    const existing = await this.odoo.searchRead(
      'ir.ui.view',
      [['name', '=', viewName]],
      ['id']
    );

    if (existing && existing.length > 0) {
      console.log('  Form view already exists (ID: ' + existing[0].id + ')');
      return existing[0].id;
    }

    const arch = `<?xml version="1.0"?>
<form string="Daily Report">
  <header>
    <field name="x_status" widget="statusbar" statusbar_visible="draft,imported,processed"/>
  </header>
  <sheet>
    <div class="oe_title">
      <h1><field name="x_name" placeholder="Report Name"/></h1>
    </div>
    <group>
      <group>
        <field name="x_report_type"/>
        <field name="x_report_date"/>
        <field name="x_imported_at"/>
      </group>
      <group>
        <field name="x_store_count"/>
        <field name="x_row_count"/>
        <field name="x_total_sales" widget="monetary"/>
      </group>
    </group>
    <group>
      <field name="x_source_email_id"/>
      <field name="x_attachment_id"/>
    </group>
    <notebook>
      <page string="Data">
        <field name="x_data_json" widget="ace" options="{'mode': 'json'}"/>
      </page>
      <page string="Notes">
        <field name="x_notes" placeholder="Additional notes..."/>
      </page>
    </notebook>
  </sheet>
</form>`;

    const viewId = await this.odoo.create('ir.ui.view', {
      name: viewName,
      model: 'x_daily_report',
      type: 'form',
      arch: arch,
    });

    console.log('  Created form view (ID: ' + viewId + ')');
    return viewId;
  }

  /**
   * Create search view
   */
  async createSearchView(modelId) {
    console.log('Creating search view...');

    const viewName = 'x_daily_report.search';
    const existing = await this.odoo.searchRead(
      'ir.ui.view',
      [['name', '=', viewName]],
      ['id']
    );

    if (existing && existing.length > 0) {
      console.log('  Search view already exists (ID: ' + existing[0].id + ')');
      return existing[0].id;
    }

    const arch = `<?xml version="1.0"?>
<search string="Search Reports">
  <field name="x_name"/>
  <field name="x_report_type"/>
  <field name="x_report_date"/>
  <filter string="Daily Sales" name="daily_sales" domain="[('x_report_type', '=', 'daily_sales_national')]"/>
  <filter string="Mel Report" name="mel_report" domain="[('x_report_type', '=', 'mel_report')]"/>
  <separator/>
  <filter string="This Week" name="this_week" domain="[('x_report_date', '>=', (context_today() - relativedelta(days=7)).strftime('%Y-%m-%d'))]"/>
  <filter string="This Month" name="this_month" domain="[('x_report_date', '>=', (context_today().replace(day=1)).strftime('%Y-%m-%d'))]"/>
  <group expand="0" string="Group By">
    <filter string="Report Type" name="group_type" context="{'group_by': 'x_report_type'}"/>
    <filter string="Report Date" name="group_date" context="{'group_by': 'x_report_date'}"/>
    <filter string="Status" name="group_status" context="{'group_by': 'x_status'}"/>
  </group>
</search>`;

    const viewId = await this.odoo.create('ir.ui.view', {
      name: viewName,
      model: 'x_daily_report',
      type: 'search',
      arch: arch,
    });

    console.log('  Created search view (ID: ' + viewId + ')');
    return viewId;
  }

  /**
   * Create action
   */
  async createAction() {
    console.log('Creating action...');

    const actionName = 'Daily Reports';
    const existing = await this.odoo.searchRead(
      'ir.actions.act_window',
      [['name', '=', actionName], ['res_model', '=', 'x_daily_report']],
      ['id']
    );

    if (existing && existing.length > 0) {
      console.log('  Action already exists (ID: ' + existing[0].id + ')');
      return existing[0].id;
    }

    const actionId = await this.odoo.create('ir.actions.act_window', {
      name: actionName,
      res_model: 'x_daily_report',
      view_mode: 'tree,form',
      help: `<p class="o_view_nocontent_smiling_face">
        No reports imported yet
      </p>
      <p>
        Reports are automatically imported nightly from Looker emails.
      </p>`,
    });

    console.log('  Created action (ID: ' + actionId + ')');
    return actionId;
  }

  /**
   * Create menu items
   */
  async createMenus(actionId) {
    console.log('Creating menus...');

    // Check for existing root menu
    const existingRoot = await this.odoo.searchRead(
      'ir.ui.menu',
      [['name', '=', 'Daily Reports']],
      ['id']
    );

    let rootMenuId;
    if (existingRoot && existingRoot.length > 0) {
      rootMenuId = existingRoot[0].id;
      console.log('  Root menu already exists (ID: ' + rootMenuId + ')');
    } else {
      // Create root menu (top-level)
      rootMenuId = await this.odoo.create('ir.ui.menu', {
        name: 'Daily Reports',
        sequence: 50,
        web_icon: 'base,static/description/icon.png',
      });
      console.log('  Created root menu (ID: ' + rootMenuId + ')');
    }

    // Check for existing submenu
    const existingSub = await this.odoo.searchRead(
      'ir.ui.menu',
      [['name', '=', 'All Reports'], ['parent_id', '=', rootMenuId]],
      ['id']
    );

    if (existingSub && existingSub.length > 0) {
      console.log('  Submenu already exists (ID: ' + existingSub[0].id + ')');
      // Update action link
      await this.odoo.write('ir.ui.menu', existingSub[0].id, {
        action: `ir.actions.act_window,${actionId}`,
      });
      return { rootMenuId, subMenuId: existingSub[0].id };
    }

    // Create submenu linked to action
    const subMenuId = await this.odoo.create('ir.ui.menu', {
      name: 'All Reports',
      parent_id: rootMenuId,
      action: `ir.actions.act_window,${actionId}`,
      sequence: 10,
    });
    console.log('  Created submenu (ID: ' + subMenuId + ')');

    return { rootMenuId, subMenuId };
  }

  /**
   * Run full setup
   */
  async setup() {
    console.log('\n=== Setting Up Odoo Daily Reports Module ===\n');

    await this.initialize();

    // Create model
    const modelId = await this.createModel();

    // Create fields
    await this.createFields(modelId);

    // Create views
    await this.createTreeView(modelId);
    await this.createFormView(modelId);
    await this.createSearchView(modelId);

    // Create action
    const actionId = await this.createAction();

    // Create menus
    const menus = await this.createMenus(actionId);

    console.log('\n=== Setup Complete ===');
    console.log('\nThe "Daily Reports" menu is now available in Odoo.');
    console.log('You may need to refresh your browser to see it.');

    return {
      success: true,
      modelId,
      actionId,
      menus,
    };
  }
}

module.exports = OdooReportSetup;
