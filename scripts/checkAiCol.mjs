import 'dotenv/config';
import { google } from 'googleapis';
import { loadServiceAccountCredentials } from '../dist/utils/googleServiceAccount.js';

const BOT_ID = process.env.GOOGLE_SHEETS_ID;
const CLIENT_ID = '1QRHoSwDzJmIofiz18YXgNvrWCBh-AegtkBsMJ0_9StI';

const credentials = await loadServiceAccountCredentials();
const auth = new google.auth.JWT({
  email: credentials.client_email,
  key: credentials.private_key,
  scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
});
const sheets = google.sheets({ version: 'v4', auth });

async function lastAI(id, label, tab) {
  console.log(`\n=== ${label} / ${tab} ===`);
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: id,
    range: `${tab}!A:M`,
  });
  const rows = res.data.values ?? [];
  console.log(`  всего: ${rows.length} строк`);
  if (rows.length < 2) return;
  // Заголовок:
  console.log('  заголовок I/J:', rows[0]?.[8], '|', rows[0]?.[9]);
  console.log('  последние 8 строк (Дата | Имя | I=AI результат | J=коммент AI):');
  for (const r of rows.slice(-8)) {
    const date = r[0] ?? '';
    const name = r[1] ?? '';
    const i = r[8] ?? '';
    const j = (r[9] ?? '').slice(0, 40);
    console.log(`    ${date} | ${name.padEnd(12)} | I="${i}" | J="${j}"`);
  }
}

for (const tab of ['Ресторан', 'Кофепоинт']) {
  await lastAI(BOT_ID, 'BOT СменаПро', tab);
  await lastAI(CLIENT_ID, 'CLIENT СменаПро_Тхали', tab);
}
