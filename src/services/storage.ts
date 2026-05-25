import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { google } from 'googleapis';
import type { drive_v3 } from 'googleapis';

const ENABLE_GOOGLE_DRIVE = process.env.ENABLE_GOOGLE_DRIVE === 'true';
const LOCAL_STORAGE_PATH = process.env.LOCAL_STORAGE_PATH ?? './uploads';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, '..', '..');

// Единая корневая папка Google Drive (фото сотрудников за смену)
const DRIVE_ROOT_FOLDER = process.env.GOOGLE_DRIVE_FOLDER_ID;

// Кэш ID подпапок сотрудников: "parentFolderId/employeeName" → folderId
const subfolderCache = new Map<string, string>();

function stripBom(s: string): string {
  if (s.length > 0 && s.charCodeAt(0) === 0xfeff) return s.slice(1);
  return s;
}

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

async function loadServiceAccountJsonString(): Promise<string | null> {
  const filePath = process.env.GOOGLE_SERVICE_ACCOUNT_JSON_FILE?.trim();
  if (filePath) {
    const realPath = filePath.startsWith('/') || /^[A-Za-z]:/.test(filePath) ? filePath : join(PROJECT_ROOT, filePath);
    const text = stripBom(await readFile(realPath, 'utf8')).trim();
    return text.startsWith('{') ? text : null;
  }
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON?.trim();
  if (!raw) return null;
  let s = stripBom(raw).trim();
  s = unwrapEnvJsonString(s);
  return s.startsWith('{') ? s : null;
}

function createOAuthDriveClient(): drive_v3.Drive | null {
  const clientId = process.env.GOOGLE_CLIENT_ID?.trim();
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim();
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN?.trim();
  if (!clientId || !clientSecret || !refreshToken) return null;

  const auth = new google.auth.OAuth2(clientId, clientSecret);
  auth.setCredentials({ refresh_token: refreshToken });
  return google.drive({ version: 'v3', auth });
}

async function createServiceAccountDriveClient(): Promise<drive_v3.Drive | null> {
  const saRaw = await loadServiceAccountJsonString();
  if (!saRaw) return null;

  const creds = JSON.parse(saRaw) as { client_email: string; private_key: string };
  const auth = new google.auth.JWT({
    email: creds.client_email,
    key: creds.private_key,
    scopes: ['https://www.googleapis.com/auth/drive'],
  });
  return google.drive({ version: 'v3', auth });
}

/**
 * Drive API client (cleanup, list). Service account first, then OAuth.
 */
export async function getDriveClient(): Promise<drive_v3.Drive> {
  const sa = await createServiceAccountDriveClient();
  if (sa) return sa;

  const oauth = createOAuthDriveClient();
  if (oauth) return oauth;

  throw new Error(
    'Drive: задайте GOOGLE_SERVICE_ACCOUNT_JSON_FILE или OAuth (CLIENT_ID + SECRET + REFRESH_TOKEN)',
  );
}

/**
 * Загрузка фото: OAuth (аккаунт клиента), иначе SA.
 * У сервисного аккаунта нет квоты на «Мой диск» — файлы дают 403, папки иногда создаются.
 */
async function getDriveClientForUpload(): Promise<drive_v3.Drive> {
  const oauth = createOAuthDriveClient();
  if (oauth) return oauth;

  const sa = await createServiceAccountDriveClient();
  if (sa) return sa;

  throw new Error(
    'Drive upload: нужен GOOGLE_REFRESH_TOKEN (OAuth) или Shared Drive + сервисный аккаунт',
  );
}

function isStorageQuotaForbidden(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes('storage quota') || msg.includes('Service Accounts do not have storage')) {
    return true;
  }
  const status = (err as { code?: number; status?: number }).code ?? (err as { status?: number }).status;
  return status === 403 && msg.toLowerCase().includes('forbidden');
}

function isParentPermissionError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes('Insufficient permissions for the specified parent');
}

/** Проверка: OAuth-аккаунт может создавать файлы/папки в GOOGLE_DRIVE_FOLDER_ID */
async function assertDriveFolderWritable(drive: drive_v3.Drive, folderId: string): Promise<void> {
  const meta = await drive.files.get({
    fileId: folderId,
    fields: 'id, name, capabilities',
    supportsAllDrives: true,
  });

  const canAdd = meta.data.capabilities?.canAddChildren;
  if (canAdd === false) {
    const name = meta.data.name ?? folderId;
    throw new Error(
      `[storage] Нет прав записи в папку Drive «${name}» (${folderId}). ` +
        'Создайте НОВУЮ папку в своём Google Диске (тот же Gmail, что при google:oauth), ' +
        'скопируйте её ID в GOOGLE_DRIVE_FOLDER_ID. Старую папку, расшаренную только на smenapro-bot@..., использовать нельзя.',
    );
  }
}

/**
 * Найти или создать подпапку внутри parentFolderId.
 */
