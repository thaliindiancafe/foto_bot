import { Telegraf, Markup, Input } from 'telegraf';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { Context } from 'telegraf';
import { config, isAdmin } from '../config/index.js';
import {
  addUserRole,
  ensureUserFromContext,
  getUserRoles,
  resolveLocationForRole,
  switchActiveRole,
  upsertRegisteredUser,
} from '../services/userService.js';
import {
  type LanguageCode,
  type RoleKey,
  roles,
  allLanguages,
  activeLanguages,
  findRoleByLabel,
  findRoleByKey,
  getLanguageConfig,
  getLanguagesForRole,
  getMenuButtonKey,
  getRolesForLanguage,
  t,
} from '../config/roles.js';
import { translate } from '../services/translationService.js';
import { prisma } from '../db/client.js';
import { getActiveChecklistsForUserNow } from '../services/checklistService.js';
import {
  type AnswerCheckResult,
  findActiveRun,
  createRun,
  getNextQuestion,
  getDeferredQuestions,
  getQuestionByIdForRun,
  deferQuestion,
  MAX_DEFER,
  recordManualAnswer,
  saveAnswer,
  skipQuestion,
  finalizeAnswer,
  deleteAnswer,
  updateRunMetrics,
  completeRun,
} from '../services/runService.js';
import { downloadTelegramFile } from '../utils/downloadFile.js';
import { validateImage } from '../utils/validateImage.js';
import { applyWatermark } from '../utils/watermark.js';
import { uploadPhoto } from '../services/storage.js';
import {
  resolvePhotoCheckRule,
  shouldRunPhotoAi,
  splitQuestionText,
  verifyPhoto,
} from '../services/aiService.js';
import { calculateAndSaveShift } from '../services/shiftService.js';
import { computePhotoHash, hammingDistance, DUPLICATE_THRESHOLD } from '../utils/photoHash.js';
import { syncChecklists } from '../db/seed.js';
import {
  // syncBaristaChecklistsFromGoogleSheet — отключено 2026-05-22:
  // бариста переехал в главную таблицу (см. SHEET_MAPPING). Функция оставлена
  // в sheetSyncService.ts на случай возврата к Тхали-таблице.
  syncChecklistsFromGoogleSheet,
  syncHelperChecklistsFromGoogleSheet,
  syncHostessChecklistsFromGoogleSheet,
} from '../services/sheetSyncService.js';
import {
  BATCH_TARGET_LANGS,
  translateMissingChecklistsToAllLanguages,
} from '../services/checklistTranslationService.js';
import { rateLimitMiddleware } from './rateLimit.js';
import { registerChecklistAdmin, sendChecklistList } from './adminChecklists.js';
import { onChecklistCompleted } from '../services/checklistService.js';
import { enqueueOutbox } from '../services/outboxService.js';
import { getBusinessDayBounds } from '../utils/businessTime.js';

// --- Типы FSM ---

type RegistrationStep = 'awaiting_language' | 'awaiting_name' | 'awaiting_role';

type RegistrationMode = 'register' | 'add_role';

type RegistrationState = {
  step: RegistrationStep;
  mode: RegistrationMode;
  tempName?: string;
  tempLanguage?: LanguageCode;
  tempRole?: RoleKey;
  existingUserId?: number;
};

const registrationState = new Map<number, RegistrationState>();

type SkipCommentState = {
  runId: number;
  questionId: number;
};

const skipCommentState = new Map<number, SkipCommentState>();

export const bot = new Telegraf(config.BOT_TOKEN);

import { whitelistMiddleware } from './whitelist.js';
import { i18nMiddleware, invalidateLanguageCache } from './i18nMiddleware.js';
bot.use(whitelistMiddleware);
bot.use(rateLimitMiddleware);
bot.use(i18nMiddleware);

function isExpiredCallbackQueryError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }

  const response = 'response' in error ? (error as { response?: { description?: string } }).response : undefined;
  const description = response?.description?.toLowerCase() ?? '';

  return (
    description.includes('query is too old') ||
    description.includes('query id is invalid') ||
    description.includes('response timeout expired')
  );
}

bot.catch((error, ctx) => {
  if (isExpiredCallbackQueryError(error)) {
    console.warn('[telegram callback expired]', ctx.update.update_id);
    return;
  }

  console.error('[bot error]', error);
});

// --- Вспомогательные функции ---

async function sendMainMenu(ctx: Context, subtitle?: string) {
  const user = await getRegisteredUser(ctx);
  // Рендерим клавиатуру сразу на языке пользователя через статические t()-строки —
  // так не зависим от LLM-переводов и кнопки на клавиатуре совпадают с тем, что
  // ищет текстовый хендлер через getMenuButtonKey().
  const lang: LanguageCode = (user?.language as LanguageCode | undefined) ?? 'ru';
  const buttons = user
    ? [[t(lang, 'start_button'), t(lang, 'main_menu_button'), t(lang, 'switch_role_btn_plain')]]
    : [[t(lang, 'register_button')]];

  const replyKeyboard = Markup.keyboard(buttons)
    .resize()
    .oneTime(false);

  const text = subtitle ? `${subtitle}` : 'Главное меню:';
  await ctx.reply(text, replyKeyboard);
}

