import { prisma } from '../db/client.js';
import {
  appendSingleAnswer,
  recordShiftSummary,
  updateMonthlyStats,
  type SingleAnswerPayload,
  type ShiftSummaryPayload,
  type MonthlyStatsPayload,
} from './sheetsService.js';

export type OutboxEvent =
  | { type: 'answer'; payload: SingleAnswerPayload }
  | { type: 'shift_summary'; payload: ShiftSummaryPayload }
  | { type: 'monthly_stats'; payload: MonthlyStatsPayload };

// Backoff после каждой неудачи: 30с, 1м, 5м, 30м, 2ч — затем status=failed
const BACKOFF_SECONDS = [30, 60, 300, 1800, 7200];
const MAX_ATTEMPTS = BACKOFF_SECONDS.length;

async function dispatch(event: OutboxEvent): Promise<void> {
  switch (event.type) {
    case 'answer':
      return appendSingleAnswer(event.payload);
    case 'shift_summary':
      return recordShiftSummary(event.payload);
    case 'monthly_stats':
      return updateMonthlyStats(event.payload);
  }
}

async function attemptSend(rowId: number, event: OutboxEvent): Promise<void> {
  try {
    await dispatch(event);
    await prisma.outbox.update({
      where: { id: rowId },
      data: { status: 'sent', lastError: null },
    });
    console.log(`[outbox] sent ${event.type} (id=${rowId})`);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    const row = await prisma.outbox.findUnique({ where: { id: rowId } });
    if (!row) return;
    const attempts = row.attempts + 1;

    if (attempts >= MAX_ATTEMPTS) {
      await prisma.outbox.update({
        where: { id: rowId },
        data: { status: 'failed', attempts, lastError: errMsg },
      });
      console.error(`[outbox] ${event.type} (id=${rowId}) failed after ${attempts} attempts: ${errMsg}`);
      return;
    }

    const delaySec = BACKOFF_SECONDS[attempts] ?? BACKOFF_SECONDS[BACKOFF_SECONDS.length - 1];
    const nextRetryAt = new Date(Date.now() + delaySec * 1000);
    await prisma.outbox.update({
      where: { id: rowId },
      data: { attempts, nextRetryAt, lastError: errMsg, status: 'pending' },
    });
    console.warn(`[outbox] ${event.type} (id=${rowId}) attempt ${attempts} failed, retry in ${delaySec}s: ${errMsg}`);
  }
}

/**
 * Постановка события в outbox с немедленной попыткой отправки.
 * Идемпотентно: повторный вызов с тем же ключом — no-op.
 */
export async function enqueueOutbox(event: OutboxEvent, idempotencyKey: string): Promise<void> {
  const existing = await prisma.outbox.findUnique({ where: { idempotencyKey } });
  if (existing && existing.status === 'sent') return;

  let row;
  if (existing) {
    row = existing;
  } else {
    try {
      row = await prisma.outbox.create({
        data: {
          eventType: event.type,
          payloadJson: JSON.stringify(event.payload),
          idempotencyKey,
          status: 'pending',
        },
      });
    } catch (err) {
      // Гонка: параллельный вызов создал запись раньше
      const again = await prisma.outbox.findUnique({ where: { idempotencyKey } });
      if (!again) throw err;
      if (again.status === 'sent') return;
      row = again;
    }
  }

  await attemptSend(row.id, event);
}

/**
 * Обработка отложенных событий: берём pending с nextRetryAt <= now и пытаемся отправить.
 */
export async function processOutbox(): Promise<void> {
  const now = new Date();
  const pending = await prisma.outbox.findMany({
    where: { status: 'pending', nextRetryAt: { lte: now } },
    orderBy: { createdAt: 'asc' },
    take: 50,
  });

  for (const row of pending) {
    let event: OutboxEvent;
    try {
      const payload = JSON.parse(row.payloadJson);
      event = { type: row.eventType, payload } as OutboxEvent;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      await prisma.outbox.update({
        where: { id: row.id },
        data: { status: 'failed', lastError: `payload parse error: ${errMsg}` },
      });
      console.error(`[outbox] payload parse error (id=${row.id}): ${errMsg}`);
      continue;
    }
    await attemptSend(row.id, event);
  }
}
