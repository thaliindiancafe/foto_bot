import { Telegraf, Markup } from 'telegraf';
import type { Context } from 'telegraf';
import { config, isAdmin } from '../config/index.js';
import { prisma } from '../db/client.js';
import { roles } from '../config/roles.js';

// --- FSM типы ---

type AdminStep =
  | { type: 'newTitle' }
  | { type: 'newRole'; title: string }
  | { type: 'newType'; title: string; role: string }
  | { type: 'newTime'; title: string; role: string; clType: string }
  | { type: 'newQuestion'; checklistId: number; questions: string[] }
  | { type: 'editTitle'; checklistId: number }
  | { type: 'editTime'; checklistId: number }
  | { type: 'addQuestion'; checklistId: number }
  | { type: 'addQuestionAi'; checklistId: number; questionText: string }
  | { type: 'editQText'; questionId: number }
  | { type: 'confirmDelChecklist'; checklistId: number }
  | { type: 'confirmDelQuestion'; questionId: number };

const adminState = new Map<number, AdminStep>();

function isAdminOrOwner(telegramId: string): boolean {
  return telegramId === config.OWNER_ID || isAdmin(telegramId);
}

function generateKey(type: string, role: string): string {
  const ts = Date.now().toString(36);
  return `${type}_${role}_${ts}`;
}

/** Telegram не принимает сообщения длиннее ~4096 символов — админка падала молча на длинных чек-листах (менеджер). */
const TELEGRAM_MESSAGE_SAFE = 3800;

function singleLinePreview(text: string, maxLen: number): string {
  const s = text.replace(/\r\n/g, '\n').replace(/\n+/g, ' ').replace(/\s+/g, ' ').trim();
  if (s.length <= maxLen) return s;
  return `${s.slice(0, Math.max(1, maxLen - 1))}…`;
}

// --- Хелперы ---

async function sendChecklistView(ctx: Context, checklistId: number) {
  const cl = await prisma.checklist.findUnique({
    where: { id: checklistId },
    include: { questions: { orderBy: { order: 'asc' } } },
  });
  if (!cl) {
    await ctx.reply('Чек-лист не найден.');
    return;
  }

  const roleLabel = roles.find((r) => r.key === cl.role)?.label ?? cl.role;
  const typeLabels: Record<string, string> = {
    open: 'Открытие',
    close: 'Закрытие',
    periodic: 'Периодический',
    manual: 'Ручной',
    handover_open: 'Пересменка-открытие',
    handover_close: 'Пересменка-закрытие',
  };
  const typeLabel = typeLabels[cl.type] ?? cl.type;

  let schedule = '';
  if (cl.timeWindows) {
    try {
      const windows = JSON.parse(cl.timeWindows) as { start: string; end: string }[];
      schedule = windows.map((w) => `${w.start}–${w.end}`).join(', ');
    } catch { schedule = cl.timeWindows; }
  } else if (cl.intervalHours) {
    schedule = `каждые ${cl.intervalHours}ч`;
  }

  const headerLines = [
    `📋 ${cl.title}`,
    `Роль: ${roleLabel} | Тип: ${typeLabel}`,
    schedule ? `Расписание: ${schedule}` : '',
    `Всего вопросов: ${cl.questions.length}`,
    '',
    'Превью (полный текст — по кнопке пункта ниже):',
  ];
  const header = headerLines.filter(Boolean).join('\n');

  const previewLines: string[] = [];
  let budget = TELEGRAM_MESSAGE_SAFE - header.length - 80;

  if (cl.questions.length === 0) {
    previewLines.push('(нет вопросов)');
  } else {
    for (let i = 0; i < cl.questions.length; i++) {
      const q = cl.questions[i];
      const aiBit = q.aiRule ? ` · AI: ${singleLinePreview(q.aiRule, 70)}` : '';
      const line = `${i + 1}. ${singleLinePreview(q.text, 200)}${aiBit}`;
      if (line.length + 1 > budget) {
        previewLines.push(`… ещё ${cl.questions.length - i} вопрос(ов) — откройте по кнопкам ниже`);
        break;
      }
      previewLines.push(line);
      budget -= line.length + 1;
    }
  }

  const messageText = [header, ...previewLines].join('\n');

  // Кнопки вопросов
  const qButtons = cl.questions.map((q, i) => [
    Markup.button.callback(`${i + 1}. ${q.text.slice(0, 40)}`, `cl:viewQ:${q.id}`),
  ]);

  const actionButtons = [
    [
      Markup.button.callback('✏️ Название', `cl:editTitle:${cl.id}`),
      Markup.button.callback('⏰ Расписание', `cl:editTime:${cl.id}`),
    ],
    [
      Markup.button.callback('+ Вопрос', `cl:addQ:${cl.id}`),
      Markup.button.callback('🗑 Удалить', `cl:del:${cl.id}`),
    ],
    [Markup.button.callback('« Назад к списку', 'cl:list')],
  ];

  const keyboard = Markup.inlineKeyboard([...qButtons, ...actionButtons]);

  try {
    await ctx.reply(messageText, keyboard);
  } catch (error) {
    console.error('[sendChecklistView] reply failed', error);
    await ctx.reply(
      `📋 ${cl.title}\n\nНе удалось отправить превью (слишком длинно для Telegram). Список вопросов — кнопками ниже.`,
      keyboard,
    );
  }
}

