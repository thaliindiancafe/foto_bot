// Downloads the waiter checklists Google Sheet as XLSX, parses it,
// merges into src/config/checklists.json, and re-seeds the DB.
//
// Triggered from the admin panel. Uses the same parser logic as
// scripts/parseChecklistsXlsx.mjs but as a TS module callable at runtime.
import { writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { syncChecklists } from '../db/seed.js';

// Основная таблица-источник. Переехала 2026-05-14 на новую таблицу клиента,
// в которой есть полный набор листов (официант RU/EN, менеджер, большая восьмёрка).
// Архивы и листы других ролей (бариста, шеф, клинер и т.д.) лежат на отдельных
// вкладках и не попадают в SHEET_MAPPING — они через эту синхронизацию не меняются.
const SHEET_ID = '1L7GDvfBglsctSu1uk2ScGKmGgkh_uR3nYeP26JsPkMY';
// Клиентская таблица «Тхали» с раздельными вкладками по ролям: бар, хелпер,
// хостес и т.д. (раньше использовалась только для бара).
const THALI_SHEET_ID = '1dvpb7FgaUjhYmZ5sjrjoWRGdgr4uUzquGe-zlCCLCPc';
function exportUrlFor(sheetId: string): string {
  return `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=xlsx`;
}

// Each mapping locates its tab by NAME (not position). Excel truncates sheet
// names to 31 chars, so predicates must work on truncated forms too.
// Disambiguator: handover sheets contain "(" (e.g. "(Открытие ресторана)"),
// regular open/close sheets do not.
//
// `parser` selects the row-shape:
//   waiterStyle  — A=#, B=Пункт, C=Галочка, D=Фото, E=Видео, F=Описание, G=Эталон, H=Описание для ИИ
//   managerStyle — A=#, B=Пункт, C=Галочка (для таблицы), D=Фото (х/✓ → нужен снимок), E=Видео, F=Можно пропустить, G=Описание, H=Эталон, I=Описание для ИИ
//   baristaStyle — A=#, B=Пункт, C=Галочка, D=Фото, E=Видео, F=Ответ, G=Можно пропустить, H=Описание пункта, I=Эталонное фото
//   simpleStyle  — A=Пункт, B=Галочка, C=Фото
type ParserKind = 'waiterStyle' | 'simpleStyle' | 'managerStyle' | 'baristaStyle';

type SheetMapping = {
  match: (name: string) => boolean;
  key: string;
  role: string;
  display_order: number;
  language: string;
  type: string;
  name: string;
  time_windows: { start: string; end: string }[];
  parser: ParserKind;
};

const WAITER_TIME_WINDOWS = [{ start: '06:00', end: '01:00' }];
const BARISTA_TIME_WINDOWS = WAITER_TIME_WINDOWS;

const SHEET_MAPPING: readonly SheetMapping[] = [
  { match: (n) => n.toLowerCase().startsWith('официант') && /открыт/i.test(n) && n.includes('('),
    key: 'waiter_handover_open_ru', role: 'waiter', display_order: 1, language: 'ru', type: 'handover_open',
    name: '🟥1️⃣ Официант Открытие смены (Открытие ресторана)',
    time_windows: WAITER_TIME_WINDOWS, parser: 'waiterStyle' },
  { match: (n) => n.trim().toLowerCase() === 'официант открытие смены',
    key: 'waiter_open_ru', role: 'waiter', display_order: 2, language: 'ru', type: 'open',
    name: '🟧2️⃣ Официант открытие смены',
    time_windows: WAITER_TIME_WINDOWS, parser: 'waiterStyle' },
  { match: (n) => n.toLowerCase().startsWith('waiter') && /start/i.test(n) && n.includes('('),
    key: 'waiter_handover_open_en', role: 'waiter', display_order: 1, language: 'en', type: 'handover_open',
    name: '🟥1️⃣ Waiter - start of the day (Open restaurant)',
    time_windows: WAITER_TIME_WINDOWS, parser: 'waiterStyle' },
  { match: (n) => n.trim().toLowerCase() === 'waiter - start of the day',
    key: 'waiter_open_en', role: 'waiter', display_order: 2, language: 'en', type: 'open',
    name: '🟧2️⃣ Waiter - start of the day',
    time_windows: WAITER_TIME_WINDOWS, parser: 'waiterStyle' },
  { match: (n) => n.toLowerCase().startsWith('официант') && /закрыт/i.test(n) && n.includes('('),
    key: 'waiter_handover_close_ru', role: 'waiter', display_order: 4, language: 'ru', type: 'handover_close',
    name: '🟦4️⃣ Официант закрытие смены (Закрытие ресторана)',
    time_windows: WAITER_TIME_WINDOWS, parser: 'waiterStyle' },
  { match: (n) => n.trim().toLowerCase() === 'официант закрытие смены',
    key: 'waiter_close_ru', role: 'waiter', display_order: 3, language: 'ru', type: 'close',
    name: '🟩3️⃣ Официант закрытие смены',
    time_windows: WAITER_TIME_WINDOWS, parser: 'waiterStyle' },
  { match: (n) => n.toLowerCase().startsWith('waiter') && /end of the day/i.test(n) && n.includes('('),
    key: 'waiter_handover_close_en', role: 'waiter', display_order: 4, language: 'en', type: 'handover_close',
    name: '🟦4️⃣ Waiter - end of the day (Closing restaurant)',
    time_windows: WAITER_TIME_WINDOWS, parser: 'waiterStyle' },
  { match: (n) => n.trim().toLowerCase() === 'waiter - end of the day',
    key: 'waiter_close_en', role: 'waiter', display_order: 3, language: 'en', type: 'close',
    name: '🟩3️⃣ Waiter - end of the day',
    time_windows: WAITER_TIME_WINDOWS, parser: 'waiterStyle' },
  // Manager + Big Eight. As of 2026-05-12 the client's sheet uses an extended layout
  // ("Можно пропустить" inserted at column F) — see managerStyle parser.
  { match: (n) => n.trim().toLowerCase() === 'менеджер открытие ресторана',
    key: 'manager_handover_open_ru', role: 'manager', display_order: 1, language: 'ru', type: 'handover_open',
    name: '🟥1️⃣ Менеджер — открытие ресторана',
    time_windows: [{ start: '06:00', end: '12:00' }], parser: 'managerStyle' },
  { match: (n) => n.toLowerCase().startsWith('менеджер') && /начал.*смен.*пересменк/i.test(n),
    key: 'manager_open_ru', role: 'manager', display_order: 2, language: 'ru', type: 'open',
    name: '🟧2️⃣ Менеджер — начало смены (пересменка)',
    time_windows: [{ start: '06:00', end: '01:00' }], parser: 'managerStyle' },
  { match: (n) => n.toLowerCase().startsWith('менеджер') && /окончан.*смен.*пересм/i.test(n),
    key: 'manager_close_ru', role: 'manager', display_order: 3, language: 'ru', type: 'close',
    name: '🟩3️⃣ Менеджер — окончание смены (пересменка)',
    time_windows: [{ start: '06:00', end: '01:00' }], parser: 'managerStyle' },
  { match: (n) => n.trim().toLowerCase() === 'менеджер закрытие ресторана',
    key: 'manager_handover_close_ru', role: 'manager', display_order: 4, language: 'ru', type: 'handover_close',
    name: '🟦4️⃣ Менеджер — закрытие ресторана',
    time_windows: [{ start: '18:00', end: '02:00' }], parser: 'managerStyle' },
  { match: (n) => /^большая\s+восьм[её]рка(?:\s+менеджер)?$/i.test(n.trim()),
    key: 'manager_big_eight_ru', role: 'manager', display_order: 10, language: 'ru', type: 'periodic',
    name: '🟪5️⃣ Большая восьмёрка — менеджер',
    // 4 ежедневных окна с дедлайнами 14:00 / 16:30 / 20:00 / 22:00; окно открывается за 30 мин до дедлайна.
    time_windows: [
      { start: '13:30', end: '14:00' },
      { start: '16:00', end: '16:30' },
      { start: '19:30', end: '20:00' },
      { start: '21:30', end: '22:00' },
    ],
    parser: 'managerStyle' },
  // Barista — 2026-05-22 чек-листы переехали из Тхали-таблицы в главную.
  // Раскладка колонок отличается от менеджерской: F=Ответ, G=Можно пропустить,
  // H=Описание, I=Эталон. Используем baristaStyle парсер. Ключи (barista_open /
  // barista_close) намеренно совпадают с тем, что использует Тхали-парсер —
  // KEYS_TO_REMOVE при синке вычистит старые записи, и в JSON останется только
  // версия из главной таблицы. Вызов syncBaristaChecklistsFromGoogleSheet из
  // adm:sheet_sync убран, поэтому конфликта быть не должно.
  { match: (n) => /^бариста\s+открытие.*кофе[- ]?поинт/i.test(n.trim()),
    key: 'barista_open', role: 'barista', display_order: 1, language: 'ru', type: 'open',
    name: '🟥1️⃣ Бариста — открытие смены',
    time_windows: BARISTA_TIME_WINDOWS, parser: 'baristaStyle' },
  { match: (n) => /^бариста\s+закрытие.*пересменк/i.test(n.trim()),
    key: 'barista_close', role: 'barista', display_order: 2, language: 'ru', type: 'close',
    name: '🟦2️⃣ Бариста — закрытие смены',
    time_windows: BARISTA_TIME_WINDOWS, parser: 'baristaStyle' },
];

// Photo filename remapping: client uses Russian filenames, we want clean ASCII
const PHOTO_RENAME: Record<string, string> = {
  'Официант. Чек-листы Открытие и Открытие (первый).png': 'waiter_uniform_selfie.png',
  'Официант.Чек-лист открытие (первый). 5.Сахарницы наполнены белым, тростниковым, леденцовым сахаром.jpg':
    'waiter_sugar_bowls.jpg',
};

// Legacy keys to remove during merge (from previous SI imports / placeholders)
const KEYS_TO_REMOVE = new Set([
  'si_2dc2b3c79aaa4c47be5c114ee8e45d2d_waiter',
  'si_71d513ae5ccf4e4ca6dd3c5a1d0e8a32_waiter',
  'si_457a01e49da3470c98ea23a20ae3fef6_waiter',
  'si_20d04d8d05114c9d87f194eeec87efc6_waiter',
  ...SHEET_MAPPING.map((s) => s.key),
]);

const KEYS_TO_ARCHIVE = new Set([
  'si_4d6b826a59d444eb8d438ddda653580e_waiter',
  'si_9f9d398a98bd4bd882864affd62b4d31_waiter',
]);

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n: string) => String.fromCodePoint(parseInt(n, 16)));
}

