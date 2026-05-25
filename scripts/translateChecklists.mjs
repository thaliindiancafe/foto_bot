// CLI обёртка над src/services/checklistTranslationService.ts.
// Массовый AI-перевод ru-чек-листов в en-партнёры. Идемпотентный.
//
// Usage:
//   node scripts/translateChecklists.mjs           # перевести только новые
//   node scripts/translateChecklists.mjs --force   # перепереводить все
//
// После завершения вручную запустите `npm run db:seed`,
// чтобы новые en-чек-листы попали в SQLite.
import 'dotenv/config';
import { translateMissingChecklistsToEnglish } from '../dist/services/checklistTranslationService.js';

const force = process.argv.includes('--force');

const result = await translateMissingChecklistsToEnglish({
  force,
  log: (msg) => console.log(msg),
});

console.log('');
console.log(`Translated: ${result.translated}`);
console.log(`Skipped:    ${result.skipped}`);
console.log(`Failed:     ${result.failed}`);
if (result.newIds.length > 0) {
  console.log(`New IDs:    ${result.newIds.join(', ')}`);
}
console.log('');
console.log('Next step: npm run db:seed');