async function sendAdminMenu(ctx: Context) {
  await ctx.reply(
    '⚙️ Панель управления',
    Markup.inlineKeyboard([
      [
        Markup.button.callback('📋 Чек-листы', 'adm:checklists'),
        Markup.button.callback('📥 Обновить из таблицы', 'adm:sheet_sync'),
      ],
      [
        Markup.button.callback('🔄 Перезагрузить чек-листы', 'adm:reload'),
        Markup.button.callback('📊 Статус бота', 'adm:status'),
      ],
      [
        Markup.button.callback('🎭 Сменить роль', 'role:menu'),
      ],
      [
        Markup.button.callback('🔍 Мой аккаунт', 'adm:debug_me'),
        Markup.button.callback('📖 Список команд', 'adm:help'),
      ],
    ]),
  );
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Парсер `sheetSyncService` склеивает короткий пункт (колонка B) и подробное
 * описание (колонка G/F) через разделитель `\n\n`. В UI бота это нужно показать
 * как два разных блока: пункт — жирным, описание — курсивом со значком ℹ️.
 */
function splitTitleAndDescription(text: string): { title: string; description: string | null } {
  const idx = text.indexOf('\n\n');
  if (idx === -1) return { title: text, description: null };
  const title = text.slice(0, idx).trim();
  const description = text.slice(idx + 2).trim();
  return { title, description: description.length > 0 ? description : null };
}

/** Не даём одному вопросу раздуть HTML-сообщение выше лимита Telegram (~4096). */
const QUESTION_TITLE_MAX = 900;
const QUESTION_DESCRIPTION_MAX = 2800;

function capQuestionRawText(text: string): string {
  const { title, description } = splitTitleAndDescription(text);
  let t = title;
  let d = description;
  if (t.length > QUESTION_TITLE_MAX) {
    t = `${t.slice(0, QUESTION_TITLE_MAX - 1)}…`;
  }
  if (d != null && d.length > QUESTION_DESCRIPTION_MAX) {
    d = `${d.slice(0, QUESTION_DESCRIPTION_MAX - 1)}…`;
  }
  return d != null ? `${t}\n\n${d}` : t;
}

function formatQuestionMessage(
  checklistTitle: string,
  questionNumber: number,
  totalQuestions: number,
  questionText: string,
  taskType?: string | null,
  section?: string | null,
): string {
  const lines = [
    `📋 <b>${escapeHtml(checklistTitle)}</b>`,
    `Вопрос <b>${questionNumber}</b> из <b>${totalQuestions}</b>`,
  ];

  if (section) {
    lines.push(`<i>Раздел: ${escapeHtml(section)}</i>`);
  }

  const { title, description } = splitTitleAndDescription(capQuestionRawText(questionText));
  lines.push('', `<b>${escapeHtml(title)}</b>`, '');
  if (description) {
    lines.push(`ℹ️ <i>${escapeHtml(description)}</i>`, '');
  }

  if (taskType === 'confirm') {
    lines.push('Выберите ответ кнопками ниже: <b>✔️ Да</b> или <b>✖️ Нет</b>.');
  } else if (taskType === 'confirm_photo') {
    lines.push(
      '📸 <b>Отправьте фото</b>.',
      'После загрузки фото выберите: <b>✔️ Да</b> или <b>✖️ Нет</b>.',
    );
  } else {
    lines.push('📸 <b>Отправьте фото</b>.');
  }

  lines.push(
    '<i>Если пункт сейчас невыполним — нажмите «Пропустить пункт» и кратко опишите причину.</i>',
  );

  return lines.join('\n');
}

function formatPendingEvaluationMessage(
  checklistTitle: string,
  questionNumber: number,
  totalQuestions: number,
  questionText: string,
): string {
  const { title, description } = splitTitleAndDescription(capQuestionRawText(questionText));
  const lines = [
    `📋 <b>${escapeHtml(checklistTitle)}</b>`,
    `Вопрос <b>${questionNumber}</b> из <b>${totalQuestions}</b>`,
    '',
    `<b>${escapeHtml(title)}</b>`,
    '',
  ];
  if (description) {
    lines.push(`ℹ️ <i>${escapeHtml(description)}</i>`, '');
  }
  lines.push(
    'ℹ️ По уже загруженному фото выберите: <b>✔️ Да</b> или <b>✖️ Нет</b> — кнопки ниже.',
    '',
    '<i>Если пункт сейчас невыполним — «Пропустить пункт» и краткий комментарий.</i>',
  );
  return lines.join('\n');
}

/** Может ли роль использовать кнопку «⏸ Вернуться к пункту позже». */
function canRoleDefer(role: string | null | undefined): boolean {
  return role === 'manager';
}

/**
 * Универсальный «подвал» под клавиатурой вопроса: «⏭ Пропустить пункт»
 * (всегда) и опционально «⏸ Вернуться позже» (только менеджер и только
 * если лимит откладывания не исчерпан). См. `creative-defer-button.md` §4.4.
 */
function questionFooterRows(
  runId: number,
  questionId: number,
  options: { canDefer: boolean; deferCount: number; isPending: boolean },
): ReturnType<typeof Markup.button.callback>[][] {
  const rows: ReturnType<typeof Markup.button.callback>[][] = [];

  // «⏸» прячем когда: роль не та, или лимит исчерпан, или сейчас идёт
  // AI-проверка фото (pending) — иначе мы оторвём фото от ответа.
  const showDefer = options.canDefer && options.deferCount < MAX_DEFER && !options.isPending;
  if (showDefer) {
    rows.push([
      Markup.button.callback('⏸ Вернуться позже', `answer:defer:${runId}:${questionId}`),
    ]);
  }

  rows.push([Markup.button.callback('⏭ Пропустить пункт', `answer:skip:${runId}:${questionId}`)]);
  return rows;
}

function buildQuestionKeyboard(
  runId: number,
  questionId: number,
  taskType: string | null | undefined,
  footerOptions: { canDefer: boolean; deferCount: number; isPending: boolean },
) {
  const rows: ReturnType<typeof Markup.button.callback>[][] = [];

  if (taskType === 'confirm') {
    rows.push(
      [
        Markup.button.callback('✔️ Да', `answer:confirm:${runId}:${questionId}:yes`),
        Markup.button.callback('✖️ Нет', `answer:confirm:${runId}:${questionId}:no`),
      ],
    );
  }

  for (const row of questionFooterRows(runId, questionId, footerOptions)) {
    rows.push(row);
  }
  return Markup.inlineKeyboard(rows);
}

function buildEvaluationKeyboard(
  runId: number,
  questionId: number,
  answerId: number,
  footerOptions: { canDefer: boolean; deferCount: number; isPending: boolean },
) {
  const rows: ReturnType<typeof Markup.button.callback>[][] = [
    [
      Markup.button.callback('✔️ Да', `answer:result:${answerId}:yes`),
      Markup.button.callback('✖️ Нет', `answer:result:${answerId}:no`),
    ],
    [Markup.button.callback('🔄 Переснять фото', `answer:result:${answerId}:retake`)],
  ];
  for (const row of questionFooterRows(runId, questionId, footerOptions)) {
    rows.push(row);
  }
  return Markup.inlineKeyboard(rows);
}

/**
 * Подсчитать `footerOptions` для текущего вопроса с одним запросом в БД.
 * Используется в кейсах «фото отклонено / дубликат / AI fail» — там нет
 * pending answer-а в момент отрисовки следующей подсказки.
 */
async function questionFooterRowsFor(
  runId: number,
  questionId: number,
  role: string | null | undefined,
): Promise<ReturnType<typeof Markup.button.callback>[][]> {
  const canDefer = canRoleDefer(role);
  if (!canDefer) {
    return questionFooterRows(runId, questionId, {
      canDefer: false,
      deferCount: 0,
      isPending: false,
    });
  }

  const last = await prisma.answer.findFirst({
    where: { runId, questionId },
    orderBy: { createdAt: 'desc' },
    select: { deferCount: true },
  });
  return questionFooterRows(runId, questionId, {
    canDefer: true,
    deferCount: last?.deferCount ?? 0,
    isPending: false,
  });
}

async function beginSkipWithComment(
  ctx: Context,
  user: NonNullable<Awaited<ReturnType<typeof getRegisteredUser>>>,
  runId: number,
  questionId: number,
): Promise<boolean> {
  const activeRun = await findActiveRun(user.id);
  if (!activeRun || activeRun.id !== runId) {
    await ctx.reply('Эта кнопка уже неактуальна.');
    return false;
  }

  const nextQ = await getNextQuestion(activeRun.id);
  if (!nextQ || nextQ.question.id !== questionId) {
    await ctx.reply('Эта кнопка уже неактуальна.');
    return false;
  }

  const from = ctx.from;
  if (!from) return false;

  const pending = await prisma.answer.findFirst({
    where: { runId, questionId, checkResult: null },
  });
  if (pending) {
    await deleteAnswer(pending.id);
  }

  skipCommentState.set(from.id, { runId, questionId });
  await ctx.reply(
    [
      '⏭ <b>Пропуск пункта</b>',
      '',
      'Напишите одним сообщением, почему пропускаете этот пункт.',
      '<i>Комментарий обязателен — минимум 5 символов</i>',
      '<i>(например: «нет ключей от склада», «техническая поломка», «нет товара»).</i>',
    ].join('\n'),
    { parse_mode: 'HTML' },
  );
  return true;
}

/** Минимальная длина обязательного комментария при пропуске пункта. */
const MIN_SKIP_COMMENT_LENGTH = 5;

async function completeSkipWithComment(
  ctx: Context,
  user: NonNullable<Awaited<ReturnType<typeof getRegisteredUser>>>,
  state: SkipCommentState,
  rawComment: string,
): Promise<void> {
  const activeRun = await findActiveRun(user.id);
  if (!activeRun || activeRun.id !== state.runId) {
    skipCommentState.delete(ctx.from!.id);
    await ctx.reply('Чек-лист уже не активен.');
    return;
  }

  const nextQ = await getNextQuestion(activeRun.id);
  if (!nextQ || nextQ.question.id !== state.questionId) {
    skipCommentState.delete(ctx.from!.id);
    await ctx.reply('Этот пункт уже пройден.');
    return;
  }

  const trimmed = rawComment.trim();
  // Совместимость: старые подсказки разрешали «—» как «без комментария».
  // Теперь комментарий обязателен — отклоняем плейсхолдеры и слишком
  // короткие тексты. См. `creative-defer-button.md` §4.5.
  const placeholderRegex = /^[—\-–_.,;:?!\s]*$/u;
  if (placeholderRegex.test(trimmed) || trimmed.length < MIN_SKIP_COMMENT_LENGTH) {
    await ctx.reply(
      [
        '⚠️ Нужен реальный комментарий — минимум 5 символов.',
        'Опишите кратко причину пропуска (например: «нет ключей от склада»).',
      ].join('\n'),
    );
    return;
  }
  const skipComment = trimmed;

  await skipQuestion(activeRun.id, state.questionId, skipComment);
  const deferMeta = await readDeferMeta(activeRun.id, state.questionId, 'skip');

  enqueueAnswerEvent({
    user,
    run: activeRun,
    question: nextQ.question,
    photoUrl: '',
    checkResult: 'skip',
    earnedWeight: 0,
    possibleWeight: 0,
    isViolation: false,
    skipComment,
    ...deferMeta,
  });

  skipCommentState.delete(ctx.from!.id);

  await ctx.reply(
    [
      `⏭ Пункт пропущен (${nextQ.questionNumber}/${nextQ.totalQuestions})`,
      `<i>Комментарий: ${escapeHtml(skipComment)}</i>`,
    ].join('\n'),
    { parse_mode: 'HTML' },
  );
  await sendCurrentQuestion(ctx, activeRun.id);
}

function formatCheckResult(checkResult: string | null | undefined): string {
  switch (checkResult) {
    case 'yes':
      return 'Да';
    case 'no':
      return 'Нет';
    case 'skip':
      return 'Пропуск';
    default:
      return '—';
  }
}

type AnswerOutboxContext = {
  user: {
    location: string | null;
    displayName: string | null;
    firstName: string | null;
    username: string | null;
    role: string | null;
  };
  run: {
    id: number;
    checklist: { title: string };
    startedAt: Date;
  };
  question: {
    id: number;
    text: string;
    taskType: string | null;
    weight: number;
    section: string | null;
  };
  photoUrl: string;
  aiVerdict?: string;
  aiReason?: string;
  checkResult: AnswerCheckResult;
  earnedWeight: number;
  possibleWeight: number;
  isViolation: boolean;
  skipComment?: string | null;
  deferCount?: number;
  firstDeferredAtIso?: string | null;
  deferStatus?: 'deferred_done' | 'deferred_skipped' | null;
};

function enqueueAnswerEvent(context: AnswerOutboxContext) {
  enqueueOutbox(
    {
      type: 'answer',
      payload: {
        location: context.user.location,
        displayName: context.user.displayName ?? context.user.firstName ?? 'Сотрудник',
        username: context.user.username,
        role: context.user.role ?? '',
        checklistTitle: context.run.checklist.title,
        questionText: context.question.text,
        taskType: context.question.taskType ?? 'photo',
        questionSection: context.question.section,
        questionWeight: context.question.weight,
        photoUrl: context.photoUrl,
        aiVerdict: context.aiVerdict,
        aiReason: context.aiReason,
        checkResult: context.checkResult,
        earnedWeight: context.earnedWeight,
        possibleWeight: context.possibleWeight,
        isViolation: context.isViolation,
        skipComment: context.skipComment ?? null,
        deferCount: context.deferCount ?? 0,
        firstDeferredAtIso: context.firstDeferredAtIso ?? null,
        deferStatus: context.deferStatus ?? null,
        runStartedAtIso: context.run.startedAt.toISOString(),
        answeredAtIso: new Date().toISOString(),
      },
    },
    `answer:${context.run.id}:${context.question.id}`,
  ).catch((err) => console.error('[outbox enqueue error]', err));
}

/**
 * Прочитать defer-метрики последнего `Answer` пункта, чтобы прокинуть
 * их в Google Sheets (`appendSingleAnswer`). Возвращает значения по
 * умолчанию, если пункт не откладывали.
 */
async function readDeferMeta(
  runId: number,
  questionId: number,
  checkResult: AnswerCheckResult,
): Promise<{
  deferCount: number;
  firstDeferredAtIso: string | null;
  deferStatus: 'deferred_done' | 'deferred_skipped' | null;
}> {
  const answer = await prisma.answer.findFirst({
    where: { runId, questionId },
    orderBy: { createdAt: 'desc' },
    select: { deferCount: true, firstDeferredAt: true },
  });
  const deferCount = answer?.deferCount ?? 0;
  if (deferCount === 0) {
    return { deferCount: 0, firstDeferredAtIso: null, deferStatus: null };
  }
  return {
    deferCount,
    firstDeferredAtIso: answer?.firstDeferredAt?.toISOString() ?? null,
    deferStatus: checkResult === 'skip' ? 'deferred_skipped' : 'deferred_done',
  };
}

/**
 * Завершить run, рассчитать смену (если close), записать в Sheets и
 * отправить шорт-лист сотруднику + в чат менеджеров. Вынесено из
 * `sendCurrentQuestion`, чтобы переиспользовать после прохождения
 * последнего отложенного пункта в финальном меню.
 */
async function completeRunAndSendSummary(ctx: Context, runId: number): Promise<void> {
  const completedBase = await completeRun(runId);
  const scoring = await updateRunMetrics(runId);
  const completed = scoring?.run ?? completedBase;
  const answersCount = completed.answers.length;

  let shiftInfo = '';

  if (completed.checklist.type === 'close') {
    try {
      const shiftResult = await calculateAndSaveShift(
        completed.userId,
        completed,
      );
      const hours = Math.floor(shiftResult.minutes / 60);
      const mins = shiftResult.minutes % 60;
      shiftInfo = `\nСмена: ${hours}ч ${mins}мин`;
      if (shiftResult.failCount > 0) {
        shiftInfo += ` | Отклонённых фото: ${shiftResult.failCount}`;
      }
    } catch (error) {
      console.error('[shift calculation error]', error);
    }
  }

  onChecklistCompleted(runId).catch((err) => console.error('[sheets error]', err));

  const violations = await prisma.violation.findMany({
    where: { runId: completed.id, status: 'open' },
    include: { question: true, answer: true },
    orderBy: { id: 'asc' },
    take: 50,
  });

  const runUser = await prisma.user.findUnique({ where: { id: completed.userId } });
  const userName = runUser?.displayName ?? runUser?.firstName ?? 'Сотрудник';

  const hasViolations = violations.length > 0;
  const rejectedCount = (await prisma.run.findUnique({
    where: { id: completed.id },
    select: { rejectedPhotoCount: true },
  }))?.rejectedPhotoCount ?? 0;
  const acceptedCount = answersCount;
  const scorePct = completed.scorePercent != null ? Math.round(completed.scorePercent) : null;

  const fmtTime = (d: Date | null) =>
    d ? d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', timeZone: config.BUSINESS_TIMEZONE }) : '';
  const startedTime = fmtTime(completed.startedAt);
  const finishedTime = fmtTime(completed.completedAt ?? new Date());

  // --- Сводки по «отложено → пройдено» и «пропущено с комментарием» ---
  // Подгружаем ответы run-а с расширенными полями для шорт-листа.
  const answersForSummary = await prisma.answer.findMany({
    where: { runId: completed.id },
    include: { question: true },
    orderBy: { createdAt: 'asc' },
  });

  const deferredDoneItems = answersForSummary
    .filter((a) => (a.deferCount ?? 0) > 0 && a.checkResult != null && a.checkResult !== 'skip')
    .map((a) => splitQuestionText(a.question.text).title);

  const skippedWithComment = answersForSummary
    .filter((a) => a.checkResult === 'skip' && (a.skipComment ?? '').trim().length > 0)
    .map((a) => ({
      title: splitQuestionText(a.question.text).title,
      comment: a.skipComment ?? '',
    }));

  const violationsList = hasViolations
    ? [
        '',
        `❌ Замечания (${violations.length}):`,
        ...violations.slice(0, 10).map((v, idx) => {
          const aiNote = v.answer?.aiReason ? ` — ${v.answer.aiReason}` : '';
          return `${idx + 1}. ${splitQuestionText(v.question.text).title}${aiNote}`;
        }),
        violations.length > 10 ? `… и ещё ${violations.length - 10}` : null,
      ]
        .filter(Boolean)
        .join('\n')
    : '';

  const deferredDoneList = deferredDoneItems.length > 0
    ? [
        '',
        `⏸ Отложено → пройдено (${deferredDoneItems.length}):`,
        ...deferredDoneItems.slice(0, 10).map((title, idx) => `${idx + 1}. ${title}`),
        deferredDoneItems.length > 10 ? `… и ещё ${deferredDoneItems.length - 10}` : null,
      ]
        .filter(Boolean)
        .join('\n')
    : '';

  const skippedList = skippedWithComment.length > 0
    ? [
        '',
        `⏭ Пропущено с комментарием (${skippedWithComment.length}):`,
        ...skippedWithComment.slice(0, 10).map(
          (item, idx) => `${idx + 1}. ${item.title} — ${item.comment}`,
        ),
        skippedWithComment.length > 10 ? `… и ещё ${skippedWithComment.length - 10}` : null,
      ]
        .filter(Boolean)
        .join('\n')
    : '';

  const summaryHeader = hasViolations
    ? '⚠️ Чек-лист завершён с замечаниями'
    : '✅ Чек-лист завершён';

  const photoLine = rejectedCount > 0
    ? `📸 Фото: ${acceptedCount} принято, ${rejectedCount} отклонено`
    : `📸 Фото: ${acceptedCount}`;

  const summary = [
    summaryHeader,
    `👤 Сотрудник: ${userName}`,
    `📋 Чек-лист: <b>${completed.checklist.title}</b>`,
    scorePct != null ? `📊 Прохождение: ${scorePct}%` : null,
    photoLine,
    `🕐 Время: ${startedTime} → ${finishedTime}`,
    shiftInfo ? shiftInfo.trim() : null,
    violationsList || null,
    deferredDoneList || null,
    skippedList || null,
  ]
    .filter(Boolean)
    .join('\n');

  await ctx.reply(summary, { parse_mode: 'HTML' });

  if (config.TEAM_CHAT_ID) {
    try {
      await bot.telegram.sendMessage(config.TEAM_CHAT_ID, summary, { parse_mode: 'HTML' });
    } catch (error) {
      console.error('[manager channel notify error]', error);
    }
  }
}

/**
 * Финальное меню «Отложенные пункты» в стиле меню выбора роли:
 * заголовок + столбец inline-кнопок (по одной на строку). Полное
 * описание UX — `creative-defer-button.md` §4.3.
 */
async function sendDeferredMenu(
  ctx: Context,
  runId: number,
  checklistTitle: string,
  userLanguage: string | null | undefined,
): Promise<void> {
  const items = await getDeferredQuestions(runId);
  if (items.length === 0) return;

  const buttons: ReturnType<typeof Markup.button.callback>[][] = items.map((item) => {
    const title = splitQuestionText(item.question.text).title;
    const label = `${item.questionNumber}/${item.totalQuestions} • ${title}`;
    const trimmed = label.length > 60 ? `${label.slice(0, 57)}…` : label;
    return [Markup.button.callback(trimmed, `defer:resume:${runId}:${item.question.id}`)];
  });

  // Подсказка как пользоваться меню — статический перевод из t() для всех
  // активных языков (см. UiKey `deferred_menu_tap_hint` в roles.ts).
  // Сотрудник часто не понимает, что нужно тапнуть на пункт в списке.
  const tapHint = t(userLanguage, 'deferred_menu_tap_hint');

  const header = [
    '⏸ <b>Отложенные пункты</b>',
    `📋 <i>${escapeHtml(checklistTitle)}</i>`,
    '',
    `Осталось пройти: <b>${items.length}</b>. Чек-лист завершится только`,
    'когда все эти пункты будут пройдены или пропущены.',
    '',
    tapHint,
  ].join('\n');

  await ctx.reply(header, {
    parse_mode: 'HTML',
    ...Markup.inlineKeyboard(buttons),
  });
}

/**
 * Единая «точка перехода» после любого финализированного ответа.
 *
 * Логика:
 *  1. Есть обычный следующий вопрос — рендерим его.
 *  2. Обычные закончились, но есть отложенные — показываем меню отложенных.
 *  3. Ничего не осталось — завершаем run и отправляем шорт-лист.
 */
async function sendCurrentQuestion(ctx: Context, runId: number) {
  const next = await getNextQuestion(runId);

  if (!next) {
    const run = await prisma.run.findUnique({
      where: { id: runId },
      include: { checklist: true, user: true },
    });
    if (!run) return;

    const deferred = await getDeferredQuestions(runId);
    if (deferred.length > 0) {
      await sendDeferredMenu(ctx, runId, run.checklist.title, run.user?.language);
      return;
    }

    await completeRunAndSendSummary(ctx, runId);
    return;
  }

  const run = await prisma.run.findUnique({
    where: { id: runId },
    include: { checklist: true, user: true },
  });

  if (!run) return;

  // Подгружаем `deferCount` для текущего вопроса, чтобы скрыть кнопку
  // «⏸» после исчерпания лимита.
  const currentAnswer = await prisma.answer.findFirst({
    where: { runId, questionId: next.question.id },
    orderBy: { createdAt: 'desc' },
    select: { deferCount: true },
  });

  const footerOptions = {
    canDefer: canRoleDefer(run.user?.role ?? null),
    deferCount: currentAnswer?.deferCount ?? 0,
    isPending: Boolean(next.pendingAnswer),
  };

  const text = next.pendingAnswer
    ? formatPendingEvaluationMessage(
        run.checklist.title,
        next.questionNumber,
        next.totalQuestions,
        next.question.text,
      )
    : formatQuestionMessage(
        run.checklist.title,
        next.questionNumber,
        next.totalQuestions,
        next.question.text,
        next.question.taskType,
        next.question.section,
      );

  const keyboard = next.pendingAnswer
    ? buildEvaluationKeyboard(runId, next.question.id, next.pendingAnswer.id, footerOptions)
    : buildQuestionKeyboard(runId, next.question.id, next.question.taskType, footerOptions);

  await ctx.reply(text, {
    parse_mode: 'HTML',
    ...(keyboard ?? {}),
  });
}

/**
 * Получить зарегистрированного пользователя из ctx.
 * Возвращает null если не зарегистрирован.
 */
async function getRegisteredUser(ctx: Context) {
  const from = ctx.from;
  if (!from) return null;

  const telegramId = String(from.id);
  const user = await prisma.user.findUnique({ where: { telegramId } });

  if (!user || !user.role) return null;
  return user;
}

async function handleChecklistImageUpload(
  ctx: Context,
  user: NonNullable<Awaited<ReturnType<typeof getRegisteredUser>>>,
  activeRun: NonNullable<Awaited<ReturnType<typeof findActiveRun>>>,
  nextQ: NonNullable<Awaited<ReturnType<typeof getNextQuestion>>>,
  buffer: Buffer,
) {
  if (nextQ.pendingAnswer) {
    await ctx.reply('Сначала выберите результат по предыдущему фото.');
    await sendCurrentQuestion(ctx, activeRun.id);
    return;
  }

  if (nextQ.question.taskType === 'confirm') {
    await ctx.reply('Для этого пункта фото не требуется. Нажмите ✔️ Да или ✖️ Нет под сообщением с вопросом.');
    await sendCurrentQuestion(ctx, activeRun.id);
    return;
  }

  const validation = await validateImage(buffer);
  if (!validation.valid) {
    // EXIF / format / size validation failed — фиксируем как нарушение в таблицу и просим переснять
    const displayName = user.displayName ?? user.firstName ?? 'Сотрудник';
    const stamped = await applyWatermark(buffer, {
      displayName,
      date: new Date(),
      location: user.location ?? 'restaurant',
    });
    const filename = `${randomUUID()}.jpg`;
    const filePath = await uploadPhoto(stamped, filename, { displayName });

    enqueueOutbox(
      {
        type: 'answer',
        payload: {
          location: user.location,
          displayName,
          username: ctx.from?.username ?? null,
          role: user.role ?? '',
          checklistTitle: activeRun.checklist.title,
          questionText: nextQ.question.text,
          taskType: nextQ.question.taskType ?? 'photo',
          questionSection: nextQ.question.section,
          questionWeight: nextQ.question.weight,
          photoUrl: filePath,
          aiVerdict: 'fail',
          aiReason: validation.reason,
          checkResult: 'retake_requested',
          earnedWeight: 0,
          possibleWeight: nextQ.question.weight ?? 0,
          isViolation: true,
          runStartedAtIso: activeRun.startedAt.toISOString(),
          answeredAtIso: new Date().toISOString(),
        },
      },
      `reject:${activeRun.id}:${nextQ.question.id}:${Date.now()}`,
    ).catch((err) => console.error('[outbox enqueue error]', err));

    if (config.TEAM_CHAT_ID) {
      bot.telegram
        .sendMessage(
          config.TEAM_CHAT_ID,
          [
            '❌ Отклонено фото (валидация)',
            `Сотрудник: ${displayName}`,
            `Чек-лист: ${activeRun.checklist.title}`,
            `Пункт: ${nextQ.question.text}`,
            `Причина: ${validation.reason}`,
            `Фото: ${filePath}`,
          ].join('\n'),
        )
        .catch((err) => console.error('[team chat notify error]', err));
    }

    await prisma.run.update({
      where: { id: activeRun.id },
      data: { rejectedPhotoCount: { increment: 1 } },
    }).catch((err) => console.error('[run.rejectedPhotoCount inc error]', err));

    const footerRows = await questionFooterRowsFor(
      activeRun.id,
      nextQ.question.id,
      user.role,
    );
    await ctx.reply(
      [
        '<b>❌ Фото не принято</b>',
        '',
        'Пожалуйста, сделайте новое свежее фото и отправьте ещё раз.',
        'Или нажмите «Пропустить пункт», если сейчас выполнить нельзя.',
        '',
        `<i>ℹ️ ${escapeHtml(validation.reason)}</i>`,
      ].join('\n'),
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard(footerRows),
      },
    );
    return;
  }

  const hash = await computePhotoHash(buffer);
  const existingAnswers = await prisma.answer.findMany({
    where: {
      photoHash: { not: null },
      run: { userId: user.id },
    },
    select: { photoHash: true },
  });
  const isDuplicate = existingAnswers.some(
    (answer) => hammingDistance(hash, answer.photoHash!) <= DUPLICATE_THRESHOLD,
  );
  if (isDuplicate) {
    const footerRows = await questionFooterRowsFor(
      activeRun.id,
      nextQ.question.id,
      user.role,
    );
    await ctx.reply(
      '❌ Это фото уже было отправлено ранее. Сделайте новое фото или пропустите пункт с комментарием.',
      Markup.inlineKeyboard(footerRows),
    );
    return;
  }

  const runPhotoAi = shouldRunPhotoAi(nextQ.question.taskType);
  const effectiveAiRule = runPhotoAi
    ? resolvePhotoCheckRule(nextQ.question.aiRule, nextQ.question.text)
    : null;
  const { title: questionTitle } = splitQuestionText(nextQ.question.text);

  if (runPhotoAi && effectiveAiRule) {
    await ctx.reply('📷 Фото получено, идёт проверка...');
  }

  const displayName = user.displayName ?? user.firstName ?? 'Сотрудник';

  const [stamped, aiResult] = await Promise.all([
    applyWatermark(buffer, {
      displayName,
      date: new Date(),
      location: user.location ?? 'restaurant',
    }),
    runPhotoAi && effectiveAiRule
      ? verifyPhoto(
          buffer,
          effectiveAiRule,
          questionTitle,
          nextQ.question.referencePhoto,
        )
      : Promise.resolve(null),
  ]);

  const aiVerdict = aiResult?.verdict;
  const aiReason = aiResult?.reason;
  const aiConfidence = aiResult?.confidence;

  const filename = `${randomUUID()}.jpg`;
  const filePath = await uploadPhoto(stamped, filename, {
    displayName,
  });

  // Если AI уверен что фото не соответствует — сохраняем, пишем в таблицу, просим переснять
  if (aiVerdict === 'fail') {
    enqueueOutbox(
      {
        type: 'answer',
        payload: {
          location: user.location,
          displayName,
          username: ctx.from?.username ?? null,
          role: user.role ?? '',
          checklistTitle: activeRun.checklist.title,
          questionText: nextQ.question.text,
          taskType: nextQ.question.taskType ?? 'photo',
          questionSection: nextQ.question.section,
          questionWeight: nextQ.question.weight,
          photoUrl: filePath,
          aiVerdict,
          aiReason: aiReason ?? 'Фото не соответствует требованиям пункта.',
          checkResult: 'retake_requested',
          earnedWeight: 0,
          possibleWeight: nextQ.question.weight ?? 0,
          isViolation: true,
          runStartedAtIso: activeRun.startedAt.toISOString(),
          answeredAtIso: new Date().toISOString(),
        },
      },
      `ai_fail:${activeRun.id}:${nextQ.question.id}:${Date.now()}`,
    ).catch((err) => console.error('[outbox enqueue error]', err));

    if (config.TEAM_CHAT_ID) {
      bot.telegram
        .sendMessage(
          config.TEAM_CHAT_ID,
          [
            '❌ Отклонено фото (AI)',
            `Сотрудник: ${displayName}`,
            `Чек-лист: ${activeRun.checklist.title}`,
            `Пункт: ${nextQ.question.text}`,
            aiReason ? `Что заметил ИИ: ${aiReason}` : null,
            aiConfidence != null ? `Уверенность: ${aiConfidence}` : null,
            `Фото: ${filePath}`,
          ]
            .filter(Boolean)
            .join('\n'),
        )
        .catch((err) => console.error('[team chat notify error]', err));
    }

    await prisma.run.update({
      where: { id: activeRun.id },
      data: { rejectedPhotoCount: { increment: 1 } },
    }).catch((err) => console.error('[run.rejectedPhotoCount inc error]', err));

    const footerRows = await questionFooterRowsFor(
      activeRun.id,
      nextQ.question.id,
      user.role,
    );
    await ctx.reply(
      [
        `<b>❌ Фото не принято (${nextQ.questionNumber}/${nextQ.totalQuestions})</b>`,
        '',
        'Пожалуйста, сделайте новое фото по описанию пункта и отправьте ещё раз.',
        'Или нажмите «Пропустить пункт», если сейчас выполнить нельзя.',
        aiReason ? '' : null,
        aiReason ? `<i>ℹ️ ${escapeHtml(aiReason)}</i>` : null,
      ]
        .filter((line) => line !== null)
        .join('\n'),
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard(footerRows),
      },
    );
    return;
  }

  const answer = await saveAnswer(
    activeRun.id,
    nextQ.question.id,
    filePath,
    aiVerdict,
    aiReason,
    aiConfidence,
    hash,
  );

  // да/нет (фото): фото сохранено, ждём выбор Да/Нет (не автозачёт)
  if (nextQ.question.taskType === 'confirm_photo') {
    const verificationText = aiResult ? ' Проверка ИИ пройдена.' : '';
    await ctx.reply(
      `📷 Фото принято (${nextQ.questionNumber}/${nextQ.totalQuestions}).${verificationText} Выберите ✔️ Да или ✖️ Нет.`,
    );
    await sendCurrentQuestion(ctx, activeRun.id);
    return;
  }

  const finalized = await finalizeAnswer(answer.id, 'yes');
  if (!finalized) {
    await ctx.reply('Не удалось сохранить результат после проверки фото.');
    return;
  }

  const deferMeta = await readDeferMeta(activeRun.id, finalized.questionId, 'yes');
  enqueueAnswerEvent({
    user,
    run: activeRun,
    question: finalized.question,
    photoUrl: finalized.value,
    aiVerdict: finalized.aiVerdict ?? undefined,
    aiReason: finalized.aiReason ?? undefined,
    checkResult: 'yes',
    earnedWeight: finalized.earnedWeight ?? 0,
    possibleWeight: finalized.possibleWeight ?? 0,
    isViolation: false,
    ...deferMeta,
  });

  const verificationText = aiResult ? '\nПроверка пройдена.' : '';
  await ctx.reply(
    `✅ Фото принято (${nextQ.questionNumber}/${nextQ.totalQuestions})${verificationText}`,
  );
  await sendCurrentQuestion(ctx, activeRun.id);
}