export async function sendChecklistList(ctx: Context) {
  // Показываем только русские источники. Переводы (_en/_hi/_fa) — машинные,
  // регенерируются при каждом «📥 Обновить из таблицы», редактировать их
  // руками бессмысленно: правки сотрутся на ближайшем синке.
  const checklists = await prisma.checklist.findMany({
    where: {
      role: { not: 'archived' },
      language: 'ru',
    },
    orderBy: [{ role: 'asc' }, { displayOrder: 'asc' }, { title: 'asc' }],
  });

  if (checklists.length === 0) {
    await ctx.reply('Нет чек-листов.', Markup.inlineKeyboard([
      [Markup.button.callback('+ Создать чек-лист', 'cl:new')],
    ]));
    return;
  }

  // Группировка по ролям
  const grouped = new Map<string, typeof checklists>();
  for (const cl of checklists) {
    const list = grouped.get(cl.role) ?? [];
    list.push(cl);
    grouped.set(cl.role, list);
  }

  const buttons: ReturnType<typeof Markup.button.callback>[][] = [];

  for (const [roleKey, cls] of grouped) {
    const roleLabel = roles.find((r) => r.key === roleKey)?.label ?? roleKey;
    // Заголовок роли как неактивная кнопка
    buttons.push([Markup.button.callback(`— ${roleLabel} —`, `cl:noop`)]);
    for (const cl of cls) {
      buttons.push([Markup.button.callback(cl.title, `cl:view:${cl.id}`)]);
    }
  }

  buttons.push([Markup.button.callback('+ Создать чек-лист', 'cl:new')]);

  await ctx.reply(
    '📋 Управление чек-листами\n\n' +
      '<i>Показаны русские оригиналы. Переводы на английский, хинди и фарси ' +
      'делает OpenAI автоматически при «Обновить из таблицы».</i>',
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard(buttons),
    },
  );
}

// --- Регистрация хендлеров ---

