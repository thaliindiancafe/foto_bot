import { prisma } from '../db/client.js';

export type AnswerCheckResult = 'yes' | 'no' | 'skip';

/**
 * Сколько раз один пункт можно отложить через кнопку «⏸ Вернуться позже».
 * Установлено клиентом 2026-05-15 = 1. Лимит проверяется и в UI (скрытие
 * кнопки), и в `deferQuestion` (защита уровня сервиса).
 */
export const MAX_DEFER = 1;

function getAnswerWeights(weight: number, checkResult: AnswerCheckResult): {
  earnedWeight: number;
  possibleWeight: number;
} {
  if (checkResult === 'yes') {
    return { earnedWeight: weight, possibleWeight: weight };
  }

  if (checkResult === 'no') {
    return { earnedWeight: 0, possibleWeight: weight };
  }

  return { earnedWeight: 0, possibleWeight: 0 };
}

/**
 * Найти активный (незавершённый) run пользователя.
 * Активный = completedAt === null.
 */
export async function findActiveRun(userId: number) {
  return prisma.run.findFirst({
    where: {
      userId,
      completedAt: null,
    },
    include: {
      checklist: true,
      answers: { select: { questionId: true } },
    },
  });
}

/**
 * Создать новый run для пользователя по чек-листу.
 * Возвращает run вместе с отсортированными вопросами.
 */
export async function createRun(userId: number, checklistId: number) {
  const run = await prisma.run.create({
    data: { userId, checklistId },
    include: {
      checklist: {
        include: {
          questions: { orderBy: { order: 'asc' } },
        },
      },
    },
  });
  return run;
}

/**
 * Получить следующий неотвеченный вопрос для run (фаза 1, основной обход).
 *
 * Логика приоритета:
 *  1. Pending-`Answer` (фото загружено, ждёт оценки) — высший приоритет.
 *  2. Первый вопрос без финального `checkResult` **и** без откладывания
 *     (`deferCount === 0` или записи вообще нет).
 *
 * Отложенные пункты (`deferCount > 0` и `checkResult == null`) намеренно
 * исключаются из этой фазы — они показываются в финальном меню через
 * `getDeferredQuestions`, см. `creative-defer-button.md` §4.2.
 *
 * Возвращает `null` когда обычные пункты закончились. Caller должен в
 * этой ситуации вызвать `getDeferredQuestions(runId)`: если он непустой —
 * рендерить меню отложенных, иначе — `completeRun`.
 */
export async function getNextQuestion(runId: number) {
  const run = await prisma.run.findUnique({
    where: { id: runId },
    include: {
      checklist: {
        include: {
          questions: { orderBy: { order: 'asc' } },
        },
      },
      answers: {
        select: {
          id: true,
          questionId: true,
          checkResult: true,
          value: true,
          deferCount: true,
        },
        orderBy: { createdAt: 'asc' },
      },
    },
  });

  if (!run) return null;

  const questions = run.checklist.questions;
  const pendingAnswer = run.answers.find(
    (answer) => answer.checkResult == null && answer.value !== '',
  );
  if (pendingAnswer) {
    const pendingQuestion = questions.find((question) => question.id === pendingAnswer.questionId);
    if (!pendingQuestion) return null;

    return {
      question: pendingQuestion,
      questionNumber: questions.findIndex((question) => question.id === pendingQuestion.id) + 1,
      totalQuestions: questions.length,
      pendingAnswer: {
        id: pendingAnswer.id,
        value: pendingAnswer.value,
      },
    };
  }

  const answeredIds = new Set(
    run.answers
      .filter((answer) => answer.checkResult != null)
      .map((answer) => answer.questionId),
  );
  const deferredIds = new Set(
    run.answers
      .filter((answer) => answer.checkResult == null && answer.deferCount > 0)
      .map((answer) => answer.questionId),
  );

  const next = questions.find((q) => !answeredIds.has(q.id) && !deferredIds.has(q.id));

  if (!next) return null;

  const questionNumber = questions.findIndex((q) => q.id === next.id) + 1;

  return {
    question: next,
    questionNumber,
    totalQuestions: questions.length,
  };
}

