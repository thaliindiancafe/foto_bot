import Database from 'better-sqlite3';

const TELEGRAM_ID = '943657550';
const db = new Database('dev.db');

// Узнаём реальные имена таблиц
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
console.log('Tables:', tables.map(t => t.name).join(', '));

// Ищем пользователя
const userTable = tables.find(t => t.name.toLowerCase() === 'user')?.name;
if (!userTable) {
  console.log('No User table found');
  process.exit(0);
}

const user = db.prepare(`SELECT id, displayName, role, location FROM "${userTable}" WHERE telegramId = ?`).get(TELEGRAM_ID);
if (!user) {
  console.log('User not found');
  process.exit(0);
}
console.log('Found user:', user);

const runs = db.prepare(`SELECT id FROM Run WHERE userId = ?`).all(user.id);
const runIds = runs.map(r => r.id);

if (runIds.length) {
  const ph = runIds.map(() => '?').join(',');
  db.prepare(`DELETE FROM Answer WHERE runId IN (${ph})`).run(...runIds);
  try { db.prepare(`DELETE FROM Violation WHERE runId IN (${ph})`).run(...runIds); } catch {}
  db.prepare(`DELETE FROM Run WHERE userId = ?`).run(user.id);
  console.log(`Deleted ${runIds.length} runs + answers + violations`);
}

try { db.prepare(`DELETE FROM Shift WHERE userId = ?`).run(user.id); } catch {}
try { db.prepare(`DELETE FROM Outbox WHERE 1=1`).run(); } catch {}
db.prepare(`DELETE FROM "${userTable}" WHERE id = ?`).run(user.id);
console.log('User deleted. You can now /start and pick barista.');
db.close();
