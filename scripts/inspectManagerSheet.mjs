import AdmZip from 'adm-zip';
const SHEET_ID = '1L7GDvfBglsctSu1uk2ScGKmGgkh_uR3nYeP26JsPkMY';
const URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=xlsx`;

const r = await fetch(URL, { redirect: 'follow' });
const buf = Buffer.from(await r.arrayBuffer());
const zip = new AdmZip(buf);

const decodeXml = (s) => s
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
  .replace(/&quot;/g, '"').replace(/&apos;/g, "'");

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
  if (name) sheets.push({ name: decodeXml(name), rid });
}

const relsXml = zip.getEntry('xl/_rels/workbook.xml.rels').getData().toString('utf-8');
const rels = {};
for (const m of relsXml.matchAll(/<Relationship\b\s+([^>]*?)\/>/g)) {
  const attrs = m[1];
  const id = attrs.match(/\bId="([^"]+)"/)?.[1];
  const tgt = attrs.match(/\bTarget="([^"]+)"/)?.[1];
  if (id && tgt) rels[id] = tgt;
}

function readSheet(name) {
  const sheet = sheets.find(s => s.name === name);
  if (!sheet) return null;
  const tgt = rels[sheet.rid];
  const idx = tgt?.match(/sheet(\d+)\.xml/)?.[1];
  if (!idx) return null;
  const xml = zip.getEntry(`xl/worksheets/sheet${idx}.xml`).getData().toString('utf-8');
  const rows = [];
  for (const r of xml.matchAll(/<row\b[^>]*r="(\d+)"[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells = {};
    for (const c of r[2].matchAll(/<c\s+r="([A-Z]+)(\d+)"([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const col = c[1];
      const attrs = c[3] ?? '';
      const inner = c[4] ?? '';
      const tMatch = attrs.match(/\bt="([^"]+)"/);
      const cellType = tMatch ? tMatch[1] : null;
      const v = inner.match(/<v>([\s\S]*?)<\/v>/);
      let value = '';
      if (v) {
        if (cellType === 's') value = ss[Number(v[1])] ?? '';
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

const TABS = [
  'Менеджер открытие ресторана',
  'Менеджер начало смены пересменка',
  'Менеджер окончание смены пересменка',
  'Менеджер закрытие ресторана',
  'Большая восьмерка Менеджер',
];

for (const name of TABS) {
  console.log('\n=== ' + name + ' ===');
  const rows = readSheet(name);
  if (!rows) { console.log('  (вкладка не найдена)'); continue; }
  let printed = 0;
  for (const row of rows) {
    const a = (row.cells.A ?? '').trim();
    const b = (row.cells.B ?? '').trim();
    const g = (row.cells.G ?? '').trim();
    const h = (row.cells.H ?? '').trim();
    const i = (row.cells.I ?? '').trim();
    if (!b) continue;
    if (b === 'Пункт') continue;
    // Show only data rows with content
    if (printed >= 60) break;
    printed++;
    console.log(`r${row.rowNum} A="${a}" B(пункт)="${b.slice(0,70)}" G(описание)="${g.slice(0,90)}" H(этал)="${h.slice(0,30)}" I(ai)="${i.slice(0,40)}"`);
  }
}
