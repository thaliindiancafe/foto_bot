import { google } from 'googleapis';

import { findRoleByKey } from '../config/roles.js';
import { loadServiceAccountCredentials } from '../utils/googleServiceAccount.js';

/** ID таблицы из URL: .../spreadsheets/d/THIS_PART/edit */
const SHEETS_ID = process.env.GOOGLE_SHEETS_ID;

const LOCATION_TO_SHEET: Record<string, string> = {
  restaurant: 'Ресторан',
  cafe: 'Кофепоинт',
};

function resolveSheetName(location: string | null): string {
  return LOCATION_TO_SHEET[location ?? 'restaurant'] ?? 'Ресторан';
}

async function getSheetsClient() {
  const credentials = await loadServiceAccountCredentials();
  const auth = new google.auth.JWT({
    email: credentials.client_email,
    key: credentials.private_key,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });

  return google.sheets({ version: 'v4', auth });
}

function formatDate(date: Date): string {
  return date.toLocaleDateString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    timeZone: 'Europe/Moscow',
  });
}

function formatTime(date: Date): string {
  return date.toLocaleTimeString('ru-RU', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Europe/Moscow',
  });
}

function formatRoleLabel(roleKey: string): string {
  if (!roleKey) return '';
  return findRoleByKey(roleKey)?.label ?? roleKey;
}

function formatTaskTypeLabel(taskType: string): string {
  switch (taskType) {
    case 'photo':
      return 'Фото';
    case 'confirm':
      return 'Кнопка';
    case 'confirm_photo':
      return 'Фото / Кнопка';
    default:
      return taskType || '—';
  }
}

/** I: результат AI; для кнопок без фото — прочерк */
function formatAiResultColumn(payload: SingleAnswerPayload): string {
  if (payload.aiVerdict === 'ok') return '✅';
  if (payload.aiVerdict === 'fail') return '❌';
  if (payload.taskType === 'confirm') return '—';
  return '';
}

/** J: комментарий AI */
function formatAiReasonColumn(payload: SingleAnswerPayload): string {
  if (payload.aiReason?.trim()) return payload.aiReason.trim();
  if (payload.taskType === 'confirm') return 'без фото (кнопка Да/Нет)';
  return '';
}

/** K: «Верно заполнено» — из AI или из ответа Да/Нет/Пропуск */
function formatIsCorrect(payload: SingleAnswerPayload): string {
  if (payload.aiVerdict === 'ok') return 'Да';
  if (payload.aiVerdict === 'fail') return 'Нет';
  switch (payload.checkResult) {
    case 'yes':
      return 'Да';
    case 'no':
      return 'Нет';
    case 'skip':
      return 'Пропуск';
    default:
      return '';
  }
}

function cell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '';
  return String(value);
}

export interface SingleAnswerPayload {
  location: string | null;
  displayName: string;
  username: string | null;
  role: string;
  checklistTitle: string;
  questionText: string;
  taskType: string;
  questionSection?: string | null;
  questionWeight?: number;
  photoUrl: string;
  aiVerdict?: string;
  aiReason?: string;
  checkResult?: string;
  earnedWeight?: number;
  possibleWeight?: number;
  isViolation?: boolean;
  skipComment?: string | null;
  runStartedAtIso: string;
  answeredAtIso: string;
  // --- Аналитика «Вернуться к пункту позже» (creative-defer-button.md §5) ---
  deferCount?: number;
  firstDeferredAtIso?: string | null;
  deferStatus?: 'deferred_done' | 'deferred_skipped' | null;
}

/** O: сколько раз пункт откладывали (0 — без откладывания). */
function formatDeferCount(payload: SingleAnswerPayload): string {
  return String(payload.deferCount ?? 0);
}

/** P: время первого откладывания (формат «дд.мм.гггг чч:мм»). */
function formatFirstDeferredAt(payload: SingleAnswerPayload): string {
  if (!payload.firstDeferredAtIso) return '';
  const d = new Date(payload.firstDeferredAtIso);
  return `${formatDate(d)} ${formatTime(d)}`;
}

/** Q: статус откладывания для фильтрации в Sheets. */
function formatDeferStatus(payload: SingleAnswerPayload): string {
  if ((payload.deferCount ?? 0) === 0) return '';
  switch (payload.deferStatus) {
    case 'deferred_done':
      return 'Отложено → пройдено';
    case 'deferred_skipped':
      return 'Отложено → пропущено';
    default:
      return 'Отложено';
  }
}