// --- /start ---

async function sendAddRoleStep(ctx: Context, telegramUserId: number) {
  const state = registrationState.get(telegramUserId);
  if (!state || !state.existingUserId || !state.tempLanguage) return;

  state.step = 'awaiting_role';
  const userRoles = await getUserRoles(state.existingUserId);
  const existingKeys = new Set(userRoles.map((ur) => ur.role));
  const availableRoles = getRolesForLanguage(state.tempLanguage).filter(
    (r) => !existingKeys.has(r.key),
  );

  if (availableRoles.length === 0) {
    registrationState.delete(telegramUserId);
    await ctx.reply(t(state.tempLanguage, 'all_roles_added'));
    return;
  }

  const keyboard = Markup.keyboard(availableRoles.map((r) => r.label))
    .oneTime()
    .resize();

  await ctx.reply(t(state.tempLanguage, 'choose_extra_role'), keyboard);
}

async function finalizeRegistrationOrAdd(
  ctx: Context,
  state: RegistrationState,
  languageCode: LanguageCode,
) {
  const from = ctx.from;
  if (!from || !state.tempRole) return;

  const roleConfig = findRoleByKey(state.tempRole);
  if (!roleConfig) return;

  const langConfig = getLanguageConfig(languageCode);
  const langLabel = langConfig?.nativeLabel ?? languageCode;
  const telegramId = String(from.id);
  const location = resolveLocationForRole(state.tempRole);
  const locationLabel = location === 'cafe' ? '☕ Кофепоинт' : '🍽 Ресторан';

  if (state.mode === 'add_role' && state.existingUserId) {
    await addUserRole({
      userId: state.existingUserId,
      role: state.tempRole,
      language: languageCode,
    });
    const updated = await switchActiveRole({
      userId: state.existingUserId,
      role: state.tempRole,
    });

    invalidateLanguageCache(from.id);
    registrationState.delete(from.id);

    await ctx.reply(
      [
        t(languageCode, 'role_added'),
        `${t(languageCode, 'role_label_role')}: ${roleConfig.label}`,
        `${t(languageCode, 'role_label_language')}: ${langLabel}`,
        `${t(languageCode, 'role_label_location')}: ${locationLabel}`,
      ].join('\n'),
    );

    await showAvailableChecklists(ctx, updated);
    return;
  }

  const user = await upsertRegisteredUser({
    telegramId,
    firstName: from.first_name ?? null,
    lastName: from.last_name ?? null,
    username: from.username ?? null,
    displayName: state.tempName ?? from.first_name ?? 'Без имени',
    role: state.tempRole,
    language: languageCode,
    location,
  });

  invalidateLanguageCache(from.id);
  registrationState.delete(from.id);

  await ctx.reply(
    [
      t(languageCode, 'registration_complete'),
      `${t(languageCode, 'role_label_name')}: ${user.displayName}`,
      `${t(languageCode, 'role_label_role')}: ${roleConfig.label}`,
      `${t(languageCode, 'role_label_language')}: ${langLabel}`,
      `${t(languageCode, 'role_label_location')}: ${locationLabel}`,
    ].join('\n'),
  );

  await showAvailableChecklists(ctx, user);
}