/**
 * Получить отложенные пункты run для финального меню.
 *
 * Отложенный = `Answer` с `deferCount > 0` и без финального `checkResult`.
 * Сортировка по `Question.order` — менеджеру привычен порядок «пути по
 * ресторану». Возвращает пустой массив, если отложенных нет.
 */
export async function getDeferredQuestions(runId: number): Promise<
  {
    question: {
      id: number;
      text: string;
      taskType: string;
      section: string | null;
    };
    questionNumber: number;
    totalQuestions: number;
    deferCount: number;
    firstDeferredAt: Date | null;
  }[]
> {
  const run = await prisma.run.findUnique({
    where: { id: runId },
    include: {
      checklist: {
        include: {
          questions: { orderBy: { order: 'asc' } },
        },
      },
      answers: {
        select: {
          id: true,
          questionId: true,
          checkResult: true,
          deferCount: true,
          firstDeferredAt: true,
        },
      },
    },
  });

  if (!run) return [];

  const questions = run.checklist.questions;
  const totalQuestions = questions.length;

  const deferredAnswers = run.answers.filter(
    (answer) => answer.checkResult == null && answer.deferCount > 0,
  );

  const items: Awaited<ReturnType<typeof getDeferredQuestions>> = [];
  for (const answer of deferredAnswers) {
    const idx = questions.findIndex((q) => q.id === answer.questionId);
    if (idx === -1) continue; // вопрос мог быть удалён через /reload
    const question = questions[idx];
    items.push({
      question: {
        id: question.id,
        text: question.text,
        taskType: question.taskType,
        section: question.section,
      },
      questionNumber: idx + 1,
      totalQuestions,
      deferCount: answer.deferCount,
      firstDeferredAt: answer.firstDeferredAt,
    });
  }

  items.sort((a, b) => a.questionNumber - b.questionNumber);
  return items;
}

/**
 * Получить пункт по questionId, чтобы показать его как обычный вопрос
 * после нажатия `🔄` в финальном меню. Возвращает структуру в том же
 * формате, что и `getNextQuestion`, плюс информацию об откладывании.
 */
export async function getQuestionByIdForRun(
  runId: number,
  questionId: number,
): Promise<
  | (NonNullable<Awaited<ReturnType<typeof getNextQuestion>>> & {
      deferCount: number;
    })
  | null
> {
  const run = await prisma.run.findUnique({
    where: { id: runId },
    include: {
      checklist: {
        include: {
          questions: { orderBy: { order: 'asc' } },
        },
      },
      answers: {
        where: { questionId },
        select: {
          id: true,
          value: true,
          checkResult: true,
          deferCount: true,
        },
      },
    },
  });

  if (!run) return null;

  const idx = run.checklist.questions.findIndex((q) => q.id === questionId);
  if (idx === -1) return null;
  const question = run.checklist.questions[idx];

  const pending = run.answers.find((a) => a.checkResult == null && a.value !== '');
  const deferred = run.answers.find((a) => a.checkResult == null && a.deferCount > 0);

  return {
    question,
    questionNumber: idx + 1,
    totalQuestions: run.checklist.questions.length,
    pendingAnswer: pending ? { id: pending.id, value: pending.value } : undefined,
    deferCount: deferred?.deferCount ?? 0,
  };
}

/**
 * Пометить пункт как отложенный («⏸ Вернуться к пункту позже»).
 *
 * Правила:
 *  - Если у пункта есть pending-`Answer` (фото загружено, AI не ответил) —
 *    `'pending_photo'`. UI и так скрывает кнопку, это страховка.
 *  - Если `deferCount >= MAX_DEFER` — `'limit_reached'`.
 *  - Если записи `Answer` нет — создаём «пустую» (`value=''`, `checkResult=null`)
 *    с `deferCount=1`, `firstDeferredAt=now`.
 *  - Если запись есть с `deferCount=0` и `checkResult=null` — обновляем.
 *
 * После defer пункт пропадает из `getNextQuestion` и попадает в
 * `getDeferredQuestions`. Финальный ответ потом запишется в эту же запись
 * через `finalizeAnswer` / `skipQuestion` (skip создаёт новую запись, см.
 * `runService.skipQuestion` — это OK, defer-запись останется как «след»
 * откладывания для аналитики).
 */
