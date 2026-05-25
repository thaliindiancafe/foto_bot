import { existsSync } from 'node:fs';
import type { Telegraf } from 'telegraf';
import { Input } from 'telegraf';
import type { Context } from 'telegraf';
import { config } from '../config/index.js';
import { prisma } from '../db/client.js';

export async function notifyManagers(
  bot: Telegraf<Context>,
  userId: number,
  checklistName: string,
  failCount: number,
  location: string | null,
): Promise<void> {
  const managerIds =
    location === 'cafe'
      ? config.MANAGER_IDS_CAFE
      : config.MANAGER_IDS_RESTAURANT;

  if (managerIds.length === 0) return;

  const user = await prisma.user.findUnique({ where: { id: userId } });
  const userName = user?.displayName ?? user?.firstName ?? 'Сотрудник';

  let message: string;
  if (failCount > 0) {
    message = [
      '⚠️ Нарушения в чек-листе',
      `Сотрудник: ${userName}`,
      `Чек-лист: ${checklistName}`,
      `Нарушений: ${failCount}`,
    ].join('\n');
  } else {
    message = [
      '✅ Чек-лист завершён',
      `Сотрудник: ${userName}`,
      `Чек-лист: ${checklistName}`,
      'Нарушений: нет',
    ].join('\n');
  }

  const { sendTranslatedToUser } = await import('../bot/i18nMiddleware.js');
  for (const managerId of managerIds) {
    try {
      await sendTranslatedToUser(bot.telegram, managerId, message);
    } catch (error) {
      console.error(`[notificationService] Ошибка отправки менеджеру ${managerId}:`, error);
    }
  }
}

/**
 * Send a real-time alert to managers + owner when AI flagged a photo as
 * not matching. The photo is still accepted in the bot — this is just a
 * heads-up so a human can double-check.
 */
export async function notifyPhotoMismatch(
  bot: Telegraf<Context>,
  params: {
    userId: number;
    location: string | null;
    checklistTitle: string;
    questionText: string;
    photoPath: string;
    aiReason: string | null;
  },
): Promise<void> {
  const { userId, location, checklistTitle, questionText, photoPath, aiReason } = params;

  const recipients = new Set<string>();
  const managerIds =
    location === 'cafe' ? config.MANAGER_IDS_CAFE : config.MANAGER_IDS_RESTAURANT;
  for (const id of managerIds) recipients.add(id);
  if (config.OWNER_ID) recipients.add(config.OWNER_ID);

  if (recipients.size === 0) return;

  const user = await prisma.user.findUnique({ where: { id: userId } });
  const userName = user?.displayName ?? user?.firstName ?? 'Сотрудник';

  const caption = [
    '⚠️ Возможное несоответствие фото',
    `Сотрудник: ${userName}`,
    `Чек-лист: ${checklistTitle}`,
    `Пункт: ${questionText}`,
    aiReason ? `Что заметил ИИ: ${aiReason}` : null,
    '',
    'Фото принято и пункт засчитан, но проверьте — возможно, нужно поговорить с сотрудником.',
  ]
    .filter(Boolean)
    .join('\n');

  const isUrl = photoPath.startsWith('http://') || photoPath.startsWith('https://');
  const source = isUrl
    ? { url: photoPath }
    : existsSync(photoPath)
      ? Input.fromLocalFile(photoPath)
      : null;

  const { sendTranslatedToUser, getUserLanguageByTelegramId } = await import('../bot/i18nMiddleware.js');
  const { translate } = await import('./translationService.js');

  for (const recipient of recipients) {
    try {
      if (source) {
        const lang = await getUserLanguageByTelegramId(recipient);
        const translatedCaption = lang === 'ru' ? caption : await translate(caption, lang, 'ru');
        await bot.telegram.sendPhoto(recipient, source, { caption: translatedCaption });
      } else {
        await sendTranslatedToUser(bot.telegram, recipient, caption);
      }
    } catch (error) {
      console.error(`[notificationService] Ошибка отправки алерта ${recipient}:`, error);
    }
  }
}
