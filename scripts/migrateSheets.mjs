// One-shot migration:
// 1. Copy rows 25-28 May from WRONG (СменаПро 14SBB...) to RIGHT (СменаПро_Тхали 1QRH...)
// 2. Replace OK/FAIL -> ✅/❌ in column I of Ресторан + Кофепоинт in RIGHT
// 3. Switch RIGHT spreadsheet timezone to Europe/Moscow
//
// Idempotent guards:
// - Skips rows whose A+L+M+F triple already exists in destination (avoids dupes if rerun).
// - OK/FAIL replace only touches strings exactly "OK" or "FAIL".

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

const CUTOFF = new Date('2026-05-25T00:00:00+03:00'); // МСК
function parseRuDate(s) {
  // "25.05.2026" -> Date (МСК)
  if (!s) return null;
  const m = String(s).match(/^(\d{2})\.(\d{2})\.(\d{4})/);
  if (!m) return null;
  return new Date(`${m[3]}-${m[2]}-${m[1]}T00:00:00+03:00`);
}

async function readAll(id, tab, lastCol) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: id,
    range: `${tab}!A1:${lastCol}10000`,
  });
  return res.data.values ?? [];
}

async function append(id, tab, rows) {
  if (!rows.length) return;
  await sheets.spreadsheets.values.append({
    spreadsheetId: id,
    range: `${tab}!A:Q`,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: rows },
  });
}

function dedupKey(row, tab) {
  if (tab === 'Смены') return [row[0], row[1], row[4], row[5]].join('|');
  if (tab === 'Статистика') return [row[0], row[1]].join('|');
  // Ресторан / Кофепоинт: дата + имя + задача + время начала + время окончания
  return [row[0], row[1], row[5], row[11], row[12]].join('|');
}

// ====== STEP 1: migrate row-level (Ресторан/Кофепоинт) ======
for (const tab of ['Ресторан', 'Кофепоинт']) {
  console.log(`\n=== Перенос "${tab}" ===`);
  const wrongRows = await readAll(WRONG_ID, tab, 'Q');
  const rightRows = await readAll(RIGHT_ID, tab, 'Q');
  console.log(`  WRONG: ${wrongRows.length} строк, RIGHT: ${rightRows.length} строк`);

  const rightKeys = new Set(rightRows.slice(1).map((r) => dedupKey(r, tab)));

  const toCopy = [];
  for (let i = 1; i < wrongRows.length; i++) {
    const r = wrongRows[i];
    const d = parseRuDate(r[0]);
    if (!d || d < CUTOFF) continue;
    // Добиваем до 17 колонок
    const padded = [...r];
    while (padded.length < 17) padded.push('');
    const k = dedupKey(padded, tab);
    if (rightKeys.has(k)) {
      console.log(`  ⏭ дубль, пропускаю: ${r[0]} ${r[1]} "${(r[5] ?? '').slice(0, 30)}"`);
      continue;
    }
    toCopy.push(padded);
    rightKeys.add(k);
  }
  console.log(`  → переношу ${toCopy.length} строк`);
  await append(RIGHT_ID, tab, toCopy);
}

// ====== STEP 2: Смены ======
console.log('\n=== Перенос "Смены" ===');
{
  const wrongRows = await readAll(WRONG_ID, 'Смены', 'H');
  const rightRows = await readAll(RIGHT_ID, 'Смены', 'H');
  const rightKeys = new Set(rightRows.slice(1).map((r) => dedupKey(r, 'Смены')));

  const toCopy = [];
  for (let i = 1; i < wrongRows.length; i++) {
    const r = wrongRows[i];
    const d = parseRuDate(r[0]);
    if (!d || d < CUTOFF) continue;
    // Особый случай: Дарья 60.3ч — кап до 16ч, пересчитать "Конец смены"
    if (r[1] === 'Дарья' && parseFloat(r[6]) > 16) {
      const oldHours = r[6];
      const startStr = r[4]; // "10:07"
      const [hh, mm] = startStr.split(':').map(Number);
      // 16 часов: 10:07 + 16:00 = 26:07 → 02:07 след. дня
      let totalMin = hh * 60 + mm + 16 * 60;
      const endH = Math.floor((totalMin / 60) % 24);
      const endM = totalMin % 60;
      r[5] = `${String(endH).padStart(2, '0')}:${String(endM).padStart(2, '0')}`;
      r[6] = '16.0';
      console.log(`  ⚠ Дарья: пересчёт ${oldHours}ч → 16.0ч (новый конец ${r[5]})`);
    }
    const k = dedupKey(r, 'Смены');
    if (rightKeys.has(k)) continue;
    toCopy.push(r);
    rightKeys.add(k);
  }
  console.log(`  → переношу ${toCopy.length} строк`);
  if (toCopy.length) {
    await sheets.spreadsheets.values.append({
      spreadsheetId: RIGHT_ID,
      range: 'Смены!A:H',
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: toCopy },
    });
  }
}

// ====== STEP 3: Статистика ======
console.log('\n=== Перенос "Статистика" ===');
{
  const wrongRows = await readAll(WRONG_ID, 'Статистика', 'F');
  const rightRows = await readAll(RIGHT_ID, 'Статистика', 'F');
  const rightKeys = new Map();
  for (const r of rightRows.slice(1)) {
    rightKeys.set(dedupKey(r, 'Статистика'), r);
  }

  // Merge: если ключ совпадает — суммируем часы и ошибки
  const updates = [];
  const newRows = [];
  for (let i = 1; i < wrongRows.length; i++) {
    const r = wrongRows[i];
    if (!r[0] || r[0] === 'Месяц') continue; // пропуск шапок
    // Та же логика капа для Дарьи
    if (r[1] === 'Дарья' && parseFloat(r[4]) > 16) {
      console.log(`  ⚠ Статистика Дарья: ${r[4]}ч → 16.0ч`);
      r[4] = '16.0';
    }
    const k = dedupKey(r, 'Статистика');
    const existing = rightKeys.get(k);
    if (existing) {
      // суммируем
      const newHours = (parseFloat(existing[4] ?? '0') || 0) + (parseFloat(r[4] ?? '0') || 0);
      const newErrors = (parseInt(existing[5] ?? '0', 10) || 0) + (parseInt(r[5] ?? '0', 10) || 0);
      existing[4] = String(Math.round(newHours * 10) / 10);
      existing[5] = String(newErrors);
      updates.push(existing);
      console.log(`  ✚ обновляю ${k}: часы=${existing[4]}, ошибки=${existing[5]}`);
    } else {
      newRows.push(r);
    }
  }
  // Обновим merged строки in place — проще всего перезаписать всю Статистика разом
  if (updates.length || newRows.length) {
    const merged = [rightRows[0], ...Array.from(rightKeys.values()), ...newRows];
    await sheets.spreadsheets.values.clear({ spreadsheetId: RIGHT_ID, range: 'Статистика!A:F' });
    await sheets.spreadsheets.values.update({
      spreadsheetId: RIGHT_ID,
      range: 'Статистика!A1',
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: merged },
    });
    console.log(`  → итого строк: ${merged.length}, обновлено: ${updates.length}, новых: ${newRows.length}`);
  } else {
    console.log('  (нет изменений)');
  }
}

console.log('\n✅ Миграция данных завершена');
