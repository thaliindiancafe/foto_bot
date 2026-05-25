import cron from 'node-cron';
import type { Telegraf } from 'telegraf';
import type { Context } from 'telegraf';
import { prisma } from '../db/client.js';
import { config } from '../config/index.js';
import { getDriveClient } from './storage.js';
import { processOutbox } from './outboxService.js';
import { getBusinessDayBounds, getMinutesInTimeZone } from '../utils/businessTime.js';
import {
  CLOSING_REMINDER_TYPES,
  DEFAULT_SHIFT_END_MINUTES,
  DEFAULT_SHIFT_START_MINUTES,
  getMinutesSinceOperationalStart,
  getWindowDurationMinutes,
  isWithinTimeWindow,
  parseTimeToMinutes,
  parseTimeWindows,
} from '../utils/checklistTiming.js';

/**
 * Проверяет, завершил ли пользователь данный чек-лист сегодня
 * (есть run с completedAt != null ИЛИ status = missed).
 */
async function hasCompletedOrMissedToday(
  userId: number,
  checklistId: number,
  todayStart: Date,
): Promise<boolean> {
  const run = await prisma.run.findFirst({
    where: {
      userId,
      checklistId,
      startedAt: { gte: todayStart },
    },
  });
  return run !== null;
}

/**
 * Отправляет напоминание пользователю с inline-кнопкой старта чек-листа.
 */
async function sendReminder(
  bot: Telegraf<Context>,
  telegramId: string,
  checklistTitle: string,
  checklistKey: string,
): Promise<void> {
  try {
    const { sendTranslatedToUser } = await import('../bot/i18nMiddleware.js');
    await sendTranslatedToUser(
      bot.telegram,
      telegramId,
      `📋 Пора пройти чек-лист: "${checklistTitle}"`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: 'Начать', callback_data: `startChecklist:${checklistKey}` }],
          ],
        },
      },
    );
  } catch (error) {
    // Пользователь мог заблокировать бота
    const errMsg = error instanceof Error ? error.message : String(error);
    if (errMsg.includes('bot was blocked') || errMsg.includes('user is deactivated')) {
      console.warn(`[scheduler] Пользователь ${telegramId} заблокировал бота`);
    } else {
      console.error(`[scheduler] Ошибка отправки напоминания ${telegramId}:`, error);
    }
  }
}

/**
 * Создаёт пропущенный run (missed) для пользователя.
 */
async function createMissedRun(userId: number, checklistId: number): Promise<void> {
  const now = new Date();
  await prisma.run.create({
    data: {
      userId,
      checklistId,
      startedAt: now,
      completedAt: now,
      // completedAt заполнен, но без answers — значит missed
    },
  });
  console.log(`[scheduler] Missed run: userId=${userId}, checklistId=${checklistId}`);
}

/**
 * Основной cron-обработчик (каждую минуту).
 * Проверяет time_windows чек-листов и отправляет напоминания / фиксирует пропуски.
 */
async function processSchedule(bot: Telegraf<Context>): Promise<void> {
  if (config.TEST_MODE) return;

  const now = new Date();
  const nowMinutes = getMinutesInTimeZone(now);
  const { start: todayStart } = getBusinessDayBounds(now);

  const checklists = await prisma.checklist.findMany({
    include: { questions: true },
  });

  // Получаем всех пользователей с ролью
  const users = await prisma.user.findMany({
    where: { role: { not: null } },
  });

  for (const user of users) {
    if (!user.role) continue;

    const cls = checklists.filter((cl) => cl.role === user.role);

    for (const cl of cls) {
      const windows = parseTimeWindows(cl.timeWindows);

      if (windows.length > 0) {
        for (const window of windows) {
          const start = parseTimeToMinutes(window.start);
          const end = parseTimeToMinutes(window.end);

          // Для periodic с несколькими окнами в день (например, Большая восьмёрка)
          // шлём напоминание в начале каждого окна — без проверки "done", чтобы
          // менеджер получил все 4 пинга, даже если уже прошёл одну из проверок.
          if (cl.type === 'periodic' && nowMinutes === start) {
            await sendReminder(bot, user.telegramId, cl.title, cl.key);
          }

          if (nowMinutes === end) {
            const done = await hasCompletedOrMissedToday(user.id, cl.id, todayStart);
            if (!done) {
              await createMissedRun(user.id, cl.id);
            }
          }
        }

        if (CLOSING_REMINDER_TYPES.has(cl.type) && nowMinutes === (23 * 60 + 55)) {
          const done = await hasCompletedOrMissedToday(user.id, cl.id, todayStart);
          if (!done) {
            await sendReminder(bot, user.telegramId, cl.title, cl.key);
          }
        }

        continue;
      }

      if (cl.type === 'periodic' && cl.intervalHours) {
        const intervalMinutes = cl.intervalHours * 60;
        const elapsed = getMinutesSinceOperationalStart(nowMinutes, DEFAULT_SHIFT_START_MINUTES);
        const operatingDuration = getWindowDurationMinutes(
          DEFAULT_SHIFT_START_MINUTES,
          DEFAULT_SHIFT_END_MINUTES,
        );

        if (
          isWithinTimeWindow(nowMinutes, DEFAULT_SHIFT_START_MINUTES, DEFAULT_SHIFT_END_MINUTES) &&
          elapsed >= 0 &&
          elapsed < operatingDuration &&
          elapsed % intervalMinutes === 0
        ) {
          const done = await hasCompletedOrMissedToday(user.id, cl.id, todayStart);
          if (!done) {
            await sendReminder(bot, user.telegramId, cl.title, cl.key);
          }
        }

        if (nowMinutes === DEFAULT_SHIFT_END_MINUTES) {
          const done = await hasCompletedOrMissedToday(user.id, cl.id, todayStart);
          if (!done) {
            await createMissedRun(user.id, cl.id);
          }
        }
      }
    }
  }
}

