// i18n middleware: переопределяет ctx.reply / ctx.editMessageText /
// ctx.answerCbQuery так, чтобы все сообщения автоматически переводились на
// язык пользователя через src/services/translationService.ts (с кэшем в БД).
//
// Кнопки клавиатур (reply / inline) тоже обходятся и переводятся.
// Если язык пользователя 'ru' или язык не определён — middleware ничего не
// делает (русский — исходный язык всех текстов в коде).
//
// Для прямых вызовов bot.telegram.sendMessage (не через ctx) есть helper
// `sendTranslatedToUser(telegram, telegramId, text, extra?)`.
import type { Context, MiddlewareFn, Telegram } from 'telegraf';
import type { Message, InlineKeyboardMarkup, ReplyKeyboardMarkup } from 'telegraf/types';

type SendMessageExtra = Parameters<Telegram['sendMessage']>[2];
import { prisma } from '../db/client.js';
import { translate } from '../services/translationService.js';
import { allLanguages, type LanguageCode } from '../config/roles.js';

const HAS_CYRILLIC = /[А-Яа-яЁё]/;
const RU_LANGS: ReadonlySet<string> = new Set(['ru', 'ru-RU']);

// Все поддерживаемые не-русские языки, собранные из allLanguages — чтобы
// добавление нового языка в roles.ts не требовало правок здесь.
const NON_RU_SUPPORTED: ReadonlySet<LanguageCode> = new Set(
  allLanguages.map((l) => l.code).filter((c): c is LanguageCode => c !== 'ru'),
);

function isSupportedNonRu(code: string | null | undefined): code is LanguageCode {
  return code != null && NON_RU_SUPPORTED.has(code as LanguageCode);
}

// Нативные подписи языков (например `🇹🇯 Тоҷикӣ (Tajik)`) ВСЕГДА должны
// оставаться в своём родном письме — иначе таджик / кыргыз / русский,
// которому показывают выбор языка, не увидит свой язык в списке. Поэтому
// middleware никогда не пропускает эти подписи через OpenAI-переводчик.
const LANGUAGE_PICKER_LABELS: ReadonlySet<string> = new Set([
  ...allLanguages.map((l) => l.nativeLabel),
  ...allLanguages.map((l) => l.label),
]);

/** В одной сессии бот может несколько раз позвать reply от одного юзера —
 * кэшируем язык в памяти на 60 секунд, чтобы не дёргать БД на каждый вызов. */
type LangCacheEntry = { lang: LanguageCode; expiresAt: number };
const langCache = new Map<number, LangCacheEntry>();
const LANG_CACHE_TTL_MS = 60_000;

async function resolveUserLanguage(ctx: Context): Promise<LanguageCode> {
  const tgId = ctx.from?.id;
  if (!tgId) return 'ru';

  const cached = langCache.get(tgId);
  if (cached && cached.expiresAt > Date.now()) return cached.lang;

  let lang: LanguageCode = 'ru';
  try {
    const user = await prisma.user.findUnique({
      where: { telegramId: String(tgId) },
      select: { language: true },
    });
    if (isSupportedNonRu(user?.language)) {
      lang = user!.language as LanguageCode;
    }
  } catch {
    // БД может быть недоступна на старте — fallback на 'ru'
  }
  langCache.set(tgId, { lang, expiresAt: Date.now() + LANG_CACHE_TTL_MS });
  return lang;
}

/** Инвалидирует кэш — вызывается из бота после регистрации/смены роли. */
export function invalidateLanguageCache(tgId: number | string): void {
  const key = typeof tgId === 'string' ? Number(tgId) : tgId;
  if (Number.isFinite(key)) langCache.delete(key);
}

/** Получает язык пользователя по telegramId. Использует тот же кэш, что и middleware. */
export async function getUserLanguageByTelegramId(
  tgId: number | string,
): Promise<LanguageCode> {
  const key = typeof tgId === 'string' ? Number(tgId) : tgId;
  if (Number.isFinite(key)) {
    const cached = langCache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.lang;
  }
  let lang: LanguageCode = 'ru';
  try {
    const user = await prisma.user.findUnique({
      where: { telegramId: String(tgId) },
      select: { language: true },
    });
    if (isSupportedNonRu(user?.language)) {
      lang = user!.language as LanguageCode;
    }
  } catch {
    // БД может быть недоступна — fallback на 'ru'
  }
  if (Number.isFinite(key)) {
    langCache.set(key, { lang, expiresAt: Date.now() + LANG_CACHE_TTL_MS });
  }
  return lang;
}

/**
 * Helper для прямых вызовов bot.telegram.sendMessage. Получает язык
 * пользователя по telegramId и переводит текст + кнопки клавиатуры.
 * Использовать вместо `bot.telegram.sendMessage(userId, text, extra)`
 * везде, где `userId` — это сотрудник, который может быть на не-русском.
 */