async function getOrCreateSubfolder(
  drive: drive_v3.Drive,
  parentFolderId: string,
  folderName: string,
): Promise<string> {
  const cacheKey = `${parentFolderId}/${folderName}`;
  const cached = subfolderCache.get(cacheKey);
  if (cached) return cached;

  // Поиск существующей папки
  const query = [
    `name = '${folderName.replace(/'/g, "\\'")}'`,
    `'${parentFolderId}' in parents`,
    `mimeType = 'application/vnd.google-apps.folder'`,
    `trashed = false`,
  ].join(' and ');

  const list = await drive.files.list({
    q: query,
    fields: 'files(id)',
    spaces: 'drive',
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });

  if (list.data.files && list.data.files.length > 0) {
    const id = list.data.files[0].id!;
    subfolderCache.set(cacheKey, id);
    return id;
  }

  // Создание новой папки
  const created = await drive.files.create({
    requestBody: {
      name: folderName,
      mimeType: 'application/vnd.google-apps.folder',
      parents: [parentFolderId],
    },
    fields: 'id',
    supportsAllDrives: true,
  });

  const id = created.data.id!;
  subfolderCache.set(cacheKey, id);
  console.log(`[storage] Created Drive folder: ${folderName} (${id})`);
  return id;
}

export interface UploadContext {
  displayName?: string;
}

export async function uploadPhoto(
  buffer: Buffer,
  filename: string,
  context?: UploadContext,
): Promise<string> {
  if (ENABLE_GOOGLE_DRIVE) {
    try {
      return await uploadToGoogleDrive(buffer, filename, context);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error('[storage] Google Drive upload failed, falling back to local storage:', msg);
      if (msg.includes('Нет прав записи в папку Drive')) {
        console.error(
          '[storage] Подсказка: GOOGLE_DRIVE_FOLDER_ID должен быть папкой на ВАШЕМ Диске (Gmail из google:oauth), не только расшаренной на робота.',
        );
      }
      return uploadToLocal(buffer, filename);
    }
  }
  return uploadToLocal(buffer, filename);
}

async function uploadFileToDriveFolder(
  drive: drive_v3.Drive,
  buffer: Buffer,
  filename: string,
  targetFolderId: string,
): Promise<string> {
  const response = await drive.files.create({
    requestBody: {
      name: filename,
      parents: [targetFolderId],
    },
    media: {
      mimeType: 'image/jpeg',
      body: Readable.from(buffer),
    },
    fields: 'id, webViewLink, webContentLink',
    supportsAllDrives: true,
    supportsTeamDrives: true,
  });

  const fileId = response.data.id!;

  await drive.permissions.create({
    fileId,
    requestBody: {
      role: 'reader',
      type: 'anyone',
    },
    supportsAllDrives: true,
  });

  const link =
    response.data.webViewLink ??
    response.data.webContentLink ??
    `https://drive.google.com/file/d/${fileId}/view`;
  console.log(`[storage] Uploaded to Google Drive: ${filename} → ${link}`);
  return link;
}

async function uploadToGoogleDrive(
  buffer: Buffer,
  filename: string,
  context?: UploadContext,
): Promise<string> {
  if (!DRIVE_ROOT_FOLDER) {
    console.warn('[storage] GOOGLE_DRIVE_FOLDER_ID not set, falling back to local');
    return uploadToLocal(buffer, filename);
  }

  // Папку и файл создаёт один и тот же аккаунт (OAuth).
  const drive = await getDriveClientForUpload();
  await assertDriveFolderWritable(drive, DRIVE_ROOT_FOLDER);

  const employeeName = context?.displayName;
  let uploadFilename = filename;

  let targetFolderId = DRIVE_ROOT_FOLDER;
  if (employeeName) {
    try {
      targetFolderId = await getOrCreateSubfolder(drive, DRIVE_ROOT_FOLDER, employeeName);
    } catch (err) {
      if (isParentPermissionError(err)) {
        const safeName = employeeName.replace(/[<>:"/\\|?*]/g, '_').slice(0, 40);
        uploadFilename = `${safeName}_${uploadFilename}`;
        console.warn(
          `[storage] Подпапку «${employeeName}» создать нельзя — файл в корневую папку: ${uploadFilename}`,
        );
      } else {
        throw err;
      }
    }
  }

  try {
    return await uploadFileToDriveFolder(drive, buffer, uploadFilename, targetFolderId);
  } catch (err) {
    if (employeeName && (isParentPermissionError(err) || isStorageQuotaForbidden(err))) {
      subfolderCache.delete(`${DRIVE_ROOT_FOLDER}/${employeeName}`);
      console.warn(
        `[storage] Нет прав в папку «${employeeName}», создаём заново через OAuth…`,
      );
      targetFolderId = await getOrCreateSubfolder(drive, DRIVE_ROOT_FOLDER, employeeName);
      return await uploadFileToDriveFolder(drive, buffer, uploadFilename, targetFolderId);
    }
    throw err;
  }
}

async function uploadToLocal(buffer: Buffer, filename: string): Promise<string> {
  const dateDir = formatDateDir(new Date());
  const dirPath = join(LOCAL_STORAGE_PATH, dateDir);

  await mkdir(dirPath, { recursive: true });

  const filePath = join(dirPath, filename);
  await writeFile(filePath, buffer);

  console.log(`[storage] Photo saved locally: ${filePath}`);
  return filePath;
}

function formatDateDir(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}