/**
 * Удаляет файлы старше 30 дней из Google Drive папки GOOGLE_DRIVE_FOLDER_ID.
 * Рекурсивно: сначала файлы внутри подпапок, потом пустые подпапки.
 */
async function cleanupOldDriveFiles(): Promise<void> {
  const rootFolderId = process.env.GOOGLE_DRIVE_FOLDER_ID;
  if (!rootFolderId || process.env.ENABLE_GOOGLE_DRIVE !== 'true') return;

  const drive = await getDriveClient();
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 30);
  const cutoffISO = cutoff.toISOString();

  let totalDeleted = 0;
  let foldersDeleted = 0;

  // Получить все подпапки сотрудников
  const subfolders = await drive.files.list({
    q: `'${rootFolderId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
    fields: 'files(id, name)',
    spaces: 'drive',
    pageSize: 1000,
  });

  const folders = subfolders.data.files ?? [];

  for (const folder of folders) {
    if (!folder.id) continue;

    // Удалить старые файлы внутри подпапки
    let pageToken: string | undefined;
    do {
      const files = await drive.files.list({
        q: `'${folder.id}' in parents and mimeType != 'application/vnd.google-apps.folder' and trashed = false and createdTime < '${cutoffISO}'`,
        fields: 'nextPageToken, files(id, name)',
        spaces: 'drive',
        pageSize: 100,
        pageToken,
      });

      for (const file of files.data.files ?? []) {
        if (!file.id) continue;
        await drive.files.delete({ fileId: file.id });
        totalDeleted++;
      }

      pageToken = files.data.nextPageToken ?? undefined;
    } while (pageToken);

    // Проверить, осталась ли подпапка пустой
    const remaining = await drive.files.list({
      q: `'${folder.id}' in parents and trashed = false`,
      fields: 'files(id)',
      spaces: 'drive',
      pageSize: 1,
    });

    if (!remaining.data.files || remaining.data.files.length === 0) {
      await drive.files.delete({ fileId: folder.id });
      foldersDeleted++;
    }
  }

  // Удалить старые файлы в корне папки (не в подпапках)
  let pageToken: string | undefined;
  do {
    const files = await drive.files.list({
      q: `'${rootFolderId}' in parents and mimeType != 'application/vnd.google-apps.folder' and trashed = false and createdTime < '${cutoffISO}'`,
      fields: 'nextPageToken, files(id, name)',
      spaces: 'drive',
      pageSize: 100,
      pageToken,
    });

    for (const file of files.data.files ?? []) {
      if (!file.id) continue;
      await drive.files.delete({ fileId: file.id });
      totalDeleted++;
    }

    pageToken = files.data.nextPageToken ?? undefined;
  } while (pageToken);

  console.log(`[cleanup] Drive cleanup done: ${totalDeleted} files, ${foldersDeleted} empty folders deleted`);
}

export function startScheduler(bot: Telegraf<Context>): void {
  // Каждую минуту — расписание чек-листов
  cron.schedule('* * * * *', () => {
    processSchedule(bot).catch((error) => {
      console.error('[scheduler] Ошибка:', error);
    });
  });

  // Каждую ночь в 03:00 — очистка старых файлов на Google Drive
  cron.schedule('0 3 * * *', () => {
    cleanupOldDriveFiles().catch((error) => {
      console.error('[cleanup] Ошибка очистки Drive:', error);
    });
  });

  // Каждую минуту — докачка отложенных событий outbox
  cron.schedule('* * * * *', () => {
    processOutbox().catch((error) => {
      console.error('[outbox] Ошибка воркера:', error);
    });
  });

  console.log('⏰ Scheduler started');
}
