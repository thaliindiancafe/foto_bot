import 'dotenv/config';
import { syncBaristaChecklistsFromGoogleSheet } from '../src/services/sheetSyncService.js';

async function main(): Promise<void> {
  const sheetIdArg = process.argv[2]?.trim();
  const result = await syncBaristaChecklistsFromGoogleSheet({
    sheetId: sheetIdArg || undefined,
  });

  console.log('[update:barista] OK');
  console.log(`  Checklists parsed: ${result.checklists}`);
  console.log(`  Tasks parsed:      ${result.tasks}`);
  console.log(`  DB synced:         ${result.syncedToDb}`);
}

main().catch((err: unknown) => {
  console.error('[update:barista] FAILED');
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});