async function startRegistrationFlow(ctx: Context, from: { id: number }) {
  registrationState.set(from.id, { step: 'awaiting_language', mode: 'register' });
  // Показываем только активные языки (см. ACTIVE_LANG_CODES в roles.ts).
  const keyboard = Markup.keyboard(
    activeLanguages.map((lang) => [lang.nativeLabel]),
  )
    .oneTime()
    .resize();
  // Multilingual welcome — short and language-neutral
  await ctx.reply(
    'Привет! / Hi! / नमस्ते! / سلام!\n\n' +
      'Выберите язык / Choose language / भाषा चुनें / زبان را انتخاب کنید',
    keyboard,
  );
}

async function handleStart(ctx: Context) {
  const from = ctx.from;
  if (!from) {
    await ctx.reply('Не могу определить пользователя.');
    return;
  }

  const user = await getRegisteredUser(ctx);

  if (!user) {
    await startRegistrationFlow(ctx, from);
    return;
  }

  // Проверка активного run — не сбрасывать
  const activeRun = await findActiveRun(user.id);
  if (activeRun) {
    await ctx.reply(
      `У вас есть незавершённый чек-лист: "${activeRun.checklist.title}".\nПродолжаем с текущего вопроса.`,
    );
    await sendCurrentQuestion(ctx, activeRun.id);
    return;
  }

  // Показать доступные чек-листы
  await showAvailableChecklists(ctx, user);
}

