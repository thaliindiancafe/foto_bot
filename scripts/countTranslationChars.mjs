import { readFileSync } from 'node:fs';

const src = readFileSync('src/config/roles.ts', 'utf-8');

// Match ui.ru block
const m = src.match(/ru:\s*{([\s\S]*?)\n\s*},\s*\n\s*en:/);
if (!m) {
  console.error('ui.ru block not found');
  process.exit(1);
}

const block = m[1];
const re = /'((?:[^'\\]|\\.)*)'/g;
let total = 0;
let count = 0;
let match;
while ((match = re.exec(block)) !== null) {
  total += match[1].length;
  count++;
}

console.log('UI strings RU:', count, '| total chars:', total);

// Also count what /start sends + other inline Russian strings in bot/index.ts
const bot = readFileSync('src/bot/index.ts', 'utf-8');
const ruInline = bot.match(/['"`][^'"`]*[А-Яа-яЁё][^'"`]*['"`]/g) || [];
let ruInlineChars = 0;
for (const s of ruInline) {
  ruInlineChars += s.length - 2;
}
console.log('Russian inline strings in bot/index.ts:', ruInline.length, '| chars:', ruInlineChars);