export async function deferQuestion(
  runId: number,
  questionId: number,
): Promise<
  | { ok: true; deferCount: number }
  | { ok: false; reason: 'pending_photo' | 'limit_reached' | 'already_finalized' }
> {
  const existing = await prisma.answer.findFirst({
    where: { runId, questionId },
    orderBy: { createdAt: 'desc' },
  });

  if (existing && existing.checkResult != null) {
    return { ok: false, reason: 'already_finalized' };
  }

  if (existing && existing.checkResult == null && existing.value !== '') {
    return { ok: false, reason: 'pending_photo' };
  }

  if (existing && existing.deferCount >= MAX_DEFER) {
    return { ok: false, reason: 'limit_reached' };
  }

  const now = new Date();

  if (existing) {
    await prisma.answer.update({
      where: { id: existing.id },
      data: {
        deferCount: existing.deferCount + 1,
        firstDeferredAt: existing.firstDeferredAt ?? now,
        lastDeferredAt: now,
      },
    });
    return { ok: true, deferCount: existing.deferCount + 1 };
  }

  await prisma.answer.create({
    data: {
      runId,
      questionId,
      value: '',
      checkResult: null,
      deferCount: 1,
      firstDeferredAt: now,
      lastDeferredAt: now,
    },
  });
  return { ok: true, deferCount: 1 };
}

/**
 * Сохранить ответ (фото) на вопрос.
 * value — путь к файлу в локальном хранилище.
 *
 * Если у пункта есть placeholder-запись от defer (`value=''`,
 * `checkResult=null`, `deferCount>0`) — обновляем её, чтобы не плодить
 * дубли. Иначе создаём новую запись.
 */
export async function saveAnswer(
  runId: number,
  questionId: number,
  value: string,
  aiVerdict?: string,
  aiReason?: string,
  aiConfidence?: number,
  photoHash?: string,
) {
  const placeholder = await prisma.answer.findFirst({
    where: { runId, questionId, checkResult: null, value: '' },
    orderBy: { createdAt: 'desc' },
  });

  if (placeholder) {
    return prisma.answer.update({
      where: { id: placeholder.id },
      data: {
        value,
        aiVerdict: aiVerdict ?? null,
        aiReason: aiReason ?? null,
        aiConfidence: aiConfidence ?? null,
        photoHash: photoHash ?? null,
      },
    });
  }

  return prisma.answer.create({
    data: {
      runId,
      questionId,
      value,
      checkResult: null,
      earnedWeight: null,
      possibleWeight: null,
      aiVerdict: aiVerdict ?? null,
      aiReason: aiReason ?? null,
      aiConfidence: aiConfidence ?? null,
      photoHash: photoHash ?? null,
    },
  });
}

export async function recordManualAnswer(
  runId: number,
  questionId: number,
  checkResult: AnswerCheckResult,
) {
  const question = await prisma.question.findUnique({
    where: { id: questionId },
  });

  if (!question) {
    return null;
  }

  const { earnedWeight, possibleWeight } = getAnswerWeights(question.weight, checkResult);
  const shouldCreateViolation = checkResult === 'no' && question.createViolationOnNo;

  return prisma.$transaction(async (tx) => {
    // Если есть placeholder от defer — обновляем его, иначе создаём новый.
    const placeholder = await tx.answer.findFirst({
      where: { runId, questionId, checkResult: null, value: '' },
      orderBy: { createdAt: 'desc' },
    });

    const createdAnswer = placeholder
      ? await tx.answer.update({
          where: { id: placeholder.id },
          data: { checkResult, earnedWeight, possibleWeight },
          include: {
            question: true,
            run: { include: { checklist: true } },
          },
        })
      : await tx.answer.create({
          data: { runId, questionId, value: '', checkResult, earnedWeight, possibleWeight },
          include: {
            question: true,
            run: { include: { checklist: true } },
          },
        });

    if (shouldCreateViolation) {
      await tx.violation.upsert({
        where: { answerId: createdAnswer.id },
        update: { status: 'open', resolvedAt: null },
        create: {
          answerId: createdAnswer.id,
          runId,
          questionId,
        },
      });
    }

    return createdAnswer;
  });
}

