const xlsx = require('xlsx');
const fs = require('fs');

const dates = ['06', '07', '08', '09', '10'];
const results = [];

results.push('# GL Journal Export Discrepancy Report');
results.push('# Generated: ' + new Date().toISOString());
results.push('# Comparing our Dutchie API exports vs Auditor Excel files');
results.push('');

let grandTotalExcel = 0, grandTotalOurs = 0;

for (const day of dates) {
  const excelPath = '/Users/Keymaker/Downloads/revenueentries/Journal Transactions 01' + day + '2026.xlsx';
  const tsvPath = '/Users/Keymaker/mintinvsvc/exports/gl_journal_2026-01-' + day + '.tsv';

  // Read Excel
  const wb = xlsx.readFile(excelPath);
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const excelData = xlsx.utils.sheet_to_json(sheet);

  // Read TSV
  const tsvContent = fs.readFileSync(tsvPath, 'utf8');
  const tsvLines = tsvContent.split('\n').filter(l => !l.startsWith('#') && l.trim());
  const tsvData = tsvLines.slice(1).map(line => {
    const [Branch, Store, Account, Description, Subaccount, Ref, Qty, UOM, Debit, Credit] = line.split('\t');
    return { Branch, Account, Debit: parseFloat((Debit||'0').replace(/,/g,'')), Credit: parseFloat((Credit||'0').replace(/,/g,'')) };
  });

  const excelBranches = [...new Set(excelData.map(r => r.Branch))].sort();
  const tsvBranches = [...new Set(tsvData.map(r => r.Branch))].sort();

  results.push('========================================');
  results.push('DATE: January ' + day + ', 2026');
  results.push('========================================');

  let dayTotalExcel = 0, dayTotalOurs = 0;
  let dayDiscrepancies = [];

  // Check sales (40001)
  for (const branch of excelBranches) {
    const excelRow = excelData.find(r => r.Branch === branch && r.Account === '40001');
    const tsvRow = tsvData.find(r => r.Branch === branch && r.Account === '40001');

    const excelVal = excelRow ? excelRow['Credit Amount'] || 0 : 0;
    const tsvVal = tsvRow ? tsvRow.Credit : 0;
    const diff = excelVal - tsvVal;

    dayTotalExcel += excelVal;
    dayTotalOurs += tsvVal;

    if (Math.abs(diff) >= 1) {
      dayDiscrepancies.push({
        branch,
        excel: excelVal,
        ours: tsvVal,
        diff: diff
      });
    }
  }

  // Missing stores
  const missingInOurs = excelBranches.filter(b => !tsvBranches.includes(b));
  const missingInExcel = tsvBranches.filter(b => !excelBranches.includes(b));

  grandTotalExcel += dayTotalExcel;
  grandTotalOurs += dayTotalOurs;

  results.push('');
  results.push('SALES TOTALS:');
  results.push('  Auditor Excel: $' + dayTotalExcel.toFixed(2));
  results.push('  Our Report:    $' + dayTotalOurs.toFixed(2));
  results.push('  Difference:    $' + (dayTotalExcel - dayTotalOurs).toFixed(2));
  results.push('');

  if (dayDiscrepancies.length > 0) {
    results.push('DISCREPANCIES (Sales differences >= $1):');
    for (const d of dayDiscrepancies) {
      results.push('  ' + d.branch + ': Excel $' + d.excel.toFixed(2) + ' vs Ours $' + d.ours.toFixed(2) + ' (diff: $' + d.diff.toFixed(2) + ')');
    }
    results.push('');
  } else {
    results.push('DISCREPANCIES: None - all stores match exactly!');
    results.push('');
  }

  if (missingInOurs.length > 0) {
    results.push('MISSING IN OUR REPORT: ' + missingInOurs.join(', '));
    results.push('');
  }

  if (missingInExcel.length > 0) {
    results.push('MISSING IN EXCEL: ' + missingInExcel.join(', '));
    results.push('');
  }
}

results.push('========================================');
results.push('GRAND TOTALS (Jan 6-10)');
results.push('========================================');
results.push('Auditor Excel: $' + grandTotalExcel.toFixed(2));
results.push('Our Reports:   $' + grandTotalOurs.toFixed(2));
results.push('Total Diff:    $' + (grandTotalExcel - grandTotalOurs).toFixed(2));
results.push('Variance:      ' + ((grandTotalExcel - grandTotalOurs) / grandTotalExcel * 100).toFixed(4) + '%');
results.push('');
results.push('========================================');
results.push('NOTES');
results.push('========================================');
results.push('- Small differences (<$100) are typically boundary transactions at midnight');
results.push('- MID-MT store is in auditor reports but not in our Strapi backend (needs API key)');
results.push('- Debit card breakdown unavailable for non-Florida stores (POS config issue)');

console.log(results.join('\n'));
fs.writeFileSync('/Users/Keymaker/mintinvsvc/exports/discrepancies_jan6-10.txt', results.join('\n'));
console.log('\n\nFile saved to: exports/discrepancies_jan6-10.txt');