async function showAvailableChecklists(
  ctx: Context,
  user: { id: number; role: string | null; language?: string | null },
  options?: { roleOverride?: string; languageOverride?: string },
) {
  const now = new Date();
  const { checklists, nextTimeText } = await getActiveChecklistsForUserNow(
    user as Parameters<typeof getActiveChecklistsForUserNow>[0],
    now,
    {
      role: options?.roleOverride,
      language: options?.languageOverride,
    },
  );

  // Шапка с указанием активной роли/языка
  const activeRole = options?.roleOverride ?? user.role ?? null;
  const activeLang = options?.languageOverride ?? user.language ?? 'ru';
  const roleLabel = activeRole ? (findRoleByKey(activeRole)?.label ?? activeRole) : '—';
  const langLabel = getLanguageConfig(activeLang)?.nativeLabel ?? activeLang;
  const header = `Активная роль: ${roleLabel}\nЯзык: ${langLabel}`;

  if (checklists.length === 0) {
    const timeHint =
      nextTimeText != null
        ? `Следующий чек-лист будет доступен в ${nextTimeText}.`
        : 'Все чек-листы на сегодня пройдены. Отличная работа!';
    await sendMainMenu(ctx, `${header}\n\n${timeHint}`);
    return;
  }

  const buttons = checklists.map((cl) => [
    Markup.button.callback(cl.title, `startChecklist:${cl.key}`),
  ]);
  buttons.push([Markup.button.callback('🔄 Сменить роль', 'role:menu')]);

  await ctx.reply(`${header}\n\nДоступные чек-листы:`, Markup.inlineKeyboard(buttons));
}

async function sendRoleSwitchMenu(
  ctx: Context,
  user: { id: number; role: string | null; telegramId: string },
) {
  const isUserAdmin = isAdmin(user.telegramId);

  // Админ: список всех ролей системы (доступ ко всему)
  // Сотрудник: только свои сохранённые роли + кнопка добавить новую
  const buttons: ReturnType<typeof Markup.button.callback>[][] = [];

  if (isUserAdmin) {
    for (const role of roles) {
      const isCurrent = role.key === user.role;
      const prefix = isCurrent ? '✅ ' : '';
      buttons.push([
        Markup.button.callback(`${prefix}${role.label}`, `role:set:${role.key}`),
      ]);
    }
  } else {
    const userRoles = await getUserRoles(user.id);

    if (userRoles.length === 0) {
      await ctx.reply('У вас пока только одна роль. Добавьте новую кнопкой ниже.');
    } else {
      for (const ur of userRoles) {
        const roleConfig = findRoleByKey(ur.role);
        if (!roleConfig) continue;
        const isCurrent = ur.role === user.role;
        const prefix = isCurrent ? '✅ ' : '';
        const langLabel = getLanguageConfig(ur.language)?.nativeLabel ?? ur.language;
        buttons.push([
          Markup.button.callback(
            `${prefix}${roleConfig.label} (${langLabel})`,
            `role:set:${ur.role}`,
          ),
        ]);
      }
    }

    buttons.push([Markup.button.callback('➕ Добавить роль', 'role:add')]);
  }

  await ctx.reply('Выберите роль:', Markup.inlineKeyboard(buttons));
}

// --- Команды ---

bot.start(handleStart);

bot.command('register', async (ctx) => {
  const from = ctx.from;
  if (!from) {
    await ctx.reply('Не могу определить пользователя.');
    return;
  }

  // Не давать перерегистрироваться при активном run
  const user = await getRegisteredUser(ctx);
  if (user) {
    const activeRun = await findActiveRun(user.id);
    if (activeRun) {
      await ctx.reply(
        `Нельзя перерегистрироваться во время чек-листа "${activeRun.checklist.title}". Завершите его сначала.`,
      );
      return;
    }
  }

  registrationState.set(from.id, { step: 'awaiting_name', mode: 'register' });
  await ctx.reply('Регистрация открыта. Напиши имя/фамилию одним сообщением.');
});

bot.command('menu', async (ctx) => {
  const from = ctx.from;
  if (!from) return;
  const telegramId = String(from.id);
  if (telegramId !== config.OWNER_ID && !isAdmin(telegramId)) {
    await ctx.reply(`Нет доступа. Ваш Telegram ID: ${telegramId}`);
    return;
  }
  await sendAdminMenu(ctx);
});

// Lightweight diagnostics for env/admin issues.
// Does not reveal secrets, only the requesting user's id + admin flag.
bot.command('whoami', async (ctx) => {
  const from = ctx.from;
  if (!from) return;
  const telegramId = String(from.id);
  const admin = isAdmin(telegramId);
  const owner = config.OWNER_ID ? 'set' : 'not set';
  await ctx.reply(
    [
      `Ваш Telegram ID: ${telegramId}`,
      `isAdmin: ${admin ? 'true' : 'false'}`,
      `OWNER_ID: ${owner}`,
      `ADMIN_IDS count: ${config.ADMIN_IDS.length}`,
    ].join('\n'),
  );
});

async function handleDebugMe(ctx: Context) {
  try {
    const user = await ensureUserFromContext(ctx);
    const activeRun = await findActiveRun(user.id);

    const lines = [
      'Debug info:',
      `ID: ${user.id}`,
      `Telegram ID: ${user.telegramId}`,
      `Username: ${user.username ?? '—'}`,
      `Role: ${user.role ?? '—'}`,
      `Active run: ${activeRun ? `#${activeRun.id} (${activeRun.checklist.title})` : 'нет'}`,
    ];

    await ctx.reply(lines.join('\n'));
  } catch (error) {
    console.error('[debug_me error]', error);
    await ctx.reply('Ошибка при обращении к БД, попробуйте позже.');
  }
}

bot.command('debug_me', handleDebugMe);

// --- Админ-команды ---

async function handleHelp(ctx: Context) {
  await ctx.reply(
    [
      '📖 Список команд:',
      '',
      '/start — начало работы',
      '/menu — панель управления (только для админов)',
    ].join('\n'),
  );
}

async function handleInvite(ctx: Context) {
  await ctx.reply('Открытая регистрация уже включена. Инвайт-коды больше не используются.');
}

async function handleInvites(ctx: Context) {
  await ctx.reply('Инвайт-коды отключены. Новые сотрудники могут регистрироваться по обычной ссылке на бота.');
}

bot.command('invite', async (ctx) => {
  const from = ctx.from;
  if (!from) return;
  const telegramId = String(from.id);
  if (telegramId !== config.OWNER_ID && !isAdmin(telegramId)) return;
  await handleInvite(ctx);
});

bot.command('invites', async (ctx) => {
  const from = ctx.from;
  if (!from) return;
  const telegramId = String(from.id);
  if (telegramId !== config.OWNER_ID && !isAdmin(telegramId)) return;
  await handleInvites(ctx);
});

async function handleReload(ctx: Context) {
  try {
    await ctx.reply('Перезагружаю чек-листы...');
    const count = await syncChecklists();
    await ctx.reply(`Чек-листы перезагружены (${count} штук)`);
  } catch (error) {
    console.error('[reload error]', error);
    await ctx.reply('Ошибка при перезагрузке чек-листов.');
  }
}