function loadSharedStrings(zip: AdmZip): string[] {
  const entry = zip.getEntry('xl/sharedStrings.xml');
  if (!entry) throw new Error('sharedStrings.xml not found in XLSX');
  const xml = entry.getData().toString('utf-8');

  const result: string[] = [];
  const siRe = /<si\b[^>]*>([\s\S]*?)<\/si>/g;
  let m;
  while ((m = siRe.exec(xml)) !== null) {
    const inner = m[1];
    const tParts: string[] = [];
    const tRe = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g;
    let t;
    while ((t = tRe.exec(inner)) !== null) {
      tParts.push(decodeXmlEntities(t[1]));
    }
    result.push(tParts.join(''));
  }
  return result;
}

type WorkbookSheet = { name: string; rId: string };

function loadWorkbookSheets(zip: AdmZip): WorkbookSheet[] {
  const entry = zip.getEntry('xl/workbook.xml');
  if (!entry) throw new Error('xl/workbook.xml not found in XLSX');
  const xml = entry.getData().toString('utf-8');
  const sheets: WorkbookSheet[] = [];
  // Lazy match up to "/>" — attribute values may contain "/" (URLs in Type, etc.).
  const sheetRe = /<sheet\b\s+([^>]*?)\/>/g;
  let m: RegExpExecArray | null;
  while ((m = sheetRe.exec(xml)) !== null) {
    const attrs = m[1];
    const name = attrs.match(/\bname="([^"]+)"/)?.[1];
    const rId = attrs.match(/\br:id="([^"]+)"/)?.[1];
    if (name && rId) sheets.push({ name: decodeXmlEntities(name), rId });
  }
  return sheets;
}

