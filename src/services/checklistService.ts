import type { Checklist, User } from '@prisma/client';
import { prisma } from '../db/client.js';
import { config } from '../config/index.js';
import { enqueueOutbox } from './outboxService.js';
import { getBusinessDayBounds, getMinutesInTimeZone } from '../utils/businessTime.js';
import {
  formatMinutesToTime,
  isChecklistActiveAtMinutes,
  parseTimeToMinutes,
  parseTimeWindows,
} from '../utils/checklistTiming.js';

type ActiveChecklistsResult = {
  checklists: Checklist[];
  nextTimeText: string | null;
};

export async function getActiveChecklistsForUserNow(
  user: User,
  now: Date,
  overrides?: { role?: string; language?: string },
): Promise<ActiveChecklistsResult> {
  const role = overrides?.role ?? user.role;

  if (!role) {
    return { checklists: [], nextTimeText: null };
  }

  const language = overrides?.language ?? user.language ?? 'ru';

  const all = await prisma.checklist.findMany({
    where: {
      role,
      language,
      type: { not: 'archived' },
    },
    orderBy: [{ displayOrder: 'asc' }, { title: 'asc' }],
  });

  if (all.length === 0) {
    return { checklists: [], nextTimeText: null };
  }

  // В тестовом режиме показываем все чек-листы без фильтра по времени
  if (config.TEST_MODE) {
    const { start: todayStart } = getBusinessDayBounds(now);
    const completedRuns = await prisma.run.findMany({
      where: {
        userId: user.id,
        checklistId: { in: all.map((cl) => cl.id) },
        completedAt: { not: null, gte: todayStart },
      },
      select: { checklistId: true },
    });
    const completedChecklistIds = new Set(completedRuns.map((r) => r.checklistId));
    const notCompleted = all.filter((cl) => !completedChecklistIds.has(cl.id));
    return { checklists: notCompleted, nextTimeText: null };
  }

  const nowMinutes = getMinutesInTimeZone(now);

  const active: Checklist[] = [];

  for (const cl of all) {
    if (isChecklistActiveAtMinutes(cl, nowMinutes)) {
      active.push(cl);
    }
  }

  // Убираем чек-листы, которые пользователь уже завершил сегодня
  if (active.length > 0) {
    const { start: todayStart } = getBusinessDayBounds(now);

    const completedRuns = await prisma.run.findMany({
      where: {
        userId: user.id,
        checklistId: { in: active.map((cl) => cl.id) },
        completedAt: { not: null, gte: todayStart },
      },
      select: { checklistId: true },
    });

    const completedChecklistIds = new Set(completedRuns.map((r) => r.checklistId));
    const notCompleted = active.filter((cl) => !completedChecklistIds.has(cl.id));

    if (notCompleted.length > 0) {
      return { checklists: notCompleted, nextTimeText: null };
    }
    // Все доступные чек-листы уже пройдены — покажем "нет активных"
  }

  const futureStarts: number[] = [];

  for (const cl of all) {
    for (const window of parseTimeWindows(cl.timeWindows)) {
      const start = parseTimeToMinutes(window.start);
      if (start > nowMinutes) {
        futureStarts.push(start);
      }
    }
  }

  let nextTimeText: string | null = null;

  if (futureStarts.length > 0) {
    const next = Math.min(...futureStarts);
    nextTimeText = formatMinutesToTime(next);
  } else {
    const allStarts = all
      .flatMap((cl) => parseTimeWindows(cl.timeWindows))
      .map((window) => parseTimeToMinutes(window.start));

    if (allStarts.length > 0) {
      const earliestOpen = Math.min(...allStarts);
      nextTimeText = formatMinutesToTime(earliestOpen);
    }
  }

  return { checklists: [], nextTimeText };
}

/**
 * Вызывается после завершения чек-листа.
 * Загружает полные данные run + answers + questions и отправляет в Google Sheets.
 */
export async function onChecklistCompleted(runId: number): Promise<void> {
  const run = await prisma.run.findUnique({
    where: { id: runId },
    include: {
      checklist: true,
      answers: {
        include: { question: true },
        orderBy: { createdAt: 'asc' },
      },
    },
  });
  if (!run) return;

  const user = await prisma.user.findUnique({ where: { id: run.userId } });
  if (!user) return;

  // Ответы записываются в Sheets сразу после каждого фото (через outbox)
  // Здесь только смена и статистика для close чек-листов
  if (run.checklist.type === 'close') {
    const shift = await prisma.shift.findFirst({
      where: { userId: run.userId },
      orderBy: { id: 'desc' },
    });

    if (shift) {
      const endedAt = shift.endedAt ?? new Date();
      const diffMs = endedAt.getTime() - shift.startedAt.getTime();
      const hours = Math.round((diffMs / 3_600_000) * 10) / 10;
      const failCount = shift.failCount ?? 0;
      const displayName = user.displayName ?? user.firstName ?? 'Сотрудник';
      const role = user.role ?? '';
      const month = `${String(endedAt.getMonth() + 1).padStart(2, '0')}.${endedAt.getFullYear()}`;

      await enqueueOutbox(
        {
          type: 'shift_summary',
          payload: {
            location: user.location,
            displayName,
            role,
            startedAtIso: shift.startedAt.toISOString(),
            endedAtIso: endedAt.toISOString(),
            failCount,
          },
        },
        `shift:${shift.id}`,
      );

      await enqueueOutbox(
        {
          type: 'monthly_stats',
          payload: {
            location: user.location,
            displayName,
            role,
            hoursToAdd: hours,
            errorsToAdd: failCount,
            month,
          },
        },
        `monthly:${shift.id}`,
      );
    }
  }
}

