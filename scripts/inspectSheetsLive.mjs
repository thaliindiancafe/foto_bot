import 'dotenv/config';
import { google } from 'googleapis';
import { loadServiceAccountCredentials } from '../dist/utils/googleServiceAccount.js';

const SHEETS_ID = process.env.GOOGLE_SHEETS_ID;
console.log('GOOGLE_SHEETS_ID =', SHEETS_ID);

const credentials = await loadServiceAccountCredentials();
const auth = new google.auth.JWT({
  email: credentials.client_email,
  key: credentials.private_key,
  scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
});
const sheets = google.sheets({ version: 'v4', auth });

const meta = await sheets.spreadsheets.get({ spreadsheetId: SHEETS_ID });
console.log('\n=== Все вкладки таблицы ===');
for (const s of meta.data.sheets ?? []) {
  console.log(`  "${s.properties?.title}" gid=${s.properties?.sheetId} rows=${s.properties?.gridProperties?.rowCount}`);
}

async function dumpSheet(name, range) {
  console.log(`\n=== ${name} (${range}) ===`);
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEETS_ID,
      range: `${name}!${range}`,
    });
    const rows = res.data.values ?? [];
    console.log(`  всего строк с данными: ${rows.length}`);
    if (!rows.length) return;
    console.log('  --- первые 3 строки ---');
    for (const r of rows.slice(0, 3)) console.log('   ', r.map((v) => String(v).slice(0, 30)).join(' | '));
    console.log('  --- последние 5 строк ---');
    for (const r of rows.slice(-5)) console.log('   ', r.map((v) => String(v).slice(0, 30)).join(' | '));
  } catch (e) {
    console.log('  ERROR:', e.message);
  }
}

await dumpSheet('Ресторан', 'A1:Q200');
await dumpSheet('Кофепоинт', 'A1:Q200');
await dumpSheet('Смены', 'A1:H200');
