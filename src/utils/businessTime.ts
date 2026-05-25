import { config } from '../config/index.js';
import { DEFAULT_SHIFT_START_MINUTES } from './checklistTiming.js';

export type ZonedDateTimeParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function getFormatter(timeZone: string): Intl.DateTimeFormat {
  const cached = formatterCache.get(timeZone);
  if (cached) return cached;

  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });

  formatterCache.set(timeZone, formatter);
  return formatter;
}

export function getZonedDateTimeParts(
  date: Date,
  timeZone: string = config.BUSINESS_TIMEZONE,
): ZonedDateTimeParts {
  const parts = getFormatter(timeZone).formatToParts(date);

  const getNumber = (type: Intl.DateTimeFormatPartTypes) =>
    Number.parseInt(parts.find((part) => part.type === type)?.value ?? '0', 10);

  return {
    year: getNumber('year'),
    month: getNumber('month'),
    day: getNumber('day'),
    hour: getNumber('hour'),
    minute: getNumber('minute'),
    second: getNumber('second'),
  };
}

function getTimeZoneOffsetMs(
  date: Date,
  timeZone: string = config.BUSINESS_TIMEZONE,
): number {
  const parts = getZonedDateTimeParts(date, timeZone);
  const utcTimestamp = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );

  return utcTimestamp - date.getTime();
}

export function zonedDateTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number = 0,
  timeZone: string = config.BUSINESS_TIMEZONE,
): Date {
  const utcGuess = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  const offset = getTimeZoneOffsetMs(utcGuess, timeZone);
  return new Date(utcGuess.getTime() - offset);
}

export function getMinutesInTimeZone(
  date: Date,
  timeZone: string = config.BUSINESS_TIMEZONE,
): number {
  const parts = getZonedDateTimeParts(date, timeZone);
  return parts.hour * 60 + parts.minute;
}

export function getBusinessDayBounds(
  date: Date,
  timeZone: string = config.BUSINESS_TIMEZONE,
): { start: Date; end: Date } {
  const parts = getZonedDateTimeParts(date, timeZone);
  const startHour = Math.floor(DEFAULT_SHIFT_START_MINUTES / 60);
  const startMinute = DEFAULT_SHIFT_START_MINUTES % 60;

  let startYear = parts.year;
  let startMonth = parts.month;
  let startDay = parts.day;

  if (parts.hour < startHour || (parts.hour === startHour && parts.minute < startMinute)) {
    const previousDate = new Date(Date.UTC(parts.year, parts.month - 1, parts.day - 1, 12, 0, 0));
    startYear = previousDate.getUTCFullYear();
    startMonth = previousDate.getUTCMonth() + 1;
    startDay = previousDate.getUTCDate();
  }

  const start = zonedDateTimeToUtc(
    startYear,
    startMonth,
    startDay,
    startHour,
    startMinute,
    0,
    timeZone,
  );

  const nextDay = new Date(Date.UTC(startYear, startMonth - 1, startDay + 1, 12, 0, 0));
  const end = zonedDateTimeToUtc(
    nextDay.getUTCFullYear(),
    nextDay.getUTCMonth() + 1,
    nextDay.getUTCDate(),
    startHour,
    startMinute,
    0,
    timeZone,
  );

  return { start, end };
}
