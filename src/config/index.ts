import 'dotenv/config';

function getEnv(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required env variable: ${key}`);
  }
  return value;
}

function getOptionalEnv(key: string): string | undefined {
  return process.env[key] || undefined;
}

function getNumberEnv(key: string, fallback: number): number {
  const value = getOptionalEnv(key);
  if (!value) return fallback;

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function getFloatEnv(key: string, fallback: number): number {
  const value = getOptionalEnv(key);
  if (!value) return fallback;

  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export const config = {
  BOT_TOKEN: getEnv('BOT_TOKEN'),
  OPENAI_API_KEY: getOptionalEnv('OPENAI_API_KEY'),
  TEST_MODE: getOptionalEnv('TEST_MODE') === 'true',
  BUSINESS_TIMEZONE: getOptionalEnv('BUSINESS_TIMEZONE') ?? 'Europe/Moscow',
  EXIF_MAX_AGE_MINUTES: getNumberEnv('EXIF_MAX_AGE_MINUTES', 10),
  /** Минимальная уверенность ИИ для отклонения фото (0–1). Выше = мягче (меньше отказов). */
  AI_FAIL_MIN_CONFIDENCE: getFloatEnv('AI_FAIL_MIN_CONFIDENCE', 0.95),
  ADMIN_IDS: (getOptionalEnv('ADMIN_IDS') ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id.length > 0),
  /**
   * Кому шлются stack-trace сообщения «🚨 Критическая ошибка бота».
   * Отдельно от ADMIN_IDS, потому что менеджеры-админы (Илана и др.)
   * не должны видеть служебные stack-trace ошибки — только разработчик.
   * Если не задан — fallback на первого из ADMIN_IDS (чтобы старые
   * установки не вещали ошибки всем подряд по умолчанию).
   */
  ERROR_NOTIFY_IDS: (getOptionalEnv('ERROR_NOTIFY_IDS') ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id.length > 0),
  OWNER_ID: getOptionalEnv('OWNER_ID'),
  TEAM_CHAT_ID: getOptionalEnv('TEAM_CHAT_ID'),
  MAKE_WEBHOOK_URL: getOptionalEnv('MAKE_WEBHOOK_URL'),
  MANAGER_IDS_RESTAURANT: (getOptionalEnv('MANAGER_IDS_RESTAURANT') ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id.length > 0),
  MANAGER_IDS_CAFE: (getOptionalEnv('MANAGER_IDS_CAFE') ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id.length > 0),
} as const;

export function isAdmin(telegramId: string): boolean {
  return config.ADMIN_IDS.includes(telegramId);
}
