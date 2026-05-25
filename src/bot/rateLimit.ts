import type { Context, MiddlewareFn } from 'telegraf';

type UserCounters = {
  msgCount: number;
  photoCount: number;
  lastReset: number;
};

const WINDOW_MS = 60_000;
const MSG_LIMIT = 10;
const PHOTO_LIMIT = 5;
const COOLDOWN_TEXT = 'Слишком часто. Подождите 30 секунд.';

const counters = new Map<number, UserCounters>();

function getOrCreate(userId: number, now: number): UserCounters {
  let entry = counters.get(userId);
  if (!entry || now - entry.lastReset > WINDOW_MS) {
    entry = { msgCount: 0, photoCount: 0, lastReset: now };
    counters.set(userId, entry);
  }
  return entry;
}

export const rateLimitMiddleware: MiddlewareFn<Context> = async (ctx, next) => {
  // Inline-кнопки не должны расходовать лимит «сообщений в минуту» — иначе
  // админ быстро кликает по чек-листам и перестаёт получать ответы.
  if (ctx.callbackQuery) return next();

  const from = ctx.from;
  if (!from) return next();

  const now = Date.now();
  const entry = getOrCreate(from.id, now);

  const isPhoto =
    ctx.message && ('photo' in ctx.message || ('document' in ctx.message && ctx.message.document.mime_type?.startsWith('image/')));

  entry.msgCount++;
  if (isPhoto) entry.photoCount++;

  if (entry.msgCount > MSG_LIMIT || (isPhoto && entry.photoCount > PHOTO_LIMIT)) {
    await ctx.reply(COOLDOWN_TEXT);
    return;
  }

  return next();
};
