/**
 * Fix Odoo Action - update view_mode from tree to list
 */

const OdooClient = require('../src/api/odoo');

async function main() {
  const odoo = new OdooClient();

  console.log('Connecting to Odoo...');
  await odoo.authenticate();
  console.log('Authenticated');

  // Read current action
  const actions = await odoo.searchRead(
    'ir.actions.act_window',
    [['id', '=', 1633]],
    ['id', 'name', 'res_model', 'view_mode', 'view_ids']
  );

  console.log('Current action:', JSON.stringify(actions, null, 2));

  if (actions && actions.length > 0) {
    // Update to list,form
    console.log('\nUpdating view_mode to list,form...');
    await odoo.write('ir.actions.act_window', 1633, {
      view_mode: 'list,form',
    });
    console.log('Updated!');

    // Verify
    const updated = await odoo.searchRead(
      'ir.actions.act_window',
      [['id', '=', 1633]],
      ['id', 'name', 'view_mode']
    );
    console.log('Updated action:', JSON.stringify(updated, null, 2));
  }
}

main().catch(console.error);