async function handleStatus(ctx: Context) {
  try {
    const lines: string[] = [];

    try {
      await prisma.$queryRaw`SELECT 1`;
      lines.push('🟢 DB: ok');
    } catch {
      lines.push('🔴 DB: fail');
    }

    const uploadsDir = path.resolve('uploads');
    lines.push(existsSync(uploadsDir) ? '🟢 Storage: ok' : '🟡 Storage: папка uploads отсутствует');

    lines.push(config.OPENAI_API_KEY ? '🟢 AI: ключ настроен' : '🔴 AI: OPENAI_API_KEY не задан');

    const userCount = await prisma.user.count();
    lines.push(`👥 Пользователей: ${userCount}`);

    const { start: todayStart } = getBusinessDayBounds(new Date());

    const runsToday = await prisma.run.count({
      where: { startedAt: { gte: todayStart } },
    });
    const activeRuns = await prisma.run.count({
      where: { completedAt: null },
    });

    lines.push(`📋 Runs за сегодня: ${runsToday}`);
    lines.push(`▶️ Активных runs: ${activeRuns}`);

    const outboxPending = await prisma.outbox.count({ where: { status: 'pending' } });
    const outboxFailed = await prisma.outbox.count({ where: { status: 'failed' } });
    lines.push(`📬 Outbox: pending ${outboxPending}, failed ${outboxFailed}`);

    await ctx.reply(lines.join('\n'));
  } catch (error) {
    console.error('[status error]', error);
    await ctx.reply('Ошибка при получении статуса.');
  }
}

bot.command('reload', async (ctx) => {
  const from = ctx.from;
  if (!from || !isAdmin(String(from.id))) return;
  await handleReload(ctx);
});

bot.command('status', async (ctx) => {
  const from = ctx.from;
  if (!from || !isAdmin(String(from.id))) return;
  await handleStatus(ctx);
});

// --- Callback: админ-панель (/menu) ---

bot.action('adm:invites', async (ctx) => {
  await ctx.answerCbQuery();
  const from = ctx.from;
  if (!from) return;
  const telegramId = String(from.id);
  if (telegramId !== config.OWNER_ID && !isAdmin(telegramId)) return;
  await handleInvites(ctx);
});

bot.action('adm:checklists', async (ctx) => {
  await ctx.answerCbQuery();
  const from = ctx.from;
  if (!from) return;
  const telegramId = String(from.id);
  if (telegramId !== config.OWNER_ID && !isAdmin(telegramId)) return;
  await sendChecklistList(ctx);
});

bot.action('adm:invite', async (ctx) => {
  await ctx.answerCbQuery();
  const from = ctx.from;
  if (!from) return;
  const telegramId = String(from.id);
  if (telegramId !== config.OWNER_ID && !isAdmin(telegramId)) return;
  await handleInvite(ctx);
});

bot.action('adm:reload', async (ctx) => {
  await ctx.answerCbQuery();
  const from = ctx.from;
  if (!from) return;
  const telegramId = String(from.id);
  if (telegramId !== config.OWNER_ID && !isAdmin(telegramId)) return;
  await handleReload(ctx);
});

bot.action('adm:sheet_sync', async (ctx) => {
  await ctx.answerCbQuery();
  const from = ctx.from;
  if (!from) return;
  const telegramId = String(from.id);
  if (telegramId !== config.OWNER_ID && !isAdmin(telegramId)) return;

  await ctx.reply('📥 Скачиваю таблицу и обновляю чек-листы...');
  try {
    // Главная таблица — официант + менеджер + бариста (бариста переехал сюда 2026-05-22).
    const result = await syncChecklistsFromGoogleSheet();
    // Тхали-таблица — пока остаётся источником для хелпера и хостес,
    // до переезда их вкладок в главную таблицу.
    const helperResult = await syncHelperChecklistsFromGoogleSheet();
    const hostessResult = await syncHostessChecklistsFromGoogleSheet();

    await ctx.reply(
      `🌐 Перевожу новые чек-листы на ${BATCH_TARGET_LANGS.length} язык(а/ов): ${BATCH_TARGET_LANGS.join(', ')}. OpenAI работает последовательно…`,
    );
    const translateResults = await translateMissingChecklistsToAllLanguages({
      log: (msg) => console.log(msg),
    });

    const totalTranslated = Object.values(translateResults).reduce(
      (sum, r) => sum + r.translated,
      0,
    );
    let finalSynced = result.syncedToDb;
    if (totalTranslated > 0) {
      finalSynced = await syncChecklists();
    }

    const translateSummary = BATCH_TARGET_LANGS.map((lang) => {
      const r = translateResults[lang];
      return `  • ${lang}: +${r.translated} (пропущено ${r.skipped}, ошибок ${r.failed})`;
    }).join('\n');

    await ctx.reply(
      [
        '✅ Чек-листы обновлены из Google-таблиц',
        `Main sheet (официант + менеджер + бариста): чек-листов ${result.checklists}, вопросов ${result.tasks}`,
        `Helper sheet (Тхали): чек-листов ${helperResult.checklists}, вопросов ${helperResult.tasks}`,
        `Hostess sheet (Тхали): чек-листов ${hostessResult.checklists}, вопросов ${hostessResult.tasks}`,
        '',
        '🌐 Batch-перевод:',
        translateSummary,
        '',
        `📦 Итого в БД: ${finalSynced} чек-листов`,
      ].join('\n'),
    );
  } catch (error) {
    console.error('[sheet sync error]', error);
    const message = error instanceof Error ? error.message : String(error);
    await ctx.reply(`❌ Не удалось обновить из таблицы: ${message}`);
  }
});

bot.action('adm:status', async (ctx) => {
  await ctx.answerCbQuery();
  const from = ctx.from;
  if (!from) return;
  const telegramId = String(from.id);
  if (telegramId !== config.OWNER_ID && !isAdmin(telegramId)) return;
  await handleStatus(ctx);
});

bot.action('adm:debug_me', async (ctx) => {
  await ctx.answerCbQuery();
  const from = ctx.from;
  if (!from) return;
  const telegramId = String(from.id);
  if (telegramId !== config.OWNER_ID && !isAdmin(telegramId)) return;
  await handleDebugMe(ctx);
});

bot.action('adm:help', async (ctx) => {
  await ctx.answerCbQuery();
  const from = ctx.from;
  if (!from) return;
  const telegramId = String(from.id);
  if (telegramId !== config.OWNER_ID && !isAdmin(telegramId)) return;
  await handleHelp(ctx);
});

// --- Callback: старт чек-листа ---

bot.action(/^startChecklist:(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();

  const from = ctx.from;
  if (!from) return;

  const user = await getRegisteredUser(ctx);
  if (!user) {
    await ctx.reply('Ты ещё не зарегистрирован. Нажми /start.');
    return;
  }

  // Проверка: нет ли уже активного run
  const activeRun = await findActiveRun(user.id);
  if (activeRun) {
    await ctx.reply(
      `У вас уже есть активный чек-лист: "${activeRun.checklist.title}".\nЗавершите его, прежде чем начинать новый.`,
    );
    await sendCurrentQuestion(ctx, activeRun.id);
    return;
  }

  const key = ctx.match[1];
  const checklist = await prisma.checklist.findUnique({
    where: { key },
    include: { questions: { orderBy: { order: 'asc' } } },
  });

  if (!checklist) {
    await ctx.reply('Чек-лист не найден.');
    return;
  }

  if (checklist.questions.length === 0) {
    await ctx.reply(`Чек-лист "${checklist.title}" пуст — нет вопросов.`);
    return;
  }

  // Записать время старта смены если ещё не записано сегодня
  const { start: todayStart } = getBusinessDayBounds(new Date());
  if (!user.shiftStartedAt || user.shiftStartedAt < todayStart) {
    await prisma.user.update({
      where: { id: user.id },
      data: { shiftStartedAt: new Date() },
    });
  }

  // Создаём run
  const run = await createRun(user.id, checklist.id);

  const total = checklist.questions.length;
  const wordForm = total % 10 === 1 && total % 100 !== 11
    ? 'вопрос'
    : total % 10 >= 2 && total % 10 <= 4 && (total % 100 < 10 || total % 100 >= 20)
      ? 'вопроса'
      : 'вопросов';

  await ctx.reply(
    `▶️ Начинаем чек-лист\n<b>${checklist.title}</b>\n\nВсего ${total} ${wordForm}.`,
    { parse_mode: 'HTML' },
  );
  await sendCurrentQuestion(ctx, run.id);
});

bot.action(/^answer:skip:(\d+):(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();

  const user = await getRegisteredUser(ctx);
  if (!user) {
    await ctx.reply('Ты ещё не зарегистрирован. Нажми /start.');
    return;
  }

  const runId = Number(ctx.match[1]);
  const questionId = Number(ctx.match[2]);
  await beginSkipWithComment(ctx, user, runId, questionId);
});

/**
 * «⏸ Вернуться к пункту позже».
 * Доступна только для роли `manager` (страховка от подмены callback).
 * Логика отказов покрывает: pending-фото, исчерпанный лимит, неактуальный
 * вопрос. См. `creative-defer-button.md` §4.4.
 */
bot.action(/^answer:defer:(\d+):(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();

  const user = await getRegisteredUser(ctx);
  if (!user) {
    await ctx.reply('Ты ещё не зарегистрирован. Нажми /start.');
    return;
  }

  if (!canRoleDefer(user.role)) {
    await ctx.reply('Эта кнопка недоступна для вашей роли.');
    return;
  }

  const runId = Number(ctx.match[1]);
  const questionId = Number(ctx.match[2]);

  const activeRun = await findActiveRun(user.id);
  if (!activeRun || activeRun.id !== runId) {
    await ctx.reply('Эта кнопка уже неактуальна.');
    return;
  }

  const nextQ = await getNextQuestion(activeRun.id);
  if (!nextQ || nextQ.question.id !== questionId) {
    await ctx.reply('Этот пункт уже не активен.');
    return;
  }

  const result = await deferQuestion(activeRun.id, questionId);
  if (!result.ok) {
    if (result.reason === 'pending_photo') {
      await ctx.reply(
        'Сначала выберите результат по уже загруженному фото — потом можно будет отложить.',
      );
    } else if (result.reason === 'limit_reached') {
      await ctx.reply(
        `Этот пункт уже откладывали ${MAX_DEFER} раз — пройдите его сейчас или нажмите «⏭ Пропустить пункт».`,
      );
    } else {
      await ctx.reply('Пункт уже закрыт.');
    }
    return;
  }

  await ctx.reply(
    `⏸ Пункт отложен. Вы вернётесь к нему в конце чек-листа в меню отложенных.`,
  );
  await sendCurrentQuestion(ctx, activeRun.id);
});

