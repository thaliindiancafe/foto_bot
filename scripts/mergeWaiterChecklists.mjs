// Merges parsed waiter checklists into src/config/checklists.json.
// Removes old waiter open/close keys (will be replaced) and removes bilingual legacy keys.
import { readFileSync, writeFileSync } from 'node:fs';

const CONFIG_PATH = 'src/config/checklists.json';
const PARSED_PATH = process.argv[2];
if (!PARSED_PATH) {
  console.error('Usage: node mergeWaiterChecklists.mjs <parsed-json-path>');
  process.exit(1);
}

const config = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
const parsed = JSON.parse(readFileSync(PARSED_PATH, 'utf-8'));

// Keys we replace with parsed data
const KEYS_TO_REPLACE = new Set([
  // Old SI-imported regular open/close waiter
  'si_2dc2b3c79aaa4c47be5c114ee8e45d2d_waiter',
  'si_71d513ae5ccf4e4ca6dd3c5a1d0e8a32_waiter',
  'si_457a01e49da3470c98ea23a20ae3fef6_waiter',
  'si_20d04d8d05114c9d87f194eeec87efc6_waiter',
  // Placeholders we created in the previous step
  'waiter_handover_open_ru',
  'waiter_handover_close_ru',
  'waiter_handover_open_en',
  'waiter_handover_close_en',
  // Parser keys (in case re-running)
  'waiter_open_ru',
  'waiter_open_en',
  'waiter_close_ru',
  'waiter_close_en',
]);

// Bilingual legacy waiter checklists — not in the new 8, archive them
const KEYS_TO_ARCHIVE = new Set([
  'si_4d6b826a59d444eb8d438ddda653580e_waiter', // Открытие кофепоинта и бара
  'si_9f9d398a98bd4bd882864affd62b4d31_waiter', // Закрытие кофепоинта и бара
]);

const filtered = config.checklists.filter((c) => !KEYS_TO_REPLACE.has(c.id));

// Mark archived ones (preserve them so admin can re-enable, but switch role to archived)
for (const c of filtered) {
  if (KEYS_TO_ARCHIVE.has(c.id)) {
    c.role = 'archived';
    c.type = 'archived';
  }
}

// Append parsed waiter checklists
const merged = [...filtered, ...parsed];

config.checklists = merged;

writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));

console.log(`Merged. Removed ${config.checklists.length - merged.length + parsed.length} old, added ${parsed.length} parsed.`);
console.log(`Total checklists: ${merged.length}`);
console.log(`Waiter checklists in new structure:`);
for (const c of merged.filter((x) => x.role === 'waiter')) {
  console.log(`  ${c.language ?? '?'} | order ${c.display_order ?? '-'} | ${c.type} | ${c.name}`);
}
