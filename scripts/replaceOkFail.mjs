// Заменяет "OK" → "✅" и "FAIL" → "❌" в колонке I (Результат AI)
// во вкладках Ресторан + Кофепоинт правильной таблицы (СменаПро_Тхали).
// Только точные строки "OK"/"FAIL" (с учётом регистра) — не трогает уже эмодзи и пустые ячейки.

import 'dotenv/config';
import { google } from 'googleapis';
import { loadServiceAccountCredentials } from '../dist/utils/googleServiceAccount.js';

const RIGHT_ID = '1QRHoSwDzJmIofiz18YXgNvrWCBh-AegtkBsMJ0_9StI';

const credentials = await loadServiceAccountCredentials();
const auth = new google.auth.JWT({
  email: credentials.client_email,
  key: credentials.private_key,
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});
const sheets = google.sheets({ version: 'v4', auth });

for (const tab of ['Ресторан', 'Кофепоинт']) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: RIGHT_ID,
    range: `${tab}!I2:I10000`,
  });
  const rows = res.data.values ?? [];
  let okCount = 0, failCount = 0;
  const newRows = rows.map((r) => {
    const v = r[0];
    if (v === 'OK') { okCount++; return ['✅']; }
    if (v === 'FAIL') { failCount++; return ['❌']; }
    return [v ?? ''];
  });

  if (okCount + failCount === 0) {
    console.log(`${tab}: нечего менять`);
    continue;
  }

  await sheets.spreadsheets.values.update({
    spreadsheetId: RIGHT_ID,
    range: `${tab}!I2:I${1 + newRows.length}`,
    valueInputOption: 'RAW',
    requestBody: { values: newRows },
  });
  console.log(`${tab}: OK→✅ заменено ${okCount}, FAIL→❌ заменено ${failCount}`);
}

console.log('\n✅ Замена завершена');
