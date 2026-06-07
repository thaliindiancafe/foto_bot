import 'dotenv/config';
import { google } from 'googleapis';
import { loadServiceAccountCredentials } from '../dist/utils/googleServiceAccount.js';

const BOT_ID = process.env.GOOGLE_SHEETS_ID; // куда пишет бот
const CLIENT_ID = '1QRHoSwDzJmIofiz18YXgNvrWCBh-AegtkBsMJ0_9StI'; // ссылка клиента

const credentials = await loadServiceAccountCredentials();
const auth = new google.auth.JWT({
  email: credentials.client_email,
  key: credentials.private_key,
  scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
});
const sheets = google.sheets({ version: 'v4', auth });

async function inspect(label, id) {
  console.log(`\n========== ${label} (${id}) ==========`);
  try {
    const meta = await sheets.spreadsheets.get({ spreadsheetId: id });
    console.log('Title:', meta.data.properties?.title);
    console.log('Вкладки:');
    for (const s of meta.data.sheets ?? []) {
      console.log(`  - "${s.properties?.title}" gid=${s.properties?.sheetId}`);
    }
    for (const tab of ['Ресторан', 'Кофепоинт', 'Смены']) {
      try {
        const res = await sheets.spreadsheets.values.get({
          spreadsheetId: id,
          range: `${tab}!A1:H300`,
        });
        const rows = res.data.values ?? [];
        console.log(`  ${tab}: ${rows.length} строк`);
        if (tab === 'Смены' && rows.length > 0) {
          console.log('    Все строки "Смены":');
          for (const r of rows) console.log('     ', r.map((v) => String(v).slice(0, 30)).join(' | '));
        } else if (rows.length > 1) {
          console.log('    Последняя строка:', rows[rows.length - 1].slice(0, 8).map((v) => String(v).slice(0, 25)).join(' | '));
        }
      } catch (e) {
        console.log(`  ${tab}: ERROR ${e.message}`);
      }
    }
  } catch (e) {
    console.log('META ERROR:', e.message);
  }
}

await inspect('BOT  (куда пишет бот, из .env)', BOT_ID);
await inspect('CLIENT (ссылка от клиента)', CLIENT_ID);