export async function skipQuestion(
  runId: number,
  questionId: number,
  skipComment?: string | null,
) {
  // Если есть placeholder от defer — обновляем его, иначе создаём новый.
  // Так placeholder не остаётся «висеть» в getDeferredQuestions после skip.
  const placeholder = await prisma.answer.findFirst({
    where: { runId, questionId, checkResult: null, value: '' },
    orderBy: { createdAt: 'desc' },
  });

  if (placeholder) {
    return prisma.answer.update({
      where: { id: placeholder.id },
      data: {
        checkResult: 'skip',
        earnedWeight: 0,
        possibleWeight: 0,
        skipComment: skipComment?.trim() || null,
      },
    });
  }

  return prisma.answer.create({
    data: {
      runId,
      questionId,
      value: '',
      checkResult: 'skip',
      earnedWeight: 0,
      possibleWeight: 0,
      skipComment: skipComment?.trim() || null,
    },
  });
}

export async function finalizeAnswer(answerId: number, checkResult: AnswerCheckResult) {
  const answer = await prisma.answer.findUnique({
    where: { id: answerId },
    include: {
      question: true,
    },
  });

  if (!answer) {
    return null;
  }

  const { earnedWeight, possibleWeight } = getAnswerWeights(answer.question.weight, checkResult);
  const shouldCreateViolation = checkResult === 'no' && answer.question.createViolationOnNo;

  return prisma.$transaction(async (tx) => {
    const updatedAnswer = await tx.answer.update({
      where: { id: answerId },
      data: {
        checkResult,
        earnedWeight,
        possibleWeight,
      },
      include: {
        question: true,
        run: {
          include: {
            checklist: true,
          },
        },
      },
    });

    if (shouldCreateViolation) {
      await tx.violation.upsert({
        where: { answerId },
        update: {
          status: 'open',
          resolvedAt: null,
        },
        create: {
          answerId,
          runId: updatedAnswer.runId,
          questionId: updatedAnswer.questionId,
        },
      });
    } else {
      await tx.violation.deleteMany({
        where: { answerId },
      });
    }

    return updatedAnswer;
  });
}

export async function deleteAnswer(answerId: number) {
  await prisma.answer.delete({
    where: { id: answerId },
  });
}

export async function updateRunMetrics(runId: number) {
  const run = await prisma.run.findUnique({
    where: { id: runId },
    include: {
      checklist: true,
      answers: {
        include: { question: true },
        orderBy: { createdAt: 'asc' },
      },
      violations: true,
    },
  });

  if (!run) {
    return null;
  }

  let earnedWeight = 0;
  let possibleWeight = 0;

  for (const answer of run.answers) {
    earnedWeight += answer.earnedWeight ?? 0;
    possibleWeight += answer.possibleWeight ?? 0;
  }

  const scorePercent =
    possibleWeight > 0 ? Math.round((earnedWeight / possibleWeight) * 1000) / 10 : null;
  const hasDeviation = scorePercent != null && scorePercent < 90;
  const violationCount = run.violations.length;

  const updatedRun = await prisma.run.update({
    where: { id: runId },
    data: {
      earnedWeight,
      possibleWeight,
      scorePercent,
      hasDeviation,
      violationCount,
    },
    include: {
      checklist: true,
      answers: true,
      violations: true,
    },
  });

  const sectionMap = new Map<string, { earnedWeight: number; possibleWeight: number }>();
  for (const answer of run.answers) {
    const sectionName = answer.question.section ?? 'Без раздела';
    const section = sectionMap.get(sectionName) ?? { earnedWeight: 0, possibleWeight: 0 };
    section.earnedWeight += answer.earnedWeight ?? 0;
    section.possibleWeight += answer.possibleWeight ?? 0;
    sectionMap.set(sectionName, section);
  }

  const sections = [...sectionMap.entries()].map(([name, section]) => ({
    name,
    earnedWeight: section.earnedWeight,
    possibleWeight: section.possibleWeight,
    scorePercent:
      section.possibleWeight > 0
        ? Math.round((section.earnedWeight / section.possibleWeight) * 1000) / 10
        : null,
  }));

  return {
    run: updatedRun,
    sections,
  };
}

/**
 * Завершить run (установить completedAt).
 */
export async function completeRun(runId: number) {
  return prisma.run.update({
    where: { id: runId },
    data: { completedAt: new Date() },
    include: {
      checklist: true,
      answers: true,
    },
  });
}
