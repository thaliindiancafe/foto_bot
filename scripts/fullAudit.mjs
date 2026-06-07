import 'dotenv/config';
import { google } from 'googleapis';
import { loadServiceAccountCredentials } from '../dist/utils/googleServiceAccount.js';

const REAL_ID = '1QRHoSwDzJmIofiz18YXgNvrWCBh-AegtkBsMJ0_9StI'; // правильная (клиент подтвердил)
const WRONG_ID = process.env.GOOGLE_SHEETS_ID; // куда бот пишет сейчас

const credentials = await loadServiceAccountCredentials();
const auth = new google.auth.JWT({
  email: credentials.client_email,
  key: credentials.private_key,
  scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
});
const sheets = google.sheets({ version: 'v4', auth });

async function audit(label, id) {
  console.log(`\n============================================`);
  console.log(`📊 ${label}: ${id}`);
  console.log(`============================================`);

  const meta = await sheets.spreadsheets.get({
    spreadsheetId: id,
    includeGridData: false,
  });
  console.log('Title:', meta.data.properties?.title);
  console.log('Локаль/таймзона spreadsheet:', meta.data.properties?.locale, '/', meta.data.properties?.timeZone);

  const tabs = (meta.data.sheets ?? []).map((s) => s.properties?.title).filter(Boolean);
  console.log('Вкладки:', tabs.join(', '));

  for (const tab of tabs) {
    console.log(`\n--- "${tab}" ---`);
    // Заголовки
    const headerRes = await sheets.spreadsheets.values.get({
      spreadsheetId: id,
      range: `${tab}!A1:Z1`,
    });
    const headers = headerRes.data.values?.[0] ?? [];
    console.log('  заголовки (' + headers.length + '):', headers.map((h, i) => `${String.fromCharCode(65 + i)}=${h}`).join(' | '));

    // Формулы — берём через grid data на первые 10 строк
    const gridRes = await sheets.spreadsheets.get({
      spreadsheetId: id,
      ranges: [`${tab}!A1:Z10`],
      includeGridData: true,
    });
    const gridRows = gridRes.data.sheets?.[0]?.data?.[0]?.rowData ?? [];
    const formulas = [];
    for (let r = 0; r < gridRows.length; r++) {
      const cells = gridRows[r].values ?? [];
      for (let c = 0; c < cells.length; c++) {
        const f = cells[c].userEnteredValue?.formulaValue;
        if (f) formulas.push(`  ${String.fromCharCode(65 + c)}${r + 1}: ${f}`);
      }
    }
    if (formulas.length) {
      console.log('  Формулы в первых 10 строках:');
      for (const f of formulas) console.log(f);
    } else {
      console.log('  Формул в первых 10 строках нет (только values).');
    }

    // Количество строк и колонок
    const allRes = await sheets.spreadsheets.values.get({
      spreadsheetId: id,
      range: `${tab}!A:Z`,
    });
    const all = allRes.data.values ?? [];
    console.log(`  всего строк с данными: ${all.length}, ширина первой строки: ${all[0]?.length ?? 0}`);

    // Образец последних 3
    if (all.length > 1) {
      console.log('  последние 3 строки:');
      for (const r of all.slice(-3)) {
        console.log('   ', r.map((v) => String(v ?? '').slice(0, 22)).join(' | '));
      }
    }
  }
}

await audit('ПРАВИЛЬНАЯ (СменаПро_Тхали)', REAL_ID);
await audit('НЕПРАВИЛЬНАЯ (СменаПро) — куда бот пишет сейчас', WRONG_ID);
