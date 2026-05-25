import type { Checklist } from '@prisma/client';

export type TimeWindow = { start: string; end: string };

export const EXTENDED_CHECKLIST_TYPES = [
  'open',
  'close',
  'periodic',
  'handover_open',
  'handover_close',
] as const;

export const WINDOWED_CHECKLIST_TYPES = new Set<string>(EXTENDED_CHECKLIST_TYPES);
export const CLOSING_REMINDER_TYPES = new Set<string>(['close', 'handover_close']);
export const ALWAYS_AVAILABLE_CHECKLIST_TYPES = new Set<string>(['manual']);

export const DEFAULT_SHIFT_START_MINUTES = 6 * 60;
export const DEFAULT_SHIFT_END_MINUTES = 60;

export function parseTimeToMinutes(time: string): number {
  const [h, m] = time.split(':').map((value) => Number.parseInt(value, 10));
  return h * 60 + m;
}

export function formatMinutesToTime(minutes: number): string {
  const h = Math.floor(minutes / 60) % 24;
  const m = minutes % 60;
  return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`;
}

export function parseTimeWindows(raw: string | null): TimeWindow[] {
  if (!raw) return [];

  try {
    const parsed = JSON.parse(raw) as TimeWindow[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function isWithinTimeWindow(
  nowMinutes: number,
  startMinutes: number,
  endMinutes: number,
): boolean {
  if (startMinutes <= endMinutes) {
    return nowMinutes >= startMinutes && nowMinutes <= endMinutes;
  }

  return nowMinutes >= startMinutes || nowMinutes <= endMinutes;
}

export function getWindowDurationMinutes(
  startMinutes: number,
  endMinutes: number,
): number {
  if (startMinutes <= endMinutes) {
    return endMinutes - startMinutes;
  }

  return 24 * 60 - startMinutes + endMinutes;
}

export function getMinutesSinceOperationalStart(
  nowMinutes: number,
  operationalStartMinutes: number = DEFAULT_SHIFT_START_MINUTES,
): number {
  if (nowMinutes >= operationalStartMinutes) {
    return nowMinutes - operationalStartMinutes;
  }

  return 24 * 60 - operationalStartMinutes + nowMinutes;
}

export function isChecklistActiveAtMinutes(checklist: Checklist, nowMinutes: number): boolean {
  if (ALWAYS_AVAILABLE_CHECKLIST_TYPES.has(checklist.type)) {
    return true;
  }

  const windows = parseTimeWindows(checklist.timeWindows);
  if (windows.length > 0) {
    return windows.some((window) => {
      const start = parseTimeToMinutes(window.start);
      const end = parseTimeToMinutes(window.end);
      return isWithinTimeWindow(nowMinutes, start, end);
    });
  }

  if (checklist.type === 'periodic' && checklist.intervalHours) {
    return nowMinutes >= DEFAULT_SHIFT_START_MINUTES && nowMinutes <= DEFAULT_SHIFT_END_MINUTES;
  }

  return false;
}