export async function appendSingleAnswer(payload: SingleAnswerPayload): Promise<void> {
  if (!SHEETS_ID) {
    console.warn('[sheets] GOOGLE_SHEETS_ID не задан — строка не записана');
    return;
  }

  const sheets = await getSheetsClient();
  const sheetName = resolveSheetName(payload.location);
  const username = payload.username ? `@${payload.username}` : '';
  const runStartedAt = new Date(payload.runStartedAtIso);
  const answeredAt = new Date(payload.answeredAtIso);

  // Колонки A–Q — таблица «СменаПро_Тхали» (листы Ресторан / Кофепоинт).
  // O/P/Q добавлены для аналитики откладывания (см. creative-defer-button.md §5).
  const row = [
    cell(formatDate(answeredAt)),
    cell(payload.displayName),
    cell(username),
    cell(formatRoleLabel(payload.role)),
    cell(payload.checklistTitle),
    cell(payload.questionText),
    cell(formatTaskTypeLabel(payload.taskType)),
    cell(payload.photoUrl),
    cell(formatAiResultColumn(payload)),
    cell(formatAiReasonColumn(payload)),
    cell(formatIsCorrect(payload)),
    cell(`${formatDate(runStartedAt)} ${formatTime(runStartedAt)}`),
    cell(`${formatDate(answeredAt)} ${formatTime(answeredAt)}`),
    cell(payload.skipComment),
    cell(formatDeferCount(payload)),
    cell(formatFirstDeferredAt(payload)),
    cell(formatDeferStatus(payload)),
  ];

  const result = await sheets.spreadsheets.values.append({
    spreadsheetId: SHEETS_ID,
    range: `${sheetName}!A:Q`,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [row] },
  });

  const updatedRange = result.data.updates?.updatedRange ?? '?';
  console.log(
    `[sheets] answer → ${sheetName} ${updatedRange} (${row.filter((c) => c !== '').length}/17 cols)`,
  );
}

export interface ShiftSummaryPayload {
  location: string | null;
  displayName: string;
  role: string;
  startedAtIso: string;
  endedAtIso: string;
  failCount: number;
}

export async function recordShiftSummary(payload: ShiftSummaryPayload): Promise<void> {
  if (!SHEETS_ID) return;

  const sheets = await getSheetsClient();
  const location = resolveSheetName(payload.location);
  const startedAt = new Date(payload.startedAtIso);
  const endedAt = new Date(payload.endedAtIso);
  const diffMs = endedAt.getTime() - startedAt.getTime();
  const hours = Math.round((diffMs / 3_600_000) * 10) / 10;

  const row = [
    formatDate(startedAt),
    payload.displayName,
    payload.role,
    location,
    formatTime(startedAt),
    formatTime(endedAt),
    String(hours),
    String(payload.failCount),
  ];

  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEETS_ID,
    range: 'Смены!A:H',
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [row] },
  });
}

export interface MonthlyStatsPayload {
  location: string | null;
  displayName: string;
  role: string;
  hoursToAdd: number;
  errorsToAdd: number;
  month: string; // "MM.YYYY"
}

export async function updateMonthlyStats(payload: MonthlyStatsPayload): Promise<void> {
  if (!SHEETS_ID) return;

  const sheets = await getSheetsClient();
  const location = resolveSheetName(payload.location);

  const existing = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEETS_ID,
    range: 'Статистика!A:F',
  });

  const rows = existing.data.values ?? [];
  let foundRowIndex = -1;

  for (let i = 0; i < rows.length; i++) {
    if (rows[i][0] === payload.month && rows[i][1] === payload.displayName) {
      foundRowIndex = i;
      break;
    }
  }

  if (foundRowIndex >= 0) {
    const currentHours = parseFloat(rows[foundRowIndex][4] ?? '0') || 0;
    const currentErrors = parseInt(rows[foundRowIndex][5] ?? '0', 10) || 0;
    const newHours = Math.round((currentHours + payload.hoursToAdd) * 10) / 10;
    const newErrors = currentErrors + payload.errorsToAdd;
    const rowNumber = foundRowIndex + 1;

    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEETS_ID,
      range: `Статистика!E${rowNumber}:F${rowNumber}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [[String(newHours), String(newErrors)]] },
    });
    return;
  }

  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEETS_ID,
    range: 'Статистика!A:F',
    valueInputOption: 'USER_ENTERED',
    requestBody: {
      values: [[
        payload.month,
        payload.displayName,
        payload.role,
        location,
        String(payload.hoursToAdd),
        String(payload.errorsToAdd),
      ]],
    },
  });
}