/**
 * Финальное меню → выбор отложенного пункта. Возвращаем пользователя
 * к этому вопросу как к обычному (с тем же `formatQuestionMessage`).
 * Лимит уже исчерпан, поэтому «⏸» в подвале не появится повторно.
 */
bot.action(/^defer:resume:(\d+):(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();

  const user = await getRegisteredUser(ctx);
  if (!user) {
    await ctx.reply('Ты ещё не зарегистрирован. Нажми /start.');
    return;
  }

  const runId = Number(ctx.match[1]);
  const questionId = Number(ctx.match[2]);

  const activeRun = await findActiveRun(user.id);
  if (!activeRun || activeRun.id !== runId) {
    await ctx.reply('Эта кнопка уже неактуальна.');
    return;
  }

  const target = await getQuestionByIdForRun(activeRun.id, questionId);
  if (!target) {
    await ctx.reply('Этот пункт уже не активен.');
    return;
  }

  const text = target.pendingAnswer
    ? formatPendingEvaluationMessage(
        activeRun.checklist.title,
        target.questionNumber,
        target.totalQuestions,
        target.question.text,
      )
    : formatQuestionMessage(
        activeRun.checklist.title,
        target.questionNumber,
        target.totalQuestions,
        target.question.text,
        target.question.taskType,
        target.question.section,
      );

  const footerOptions = {
    canDefer: canRoleDefer(user.role),
    deferCount: target.deferCount,
    isPending: Boolean(target.pendingAnswer),
  };

  const keyboard = target.pendingAnswer
    ? buildEvaluationKeyboard(
        runId,
        target.question.id,
        target.pendingAnswer.id,
        footerOptions,
      )
    : buildQuestionKeyboard(
        runId,
        target.question.id,
        target.question.taskType,
        footerOptions,
      );

  await ctx.reply(text, {
    parse_mode: 'HTML',
    ...(keyboard ?? {}),
  });
});

bot.action(/^answer:confirm:(\d+):(\d+):(yes|no|skip)$/, async (ctx) => {
  await ctx.answerCbQuery();

  const user = await getRegisteredUser(ctx);
  if (!user) {
    await ctx.reply('Ты ещё не зарегистрирован. Нажми /start.');
    return;
  }

  const activeRun = await findActiveRun(user.id);
  if (!activeRun) {
    await ctx.reply('Нет активного чек-листа.');
    return;
  }

  const runId = Number(ctx.match[1]);
  const questionId = Number(ctx.match[2]);
  const checkResult = ctx.match[3] as AnswerCheckResult;

  if (activeRun.id !== runId) {
    await ctx.reply('Эта кнопка уже неактуальна.');
    return;
  }

  const nextQ = await getNextQuestion(activeRun.id);
  if (!nextQ || nextQ.pendingAnswer || nextQ.question.id !== questionId || nextQ.question.taskType !== 'confirm') {
    await ctx.reply('Эта кнопка уже неактуальна.');
    return;
  }

  if (checkResult === 'skip') {
    await beginSkipWithComment(ctx, user, runId, questionId);
    return;
  }

  const answer = await recordManualAnswer(activeRun.id, questionId, checkResult);
  if (!answer) {
    await ctx.reply('Не удалось сохранить результат.');
    return;
  }

  const isViolation = checkResult === 'no' && answer.question.createViolationOnNo;
  const deferMeta = await readDeferMeta(activeRun.id, questionId, checkResult);
  enqueueAnswerEvent({
    user,
    run: activeRun,
    question: answer.question,
    photoUrl: '',
    checkResult,
    earnedWeight: answer.earnedWeight ?? 0,
    possibleWeight: answer.possibleWeight ?? 0,
    isViolation,
    ...deferMeta,
  });

  const statusText =
    checkResult === 'yes'
      ? '✅ Пункт отмечен как выполненный.'
      : checkResult === 'no'
        ? '❌ Нарушение зафиксировано.'
        : '⏭ Пункт пропущен.';
  await ctx.reply(statusText);
  await sendCurrentQuestion(ctx, activeRun.id);
});

bot.action(/^answer:result:(\d+):(yes|no|skip|retake)$/, async (ctx) => {
  await ctx.answerCbQuery();

  const user = await getRegisteredUser(ctx);
  if (!user) {
    await ctx.reply('Ты ещё не зарегистрирован. Нажми /start.');
    return;
  }

  const activeRun = await findActiveRun(user.id);
  if (!activeRun) {
    await ctx.reply('Нет активного чек-листа.');
    return;
  }

  const answerId = Number(ctx.match[1]);
  const action = ctx.match[2] as 'yes' | 'no' | 'skip' | 'retake';
  const nextQ = await getNextQuestion(activeRun.id);

  if (!nextQ?.pendingAnswer || nextQ.pendingAnswer.id !== answerId) {
    await ctx.reply('Эта кнопка уже неактуальна.');
    return;
  }

  if (action === 'retake') {
    await deleteAnswer(answerId);
    await ctx.reply('🔄 Фото удалено. Отправьте новое фото.');
    await sendCurrentQuestion(ctx, activeRun.id);
    return;
  }

  if (action === 'skip') {
    await beginSkipWithComment(ctx, user, activeRun.id, nextQ.question.id);
    return;
  }

  const checkResult: AnswerCheckResult = action;
  const finalized = await finalizeAnswer(answerId, checkResult);
  if (!finalized) {
    await ctx.reply('Не удалось сохранить результат.');
    return;
  }

  const isViolation = checkResult === 'no' && finalized.question.createViolationOnNo;
  const deferMeta = await readDeferMeta(activeRun.id, finalized.questionId, checkResult);
  enqueueAnswerEvent({
    user,
    run: activeRun,
    question: finalized.question,
    photoUrl: finalized.value,
    aiVerdict: finalized.aiVerdict ?? undefined,
    aiReason: finalized.aiReason ?? undefined,
    checkResult,
    earnedWeight: finalized.earnedWeight ?? 0,
    possibleWeight: finalized.possibleWeight ?? 0,
    isViolation,
    ...deferMeta,
  });

  const statusText =
    checkResult === 'yes'
      ? '✅ Пункт отмечен как выполненный.'
      : checkResult === 'no'
        ? '❌ Нарушение зафиксировано.'
        : '⏭ Пункт пропущен.';
  await ctx.reply(statusText);
  await sendCurrentQuestion(ctx, activeRun.id);
});

// --- Callback: просмотр фото владельцем ---

bot.action(/^viewPhotos:(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();

  const from = ctx.from;
  if (!from) return;

  const telegramId = String(from.id);
  // Доступ только владельцу или админу
  if (telegramId !== config.OWNER_ID && !isAdmin(telegramId)) {
    return;
  }

  const runId = Number(ctx.match[1]);
  const run = await prisma.run.findUnique({
    where: { id: runId },
    include: {
      checklist: true,
      user: true,
      answers: {
        include: { question: true },
        orderBy: { question: { order: 'asc' } },
      },
    },
  });

  if (!run) {
    await ctx.reply('Чек-лист не найден.');
    return;
  }

  const isUrl = (v: string) => v.startsWith('http://') || v.startsWith('https://');
  const photosWithFiles = run.answers.filter((a) => a.value && (isUrl(a.value) || existsSync(a.value)));

  if (photosWithFiles.length === 0) {
    await ctx.reply('Фото не найдены для этого чек-листа.');
    return;
  }

  const userName = run.user.displayName ?? run.user.firstName ?? 'Сотрудник';
  await ctx.reply(`📋 ${run.checklist.title} — ${userName}\nФото: ${photosWithFiles.length}`);

  const getPhotoSource = (value: string) =>
    isUrl(value) ? { url: value } : Input.fromLocalFile(value);

  // Отправляем группами до 10 штук (лимит Telegram mediaGroup)
  for (let i = 0; i < photosWithFiles.length; i += 10) {
    const batch = photosWithFiles.slice(i, i + 10);

    if (batch.length === 1) {
      const a = batch[0];
      const verdictText = a.aiVerdict ? ` [${a.aiVerdict}]` : '';
      const resultText = ` [${formatCheckResult(a.checkResult)}]`;
      const caption = `${a.question.order}. ${a.question.text}${resultText}${verdictText}`;
      await ctx.replyWithPhoto(getPhotoSource(a.value), { caption });
    } else {
      const media = batch.map((a) => {
        const verdictText = a.aiVerdict ? ` [${a.aiVerdict}]` : '';
        const resultText = ` [${formatCheckResult(a.checkResult)}]`;
        const caption = `${a.question.order}. ${a.question.text}${resultText}${verdictText}`;
        return {
          type: 'photo' as const,
          media: getPhotoSource(a.value),
          caption,
        };
      });
      await ctx.replyWithMediaGroup(media);
    }
  }
});

// --- Callback: смена/добавление роли ---

bot.action('role:menu', async (ctx) => {
  await ctx.answerCbQuery();
  const user = await getRegisteredUser(ctx);
  if (!user) {
    await ctx.reply('Ты ещё не зарегистрирован. Нажми /start.');
    return;
  }

  const activeRun = await findActiveRun(user.id);
  if (activeRun) {
    await ctx.reply(
      `Нельзя сменить роль во время чек-листа "${activeRun.checklist.title}". Завершите его сначала.`,
    );
    return;
  }

  await sendRoleSwitchMenu(ctx, user);
});

bot.action(/^role:set:(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const user = await getRegisteredUser(ctx);
  if (!user) {
    await ctx.reply('Ты ещё не зарегистрирован. Нажми /start.');
    return;
  }

  const activeRun = await findActiveRun(user.id);
  if (activeRun) {
    await ctx.reply(
      `Нельзя сменить роль во время чек-листа "${activeRun.checklist.title}". Завершите его сначала.`,
    );
    return;
  }

  const targetRoleKey = ctx.match[1] as RoleKey;
  const roleConfig = findRoleByKey(targetRoleKey);
  if (!roleConfig) {
    await ctx.reply('Роль не найдена.');
    return;
  }

  const isUserAdmin = isAdmin(user.telegramId);
  const userRoles = await getUserRoles(user.id);
  const hasRole = userRoles.some((ur) => ur.role === targetRoleKey);

  // Сотрудник не может выбрать роль, которой у него нет
  if (!isUserAdmin && !hasRole) {
    await ctx.reply('Эта роль вам не добавлена. Используйте «Добавить роль».');
    return;
  }

  // Для админа без сохранённого UserRole — выбираем язык по умолчанию (ru)
  if (isUserAdmin && !hasRole) {
    const languages = getLanguagesForRole(targetRoleKey);
    const defaultLang: LanguageCode = languages.find((l) => l.code === 'ru') ? 'ru' : (languages[0]?.code ?? 'ru');
    await addUserRole({ userId: user.id, role: targetRoleKey, language: defaultLang });
  }

  const updated = await switchActiveRole({ userId: user.id, role: targetRoleKey });
  invalidateLanguageCache(user.telegramId);
  const langLabel = getLanguageConfig(updated.language)?.nativeLabel ?? updated.language;
  await ctx.reply(`✅ Активная роль: ${roleConfig.label}\nЯзык: ${langLabel}`);
  await showAvailableChecklists(ctx, updated);
});

