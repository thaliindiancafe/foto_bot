/**
 * Полная синхронизация чек-листов из основной таблицы (см. SHEET_ID в
 * src/services/sheetSyncService.ts). Делает то же, что админ-кнопка
 * "📥 Обновить из Google-таблицы": качает XLSX, парсит все маппинги,
 * мёрджит в src/config/checklists.json и пушит в SQLite.
 *
 * Затрагивает только роли, перечисленные в SHEET_MAPPING (waiter RU/EN,
 * manager + большая восьмёрка). Архивы и роли вне маппинга (бариста, шеф,
 * клинер и т.д.) остаются без изменений.
 *
 * Usage:
 *   npm run update:all
 *   npm run update:all -- <sheetId>          # одноразово взять другую таблицу
 */
import 'dotenv/config';
import {
  syncBaristaChecklistsFromGoogleSheet,
  syncChecklistsFromGoogleSheet,
  syncHelperChecklistsFromGoogleSheet,
  syncHostessChecklistsFromGoogleSheet,
} from '../src/services/sheetSyncService.js';
import { translateMissingChecklistsToEnglish } from '../src/services/checklistTranslationService.js';
import { syncChecklists } from '../src/db/seed.js';

async function main(): Promise<void> {
  const sheetIdArg = process.argv[2]?.trim();
  console.log(`[update:all] Sheet: ${sheetIdArg ?? 'default (из sheetSyncService.ts)'}`);

  const result = await syncChecklistsFromGoogleSheet({
    sheetId: sheetIdArg || undefined,
  });

  const baristaResult = await syncBaristaChecklistsFromGoogleSheet();
  const helperResult = await syncHelperChecklistsFromGoogleSheet();
  const hostessResult = await syncHostessChecklistsFromGoogleSheet();

  console.log('[update:all] OK');
  console.log(`  Checklists parsed: ${result.checklists}`);
  console.log(`  Tasks parsed:      ${result.tasks}`);
  console.log(`  DB synced:         ${result.syncedToDb}`);
  console.log('');
  console.log(`  Barista checklists parsed: ${baristaResult.checklists}`);
  console.log(`  Barista tasks parsed:      ${baristaResult.tasks}`);
  console.log(`  Barista DB synced:         ${baristaResult.syncedToDb}`);
  console.log('');
  console.log(`  Helper checklists parsed:  ${helperResult.checklists}`);
  console.log(`  Helper tasks parsed:       ${helperResult.tasks}`);
  console.log(`  Helper DB synced:          ${helperResult.syncedToDb}`);
  console.log('');
  console.log(`  Hostess checklists parsed: ${hostessResult.checklists}`);
  console.log(`  Hostess tasks parsed:      ${hostessResult.tasks}`);
  console.log(`  Hostess DB synced:         ${hostessResult.syncedToDb}`);

  console.log('');
  console.log('[update:all] Translating new checklists to English…');
  const translate = await translateMissingChecklistsToEnglish({
    log: (msg) => console.log(`  ${msg}`),
  });
  console.log(`  Translated: ${translate.translated}`);
  console.log(`  Skipped:    ${translate.skipped}`);
  console.log(`  Failed:     ${translate.failed}`);

  if (translate.translated > 0) {
    console.log('');
    console.log('[update:all] Re-syncing DB after translation…');
    const finalCount = await syncChecklists();
    console.log(`  Total checklists now in DB: ${finalCount}`);
  }
}

main().catch((err: unknown) => {
  console.error('[update:all] FAILED');
  console.error(err instanceof Error ? err.message : err);
  if (err instanceof Error && err.stack) console.error(err.stack);
  process.exit(1);
});