export function registerChecklistAdmin(bot: Telegraf<Context>) {

  // Команда /checklists
  bot.command('checklists', async (ctx) => {
    const from = ctx.from;
    if (!from || !isAdminOrOwner(String(from.id))) return;
    adminState.delete(from.id);
    await sendChecklistList(ctx);
  });

  // Noop для заголовков групп ролей (не чек-лист)
  bot.action('cl:noop', async (ctx) => {
    await ctx.answerCbQuery('Это заголовок раздела. Выберите чек-лист под ним.');
  });

  // Назад к списку
  bot.action('cl:list', async (ctx) => {
    await ctx.answerCbQuery();
    const from = ctx.from;
    if (!from || !isAdminOrOwner(String(from.id))) return;
    adminState.delete(from.id);
    await sendChecklistList(ctx);
  });

  // --- Просмотр чек-листа ---
  bot.action(/^cl:view:(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const from = ctx.from;
    if (!from || !isAdminOrOwner(String(from.id))) return;
    adminState.delete(from.id);
    const id = Number(ctx.match[1]);
    await sendChecklistView(ctx, id);
  });

  // --- Просмотр вопроса ---
  bot.action(/^cl:viewQ:(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const from = ctx.from;
    if (!from || !isAdminOrOwner(String(from.id))) return;

    const qId = Number(ctx.match[1]);
    const q = await prisma.question.findUnique({
      where: { id: qId },
      include: { checklist: true },
    });
    if (!q) {
      await ctx.reply('Вопрос не найден.');
      return;
    }

    const aiText = q.aiRule ?? 'нет';
    const typeLine =
      q.taskType === 'confirm'
        ? 'Тип: подтверждение (✔️ Да / ✖️ Нет, без фото)'
        : 'Тип: фото (сотрудник отправляет снимок)';
    const text = [
      `Вопрос #${q.order}: ${q.text}`,
      typeLine,
      `AI-правило: ${aiText}`,
    ].join('\n');

    await ctx.reply(text, Markup.inlineKeyboard([
      [
        Markup.button.callback('✏️ Текст', `cl:editQText:${q.id}`),
        Markup.button.callback('🤖 AI-правило', `cl:editQAi:${q.id}`),
      ],
      [Markup.button.callback('🗑 Удалить', `cl:delQ:${q.id}`)],
      [Markup.button.callback('« Назад к чек-листу', `cl:view:${q.checklistId}`)],
    ]));
  });

  // --- Создание чек-листа: шаг 1 - запрос названия ---
  bot.action('cl:new', async (ctx) => {
    await ctx.answerCbQuery();
    const from = ctx.from;
    if (!from || !isAdminOrOwner(String(from.id))) return;

    adminState.set(from.id, { type: 'newTitle' });
    await ctx.reply('Введите название нового чек-листа:');
  });

  // --- Создание: шаг 3 - выбор роли ---
  bot.action(/^cl:newRole:(.+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const from = ctx.from;
    if (!from || !isAdminOrOwner(String(from.id))) return;

    const state = adminState.get(from.id);
    if (!state || state.type !== 'newRole') return;

    const roleKey = ctx.match[1];
    adminState.set(from.id, { type: 'newType', title: state.title, role: roleKey });

      await ctx.reply('Выберите тип чек-листа:', Markup.inlineKeyboard([
        [Markup.button.callback('Открытие (open)', 'cl:newType:open')],
        [Markup.button.callback('Закрытие (close)', 'cl:newType:close')],
        [Markup.button.callback('Периодический (periodic)', 'cl:newType:periodic')],
        [Markup.button.callback('Пересменка-открытие', 'cl:newType:handover_open')],
        [Markup.button.callback('Пересменка-закрытие', 'cl:newType:handover_close')],
      ]));
  });

  // --- Создание: шаг 4 - выбор типа ---
  bot.action(/^cl:newType:(.+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const from = ctx.from;
    if (!from || !isAdminOrOwner(String(from.id))) return;

    const state = adminState.get(from.id);
    if (!state || state.type !== 'newType') return;

    const clType = ctx.match[1];
    adminState.set(from.id, { type: 'newTime', title: state.title, role: state.role, clType });

    if (clType === 'periodic') {
      await ctx.reply('Введите интервал в часах (например: 2):');
    } else {
      await ctx.reply('Введите расписание (формат 08:00-10:00):');
    }
  });

  // --- Создание: кнопка "Ещё вопрос" ---
  bot.action(/^cl:newMoreQ:(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const from = ctx.from;
    if (!from || !isAdminOrOwner(String(from.id))) return;

    const state = adminState.get(from.id);
    if (!state || state.type !== 'newQuestion') return;

    await ctx.reply('Введите текст следующего вопроса:');
  });

  // --- Создание: кнопка "Готово" ---
  bot.action(/^cl:newDone:(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const from = ctx.from;
    if (!from || !isAdminOrOwner(String(from.id))) return;

    const checklistId = Number(ctx.match[1]);
    adminState.delete(from.id);

    await ctx.reply('✅ Чек-лист создан!');
    await sendChecklistView(ctx, checklistId);
  });

  // --- Редактирование названия ---
  bot.action(/^cl:editTitle:(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const from = ctx.from;
    if (!from || !isAdminOrOwner(String(from.id))) return;

    const id = Number(ctx.match[1]);
    const cl = await prisma.checklist.findUnique({ where: { id } });
    if (!cl) {
      await ctx.reply('Чек-лист не найден.');
      return;
    }

    adminState.set(from.id, { type: 'editTitle', checklistId: id });
    await ctx.reply(`Текущее название: ${cl.title}\nВведите новое:`);
  });

  // --- Редактирование расписания ---
  bot.action(/^cl:editTime:(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const from = ctx.from;
    if (!from || !isAdminOrOwner(String(from.id))) return;

    const id = Number(ctx.match[1]);
    const cl = await prisma.checklist.findUnique({ where: { id } });
    if (!cl) {
      await ctx.reply('Чек-лист не найден.');
      return;
    }

    adminState.set(from.id, { type: 'editTime', checklistId: id });

    if (cl.type === 'periodic') {
      await ctx.reply(`Текущий интервал: ${cl.intervalHours ?? '—'}ч\nВведите новый интервал в часах:`);
    } else {
      let current = '—';
      if (cl.timeWindows) {
        try {
          const w = JSON.parse(cl.timeWindows) as { start: string; end: string }[];
          current = w.map((x) => `${x.start}-${x.end}`).join(', ');
        } catch { current = cl.timeWindows; }
      }
      await ctx.reply(`Текущее расписание: ${current}\nВведите новое (формат 08:00-10:00):`);
    }
  });

  // --- Добавление вопроса ---
  bot.action(/^cl:addQ:(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const from = ctx.from;
    if (!from || !isAdminOrOwner(String(from.id))) return;

    const id = Number(ctx.match[1]);
    adminState.set(from.id, { type: 'addQuestion', checklistId: id });
    await ctx.reply('Введите текст вопроса:');
  });

  // --- AI-правило для добавленного вопроса ---
  bot.action(/^cl:setAi:(\d+):(.+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const from = ctx.from;
    if (!from || !isAdminOrOwner(String(from.id))) return;

    const qId = Number(ctx.match[1]);
    const rule = ctx.match[2] === 'none' ? null : ctx.match[2];

    await prisma.question.update({ where: { id: qId }, data: { aiRule: rule } });

    const q = await prisma.question.findUnique({ where: { id: qId } });
    if (!q) return;

    // Проверяем, находимся ли мы в процессе создания нового чек-листа
    const state = adminState.get(from.id);
    if (state && state.type === 'addQuestionAi') {
      adminState.delete(from.id);
      await ctx.reply('✅ Вопрос добавлен и сохранён.\nВыберите следующее действие:');
      await sendChecklistView(ctx, q.checklistId);
      return;
    }

    adminState.delete(from.id);
    await ctx.reply('✅ AI-правило обновлено и сохранено.\nВыберите следующее действие:');
    await sendChecklistView(ctx, q.checklistId);
  });

  // --- Редактирование AI-правила вопроса ---
  bot.action(/^cl:editQAi:(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const from = ctx.from;
    if (!from || !isAdminOrOwner(String(from.id))) return;

    const qId = Number(ctx.match[1]);

    await ctx.reply('Выберите AI-правило:', Markup.inlineKeyboard([
      [Markup.button.callback('👕 Проверка формы', `cl:setAi:${qId}:uniform_check`)],
      [Markup.button.callback('🧼 Проверка чистоты', `cl:setAi:${qId}:cleanliness_check`)],
      [Markup.button.callback('☕ Проверка кофемашины', `cl:setAi:${qId}:steam_check`)],
      [Markup.button.callback('Убрать правило', `cl:setAi:${qId}:none`)],
    ]));
  });

  // --- Редактирование текста вопроса ---
  bot.action(/^cl:editQText:(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const from = ctx.from;
    if (!from || !isAdminOrOwner(String(from.id))) return;

    const qId = Number(ctx.match[1]);
    const q = await prisma.question.findUnique({ where: { id: qId } });
    if (!q) {
      await ctx.reply('Вопрос не найден.');
      return;
    }

    adminState.set(from.id, { type: 'editQText', questionId: qId });
    await ctx.reply(`Текущий текст: ${q.text}\nВведите новый:`);
  });

  // --- Удаление вопроса ---
  bot.action(/^cl:delQ:(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const from = ctx.from;
    if (!from || !isAdminOrOwner(String(from.id))) return;

    const qId = Number(ctx.match[1]);
    const q = await prisma.question.findUnique({ where: { id: qId } });
    if (!q) {
      await ctx.reply('Вопрос не найден.');
      return;
    }

    adminState.set(from.id, { type: 'confirmDelQuestion', questionId: qId });
    await ctx.reply(`Удалить вопрос "${q.text}"?`, Markup.inlineKeyboard([
      [
        Markup.button.callback('Да, удалить', `cl:confirmDelQ:${qId}`),
        Markup.button.callback('Отмена', `cl:view:${q.checklistId}`),
      ],
    ]));
  });

  bot.action(/^cl:confirmDelQ:(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const from = ctx.from;
    if (!from || !isAdminOrOwner(String(from.id))) return;

    const qId = Number(ctx.match[1]);
    const q = await prisma.question.findUnique({ where: { id: qId } });
    if (!q) {
      await ctx.reply('Вопрос не найден.');
      return;
    }

    const checklistId = q.checklistId;
    await prisma.question.delete({ where: { id: qId } });
    adminState.delete(from.id);

    await ctx.reply('✅ Вопрос удалён.\nВыберите следующее действие:');
    await sendChecklistView(ctx, checklistId);
  });

  // --- Удаление чек-листа ---
  bot.action(/^cl:del:(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const from = ctx.from;
    if (!from || !isAdminOrOwner(String(from.id))) return;

    const id = Number(ctx.match[1]);
    const cl = await prisma.checklist.findUnique({
      where: { id },
      include: { questions: true, runs: { where: { completedAt: null } } },
    });
    if (!cl) {
      await ctx.reply('Чек-лист не найден.');
      return;
    }

    if (cl.runs.length > 0) {
      await ctx.reply(`Нельзя удалить: есть ${cl.runs.length} незавершённых прохождений.`);
      return;
    }

    adminState.set(from.id, { type: 'confirmDelChecklist', checklistId: id });
    await ctx.reply(
      `Удалить чек-лист "${cl.title}" и все ${cl.questions.length} вопросов?`,
      Markup.inlineKeyboard([
        [
          Markup.button.callback('Да, удалить', `cl:confirmDel:${id}`),
          Markup.button.callback('Отмена', `cl:view:${id}`),
        ],
      ]),
    );
  });

  bot.action(/^cl:confirmDel:(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const from = ctx.from;
    if (!from || !isAdminOrOwner(String(from.id))) return;

    const id = Number(ctx.match[1]);

    // Удаляем связанные answers и runs перед удалением чек-листа
    await prisma.answer.deleteMany({ where: { run: { checklistId: id } } });
    await prisma.run.deleteMany({ where: { checklistId: id } });
    await prisma.checklist.delete({ where: { id } });

    adminState.delete(from.id);
    await ctx.reply('✅ Чек-лист удалён.');
    await sendChecklistList(ctx);
  });

  // --- Обработка текста для FSM ---
  bot.on('text', async (ctx, next) => {
    const from = ctx.from;
    if (!from || !isAdminOrOwner(String(from.id))) return next();

    const state = adminState.get(from.id);
    if (!state) return next();

    const text = ctx.message.text.trim();
    if (text.startsWith('/')) {
      adminState.delete(from.id);
      return;
    }

    // --- Создание: ввод названия ---
    if (state.type === 'newTitle') {
      if (text.length < 2) {
        await ctx.reply('Название слишком короткое. Введите ещё раз:');
        return;
      }
      adminState.set(from.id, { type: 'newRole', title: text });

      const roleButtons = roles.map((r) => [
        Markup.button.callback(r.label, `cl:newRole:${r.key}`),
      ]);
      await ctx.reply('Выберите роль:', Markup.inlineKeyboard(roleButtons));
      return;
    }

    // --- Создание: ввод расписания ---
    if (state.type === 'newTime') {
      let timeWindows: string | null = null;
      let intervalHours: number | null = null;

      if (state.clType === 'periodic') {
        const hours = parseInt(text, 10);
        if (isNaN(hours) || hours < 1 || hours > 24) {
          await ctx.reply('Введите число от 1 до 24:');
          return;
        }
        intervalHours = hours;
      } else {
        const match = text.match(/^(\d{1,2}:\d{2})\s*[-–]\s*(\d{1,2}:\d{2})$/);
        if (!match) {
          await ctx.reply('Неверный формат. Введите в формате 08:00-10:00:');
          return;
        }
        timeWindows = JSON.stringify([{ start: match[1], end: match[2] }]);
      }

      // Создаём чек-лист в БД
      const key = generateKey(state.clType, state.role);
      const cl = await prisma.checklist.create({
        data: {
          key,
          title: state.title,
          description: `${state.role} — ${state.clType}`,
          role: state.role,
          type: state.clType,
          timeWindows,
          intervalHours,
        },
      });

      adminState.set(from.id, { type: 'newQuestion', checklistId: cl.id, questions: [] });
      await ctx.reply('Чек-лист создан. Введите текст первого вопроса:');
      return;
    }

    // --- Создание: ввод вопросов ---
    if (state.type === 'newQuestion') {
      if (text.length < 2) {
        await ctx.reply('Текст вопроса слишком короткий. Введите ещё раз:');
        return;
      }

      const maxOrder = await prisma.question.findFirst({
        where: { checklistId: state.checklistId },
        orderBy: { order: 'desc' },
        select: { order: true },
      });
      const nextOrder = (maxOrder?.order ?? 0) + 1;

      await prisma.question.create({
        data: {
          checklistId: state.checklistId,
          text,
          order: nextOrder,
          isRequired: true,
        },
      });

      state.questions.push(text);

      await ctx.reply(
        `Вопрос #${nextOrder} добавлен.`,
        Markup.inlineKeyboard([
          [
            Markup.button.callback('+ Ещё вопрос', `cl:newMoreQ:${state.checklistId}`),
            Markup.button.callback('✅ Готово', `cl:newDone:${state.checklistId}`),
          ],
        ]),
      );
      return;
    }

    // --- Редактирование названия ---
    if (state.type === 'editTitle') {
      if (text.length < 2) {
        await ctx.reply('Название слишком короткое. Введите ещё раз:');
        return;
      }
      await prisma.checklist.update({
        where: { id: state.checklistId },
        data: { title: text },
      });
      adminState.delete(from.id);
      await ctx.reply('✅ Название обновлено и сохранено.\nВыберите следующее действие:');
      await sendChecklistView(ctx, state.checklistId);
      return;
    }

    // --- Редактирование расписания ---
    if (state.type === 'editTime') {
      const cl = await prisma.checklist.findUnique({ where: { id: state.checklistId } });
      if (!cl) {
        adminState.delete(from.id);
        await ctx.reply('Чек-лист не найден.');
        return;
      }

      if (cl.type === 'periodic') {
        const hours = parseInt(text, 10);
        if (isNaN(hours) || hours < 1 || hours > 24) {
          await ctx.reply('Введите число от 1 до 24:');
          return;
        }
        await prisma.checklist.update({
          where: { id: state.checklistId },
          data: { intervalHours: hours },
        });
      } else {
        const match = text.match(/^(\d{1,2}:\d{2})\s*[-–]\s*(\d{1,2}:\d{2})$/);
        if (!match) {
          await ctx.reply('Неверный формат. Введите в формате 08:00-10:00:');
          return;
        }
        await prisma.checklist.update({
          where: { id: state.checklistId },
          data: { timeWindows: JSON.stringify([{ start: match[1], end: match[2] }]) },
        });
      }

      adminState.delete(from.id);
      await ctx.reply('✅ Расписание обновлено и сохранено.\nВыберите следующее действие:');
      await sendChecklistView(ctx, state.checklistId);
      return;
    }

    // --- Добавление вопроса ---
    if (state.type === 'addQuestion') {
      if (text.length < 2) {
        await ctx.reply('Текст вопроса слишком короткий. Введите ещё раз:');
        return;
      }

      const maxOrder = await prisma.question.findFirst({
        where: { checklistId: state.checklistId },
        orderBy: { order: 'desc' },
        select: { order: true },
      });
      const nextOrder = (maxOrder?.order ?? 0) + 1;

      const q = await prisma.question.create({
        data: {
          checklistId: state.checklistId,
          text,
          order: nextOrder,
          isRequired: true,
        },
      });

      adminState.set(from.id, { type: 'addQuestionAi', checklistId: state.checklistId, questionText: text });

      await ctx.reply('Добавить AI-правило?', Markup.inlineKeyboard([
        [Markup.button.callback('👕 Проверка формы', `cl:setAi:${q.id}:uniform_check`)],
        [Markup.button.callback('🧼 Проверка чистоты', `cl:setAi:${q.id}:cleanliness_check`)],
        [Markup.button.callback('☕ Проверка кофемашины', `cl:setAi:${q.id}:steam_check`)],
        [Markup.button.callback('Без правила', `cl:setAi:${q.id}:none`)],
      ]));
      return;
    }

    // --- Редактирование текста вопроса ---
    if (state.type === 'editQText') {
      if (text.length < 2) {
        await ctx.reply('Текст слишком короткий. Введите ещё раз:');
        return;
      }
      const q = await prisma.question.update({
        where: { id: state.questionId },
        data: { text },
      });
      adminState.delete(from.id);
      await ctx.reply('✅ Текст вопроса обновлён и сохранён.\nВыберите следующее действие:');
      await sendChecklistView(ctx, q.checklistId);
      return;
    }
  });
}