bot.action('role:add', async (ctx) => {
  await ctx.answerCbQuery();
  const from = ctx.from;
  if (!from) return;

  const user = await getRegisteredUser(ctx);
  if (!user) {
    await ctx.reply('Ты ещё не зарегистрирован. Нажми /start.');
    return;
  }

  const activeRun = await findActiveRun(user.id);
  if (activeRun) {
    await ctx.reply(t(user.language, 'cant_switch_during_run'));
    return;
  }

  // Start with language step (works for any user, including non-RU speakers)
  registrationState.set(from.id, {
    step: 'awaiting_language',
    mode: 'add_role',
    existingUserId: user.id,
    tempName: user.displayName ?? user.firstName ?? 'Сотрудник',
  });

  // Показываем только активные языки (см. ACTIVE_LANG_CODES в roles.ts).
  const keyboard = Markup.keyboard(
    activeLanguages.map((lang) => [lang.nativeLabel]),
  )
    .oneTime()
    .resize();

  await ctx.reply(t(user.language, 'choose_language'), keyboard);
});

// --- Админ-управление чек-листами ---
registerChecklistAdmin(bot);

// --- Обработка фото ---

bot.on('photo', async (ctx) => {
  try {
    const user = await getRegisteredUser(ctx);
    if (!user) {
      await ctx.reply('Ты ещё не зарегистрирован. Нажми /start.');
      return;
    }

    const activeRun = await findActiveRun(user.id);
    if (!activeRun) {
      await ctx.reply('Нет активного чек-листа. Фото не принято.');
      return;
    }

    const nextQ = await getNextQuestion(activeRun.id);
    if (!nextQ) {
      await sendCurrentQuestion(ctx, activeRun.id);
      return;
    }

    const photos = ctx.message.photo;
    const bestPhoto = photos[photos.length - 1];
    const fileId = bestPhoto.file_id;
    const buffer = await downloadTelegramFile(ctx, fileId);
    await handleChecklistImageUpload(ctx, user, activeRun, nextQ, buffer);
  } catch (error) {
    console.error('[photo handler error]', error);
    await ctx.reply('Произошла ошибка при обработке фото. Попробуйте ещё раз.');
  }
});

// --- Обработка документов (изображения, отправленные как файл) ---

bot.on('document', async (ctx) => {
  const doc = ctx.message.document;
  const mimeType = doc.mime_type ?? '';

  if (!mimeType.startsWith('image/')) {
    await ctx.reply('Отправьте фото, не файл.');
    return;
  }

  // Изображение отправлено как документ — обрабатываем аналогично фото
  try {
    const user = await getRegisteredUser(ctx);
    if (!user) {
      await ctx.reply('Ты ещё не зарегистрирован. Нажми /start.');
      return;
    }

    const activeRun = await findActiveRun(user.id);
    if (!activeRun) {
      await ctx.reply('Нет активного чек-листа. Фото не принято.');
      return;
    }

    const nextQ = await getNextQuestion(activeRun.id);
    if (!nextQ) {
      await sendCurrentQuestion(ctx, activeRun.id);
      return;
    }

    const buffer = await downloadTelegramFile(ctx, doc.file_id);
    await handleChecklistImageUpload(ctx, user, activeRun, nextQ, buffer);
  } catch (error) {
    console.error('[document handler error]', error);
    await ctx.reply('Произошла ошибка при обработке фото. Попробуйте ещё раз.');
  }
});

// --- Обработка текста ---

bot.on('text', async (ctx) => {
  const from = ctx.from;
  const message = ctx.message;

  if (!from || !('text' in message)) return;

  const text = message.text.trim();

  // Кнопки основного меню — матчим во всех поддерживаемых языках
  const menuButton = getMenuButtonKey(text);

  if (menuButton === 'start') {
    await handleStart(ctx);
    return;
  }

  if (menuButton === 'menu') {
    const telegramId = String(from.id);
    if (telegramId === config.OWNER_ID || isAdmin(telegramId)) {
      await sendAdminMenu(ctx);
      return;
    }

    const user = await getRegisteredUser(ctx);
    if (!user) {
      await ctx.reply('Ты ещё не зарегистрирован. Нажми /start.');
      return;
    }
    const activeRun = await findActiveRun(user.id);
    if (activeRun) {
      await ctx.reply(
        `У вас есть незавершённый чек-лист: "${activeRun.checklist.title}".\nПродолжаем с текущего вопроса.`,
      );
      await sendCurrentQuestion(ctx, activeRun.id);
      return;
    }
    await showAvailableChecklists(ctx, user);
    return;
  }

  if (menuButton === 'switch_role') {
    const user = await getRegisteredUser(ctx);
    if (!user) {
      await ctx.reply('Ты ещё не зарегистрирован. Нажми /start.');
      return;
    }
    const activeRun = await findActiveRun(user.id);
    if (activeRun) {
      await ctx.reply(
        `Нельзя сменить роль во время чек-листа "${activeRun.checklist.title}". Завершите его сначала.`,
      );
      return;
    }
    await sendRoleSwitchMenu(ctx, user);
    return;
  }

  if (menuButton === 'register') {
    const user = await getRegisteredUser(ctx);
    if (user) {
      const activeRun = await findActiveRun(user.id);
      if (activeRun) {
        await ctx.reply(
          `Нельзя перерегистрироваться во время чек-листа. Завершите "${activeRun.checklist.title}" сначала.`,
        );
        return;
      }
    }
    registrationState.set(from.id, { step: 'awaiting_name', mode: 'register' });
    await ctx.reply('Регистрация открыта. Напиши имя/фамилию одним сообщением.');
    return;
  }

  // Команды — пропускаем
  if (text.startsWith('/')) return;

  // Регистрация FSM
  const state = registrationState.get(from.id);

  if (state) {
    if (state.step === 'awaiting_language') {
      const matched = allLanguages.find(
        (lang) =>
          lang.nativeLabel === text ||
          lang.label.toLowerCase() === text.toLowerCase() ||
          lang.code === text.toLowerCase(),
      );

      if (!matched) {
        await ctx.reply('Выберите язык кнопкой / Pick a language from the keyboard');
        return;
      }

      state.tempLanguage = matched.code;

      // For "add_role" mode we already have a name, so go straight to role step
      if (state.mode === 'add_role') {
        await sendAddRoleStep(ctx, from.id);
        return;
      }

      state.step = 'awaiting_name';
      await ctx.reply(t(matched.code, 'enter_name'));
      return;
    }

    if (state.step === 'awaiting_name') {
      if (text.length < 2) {
        await ctx.reply(t(state.tempLanguage, 'name_too_short'));
        return;
      }

      state.tempName = text;
      state.step = 'awaiting_role';

      const langCode = state.tempLanguage ?? 'ru';
      const availableRoles = getRolesForLanguage(langCode);

      const keyboard = Markup.keyboard(availableRoles.map((role) => role.label))
        .oneTime()
        .resize();

      await ctx.reply(t(langCode, 'choose_role'), keyboard);
      return;
    }

    if (state.step === 'awaiting_role') {
      const langCode = state.tempLanguage ?? 'ru';
      let roleConfig = findRoleByLabel(text);

      // Для не-русских языков клавиатура с ролями переводится i18n-middleware,
      // поэтому пользователь присылает обратно переведённый ярлык. Сверяем его
      // с тем же переводом через кеш (translate() возвращает кешированное
      // значение мгновенно, т. к. оно уже сохранено при отправке клавиатуры).
      if (!roleConfig && langCode !== 'ru') {
        const trimmed = text.trim().toLowerCase();
        for (const candidate of roles) {
          try {
            const translated = (await translate(candidate.label, langCode, 'ru'))
              .trim()
              .toLowerCase();
            if (translated && translated === trimmed) {
              roleConfig = candidate;
              break;
            }
          } catch {
            // Игнорируем ошибки перевода — пользователь получит role_not_recognized
          }
        }
      }

      if (!roleConfig) {
        await ctx.reply(t(state.tempLanguage, 'role_not_recognized'));
        return;
      }

      // Verify the chosen role supports the picked language
      if (!roleConfig.languages.includes(langCode as LanguageCode)) {
        // Fall back to a supported language for this role (unlikely path since we filter)
        await ctx.reply(t(state.tempLanguage, 'role_not_recognized'));
        return;
      }

      state.tempRole = roleConfig.key;
      await finalizeRegistrationOrAdd(ctx, state, langCode as LanguageCode);
      return;
    }
  }

  const user = await getRegisteredUser(ctx);

  const pendingSkip = skipCommentState.get(from.id);
  if (pendingSkip && user) {
    await completeSkipWithComment(ctx, user, pendingSkip, text);
    return;
  }

  // Если у пользователя активный run — напомнить что нужно фото
  if (user) {
    const activeRun = await findActiveRun(user.id);
    if (activeRun) {
      const nextQ = await getNextQuestion(activeRun.id);
      if (nextQ?.pendingAnswer) {
        await ctx.reply('Выберите результат по предыдущему фото кнопками под сообщением.');
        return;
      }

      if (nextQ?.question.taskType === 'confirm') {
        await ctx.reply('Выберите ответ кнопками под сообщением: ✔️ Да или ✖️ Нет.');
        return;
      }

      if (nextQ?.question.taskType === 'confirm_photo') {
        await ctx.reply('Пожалуйста, отправьте фото. После этого появятся кнопки ✔️ Да и ✖️ Нет.');
        return;
      }

      await ctx.reply('Пожалуйста, отправьте фото.');
      return;
    }
  }
});
