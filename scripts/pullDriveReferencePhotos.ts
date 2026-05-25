/**
 * Download reference images from a Google Drive folder into src/config/reference_photos/
 * and optionally patch src/config/checklists.json using reference_drive_aliases.json.
 *
 * Setup:
 * - Enable Google Drive API for the same GCP project as the service account.
 * - GOOGLE_SERVICE_ACCOUNT_JSON — same JSON as for Sheets (one line in .env), **or**
 *   GOOGLE_SERVICE_ACCOUNT_JSON_FILE — path to the `.json` key file (recommended on Windows).
 * - Share the Drive folder with the service account email (Viewer is enough).
 *
 * Run from repo root (per project rules, do not use `npx tsx`):
 *   node --import tsx scripts/pullDriveReferencePhotos.ts
 *   node --import tsx scripts/pullDriveReferencePhotos.ts --dry-run
 *   node --import tsx scripts/pullDriveReferencePhotos.ts --no-patch
 */

import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { google } from 'googleapis';
import sharp from 'sharp';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const REF_DIR = path.join(ROOT, 'src', 'config', 'reference_photos');
const ALIAS_PATH = path.join(ROOT, 'src', 'config', 'reference_drive_aliases.json');
const CHECKLISTS_PATH = path.join(ROOT, 'src', 'config', 'checklists.json');

/** Default: "Тхали эталонные фото для чек-листов" shared folder */
const DEFAULT_FOLDER = '1m9JZnSAZwEdbGfs2BUm9SRN6-VJk8iCD';

interface ApplyTarget {
  checklistId: string;
  order: number;
}

interface AliasRule {
  priority: number;
  match: string;
  saveAs: string;
  applyTo: ApplyTarget[];
}

interface AliasFile {
  rules: AliasRule[];
}

/** Root shape of src/config/checklists.json (not a bare array). */
interface ChecklistsRoot {
  roles?: unknown;
  roleNames?: unknown;
  checklists: Array<{
    id: string;
    tasks?: Array<{ order: number; reference_photo?: string | null; type?: string }>;
  }>;
}

function normName(s: string): string {
  let x = s
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[._]+/g, ' ')
    .replace(/[\u2013\u2014-]/g, ' ')
    .replace(/,/g, ' ')
    .replace(/[()[\]]/g, ' ');
  // Homoglyph: Latin "c" + Cyrillic "толы…" (file name typo for "Столы")
  x = x.replace(/c(?=\u0442\u043e\u043b)/g, '\u0441');
  x = x.replace(/\s+/g, ' ').trim();
  return x;
}

function matches(rule: AliasRule, driveFileName: string): boolean {
  return normName(driveFileName).includes(normName(rule.match));
}

function findRule(rulesSorted: AliasRule[], driveFileName: string): AliasRule | null {
  for (const r of rulesSorted) {
    if (matches(r, driveFileName)) return r;
  }
  return null;
}

function isHeicFilename(name: string): boolean {
  return /\.(heic|heif)$/i.test(name.trim());
}

function stripBom(s: string): string {
  if (s.length > 0 && s.charCodeAt(0) === 0xfeff) return s.slice(1);
  return s;
}

/** Outer quotes from .env like KEY='{...}' or KEY="{...}" */
function unwrapEnvJsonString(s: string): string {
  let x = s.trim();
  if (x.length >= 2) {
    const a = x[0];
    const b = x[x.length - 1];
    if ((a === "'" && b === "'") || (a === '"' && b === '"')) {
      x = x.slice(1, -1).trim();
    }
  }
  return x;
}

