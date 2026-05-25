// Parses the downloaded XLSX of waiter checklists and emits JSON for src/config/checklists.json.
// Usage: node scripts/parseChecklistsXlsx.mjs <xlsx-path>
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';

const xlsxPath = process.argv[2];
if (!xlsxPath) {
  console.error('Usage: node parseChecklistsXlsx.mjs <xlsx-path>');
  process.exit(1);
}

const tmp = mkdtempSync(path.join(tmpdir(), 'xlsx-parse-'));
execSync(`unzip -o -q "${xlsxPath}" -d "${tmp}"`);

function decodeXmlEntities(s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCodePoint(parseInt(n, 16)));
}

function loadSharedStrings() {
  const xml = readFileSync(path.join(tmp, 'xl', 'sharedStrings.xml'), 'utf-8');
  const result = [];
  const siRe = /<si\b[^>]*>([\s\S]*?)<\/si>/g;
  let m;
  while ((m = siRe.exec(xml)) !== null) {
    const inner = m[1];
    // Concatenate all <t>...</t> within this <si> (handles rich text runs)
    const tParts = [];
    const tRe = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g;
    let t;
    while ((t = tRe.exec(inner)) !== null) {
      tParts.push(decodeXmlEntities(t[1]));
    }
    result.push(tParts.join(''));
  }
  return result;
}

function parseSheet(sheetIdx, sharedStrings) {
  const xml = readFileSync(
    path.join(tmp, 'xl', 'worksheets', `sheet${sheetIdx}.xml`),
    'utf-8',
  );

  const rowRe = /<row\b[^>]*r="(\d+)"[^>]*>([\s\S]*?)<\/row>/g;
  const cellRe = /<c\b[^>]*r="([A-Z]+)\d+"(?:\s[^>]*)?(?:\s+t="([^"]+)")?(?:\s[^>]*)?(?:\/>|>([\s\S]*?)<\/c>)/g;
  const valueRe = /<v>([\s\S]*?)<\/v>/;
  const inlineStrRe = /<is><t[^>]*>([\s\S]*?)<\/t><\/is>/;

  const rows = [];
  let r;
  while ((r = rowRe.exec(xml)) !== null) {
    const rowNum = Number(r[1]);
    const rowContent = r[2];
    const cells = {};

    const fullRe = /<c\s+r="([A-Z]+)(\d+)"([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
    let c;
    while ((c = fullRe.exec(rowContent)) !== null) {
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

const sharedStrings = loadSharedStrings();

// Sheets 2-9 are the waiter checklists per workbook.xml ordering
const SHEET_MAPPING = [
  { sheetIdx: 2, key: 'waiter_handover_open_ru', display_order: 1, language: 'ru', type: 'handover_open',
    name: '1️⃣ Официант Открытие смены (Открытие ресторана)' },
  { sheetIdx: 3, key: 'waiter_open_ru', display_order: 2, language: 'ru', type: 'open',
    name: '2️⃣ Официант открытие смены' },
  { sheetIdx: 4, key: 'waiter_handover_open_en', display_order: 1, language: 'en', type: 'handover_open',
    name: '1️⃣ Waiter - start of the day (Open restaurant)' },
  { sheetIdx: 5, key: 'waiter_open_en', display_order: 2, language: 'en', type: 'open',
    name: '2️⃣ Waiter - start of the day' },
  { sheetIdx: 6, key: 'waiter_handover_close_ru', display_order: 4, language: 'ru', type: 'handover_close',
    name: '4️⃣ Официант закрытие смены (Закрытие ресторана)' },
  { sheetIdx: 7, key: 'waiter_close_ru', display_order: 3, language: 'ru', type: 'close',
    name: '3️⃣ Официант закрытие смены' },
  { sheetIdx: 8, key: 'waiter_handover_close_en', display_order: 4, language: 'en', type: 'handover_close',
    name: '4️⃣ Waiter - end of the day (Closing restaurant)' },
  { sheetIdx: 9, key: 'waiter_close_en', display_order: 3, language: 'en', type: 'close',
    name: '3️⃣ Waiter - end of the day' },
];

const result = [];

for (const meta of SHEET_MAPPING) {
  const rows = parseSheet(meta.sheetIdx, sharedStrings);

  // Skip header rows (typically 1-2). Section/item detection:
  //   B contains the item text (Пункт)
  //   D=х means photo required
  //   F = description
  //   G = reference photo marker
  //   H = AI description
  // First non-empty row often is a section header — A=empty, B=section name with no number.

  const tasks = [];
  let order = 0;
  let currentSection = null;

  for (const row of rows) {
    const a = (row.cells.A ?? '').trim();
    const b = (row.cells.B ?? '').trim();
    const d = (row.cells.D ?? '').trim();
    const f = (row.cells.F ?? '').trim();
    const g = (row.cells.G ?? '').trim();
    const h = (row.cells.H ?? '').trim();

    if (!b) continue;

    // Header row: B contains literal "Пункт"
    if (b === 'Пункт') continue;

    // Section header heuristic: row has B but no A (no number) — treat as section
    if (!a) {
      currentSection = b;
      continue;
    }

    // Item row
    const photoRequired = d === 'х' || d === 'x' || d === '✓' || d === 'X' || d === 'Х';

    // Task text: prefer F (full description) when it's substantially longer than B (label)
    let taskText = b;
    if (f && f.length > b.length * 1.3 && f.length > 20) {
      taskText = f;
    }

    // Reference photo: only if G looks like a real filename (ends with image extension)
    let referencePhoto = null;
    let extraInstructions = null;

    if (g) {
      const isImageFile = /\.(jpg|jpeg|png|webp)$/i.test(g.trim());
      const isPlaceholder = /^будет (фото|видео)$/i.test(g.trim());

      if (isImageFile) {
        referencePhoto = g.trim();
      } else if (!isPlaceholder && g.length > 10) {
        // Likely instruction text (close sheets have "ref:" col with action instructions)
        extraInstructions = g.trim();
      }
    }

    if (extraInstructions && !taskText.includes(extraInstructions)) {
      taskText = `${taskText}\n${extraInstructions}`;
    }

    let aiDescription = h && h.trim().length > 0 ? h.trim() : null;

    // Edge case: client sometimes put the photo filename into column H ("Описание для ИИ").
    // Treat it as a reference photo and clear the AI rule.
    if (aiDescription && /\.(jpg|jpeg|png|webp)$/i.test(aiDescription)) {
      if (!referencePhoto) {
        referencePhoto = aiDescription;
      }
      aiDescription = null;
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

  result.push({
    id: meta.key,
    role: 'waiter',
    type: meta.type,
    language: meta.language,
    display_order: meta.display_order,
    name: meta.name,
    time_windows: [{ start: '06:00', end: '01:00' }],
    tasks,
  });
}

writeFileSync(
  process.argv[3] ?? '/tmp/parsed-waiter-checklists.json',
  JSON.stringify(result, null, 2),
);

console.log(`Parsed ${result.length} checklists, total tasks: ${result.reduce((s, r) => s + r.tasks.length, 0)}`);
for (const r of result) {
  console.log(`  ${r.id}: ${r.tasks.length} tasks`);
}
