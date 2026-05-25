import { bot } from './bot/index.js';
import { config } from './config/index.js';
import { startScheduler } from './services/scheduler.js';

/**
 * Список получателей критических ошибок. Источник:
 * 1) ERROR_NOTIFY_IDS если задан (рекомендуемый, отдельно от админов);
 * 2) иначе — ПЕРВЫЙ из ADMIN_IDS (обычно разработчик; чтобы не вещать
 *    stack-trace всем подряд, как было раньше).
 *
 * Менеджеры-админы (Илана и др.) получают только бизнес-кнопки
 * админ-панели, но НЕ видят 🚨 stack-trace.
 */
function getErrorRecipients(): string[] {
  if (config.ERROR_NOTIFY_IDS.length > 0) return config.ERROR_NOTIFY_IDS;
  if (config.ADMIN_IDS.length > 0) return [config.ADMIN_IDS[0]];
  return [];
}

// Отправка критических ошибок разработчику в Telegram
const sendErrorToAdmins = async (error: unknown) => {
  const recipients = getErrorRecipients();
  const text = `🚨 Критическая ошибка бота:\n\n${error instanceof Error ? error.stack : String(error)}`;

  for (const recipient of recipients) {
    try {
      await bot.telegram.sendMessage(recipient, text);
    } catch {
      console.error('Не удалось отправить ошибку:', recipient);
    }
  }
};

process.on('uncaughtException', async (err) => {
  console.error('uncaughtException:', err);
  await sendErrorToAdmins(err);
});

process.on('unhandledRejection', async (reason) => {
  console.error('unhandledRejection:', reason);
  await sendErrorToAdmins(reason);
});

// Graceful shutdown
process.once('SIGINT', () => {
  bot.stop('SIGINT');
});
process.once('SIGTERM', () => {
  bot.stop('SIGTERM');
});

// Настройка меню команд и запуск
(async () => {
  try {
    // Команды для всех (сотрудники)
    await bot.telegram.setMyCommands([
      { command: 'start', description: 'Начало работы' },
    ], { scope: { type: 'default' } });

    // Команды для администраторов (из ADMIN_IDS)
    const adminCommands = [
      { command: 'start', description: 'Начало работы' },
      { command: 'menu', description: 'Панель управления' },
    ];

    const adminIds = process.env.ADMIN_IDS?.split(',') ?? [];
    for (const adminId of adminIds) {
      const chatId = Number(adminId.trim());
      try {
        await bot.telegram.setMyCommands(adminCommands, {
          scope: { type: 'chat', chat_id: chatId }
        });
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : String(error);
        console.error(`Не удалось установить команды для админа ${adminId.trim()}: ${message}`);
      }
    }
  } catch (error) {
    console.error('Startup error (setMyCommands):', error);
  }
})();

/**
 * Проверка ошибки 409 — «другой экземпляр бота опрашивает getUpdates».
 * Telegram разрешает только один процесс polling-а на токен. Если запущено
 * несколько копий (зомби-процесс после tsx watch, бот на ноуте + на сервере,
 * чужая копия с тем же токеном) — Telegram отдаёт 409 одному из них.
 */
function is409Conflict(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { response?: { error_code?: number; description?: string } };
  return e.response?.error_code === 409;
}

// Простое адресное оповещение разработчика без stack-trace и эмодзи «🚨».
// Использует тот же список получателей, что и критические ошибки (см.
// getErrorRecipients), потому что это тоже диагностика — менеджерам
// в админ-панели не нужно видеть сообщения про 409 Conflict и т. п.
async function notifyAdmins(text: string): Promise<void> {
  const recipients = getErrorRecipients();
  for (const recipient of recipients) {
    try {
      await bot.telegram.sendMessage(recipient, text);
    } catch {
      // молча игнорируем — это всего лишь уведомление
    }
  }
}

/**
 * Pre-flight проверка: дёргаем getUpdates один раз с короткой паузой —
 * этого достаточно, чтобы Telegram сразу вернул 409, если уже кто-то
 * polling-ит токен. Делаем ДО bot.launch(), чтобы не запускать polling
 * параллельно с конкурентом и не давить retry-каскадом.
 */
