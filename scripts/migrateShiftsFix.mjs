// Доперенос: смена Дарьи 24.05 + чистка тестовой строки Иванова из Статистики

import 'dotenv/config';
import { google } from 'googleapis';
import { loadServiceAccountCredentials } from '../dist/utils/googleServiceAccount.js';

const WRONG_ID = '14SBBTlachXMsKx4MaI4YUX1PAFwjudE4_UJTGNWcc0U';
const RIGHT_ID = '1QRHoSwDzJmIofiz18YXgNvrWCBh-AegtkBsMJ0_9StI';

const credentials = await loadServiceAccountCredentials();
const auth = new google.auth.JWT({
  email: credentials.client_email,
  key: credentials.private_key,
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});
const sheets = google.sheets({ version: 'v4', auth });

// 1. Дарья 24.05 — взять из WRONG, пересчитать на 16ч, добавить в RIGHT
const wrongShifts = (await sheets.spreadsheets.values.get({
  spreadsheetId: WRONG_ID, range: 'Смены!A:H',
})).data.values ?? [];

const dariaRow = wrongShifts.slice(1).find((r) => r[1] === 'Дарья' && r[0]?.startsWith('24.05'));
if (dariaRow) {
  const r = [...dariaRow];
  const [hh, mm] = r[4].split(':').map(Number);
  const totalMin = hh * 60 + mm + 16 * 60;
  const endH = Math.floor((totalMin / 60) % 24);
  const endM = totalMin % 60;
  r[5] = `${String(endH).padStart(2, '0')}:${String(endM).padStart(2, '0')}`;
  r[6] = '16.0';
  console.log('Добавляю смену Дарьи (пересчитано):', r.join(' | '));
  await sheets.spreadsheets.values.append({
    spreadsheetId: RIGHT_ID, range: 'Смены!A:H',
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [r] },
  });
} else {
  console.log('Дарьи 24.05 не нашлось в WRONG.Смены');
}

// 2. Чистка Статистики в RIGHT: удалить тестового Иванова (если есть)
const rightStats = (await sheets.spreadsheets.values.get({
  spreadsheetId: RIGHT_ID, range: 'Статистика!A:F',
})).data.values ?? [];

console.log('\nТекущая Статистика RIGHT:');
for (const r of rightStats) console.log(' ', r.join(' | '));

const filtered = rightStats.filter((r) => {
  // Шапка
  if (r[0] === 'Месяц') return true;
  // Тестовый Иванов
  if (r[1] === 'Иванов Иван') {
    console.log('  ⛔ удаляю:', r.join(' | '));
    return false;
  }
  return true;
});

if (filtered.length !== rightStats.length) {
  await sheets.spreadsheets.values.clear({ spreadsheetId: RIGHT_ID, range: 'Статистика!A:F' });
  await sheets.spreadsheets.values.update({
    spreadsheetId: RIGHT_ID,
    range: 'Статистика!A1',
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: filtered },
  });
  console.log(`\n✅ Статистика очищена: было ${rightStats.length}, стало ${filtered.length}`);
} else {
  console.log('\n(Иванова не нашлось, чистка не нужна)');
}
