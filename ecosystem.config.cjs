// PM2 ecosystem config — production (Beget VPS)
// Расширение .cjs обязательно: package.json имеет "type":"module",
// поэтому .js-файл PM2 попытается разобрать как ESM и упадёт.
//
// Перед первым запуском на сервере:
//   npm install
//   npx prisma generate
//   npm rebuild better-sqlite3
//   npx prisma db push
//   npm run db:seed
//   npm run build
//   pm2 start ecosystem.config.cjs --env production
//   pm2 save
//   pm2 startup   (следуй инструкции в выводе)

'use strict';

module.exports = {
  apps: [
    {
      name: 'foto-bot',

      // Запускаем скомпилированный JS напрямую, без npm-обёртки.
      // dotenv/config в src/config/index.ts подхватит .env из cwd ниже.
      script: 'node',
      args: 'dist/index.js',

      // Абсолютный путь к проекту на сервере.
      // Замени на реальный путь после клонирования репо на Бегете.
      // Пример: /home/username/foto_bot
      cwd: '/home/username/foto_bot',

      // Один процесс — Telegram-бот не масштабируется горизонтально
      // (getUpdates/webhook работает только с одним активным соединением).
      instances: 1,
      exec_mode: 'fork',

      // Не следить за файлами — в продакшне нет горячей перезагрузки.
      watch: false,

      // Перезапускать при падении.
      autorestart: true,

      // Если процесс умирает быстрее 10 секунд — это считается "crash",
      // PM2 не будет бесконечно рестартовать.
      min_uptime: '10s',
      max_restarts: 10,

      // Перезапустить если процесс съел слишком много памяти.
      max_memory_restart: '512M',

      // Время ожидания graceful-shutdown перед SIGKILL.
      kill_timeout: 5000,

      // Форматирование временных меток в pm2 logs.
      log_date_format: 'YYYY-MM-DD HH:mm:ss',

      // Логи пишем рядом с проектом.
      // Замени путь если нужен другой каталог.
      error_file: './logs/pm2-error.log',
      out_file: './logs/pm2-out.log',
      merge_logs: true,

      env_production: {
        NODE_ENV: 'production',
        // Часовой пояс обязателен: cron-расписание и штампы на фото
        // привязаны к Europe/Moscow.
        TZ: 'Europe/Moscow',
      },
    },
  ],
};
