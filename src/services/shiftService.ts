import { prisma } from '../db/client.js';

interface CompletedRun {
  id: number;
  userId: number;
  checklistId: number;
  completedAt: Date | null;
  startedAt: Date;
  checklist: { type: string };
}

interface ShiftResult {
  shiftId: number;
  minutes: number;
  failCount: number;
}

const MAX_SHIFT_MINUTES = 16 * 60;

/**
 * Рассчитать и сохранить смену при завершении close чек-листа.
 *
 * Логика:
 * 1. Найти последний завершённый open-run без привязанной смены
 * 2. Начало смены = createdAt первого answer с aiRule="uniform_check" и aiVerdict="ok"
 * 3. Конец смены = closeRun.completedAt
 * 4. Посчитать minutes и failCount
 * 5. Создать Shift и привязать run-ы
 */
export async function calculateAndSaveShift(
  userId: number,
  closeRun: CompletedRun,
): Promise<ShiftResult> {
  const closeEndedAt = closeRun.completedAt ?? new Date();

  // 1. Найти последний завершённый open-run без привязки к смене
  const openRun = await prisma.run.findFirst({
    where: {
      userId,
      shiftId: null,
      completedAt: { not: null },
      checklist: { type: 'open' },
    },
    orderBy: { completedAt: 'desc' },
    include: {
      answers: {
        include: { question: true },
        orderBy: { createdAt: 'asc' },
      },
    },
  });

  let startedAt: Date;

  if (!openRun) {
    // Нет open-рана — безопасный дефолт
    console.warn(
      `[shiftService] No open run found for user ${userId}, using closeRun.startedAt as shift start`,
    );
    startedAt = closeRun.startedAt;
  } else {
    // 2. Приоритет: uniform_check ok → первый ответ в open → создание open
    const uniformOkAnswer = openRun.answers.find(
      (a) => a.question.aiRule === 'uniform_check' && a.aiVerdict === 'ok',
    );
    const firstAnswer = openRun.answers[0];
    startedAt = uniformOkAnswer?.createdAt ?? firstAnswer?.createdAt ?? openRun.startedAt;
  }

  // 4. Рассчитать минуты с кэпом MAX_SHIFT_MINUTES
  const diffMs = closeEndedAt.getTime() - startedAt.getTime();
  const rawMinutes = Math.max(0, Math.round(diffMs / 60_000));
  let minutes = rawMinutes;
  if (rawMinutes > MAX_SHIFT_MINUTES) {
    console.warn(
      `[shiftService] Smena длительность ${rawMinutes} мин (${(rawMinutes / 60).toFixed(1)}ч) превысила кэп ${MAX_SHIFT_MINUTES} мин — user=${userId}, openRun=${openRun?.id}, closeRun=${closeRun.id}. Капаю до ${MAX_SHIFT_MINUTES} мин.`,
    );
    minutes = MAX_SHIFT_MINUTES;
  }

  // 5. Собрать все run-ы смены (open + periodic + close) без привязки к смене
  const shiftRuns = await prisma.run.findMany({
    where: {
      userId,
      shiftId: null,
      completedAt: { not: null },
      startedAt: { gte: startedAt },
    },
    include: {
      answers: true,
    },
  });

  // Посчитать failCount по всем ответам (включая close run)
  let failCount = 0;
  for (const run of shiftRuns) {
    for (const answer of run.answers) {
      if (answer.aiVerdict === 'fail') {
        failCount++;
      }
    }
  }
  // Добавить fail из close run если он не вошёл в shiftRuns
  if (!shiftRuns.some((r) => r.id === closeRun.id)) {
    const closeAnswers = await prisma.answer.findMany({
      where: { runId: closeRun.id },
    });
    for (const answer of closeAnswers) {
      if (answer.aiVerdict === 'fail') {
        failCount++;
      }
    }
  }

  // 6. Создать Shift
  const shift = await prisma.shift.create({
    data: {
      userId,
      startedAt,
      endedAt: closeEndedAt,
      minutes,
      failCount,
    },
  });

  // 7. Привязать run-ы к смене
  const runIds = shiftRuns.map((r) => r.id);
  // Также включить close-run если он не в списке
  if (!runIds.includes(closeRun.id)) {
    runIds.push(closeRun.id);
  }

  await prisma.run.updateMany({
    where: { id: { in: runIds } },
    data: { shiftId: shift.id },
  });

  return { shiftId: shift.id, minutes, failCount };
}