async function loadServiceAccountJsonString(): Promise<string> {
  const filePath = process.env.GOOGLE_SERVICE_ACCOUNT_JSON_FILE?.trim();
  if (filePath) {
    const abs = path.isAbsolute(filePath) ? filePath : path.join(ROOT, filePath);
    const text = stripBom(await fs.readFile(abs, 'utf8')).trim();
    if (!text.startsWith('{')) {
      throw new Error(
        `GOOGLE_SERVICE_ACCOUNT_JSON_FILE must point to a JSON object file. First char: ${JSON.stringify(text[0])}`,
      );
    }
    return text;
  }

  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON?.trim();
  if (!raw) {
    throw new Error(
      'Set GOOGLE_SERVICE_ACCOUNT_JSON (one-line JSON) or GOOGLE_SERVICE_ACCOUNT_JSON_FILE=path/to/key.json',
    );
  }
  let s = stripBom(raw).trim();
  s = unwrapEnvJsonString(s);
  if (!s.startsWith('{')) {
    throw new Error(
      `GOOGLE_SERVICE_ACCOUNT_JSON must start with "{". First non-space char is ${JSON.stringify(s[0])}. ` +
        'Remove extra quotes before "{" or use GOOGLE_SERVICE_ACCOUNT_JSON_FILE=... instead.',
    );
  }
  return s;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes('--dry-run');
  const noPatch = argv.includes('--no-patch');

  const folderId = process.env.GOOGLE_DRIVE_REFERENCE_FOLDER_ID ?? DEFAULT_FOLDER;

  const aliasText = await fs.readFile(ALIAS_PATH, 'utf8');
  const aliasDoc = JSON.parse(aliasText) as AliasFile;
  const rulesSorted = [...aliasDoc.rules].sort((a, b) => a.priority - b.priority);

  let accountJson: string;
  try {
    accountJson = await loadServiceAccountJsonString();
  } catch (e) {
    console.error(String(e));
    process.exit(1);
  }

  let creds: { client_email: string; private_key: string };
  try {
    creds = JSON.parse(accountJson) as { client_email: string; private_key: string };
  } catch (e) {
    const preview = accountJson.slice(0, 160).replace(/\r?\n/g, '\\n');
    console.error('[parse error] Cannot JSON.parse service account. First ~160 chars:', preview);
    console.error(
      'Typical fix: do not paste multi-line JSON into .env (dotenv breaks it). ' +
        'Save the key as e.g. secrets/google-sa.json and set GOOGLE_SERVICE_ACCOUNT_JSON_FILE=secrets/google-sa.json',
    );
    throw e;
  }

  const auth = new google.auth.JWT({
    email: creds.client_email,
    key: creds.private_key,
    scopes: ['https://www.googleapis.com/auth/drive.readonly'],
  });

  const drive = google.drive({ version: 'v3', auth });

  const listRes = await drive.files.list({
    q: `'${folderId}' in parents and trashed=false`,
    fields: 'files(id,name,mimeType)',
    pageSize: 200,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });

  const rawFiles = listRes.data.files ?? [];
  /** Prefer JPEG/PNG over HEIC so the same scene can exist as two files without failing the run. */
  const files = [...rawFiles].sort((a, b) => {
    const sa = isHeicFilename(a.name ?? '') ? 1 : 0;
    const sb = isHeicFilename(b.name ?? '') ? 1 : 0;
    return sa - sb;
  });
  console.log(`Listed ${files.length} files in folder ${folderId}`);

  const patchMap = new Map<string, string>();

  for (const f of files) {
    if (!f.id || !f.name) continue;
    if (f.mimeType === 'application/vnd.google-apps.folder') continue;
    if (f.mimeType?.startsWith('application/vnd.google-apps.')) {
      console.warn('[skip]', f.name, '(Google Docs type — export a binary image to this folder)');
      continue;
    }

    if (isHeicFilename(f.name)) {
      console.warn(
        '[skip]',
        f.name,
        '— HEIC не поддерживается здесь; если уже есть JPG с тем же кадром, удали HEIC из папки на Drive (иначе он всё равно попадает в список файлов).',
      );
      continue;
    }

    const rule = findRule(rulesSorted, f.name);
    if (!rule) {
      console.warn('[no rule]', f.name);
      continue;
    }

    console.log(`[match] "${f.name}" -> ${rule.saveAs} (match: "${rule.match}")`);

    const applyPatchKeys = (): void => {
      for (const t of rule.applyTo) {
        const key = `${t.checklistId}\t${t.order}`;
        const prev = patchMap.get(key);
        if (prev && prev !== rule.saveAs) {
          console.warn(`[overwrite] ${key}: "${prev}" -> "${rule.saveAs}" (${f.name})`);
        }
        patchMap.set(key, rule.saveAs);
      }
    };

    if (dryRun) {
      applyPatchKeys();
      continue;
    }

    await fs.mkdir(REF_DIR, { recursive: true });
    const outPath = path.join(REF_DIR, rule.saveAs);

    try {
      const media = await drive.files.get(
        { fileId: f.id, alt: 'media', supportsAllDrives: true },
        { responseType: 'arraybuffer' },
      );
      const buf = Buffer.from(media.data as ArrayBuffer);
      await sharp(buf).jpeg({ quality: 90, mozjpeg: true }).toFile(outPath);
      console.log(`[saved] ${outPath}`);
      applyPatchKeys();
    } catch (e) {
      console.error(`[fail] ${f.name} -> ${rule.saveAs}:`, e);
      const lower = f.name.toLowerCase();
      if (lower.endsWith('.heic') || lower.endsWith('.heif') || f.mimeType === 'image/heic') {
        console.error(
          '[hint] HEIC is not supported by Sharp on this Node build. Export the same photo as JPEG in Drive, re-run the script, or delete the HEIC and upload JPG.',
        );
      }
    }
  }

  if (dryRun) {
    console.log('--dry-run: no files written, no checklists patch');
    return;
  }

  if (noPatch) {
    console.log('--no-patch: skip checklists.json');
    return;
  }

  const chkText = await fs.readFile(CHECKLISTS_PATH, 'utf8');
  const root = JSON.parse(chkText) as ChecklistsRoot;
  if (!Array.isArray(root.checklists)) {
    throw new Error('checklists.json must contain a "checklists" array at the top level');
  }

  let patched = 0;
  for (const cl of root.checklists) {
    if (!cl.tasks) continue;
    for (const task of cl.tasks) {
      const key = `${cl.id}\t${task.order}`;
      const ref = patchMap.get(key);
      if (!ref) continue;
      if (task.type && task.type !== 'photo') continue;
      task.reference_photo = ref;
      patched++;
    }
  }

  await fs.writeFile(CHECKLISTS_PATH, `${JSON.stringify(root, null, 2)}\n`, 'utf8');
  console.log(`Patched ${patched} photo task(s) in checklists.json`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
