import Database from 'better-sqlite3';

const db = new Database('dev.db', { readonly: true });

const tz = { hour12: false, timeZone: 'Europe/Moscow' };
const fmt = (iso) => iso ? new Date(iso).toLocaleString('ru-RU', tz) : '—';

console.log('=== Все пользователи ===');
const users = db.prepare(`SELECT id, displayName, firstName, role, location, language FROM User ORDER BY id`).all();
for (const u of users) {
  console.log(`  id=${u.id} ${u.displayName ?? u.firstName} role=${u.role ?? 'NULL'} loc=${u.location ?? 'NULL'} lang=${u.language ?? 'NULL'}`);
}

console.log('\n=== Таблица Shift (то, что должно быть во вкладке "Смены") ===');
const shifts = db.prepare(`
  SELECT s.id, s.startedAt, s.endedAt, s.minutes, s.failCount,
         u.displayName, u.firstName, u.role, u.location
  FROM Shift s
  LEFT JOIN User u ON u.id = s.userId
  ORDER BY s.startedAt DESC
`).all();
for (const s of shifts) {
  const name = s.displayName ?? s.firstName ?? '?';
  const hours = (s.minutes / 60).toFixed(1);
  console.log(`  id=${s.id} ${name} (${s.role}/${s.location}) ${fmt(s.startedAt)} → ${fmt(s.endedAt)} | ${s.minutes} мин (${hours}ч) | fail=${s.failCount}`);
}

console.log('\n=== Завершённые close-чек-листы (Run.completedAt != NULL, type=close) ===');
const closeRuns = db.prepare(`
  SELECT r.id, r.startedAt, r.completedAt, r.shiftId,
         u.displayName, u.firstName, u.role, u.location,
         c.title as title, c.type as type
  FROM Run r
  LEFT JOIN User u ON u.id = r.userId
  LEFT JOIN Checklist c ON c.id = r.checklistId
  WHERE r.completedAt IS NOT NULL AND c.type = 'close'
  ORDER BY r.completedAt DESC
`).all();
if (!closeRuns.length) console.log('  (пусто)');
for (const r of closeRuns) {
  const name = r.displayName ?? r.firstName ?? '?';
  console.log(`  run=${r.id} ${name} (${r.role}/${r.location}) "${r.title}" ${fmt(r.completedAt)} | shiftId=${r.shiftId ?? 'NULL'}`);
}

console.log('\n=== Завершённые чек-листы за 14 дней — кто реально работает ===');
const cutoff = new Date(Date.now() - 14 * 24 * 3600 * 1000).toISOString();
const recentRuns = db.prepare(`
  SELECT r.id, r.completedAt,
         u.displayName, u.firstName, u.role, u.location,
         c.title, c.type
  FROM Run r
  LEFT JOIN User u ON u.id = r.userId
  LEFT JOIN Checklist c ON c.id = r.checklistId
  WHERE r.completedAt IS NOT NULL AND r.completedAt >= ?
  ORDER BY r.completedAt DESC
  LIMIT 50
`).all(cutoff);
for (const r of recentRuns) {
  const name = r.displayName ?? r.firstName ?? '?';
  console.log(`  ${fmt(r.completedAt)} ${name} (${r.role}/${r.location}) [${r.type}] "${r.title}"`);
}

console.log('\n=== Outbox (события для Sheets) — pending / failed ===');
const outbox = db.prepare(`
  SELECT id, eventType, status, attempts, lastError, createdAt, nextRetryAt
  FROM Outbox
  WHERE status != 'sent'
  ORDER BY createdAt DESC
  LIMIT 40
`).all();
if (!outbox.length) console.log('  (всё отправлено)');
for (const o of outbox) {
  console.log(`  #${o.id} ${o.eventType} status=${o.status} attempts=${o.attempts} created=${fmt(o.createdAt)} err=${(o.lastError ?? '').slice(0, 120)}`);
}

console.log('\n=== Outbox последние 20 отправленных ===');
const sent = db.prepare(`
  SELECT id, eventType, status, attempts, createdAt
  FROM Outbox
  WHERE status = 'sent'
  ORDER BY createdAt DESC
  LIMIT 20
`).all();
for (const o of sent) {
  console.log(`  #${o.id} ${o.eventType} attempts=${o.attempts} ${fmt(o.createdAt)}`);
}

db.close();
