// Скачивает текущую таблицу, прогоняет ту же логику что и кнопка
// "📥 Обновить из таблицы", но НЕ трогает БД (это сделает /reload в боте).
// Полезно, чтобы посмотреть результат парсера локально.
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import AdmZip from 'adm-zip';

const SHEET_ID = '1L7GDvfBglsctSu1uk2ScGKmGgkh_uR3nYeP26JsPkMY';
const URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=xlsx`;
const CONFIG_PATH = path.resolve('src/config/checklists.json');

const TITLE_DESC_SEPARATOR = '\n\n';

function collapseBlankLines(v) { return (v ?? '').replace(/\n{3,}/g, '\n\n'); }

function combine(title, description) {
  const t = collapseBlankLines((title ?? '').trim());
  const d = collapseBlankLines((description ?? '').trim());
  if (!d) return t;
  if (!t) return d;
  if (t === d) return t;
  if (t.includes(d)) return t;
  if (d.includes(t)) return d;
  return `${t}${TITLE_DESC_SEPARATOR}${d}`;
}

function decodeXml(s) {
  return s
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCodePoint(parseInt(n, 16)));
}

function isTick(v) {
  v = (v ?? '').trim();
  return v === 'х' || v === 'Х' || v === 'x' || v === 'X' || v === '✓' || v === '✔';
}

const PHOTO_RENAME = {
  'Официант. Чек-листы Открытие и Открытие (первый).png': 'waiter_uniform_selfie.png',
  'Официант.Чек-лист открытие (первый). 5.Сахарницы наполнены белым, тростниковым, леденцовым сахаром.jpg': 'waiter_sugar_bowls.jpg',
};

const WAITER_TIME_WINDOWS = [{ start: '06:00', end: '01:00' }];

const SHEET_MAPPING = [
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
    time_windows: [
      { start: '13:30', end: '14:00' },
      { start: '16:00', end: '16:30' },
      { start: '19:30', end: '20:00' },
      { start: '21:30', end: '22:00' },
    ],
    parser: 'managerStyle' },
];

const KEYS_TO_REPLACE = new Set([
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

const r = await fetch(URL, { redirect: 'follow' });
if (!r.ok) { console.error('HTTP', r.status); process.exit(1); }
const buf = Buffer.from(await r.arrayBuffer());
const zip = new AdmZip(buf);

// shared strings
const ssXml = zip.getEntry('xl/sharedStrings.xml').getData().toString('utf-8');
const ss = [];
for (const m of ssXml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)) {
  const parts = [];
  for (const t of m[1].matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)) parts.push(decodeXml(t[1]));
  ss.push(parts.join(''));
}

const wbXml = zip.getEntry('xl/workbook.xml').getData().toString('utf-8');
const sheets = [];
for (const m of wbXml.matchAll(/<sheet\b\s+([^>]*?)\/>/g)) {
  const attrs = m[1];
  const name = attrs.match(/\bname="([^"]+)"/)?.[1];
  const rid = attrs.match(/\br:id="([^"]+)"/)?.[1];
  if (name && rid) sheets.push({ name: decodeXml(name), rid });
}

const relsXml = zip.getEntry('xl/_rels/workbook.xml.rels').getData().toString('utf-8');
const rels = {};
for (const m of relsXml.matchAll(/<Relationship\b\s+([^>]*?)\/>/g)) {
  const attrs = m[1];
  const id = attrs.match(/\bId="([^"]+)"/)?.[1];
  const tgt = attrs.match(/\bTarget="([^"]+)"/)?.[1];
  if (id && tgt) rels[id] = tgt;
}

function readSheetByName(predicate) {
  const sheet = sheets.find((s) => predicate(s.name));
  if (!sheet) return null;
  const tgt = rels[sheet.rid];
  const idx = tgt?.match(/sheet(\d+)\.xml$/)?.[1];
  if (!idx) return null;
  const xml = zip.getEntry(`xl/worksheets/sheet${idx}.xml`).getData().toString('utf-8');
  const rows = [];
  for (const r of xml.matchAll(/<row\b[^>]*r="(\d+)"[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells = {};
    for (const c of r[2].matchAll(/<c\s+r="([A-Z]+)(\d+)"([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const col = c[1];
      const attrs = c[3] ?? '';
      const inner = c[4] ?? '';
      const t = attrs.match(/\bt="([^"]+)"/)?.[1];
      const v = inner.match(/<v>([\s\S]*?)<\/v>/);
      let value = '';
      if (v) {
        if (t === 's') value = ss[Number(v[1])] ?? '';
        else value = decodeXml(v[1]);
      } else {
        const inlineStr = inner.match(/<is><t[^>]*>([\s\S]*?)<\/t><\/is>/);
        if (inlineStr) value = decodeXml(inlineStr[1]);
      }
      cells[col] = value;
    }
    rows.push({ rowNum: Number(r[1]), cells });
  }
  return rows;
}

function parseWaiterStyle(rows) {
  const tasks = []; let order = 0; let currentSection = null;
  for (const row of rows) {
    const a = (row.cells.A ?? '').trim();
    const b = (row.cells.B ?? '').trim();
    const d = (row.cells.D ?? '').trim();
    const f = (row.cells.F ?? '').trim();
    const g = (row.cells.G ?? '').trim();
    const h = (row.cells.H ?? '').trim();
    if (!b || b === 'Пункт') continue;
    if (!a) { currentSection = b; continue; }
    const photoRequired = isTick(d);
    let taskText = combine(b, f);
    let referencePhoto = null;
    if (g) {
      const isImg = /\.(jpg|jpeg|png|webp)$/i.test(g);
      const isPlaceholder = /^будет (фото|видео)$/i.test(g);
      if (isImg) referencePhoto = g;
      else if (!isPlaceholder && g.length > 10) taskText = combine(taskText, g);
    }
    let aiDescription = h && h.length > 0 ? h : null;
    if (aiDescription && /\.(jpg|jpeg|png|webp)$/i.test(aiDescription)) {
      if (!referencePhoto) referencePhoto = aiDescription;
      aiDescription = null;
    }
    if (referencePhoto && PHOTO_RENAME[referencePhoto]) referencePhoto = PHOTO_RENAME[referencePhoto];
    tasks.push({ order: order++, text: taskText, type: photoRequired ? 'photo' : 'confirm', section: currentSection, ai_rule: aiDescription, reference_photo: referencePhoto });
  }
  return tasks;
}

function parseManagerStyle(rows) {
  const tasks = []; let order = 0; let currentSection = null;
  for (const row of rows) {
    const a = (row.cells.A ?? '').trim();
    const b = (row.cells.B ?? '').trim();
    const d = (row.cells.D ?? '').trim();
    const f = (row.cells.F ?? '').trim();
    const g = (row.cells.G ?? '').trim();
    const h = (row.cells.H ?? '').trim();
    const i = (row.cells.I ?? '').trim();
    if (!b || b === 'Пункт') continue;
    if (!a) { currentSection = b; continue; }
    const photoRequired = isTick(d);
    const canSkip = isTick(f);
    let taskText = combine(b, g);
    let referencePhoto = null;
    if (h) {
      const isImg = /\.(jpg|jpeg|png|webp)$/i.test(h);
      const isDriveLink = /drive\.google\.com/i.test(h);
      const isPlaceholder = /^(будет (фото|видео)|фото будет|фото не (нужно|требуется))$/i.test(h);
      if (isImg) referencePhoto = h;
      else if (!isDriveLink && !isPlaceholder && h.length > 10) taskText = combine(taskText, h);
    }
    let aiDescription = i && i.length > 0 ? i : null;
    if (aiDescription && /\.(jpg|jpeg|png|webp)$/i.test(aiDescription)) {
      if (!referencePhoto) referencePhoto = aiDescription;
      aiDescription = null;
    }
    if (referencePhoto && PHOTO_RENAME[referencePhoto]) referencePhoto = PHOTO_RENAME[referencePhoto];
    const type = photoRequired ? 'photo' : 'confirm';
    const task = { order: order++, text: taskText, type, section: currentSection, ai_rule: aiDescription, reference_photo: referencePhoto };
    if (canSkip) task.can_skip = true;
    tasks.push(task);
  }
  return tasks;
}

const parsed = [];
for (const meta of SHEET_MAPPING) {
  const rows = readSheetByName(meta.match);
  if (!rows) { console.error('MISSING sheet for', meta.key); process.exit(1); }
  const tasks = meta.parser === 'waiterStyle' ? parseWaiterStyle(rows) : parseManagerStyle(rows);
  parsed.push({
    id: meta.key, role: meta.role, type: meta.type, language: meta.language,
    display_order: meta.display_order, name: meta.name, time_windows: meta.time_windows, tasks,
  });
}

const config = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
const filtered = config.checklists.filter((c) => !KEYS_TO_REPLACE.has(c.id));
for (const c of filtered) {
  if (KEYS_TO_ARCHIVE.has(c.id)) { c.role = 'archived'; c.type = 'archived'; }
}
config.checklists = [...filtered, ...parsed];
writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));

const totalTasks = parsed.reduce((s, c) => s + c.tasks.length, 0);
console.log(`✅ Обновлено: ${parsed.length} чек-листов, ${totalTasks} пунктов в ${CONFIG_PATH}`);
console.log('Запусти `/reload` или нажми «🔄 Перезагрузить чек-листы» в боте — БД синхронизируется.');
