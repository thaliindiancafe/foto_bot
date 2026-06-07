// Переключает таймзону таблицы СменаПро_Тхали на Europe/Moscow.

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

const before = await sheets.spreadsheets.get({ spreadsheetId: RIGHT_ID });
console.log('Было:', before.data.properties?.timeZone);

await sheets.spreadsheets.batchUpdate({
  spreadsheetId: RIGHT_ID,
  requestBody: {
    requests: [
      {
        updateSpreadsheetProperties: {
          properties: { timeZone: 'Europe/Moscow' },
          fields: 'timeZone',
        },
      },
    ],
  },
});

const after = await sheets.spreadsheets.get({ spreadsheetId: RIGHT_ID });
console.log('Стало:', after.data.properties?.timeZone);