async function preflightCheck(): Promise<{ ok: true } | { ok: false; reason: 'conflict' | string }> {
  try {
    await bot.telegram.callApi('getUpdates', { offset: -1, limit: 1, timeout: 0 });
    return { ok: true };
  } catch (error) {
    if (is409Conflict(error)) {
      return { ok: false, reason: 'conflict' };
    }
    const msg = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: msg };
  }
}

/**
 * Запускаем бота с retry-логикой на 409 Conflict.
 *
 * Логика оповещений (минимум шума у админа):
 * - 1 сообщение при первом 409 — «обнаружен конфликт, переподключаюсь»;
 * - retry-попытки молча в логах (console);
 * - 1 итоговое сообщение либо «восстановился», либо «не смог, выхожу».
 *
 * После исчерпания попыток процесс выходит с exit 1 — пусть supervisor
 * (tsx watch локально, pm2/systemd на сервере) перезапустит.
 */
async function launchWithConflictRetry(): Promise<void> {
  const MAX_ATTEMPTS = 3;
  const WAIT_SECONDS = [15, 30, 60];

  let firstConflictNotified = false;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      await bot.launch();
      if (firstConflictNotified) {
        void notifyAdmins('✅ Бот восстановился после конфликта 409 и снова слушает обновления.');
      }
      console.log('Bot polling stopped normally');
      return;
    } catch (error) {
      if (!is409Conflict(error)) {
        console.error('Bot launch fatal error:', error);
        await notifyAdmins(
          `🚨 Критическая ошибка бота при запуске polling-а:\n\n${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        process.exit(1);
      }

      const isLast = attempt === MAX_ATTEMPTS;
      const waitSec = WAIT_SECONDS[attempt - 1] ?? 60;
      console.error(
        `[409 Conflict] Попытка ${attempt}/${MAX_ATTEMPTS}. ` +
          (isLast ? 'Последняя попытка — выход.' : `Жду ${waitSec}с.`),
      );

      // Только ОДНО сообщение админу — в самом начале серии retry, не на каждой.
      if (!firstConflictNotified && !isLast) {
        firstConflictNotified = true;
        void notifyAdmins(
          '⚠️ Обнаружен конфликт с другим экземпляром бота (409). ' +
            'Тихо переподключаюсь — об итоге доложу одним сообщением. ' +
            'Если ничего не пришлёт через 2 минуты — значит восстановился.',
        );
      }

      if (isLast) {
        await notifyAdmins(
          '❌ Не удалось переподключиться после 3 попыток (конфликт 409). ' +
            'Бот выходит. Проверь, не запущен ли он ещё где-то с тем же BOT_TOKEN ' +
            '(в другом окне терминала, на другом компьютере, на сервере). ' +
            'Когда лишний процесс будет остановлен — запусти бот заново (npm run dev).',
        );
        process.exit(1);
      }

      await new Promise((resolve) => setTimeout(resolve, waitSec * 1000));
    }
  }
}

// --- Старт ------------------------------------------------------------------

(async () => {
  // Сразу же делаем pre-flight: если уже есть конкурент — выходим с понятной
  // надписью в консоли БЕЗ оповещений админу. Запускающий процесс увидит
  // консоль и поймёт, что надо убить лишний экземпляр.
  const pre = await preflightCheck();
  if (!pre.ok) {
    if (pre.reason === 'conflict') {
      console.error(
        '\n❌ Не могу запустить бота: уже работает другой экземпляр с этим же BOT_TOKEN.\n' +
          '\nПроверь:\n' +
          '  1. Не запущен ли `npm run dev` в другом окне терминала?\n' +
          '  2. Не остался ли зомби-процесс? Помоги командой:\n' +
          '     Get-CimInstance Win32_Process -Filter "Name=\'node.exe\'" |\n' +
          '       Where-Object { $_.CommandLine -like \'*foto_bot*\' }\n' +
          '  3. Не запущен ли бот на другом компьютере / сервере?\n',
      );
    } else {
      console.error(`\n❌ Pre-flight check failed: ${pre.reason}\n`);
    }
    process.exit(1);
  }

  // Имя бота — для лога.
  try {
    const info = await bot.telegram.getMe();
    console.log(`✅ Bot started: @${info.username} (id=${info.id})`);
  } catch {
    // не критично
  }

  void launchWithConflictRetry();
})();

startScheduler(bot);