function loadWorkbookRels(zip: AdmZip): Record<string, string> {
  const entry = zip.getEntry('xl/_rels/workbook.xml.rels');
  if (!entry) throw new Error('xl/_rels/workbook.xml.rels not found in XLSX');
  const xml = entry.getData().toString('utf-8');
  const out: Record<string, string> = {};
  const re = /<Relationship\b\s+([^>]*?)\/>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const attrs = m[1];
    const id = attrs.match(/\bId="([^"]+)"/)?.[1];
    const target = attrs.match(/\bTarget="([^"]+)"/)?.[1];
    if (id && target) out[id] = target;
  }
  return out;
}

function resolveSheetIdx(
  sheets: WorkbookSheet[],
  rels: Record<string, string>,
  predicate: (name: string) => boolean,
): number | null {
  const found = sheets.find((s) => predicate(s.name));
  if (!found) return null;
  const target = rels[found.rId];
  if (!target) return null;
  const m = target.match(/sheet(\d+)\.xml$/);
  return m ? Number(m[1]) : null;
}

type ParsedRow = { rowNum: number; cells: Record<string, string> };

function parseSheet(zip: AdmZip, sheetIdx: number, sharedStrings: string[]): ParsedRow[] {
  const entry = zip.getEntry(`xl/worksheets/sheet${sheetIdx}.xml`);
  if (!entry) throw new Error(`sheet${sheetIdx}.xml not found in XLSX`);
  const xml = entry.getData().toString('utf-8');

  const rows: ParsedRow[] = [];
  const rowRe = /<row\b[^>]*r="(\d+)"[^>]*>([\s\S]*?)<\/row>/g;
  const valueRe = /<v>([\s\S]*?)<\/v>/;
  const inlineStrRe = /<is><t[^>]*>([\s\S]*?)<\/t><\/is>/;

  let r;
  while ((r = rowRe.exec(xml)) !== null) {
    const rowNum = Number(r[1]);
    const rowContent = r[2];
    const cells: Record<string, string> = {};

    const cellRe = /<c\s+r="([A-Z]+)(\d+)"([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
    let c;
    while ((c = cellRe.exec(rowContent)) !== null) {
      const col = c[1];
      const attrs = c[3] ?? '';
      const inner = c[4] ?? '';

      const tMatch = attrs.match(/\bt="([^"]+)"/);
      const cellType = tMatch ? tMatch[1] : null;

      let value = '';
      const v = inner.match(valueRe);
      if (v) {
        if (cellType === 's') {
          const idx = Number(v[1]);
          value = sharedStrings[idx] ?? '';
        } else {
          value = decodeXmlEntities(v[1]);
        }
      } else {
        const inlineStr = inner.match(inlineStrRe);
        if (inlineStr) {
          value = decodeXmlEntities(inlineStr[1]);
        }
      }

      cells[col] = value;
    }

    rows.push({ rowNum, cells });
  }

  return rows;
}

type ParsedTask = {
  order: number;
  text: string;
  type: 'photo' | 'confirm' | 'confirm_photo';
  section: string | null;
  ai_rule: string | null;
  reference_photo: string | null;
  can_skip?: boolean;
};

type ParsedChecklist = {
  id: string;
  role: string;
  type: string;
  language: string;
  display_order: number;
  name: string;
  time_windows: { start: string; end: string }[];
  tasks: ParsedTask[];
};

function isTick(value: string): boolean {
  const v = value.trim();
  return v === 'х' || v === 'Х' || v === 'x' || v === 'X' || v === '✓' || v === '✔';
}

// Разделитель между коротким пунктом и подробным описанием. Бот ищет именно `\n\n`,
// чтобы выделить пункт жирным, а описание — курсивом со значком ℹ️.
const TITLE_DESC_SEPARATOR = '\n\n';

function combineTitleAndDescription(title: string, description: string): string {
  const t = collapseBlankLines(title.trim());
  const d = collapseBlankLines(description.trim());
  if (!d) return t;
  if (!t) return d;
  if (t === d) return t;
  if (t.includes(d)) return t;
  if (d.includes(t)) return d;
  return `${t}${TITLE_DESC_SEPARATOR}${d}`;
}

// Иногда в ячейках Google Sheets подряд идут 3+ переводов строк — это выглядит как
// слишком большой пробел в Telegram. Сжимаем такие участки до одной пустой строки.
function collapseBlankLines(value: string): string {
  return value.replace(/\n{3,}/g, '\n\n');
}

function parseWaiterStyleTasks(rows: ParsedRow[]): ParsedTask[] {
  const tasks: ParsedTask[] = [];
  let order = 0;
  let currentSection: string | null = null;

  for (const row of rows) {
    const a = (row.cells.A ?? '').trim();
    const b = (row.cells.B ?? '').trim();
    const d = (row.cells.D ?? '').trim();
    const f = (row.cells.F ?? '').trim();
    const g = (row.cells.G ?? '').trim();
    const h = (row.cells.H ?? '').trim();

    if (!b || b === 'Пункт') continue;
    if (!a) {
      currentSection = b;
      continue;
    }

    const photoRequired = isTick(d);

    // Сначала склеиваем короткий пункт (B) и описание (F).
    let taskText = combineTitleAndDescription(b, f);

    let referencePhoto: string | null = null;

    if (g) {
      const isImageFile = /\.(jpg|jpeg|png|webp)$/i.test(g);
      const isPlaceholder = /^будет (фото|видео)$/i.test(g);
      if (isImageFile) {
        referencePhoto = g;
      } else if (!isPlaceholder && g.length > 10) {
        // Иногда в колонке G лежит дополнительное описание/инструкция, а не имя файла.
        taskText = combineTitleAndDescription(taskText, g);
      }
    }

    let aiDescription: string | null = h && h.length > 0 ? h : null;
    if (aiDescription && /\.(jpg|jpeg|png|webp)$/i.test(aiDescription)) {
      if (!referencePhoto) referencePhoto = aiDescription;
      aiDescription = null;
    }

    if (referencePhoto && PHOTO_RENAME[referencePhoto]) {
      referencePhoto = PHOTO_RENAME[referencePhoto];
    }

    tasks.push({
      order,
      text: taskText,
      type: photoRequired ? 'photo' : 'confirm',
      section: currentSection,
      ai_rule: aiDescription,
      reference_photo: referencePhoto,
    });
    order++;
  }

  return tasks;
}

// Manager layout (2026-05): adds a "Можно пропустить" column at F, shifting description / reference / AI down to G / H / I.
// Drive links and placeholder strings ("Фото будет", "Фото не нужно") in column H are ignored — we can't auto-download from Drive.
function parseManagerStyleTasks(rows: ParsedRow[]): ParsedTask[] {
  const tasks: ParsedTask[] = [];
  let order = 0;
  let currentSection: string | null = null;

  for (const row of rows) {
    const a = (row.cells.A ?? '').trim();
    const b = (row.cells.B ?? '').trim();
    const d = (row.cells.D ?? '').trim();
    const g = (row.cells.G ?? '').trim();
    const h = (row.cells.H ?? '').trim();
    const i = (row.cells.I ?? '').trim();

    if (!b || b === 'Пункт') continue;
    if (!a) {
      currentSection = b;
      continue;
    }

    const photoRequired = isTick(d);
    // Менеджер: пункт можно пропустить с комментарием (утро без официанта и т.п.)
    const canSkip = true;

    // B — короткий заголовок пункта, G — подробное описание для сотрудника.
    // Склеиваем их через явный разделитель — бот покажет пункт жирным, а описание курсивом.
    let taskText = combineTitleAndDescription(b, g);

    let referencePhoto: string | null = null;

    if (h) {
      const isImageFile = /\.(jpg|jpeg|png|webp)$/i.test(h);
      const isDriveLink = /drive\.google\.com/i.test(h);
      const isPlaceholder = /^(будет (фото|видео)|фото будет|фото не (нужно|требуется))$/i.test(h);
      if (isImageFile) {
        referencePhoto = h;
      } else if (isDriveLink || isPlaceholder) {
        // ignore: ссылки на Drive автоматически не скачать, плейсхолдеры не нужны
      } else if (h.length > 10) {
        // Иногда в H лежит ещё одна инструкция вместо эталона — добавим её к описанию.
        taskText = combineTitleAndDescription(taskText, h);
      }
    }

    let aiDescription: string | null = i && i.length > 0 ? i : null;
    if (aiDescription && /\.(jpg|jpeg|png|webp)$/i.test(aiDescription)) {
      if (!referencePhoto) referencePhoto = aiDescription;
      aiDescription = null;
    }

    if (referencePhoto && PHOTO_RENAME[referencePhoto]) {
      referencePhoto = PHOTO_RENAME[referencePhoto];
    }

    // Колонка D «Фото»: отметка → нужен снимок. Без отметки в D → пункт без фото, только подтверждение Да/Нет
    // (в таблице колонка «Галочка» C обычно совпадает с такими строками; тип в боте задаётся только по D).
    const type: 'photo' | 'confirm' = photoRequired ? 'photo' : 'confirm';

    tasks.push({
      order,
      text: taskText,
      type,
      section: currentSection,
      ai_rule: aiDescription,
      reference_photo: referencePhoto,
      can_skip: canSkip || undefined,
    });
    order++;
  }

  return tasks;
}

// Barista (2026-05-22): такая же логика, как managerStyle, но колонки сдвинуты —
// см. таблицу. Главные отличия:
// - F=Ответ (игнорируем);
// - G=Можно пропустить → теперь это конкретный признак, а не «true для всех»;
// - H=Описание пункта (у менеджера это G);
// - I=Эталонное фото (у менеджера это H);
// - отдельной колонки «Описание для ИИ» нет — ai_rule=null.
function parseBaristaStyleTasks(rows: ParsedRow[]): ParsedTask[] {
  const tasks: ParsedTask[] = [];
  let order = 0;
  let currentSection: string | null = null;

  for (const row of rows) {
    const a = (row.cells.A ?? '').trim();
    const b = (row.cells.B ?? '').trim();
    const d = (row.cells.D ?? '').trim();
    const g = (row.cells.G ?? '').trim();
    const h = (row.cells.H ?? '').trim();
    const i = (row.cells.I ?? '').trim();

    if (!b || b === 'Пункт') continue;
    if (!a) {
      currentSection = b;
      continue;
    }

    const photoRequired = isTick(d);
    const canSkip = isTick(g);

    // B — короткий заголовок, H — подробное описание для сотрудника.
    let taskText = combineTitleAndDescription(b, h);

    let referencePhoto: string | null = null;
    if (i) {
      const isImageFile = /\.(jpg|jpeg|png|webp)$/i.test(i);
      const isDriveLink = /drive\.google\.com/i.test(i);
      const isPlaceholder = /^(будет (фото|видео)|фото будет|фото не (нужно|требуется))$/i.test(i);
      if (isImageFile) {
        referencePhoto = i;
      } else if (isDriveLink || isPlaceholder) {
        // ignore: ссылки на Drive автоматически не скачать, плейсхолдеры не нужны
      } else if (i.length > 10) {
        // В I иногда лежит ещё одна инструкция вместо эталона — добавим в описание.
        taskText = combineTitleAndDescription(taskText, i);
      }
    }

    if (referencePhoto && PHOTO_RENAME[referencePhoto]) {
      referencePhoto = PHOTO_RENAME[referencePhoto];
    }

    const type: 'photo' | 'confirm' = photoRequired ? 'photo' : 'confirm';

    tasks.push({
      order,
      text: taskText,
      type,
      section: currentSection,
      ai_rule: null,
      reference_photo: referencePhoto,
      can_skip: canSkip || undefined,
    });
    order++;
  }

  return tasks;
}

// Simple sheet layout. A row with text but neither tick is a section.
function parseSimpleStyleTasks(rows: ParsedRow[]): ParsedTask[] {
  const tasks: ParsedTask[] = [];
  let order = 0;
  let currentSection: string | null = null;

  for (const row of rows) {
    const a = (row.cells.A ?? '').trim();
    const b = (row.cells.B ?? '').trim();
    const c = (row.cells.C ?? '').trim();

    if (!a || a === 'Пункт') continue;

    const photoTick = isTick(c);
    const confirmTick = isTick(b);

    if (!photoTick && !confirmTick) {
      currentSection = a;
      continue;
    }

    tasks.push({
      order: order++,
      text: a,
      type: photoTick ? 'photo' : 'confirm',
      section: currentSection,
      ai_rule: null,
      reference_photo: null,
    });
  }

  return tasks;
}

function parseChecklistsFromZip(
  zip: AdmZip,
  mappings: readonly SheetMapping[] = SHEET_MAPPING,
): ParsedChecklist[] {
  const sharedStrings = loadSharedStrings(zip);
  const workbookSheets = loadWorkbookSheets(zip);
  const rels = loadWorkbookRels(zip);
  const result: ParsedChecklist[] = [];
  const missing: string[] = [];

  for (const meta of mappings) {
    const sheetIdx = resolveSheetIdx(workbookSheets, rels, meta.match);
    if (sheetIdx == null) {
      missing.push(meta.key);
      continue;
    }
    const rows = parseSheet(zip, sheetIdx, sharedStrings);
    const tasks =
      meta.parser === 'waiterStyle'
        ? parseWaiterStyleTasks(rows)
        : meta.parser === 'managerStyle'
          ? parseManagerStyleTasks(rows)
          : meta.parser === 'baristaStyle'
            ? parseBaristaStyleTasks(rows)
            : parseSimpleStyleTasks(rows);

    result.push({
      id: meta.key,
      role: meta.role,
      type: meta.type,
      language: meta.language,
      display_order: meta.display_order,
      name: meta.name,
      time_windows: meta.time_windows,
      tasks,
    });
  }

  if (missing.length > 0) {
    throw new Error(
      `Не нашёл вкладки в таблице: ${missing.join(', ')}. Проверь имена листов или переименуй обратно.`,
    );
  }

  return result;
}

async function downloadXlsx(url: string = exportUrlFor(SHEET_ID)): Promise<Buffer> {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) {
    throw new Error(`Failed to download sheet: HTTP ${response.status}`);
  }
  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

type MergeOptions = {
  /** Keys to remove from existing config before appending parsed. Defaults to all SHEET_MAPPING keys + legacy keys. */
  keysToReplace?: Set<string>;
  /** Whether to also re-tag legacy waiter SI checklists as archived. Defaults to true (full sync mode). */
  archiveLegacy?: boolean;
};

function mergeIntoConfig(
  parsed: ParsedChecklist[],
  opts: MergeOptions = {},
): { totalChecklists: number; totalTasks: number } {
  const keysToReplace = opts.keysToReplace ?? KEYS_TO_REMOVE;
  const archiveLegacy = opts.archiveLegacy ?? true;

  const configPath = path.resolve('src/config/checklists.json');
  const config = JSON.parse(readFileSync(configPath, 'utf-8'));

  const filtered = (config.checklists as Array<{ id: string; role?: string; type?: string }>).filter(
    (c) => !keysToReplace.has(c.id),
  );

  if (archiveLegacy) {
    for (const c of filtered) {
      if (KEYS_TO_ARCHIVE.has(c.id)) {
        c.role = 'archived';
        c.type = 'archived';
      }
    }
  }

  config.checklists = [...filtered, ...parsed];
  writeFileSync(configPath, JSON.stringify(config, null, 2));

  const totalTasks = parsed.reduce((s, c) => s + c.tasks.length, 0);
  return { totalChecklists: parsed.length, totalTasks };
}

export type SheetSyncResult = {
  ok: true;
  checklists: number;
  tasks: number;
  syncedToDb: number;
};

export type SheetSyncOptions = {
  /** Override source spreadsheet ID. Defaults to the main waiter+manager sheet. */
  sheetId?: string;
  /**
   * Limit sync to mappings whose role is in this list.
   * When set, only the matching keys are removed and re-imported; other roles
   * stay untouched. Legacy archive logic is also skipped.
   */
  roleFilter?: readonly string[];
};

/**
 * Full pipeline: download XLSX, parse, merge into checklists.json, re-sync DB.
 * Throws on any failure — caller (admin handler) should catch and report.
 *
 * Examples:
 *   syncChecklistsFromGoogleSheet()
 *     — default: load all mappings from the main sheet, archive legacy keys.
 *   syncChecklistsFromGoogleSheet({ sheetId, roleFilter: ['manager'] })
 *     — only refresh manager checklists from a different sheet; waiter/etc. stay as-is.
 */
export async function syncChecklistsFromGoogleSheet(
  opts: SheetSyncOptions = {},
): Promise<SheetSyncResult> {
  const sheetId = opts.sheetId ?? SHEET_ID;
  const mappings = opts.roleFilter
    ? SHEET_MAPPING.filter((m) => opts.roleFilter!.includes(m.role))
    : SHEET_MAPPING;

  if (mappings.length === 0) {
    throw new Error(`No mappings matched roleFilter: ${opts.roleFilter?.join(',')}`);
  }

  const xlsxBuffer = await downloadXlsx(exportUrlFor(sheetId));
  const zip = new AdmZip(xlsxBuffer);
  const parsed = parseChecklistsFromZip(zip, mappings);

  if (parsed.length === 0) {
    throw new Error('No checklists parsed from sheet');
  }

  const keysToReplace = opts.roleFilter
    ? new Set(mappings.map((m) => m.key))
    : KEYS_TO_REMOVE;

  const { totalChecklists, totalTasks } = mergeIntoConfig(parsed, {
    keysToReplace,
    archiveLegacy: !opts.roleFilter,
  });
  const syncedToDb = await syncChecklists();

  return {
    ok: true,
    checklists: totalChecklists,
    tasks: totalTasks,
    syncedToDb,
  };
}

function hasPhotoMarker(d: string): boolean {
  const v = d.trim().toLowerCase();
  // Client sheet uses both "Фото" and "Селфи ...".
  return v.includes('фото') || v.includes('селфи');
}

function hasYesNoMarker(d: string): boolean {
  const v = d.trim().toLowerCase();
  // Examples from sheet: "да /нет", "да/нет (фото)", "да/нет".
  return v.includes('да') && v.includes('нет');
}

/** Column D: да/нет + фото => confirm_photo; только да/нет => confirm; только фото => photo. */
function resolveTwoBlockTaskType(d: string): 'photo' | 'confirm' | 'confirm_photo' {
  const yesNo = hasYesNoMarker(d);
  const photo = hasPhotoMarker(d);
  if (yesNo && photo) return 'confirm_photo';
  if (yesNo) return 'confirm';
  if (photo) return 'photo';
  return 'confirm';
}

/**
 * Описание вкладки клиентской таблицы Тхали, в которой на одном листе
 * хранятся два чек-листа: блок «Правила начала смены» и блок «Правила
 * окончания смены». В таком формате идут вкладки бара, хелпера, хостес.
 */
type TwoBlockTabSpec = {
  /** Человеко-читаемое имя для сообщений об ошибках. */
  label: string;
  /** Предикат для поиска нужной вкладки по её имени (XLSX обрезает имя до 31 символа). */
  tabPredicate: (sheetName: string) => boolean;
  role: string;
  language: string;
  openId: string;
  closeId: string;
  openName: string;
  closeName: string;
};

function parseTwoBlockTabToOpenClose(
  parsedTabRows: ParsedRow[],
  spec: TwoBlockTabSpec,
): { open: ParsedChecklist; close: ParsedChecklist } {
  const findHeaderIdx = (re: RegExp) => {
    return parsedTabRows.findIndex((r) => {
      const b = (r.cells.B ?? '').trim();
      return re.test(b);
    });
  };

  // More tolerant patterns — in XLSX exports there may be extra spaces / line breaks.
  const openHeaderIdx = findHeaderIdx(/начала\s*.*\s*смены/i);
  const closeHeaderIdx = parsedTabRows.findIndex((r, idx) => {
    if (idx <= openHeaderIdx) return false;
    const b = (r.cells.B ?? '').trim();
    // Matches: "Правила окончания смены", plus other "окончан..." variants.
    // Don't use `\w*` here: it only matches ASCII word chars, while sheet text is Cyrillic.
    return /окончани.*\s+смены/i.test(b) || /окончани.*\s+пересмен/i.test(b);
  });

  if (openHeaderIdx === -1 || closeHeaderIdx === -1) {
    throw new Error(
      `Не нашёл заголовки "Правила начала смены" / "Правила окончания смены" во вкладке "${spec.label}" (openHeaderIdx=${openHeaderIdx}, closeHeaderIdx=${closeHeaderIdx}).`,
    );
  }

  const buildTasks = (rows: ParsedRow[]): ParsedTask[] => {
    const tasks: ParsedTask[] = [];
    let currentSection: string | null = null;

    for (const row of rows) {
      const b = (row.cells.B ?? '').trim();
      const d = (row.cells.D ?? '').trim();
      if (!b) continue;

      // Section headers in this sheet are rows where column D is empty.
      if (!d) {
        currentSection = b;
        continue;
      }

      const type = resolveTwoBlockTaskType(d);
      const aiRule = type === 'photo' || type === 'confirm_photo' ? b : null;
      tasks.push({
        order: tasks.length,
        text: b,
        type,
        section: currentSection,
        ai_rule: aiRule,
        reference_photo: null,
      });
    }

    return tasks;
  };

  const openRows = parsedTabRows.slice(openHeaderIdx + 1, closeHeaderIdx);
  const closeRows = parsedTabRows.slice(closeHeaderIdx + 1);

  return {
    open: {
      id: spec.openId,
      role: spec.role,
      type: 'open',
      language: spec.language,
      display_order: 2,
      name: spec.openName,
      time_windows: BARISTA_TIME_WINDOWS,
      tasks: buildTasks(openRows),
    },
    close: {
      id: spec.closeId,
      role: spec.role,
      type: 'close',
      language: spec.language,
      display_order: 3,
      name: spec.closeName,
      time_windows: BARISTA_TIME_WINDOWS,
      tasks: buildTasks(closeRows),
    },
  };
}

const BARISTA_TAB_SPEC: TwoBlockTabSpec = {
  label: 'Чек-лист бар',
  tabPredicate: (n) => /чек[- ]?лист.*бар/i.test(n),
  role: 'barista',
  language: 'ru',
  openId: 'barista_open',
  closeId: 'barista_close',
  openName: '🟥1️⃣ Бариста — открытие смены',
  closeName: '🟦2️⃣ Бариста — закрытие смены',
};

const HELPER_TAB_SPEC: TwoBlockTabSpec = {
  label: 'Чек-лист Помощник повара (Хелпер)',
  // XLSX обрезает имя до 31 символа: "Чек-лист Помощник повара(Хелпер".
  tabPredicate: (n) => /помощник\s*повара|хелпер/i.test(n),
  role: 'helper',
  language: 'ru',
  openId: 'helper_open',
  closeId: 'helper_close',
  openName: '🟥1️⃣ Хелпер — открытие смены',
  closeName: '🟦2️⃣ Хелпер — закрытие смены',
};

const HOSTESS_TAB_SPEC: TwoBlockTabSpec = {
  label: 'ЧЕК-ЛИСТ хостесс',
  // Имя в таблице — "ЧЕК-ЛИСТ хостесс " (с trailing-пробелом).
  tabPredicate: (n) => /хостес/i.test(n),
  role: 'hostess',
  language: 'ru',
  openId: 'hostess_open',
  closeId: 'hostess_close',
  openName: '🟥1️⃣ Хостес — открытие смены',
  closeName: '🟦2️⃣ Хостес — закрытие смены',
};

/**
 * Защита ручного стайл-гайд-форматирования при синке. Если в текущем JSON у
 * чек-листа с тем же id уже есть task с тем же `order`, и его `text` содержит
 * `\n\n` (значит, его привели к виду «заголовок\n\nописание» вручную — см.
 * раздел «Style Guide чек-листов» в CLAUDE.md), мы сохраняем старый task
 * целиком, заменяя свежесгенерированный из таблицы. Это страхует тексты
 * barista / helper / hostess от затирания при повторном «📥 Обновить из таблицы».
 *
 * Ограничение: если в Google-таблице удалили или вставили пункт в середине
 * блока, `order` сдвинется и защита подставит «не тот» старый текст. После
 * структурных изменений в таблице нужно вручную перепроверить тексты
 * стилизованных чек-листов.
 */
function applyStyledTextProtection(parsed: ParsedChecklist[]): void {
  const configPath = path.resolve('src/config/checklists.json');
  let config: { checklists?: Array<{ id: string; tasks?: ParsedTask[] }> };
  try {
    config = JSON.parse(readFileSync(configPath, 'utf-8'));
  } catch {
    return; // нет файла или невалидный JSON — пропускаем защиту
  }
  const existingById = new Map(
    (config.checklists ?? []).map((c) => [c.id, c]),
  );
  for (const checklist of parsed) {
    const existing = existingById.get(checklist.id);
    if (!existing?.tasks) continue;
    const existingByOrder = new Map(existing.tasks.map((t) => [t.order, t]));
    for (let i = 0; i < checklist.tasks.length; i++) {
      const newTask = checklist.tasks[i];
      const oldTask = existingByOrder.get(newTask.order);
      if (oldTask?.text?.includes('\n\n')) {
        checklist.tasks[i] = {
          order: oldTask.order,
          text: oldTask.text,
          type: oldTask.type ?? newTask.type,
          section: oldTask.section ?? newTask.section,
          ai_rule: oldTask.ai_rule ?? newTask.ai_rule,
          reference_photo: oldTask.reference_photo ?? newTask.reference_photo,
        };
      }
    }
  }
}

async function syncTwoBlockChecklistsFromThaliSheet(
  sheetId: string,
  spec: TwoBlockTabSpec,
): Promise<SheetSyncResult> {
  const xlsxBuffer = await downloadXlsx(exportUrlFor(sheetId));
  const zip = new AdmZip(xlsxBuffer);

  const sharedStrings = loadSharedStrings(zip);
  const workbookSheets = loadWorkbookSheets(zip);
  const rels = loadWorkbookRels(zip);

  const sheetIdx = resolveSheetIdx(workbookSheets, rels, spec.tabPredicate);
  if (sheetIdx == null) {
    throw new Error(`Не нашёл вкладку "${spec.label}" в sheetId=${sheetId}`);
  }

  const rows = parseSheet(zip, sheetIdx, sharedStrings);
  const { open, close } = parseTwoBlockTabToOpenClose(rows, spec);

  const parsed = [open, close];
  applyStyledTextProtection(parsed);
  const keysToReplace = new Set([spec.openId, spec.closeId]);

  const { totalChecklists, totalTasks } = mergeIntoConfig(parsed, {
    keysToReplace,
    archiveLegacy: false,
  });

  const syncedToDb = await syncChecklists();

  return {
    ok: true,
    checklists: totalChecklists,
    tasks: totalTasks,
    syncedToDb,
  };
}

/**
 * Downloads XLSX, parses barista tab ("Чек-лист бар") and syncs DB.
 *
 * Rule mapping (as requested):
 * - Column B provides task text and (for photo tasks) AI criteria.
 * - Column D:
 *   - "да" and "нет" and "фото"/"селфи" => confirm_photo (фото + кнопки Да/Нет);
 *   - only "да" and "нет" => confirm (кнопки без фото);
 *   - only "Фото"/"Селфи" => photo + AI by column B;
 *   - otherwise => confirm.
 */
export async function syncBaristaChecklistsFromGoogleSheet(
  opts: { sheetId?: string } = {},
): Promise<SheetSyncResult> {
  return syncTwoBlockChecklistsFromThaliSheet(opts.sheetId ?? THALI_SHEET_ID, BARISTA_TAB_SPEC);
}

/**
 * Хелпер (помощник повара). Структура вкладки идентична бар-вкладке:
 * один лист с двумя блоками "Правила начала смены" / "Правила окончания смены".
 */
export async function syncHelperChecklistsFromGoogleSheet(
  opts: { sheetId?: string } = {},
): Promise<SheetSyncResult> {
  return syncTwoBlockChecklistsFromThaliSheet(opts.sheetId ?? THALI_SHEET_ID, HELPER_TAB_SPEC);
}

/**
 * Хостес. Структура вкладки идентична бар-вкладке.
 */
export async function syncHostessChecklistsFromGoogleSheet(
  opts: { sheetId?: string } = {},
): Promise<SheetSyncResult> {
  return syncTwoBlockChecklistsFromThaliSheet(opts.sheetId ?? THALI_SHEET_ID, HOSTESS_TAB_SPEC);
}
