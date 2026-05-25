/**
 * Refresh ONLY manager checklists (incl. "Большая восьмёрка") from an alternate
 * Google Spreadsheet. Waiter, archived and other roles in checklists.json are
 * left untouched.
 *
 * Usage:
 *   npm run update:manager
 *   npm run update:manager -- <sheetId>          # override default sheet id
 */
import 'dotenv/config';
import { syncChecklistsFromGoogleSheet } from '../src/services/sheetSyncService.js';

async function main(): Promise<void> {
  const sheetIdArg = process.argv[2]?.trim();
  console.log(`[update:manager] Sheet: ${sheetIdArg ?? 'default (из sheetSyncService.ts)'}`);
  console.log('[update:manager] Roles: manager (только менеджер + Большая восьмёрка)');

  const result = await syncChecklistsFromGoogleSheet({
    sheetId: sheetIdArg || undefined,
    roleFilter: ['manager'],
  });

  console.log('[update:manager] OK');
  console.log(`  Checklists parsed: ${result.checklists}`);
  console.log(`  Tasks parsed:      ${result.tasks}`);
  console.log(`  DB synced:         ${result.syncedToDb}`);
  console.log('\nЕсли бот запущен — он подхватит изменения; на всякий случай можно нажать /reload в админ-панели или перезапустить npm run dev.');
}

main().catch((err: unknown) => {
  console.error('[update:manager] FAILED');
  console.error(err instanceof Error ? err.message : err);
  if (err instanceof Error && err.stack) console.error(err.stack);
  process.exit(1);
});
