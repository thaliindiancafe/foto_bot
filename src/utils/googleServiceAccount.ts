import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

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

export type ServiceAccountCredentials = {
  client_email: string;
  private_key: string;
};

/** Loads SA JSON from GOOGLE_SERVICE_ACCOUNT_JSON_FILE or GOOGLE_SERVICE_ACCOUNT_JSON. */
export async function loadServiceAccountCredentials(): Promise<ServiceAccountCredentials> {
  const filePath = process.env.GOOGLE_SERVICE_ACCOUNT_JSON_FILE?.trim();
  let raw: string | null = null;

  if (filePath) {
    const realPath =
      filePath.startsWith('/') || /^[A-Za-z]:/.test(filePath)
        ? filePath
        : join(PROJECT_ROOT, filePath);
    const text = stripBom(await readFile(realPath, 'utf8')).trim();
    raw = text.startsWith('{') ? text : null;
  }

  if (!raw) {
    const envRaw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON?.trim();
    if (!envRaw) {
      throw new Error(
        'Задайте GOOGLE_SERVICE_ACCOUNT_JSON или GOOGLE_SERVICE_ACCOUNT_JSON_FILE в .env',
      );
    }
    raw = unwrapEnvJsonString(stripBom(envRaw));
  }

  return JSON.parse(raw) as ServiceAccountCredentials;
}
