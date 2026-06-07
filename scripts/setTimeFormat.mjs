// Принудительно задаёт 24-часовой формат для всех колонок с датой/временем
// во вкладках Ресторан, Кофепоинт, Смены таблицы СменаПро_Тхали.

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

const meta = await sheets.spreadsheets.get({ spreadsheetId: RIGHT_ID });
const sheetIds = Object.fromEntries(
  (meta.data.sheets ?? []).map((s) => [s.properties?.title, s.properties?.sheetId]),
);
console.log('Sheet IDs:', sheetIds);

// Конфигурация: какие колонки и какой формат
// Ресторан/Кофепоинт: A=Дата, L=Время начала, M=Время окончания, P=Первое откладывание
// Смены: A=Дата, E=Начало смены, F=Конец смены
const targets = [
  { tab: 'Ресторан', col: 0, type: 'DATE', pattern: 'dd.MM.yyyy' },
  { tab: 'Ресторан', col: 11, type: 'DATE_TIME', pattern: 'dd.MM.yyyy HH:mm' },
  { tab: 'Ресторан', col: 12, type: 'DATE_TIME', pattern: 'dd.MM.yyyy HH:mm' },
  { tab: 'Ресторан', col: 15, type: 'DATE_TIME', pattern: 'dd.MM.yyyy HH:mm' },
  { tab: 'Кофепоинт', col: 0, type: 'DATE', pattern: 'dd.MM.yyyy' },
  { tab: 'Кофепоинт', col: 11, type: 'DATE_TIME', pattern: 'dd.MM.yyyy HH:mm' },
  { tab: 'Кофепоинт', col: 12, type: 'DATE_TIME', pattern: 'dd.MM.yyyy HH:mm' },
  { tab: 'Кофепоинт', col: 15, type: 'DATE_TIME', pattern: 'dd.MM.yyyy HH:mm' },
  { tab: 'Смены', col: 0, type: 'DATE', pattern: 'dd.MM.yyyy' },
  { tab: 'Смены', col: 4, type: 'TIME', pattern: 'HH:mm' },
  { tab: 'Смены', col: 5, type: 'TIME', pattern: 'HH:mm' },
];

const requests = targets.map(({ tab, col, type, pattern }) => ({
  repeatCell: {
    range: {
      sheetId: sheetIds[tab],
      startColumnIndex: col,
      endColumnIndex: col + 1,
      startRowIndex: 1, // пропускаем заголовок
    },
    cell: {
      userEnteredFormat: {
        numberFormat: { type, pattern },
      },
    },
    fields: 'userEnteredFormat.numberFormat',
  },
}));

await sheets.spreadsheets.batchUpdate({
  spreadsheetId: RIGHT_ID,
  requestBody: { requests },
});

console.log(`✅ Применено форматов: ${requests.length}`);
for (const t of targets) {
  const colLetter = String.fromCharCode(65 + t.col);
  console.log(`  ${t.tab} ${colLetter} → ${t.pattern}`);
}