export async function sendTranslatedToUser(
  telegram: Telegram,
  telegramId: number | string,
  text: string,
  extra?: SendMessageExtra,
): Promise<Message.TextMessage> {
  const lang = await getUserLanguageByTelegramId(telegramId);
  const translatedText = await tt(text, lang);
  const translatedExtra = (await translateExtra(extra, lang)) as SendMessageExtra | undefined;
  return telegram.sendMessage(telegramId, translatedText, translatedExtra);
}

async function tt(text: string, lang: LanguageCode): Promise<string> {
  if (RU_LANGS.has(lang)) return text;
  // Нативные подписи языков сохраняем как есть — пользователь должен видеть
  // свой язык в своём письме (русский — кириллица, таджикский — кириллица,
  // и т.д.). Иначе пикер становится непригодным.
  if (LANGUAGE_PICKER_LABELS.has(text.trim())) return text;
  if (!HAS_CYRILLIC.test(text)) return text; // нет кириллицы — нечего переводить
  try {
    return await translate(text, lang, 'ru');
  } catch {
    return text;
  }
}

/** Переводит подписи в reply / inline клавиатурах. */
async function translateKeyboard(
  reply_markup: unknown,
  lang: LanguageCode,
): Promise<unknown> {
  if (!reply_markup || typeof reply_markup !== 'object') return reply_markup;
  const rm = reply_markup as Partial<InlineKeyboardMarkup & ReplyKeyboardMarkup>;

  if (Array.isArray(rm.inline_keyboard)) {
    const rows = await Promise.all(
      rm.inline_keyboard.map(async (row) =>
        Promise.all(
          row.map(async (btn) => {
            if (btn && typeof btn === 'object' && 'text' in btn && typeof btn.text === 'string') {
              return { ...btn, text: await tt(btn.text, lang) };
            }
            return btn;
          }),
        ),
      ),
    );
    return { ...rm, inline_keyboard: rows };
  }

  if (Array.isArray(rm.keyboard)) {
    const rows = await Promise.all(
      rm.keyboard.map(async (row) =>
        Promise.all(
          row.map(async (btn) => {
            if (typeof btn === 'string') {
              return await tt(btn, lang);
            }
            if (btn && typeof btn === 'object') {
              const obj = btn as { text?: string } & Record<string, unknown>;
              if (typeof obj.text === 'string') {
                return { ...obj, text: await tt(obj.text, lang) };
              }
            }
            return btn;
          }),
        ),
      ),
    );
    return { ...rm, keyboard: rows };
  }

  return reply_markup;
}

/** Глубокое переопределение сигнатуры с extra: { reply_markup, caption, ... }. */
async function translateExtra(extra: unknown, lang: LanguageCode): Promise<unknown> {
  if (!extra || typeof extra !== 'object') return extra;
  const e = extra as Record<string, unknown>;
  const result: Record<string, unknown> = { ...e };
  if (typeof e.caption === 'string') result.caption = await tt(e.caption, lang);
  if (e.reply_markup) result.reply_markup = await translateKeyboard(e.reply_markup, lang);
  return result;
}

export const i18nMiddleware: MiddlewareFn<Context> = async (ctx, next) => {
  const lang = await resolveUserLanguage(ctx);

  if (RU_LANGS.has(lang)) {
    // Русский — ничего не оборачиваем, чтобы не замедлять.
    return next();
  }

  const originalReply = ctx.reply.bind(ctx);
  ctx.reply = (async (text: string, extra?: unknown) => {
    const translatedText = typeof text === 'string' ? await tt(text, lang) : text;
    const translatedExtra = await translateExtra(extra, lang);
    return originalReply(translatedText as string, translatedExtra as never);
  }) as typeof ctx.reply;

  const originalEdit = ctx.editMessageText?.bind(ctx);
  if (originalEdit) {
    ctx.editMessageText = (async (text: string, extra?: unknown) => {
      const translatedText = typeof text === 'string' ? await tt(text, lang) : text;
      const translatedExtra = await translateExtra(extra, lang);
      return originalEdit(translatedText as string, translatedExtra as never);
    }) as typeof ctx.editMessageText;
  }

  const originalAnswerCb = ctx.answerCbQuery?.bind(ctx);
  if (originalAnswerCb) {
    ctx.answerCbQuery = (async (text?: string, extra?: unknown) => {
      const translatedText = typeof text === 'string' ? await tt(text, lang) : text;
      return originalAnswerCb(translatedText as string, extra as never);
    }) as typeof ctx.answerCbQuery;
  }

  return next();
};
