export type CronFieldName = 'minute' | 'hour' | 'day-of-month' | 'month' | 'day-of-week';

export type CronCompileErrorCode =
  | 'invalid_field_count'
  | 'unsupported_syntax'
  | 'empty_list_item'
  | 'invalid_step'
  | 'invalid_range'
  | 'reversed_range'
  | 'invalid_integer'
  | 'out_of_range'
  | 'empty_field'
  | 'unsatisfiable';

export interface CronCompileError {
  readonly code: CronCompileErrorCode;
  readonly field?: CronFieldName;
  readonly min?: number;
  readonly max?: number;
}

export interface CronSearchBounds {
  /** Inclusive lower bound. The result is still strictly after `after`. */
  readonly notBefore?: number;
  /** Inclusive absolute upper bound. */
  readonly notAfter?: number;
}

export interface CompiledCronExpression {
  /** Find the next whole-minute occurrence in the host's local timezone. */
  nextAfter(after: number, bounds?: CronSearchBounds): number | null;
}

export type CompileCronExpressionResult =
  | { readonly ok: true; readonly value: CompiledCronExpression }
  | { readonly ok: false; readonly error: CronCompileError };

interface CronFieldSpec {
  readonly name: CronFieldName;
  readonly min: number;
  readonly max: number;
  readonly normalizeSunday?: boolean;
}

interface ParsedCronField {
  readonly wildcard: boolean;
  readonly values: ReadonlySet<number>;
}

interface ParsedCronExpression {
  readonly minute: ParsedCronField;
  readonly hour: ParsedCronField;
  readonly dayOfMonth: ParsedCronField;
  readonly month: ParsedCronField;
  readonly dayOfWeek: ParsedCronField;
}

type CronParseResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: CronCompileError };

const MINUTE_MS = 60_000;
const MINUTES_PER_DAY = 24 * 60;
const MAX_SEARCH_MINUTES = 8 * 366 * MINUTES_PER_DAY;
const MAX_DAYS_IN_MONTH = Object.freeze([31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]);

const FIELD_SPECS = Object.freeze({
  minute: { name: 'minute', min: 0, max: 59 },
  hour: { name: 'hour', min: 0, max: 23 },
  dayOfMonth: { name: 'day-of-month', min: 1, max: 31 },
  month: { name: 'month', min: 1, max: 12 },
  dayOfWeek: { name: 'day-of-week', min: 0, max: 7, normalizeSunday: true },
} satisfies Record<string, CronFieldSpec>);

/**
 * Compile the one canonical five-field cron grammar used by ScheduledTask and
 * ScheduledTask cron schedules. Fields are numeric and support lists, ranges,
 * and steps. Sunday may be 0 or 7.
 */
export function compileCronExpression(expression: string): CompileCronExpressionResult {
  const parts = expression.split(' ');
  if (parts.length !== 5) return parseError('invalid_field_count');

  const minute = parseCronField(parts[0] ?? '', FIELD_SPECS.minute);
  if (!minute.ok) return minute;
  const hour = parseCronField(parts[1] ?? '', FIELD_SPECS.hour);
  if (!hour.ok) return hour;
  const dayOfMonth = parseCronField(parts[2] ?? '', FIELD_SPECS.dayOfMonth);
  if (!dayOfMonth.ok) return dayOfMonth;
  const month = parseCronField(parts[3] ?? '', FIELD_SPECS.month);
  if (!month.ok) return month;
  const dayOfWeek = parseCronField(parts[4] ?? '', FIELD_SPECS.dayOfWeek);
  if (!dayOfWeek.ok) return dayOfWeek;

  const parsed: ParsedCronExpression = {
    minute: minute.value,
    hour: hour.value,
    dayOfMonth: dayOfMonth.value,
    month: month.value,
    dayOfWeek: dayOfWeek.value,
  };
  if (hasImpossibleCalendarDate(parsed)) {
    return parseError('unsatisfiable', 'day-of-month');
  }

  return {
    ok: true,
    value: Object.freeze({
      nextAfter(after: number, bounds?: CronSearchBounds): number | null {
        return nextCronOccurrence(parsed, after, bounds);
      },
    }),
  };
}

function parseCronField(input: string, spec: CronFieldSpec): CronParseResult<ParsedCronField> {
  if (!/^[\d*,/\-]+$/.test(input)) return parseError('unsupported_syntax', spec.name);

  const values = new Set<number>();
  let wildcard = false;
  for (const item of input.split(',')) {
    if (!item) return parseError('empty_list_item', spec.name);
    const stepParts = item.split('/');
    if (stepParts.length > 2) return parseError('invalid_step', spec.name);

    const base = stepParts[0] ?? '';
    const hasStep = stepParts.length === 2;
    const step = hasStep
      ? parseCronInteger(stepParts[1] ?? '', 1, spec.max - spec.min + 1, spec)
      : ({ ok: true, value: 1 } as const);
    if (!step.ok) return { ok: false, error: { ...step.error, code: 'invalid_step' } };

    let start: number;
    let end: number;
    if (base === '*') {
      wildcard = true;
      start = spec.min;
      end = spec.max;
    } else if (base.includes('-')) {
      const range = base.split('-');
      if (range.length !== 2) return parseError('invalid_range', spec.name);
      const parsedStart = parseCronInteger(range[0] ?? '', spec.min, spec.max, spec);
      if (!parsedStart.ok) return parsedStart;
      const parsedEnd = parseCronInteger(range[1] ?? '', spec.min, spec.max, spec);
      if (!parsedEnd.ok) return parsedEnd;
      if (parsedStart.value > parsedEnd.value) return parseError('reversed_range', spec.name);
      start = parsedStart.value;
      end = parsedEnd.value;
    } else {
      const parsed = parseCronInteger(base, spec.min, spec.max, spec);
      if (!parsed.ok) return parsed;
      start = parsed.value;
      end = hasStep ? spec.max : start;
    }

    for (let candidate = start; candidate <= end; candidate += step.value) {
      values.add(normalizeCronValue(candidate, spec));
    }
  }

  if (values.size === 0) return parseError('empty_field', spec.name);
  return { ok: true, value: { wildcard, values } };
}

function parseCronInteger(
  input: string,
  min: number,
  max: number,
  spec: CronFieldSpec,
): CronParseResult<number> {
  if (!/^\d+$/.test(input)) return parseError('invalid_integer', spec.name, min, max);
  const value = Number(input);
  if (!Number.isSafeInteger(value)) return parseError('invalid_integer', spec.name, min, max);
  if (value < min || value > max) return parseError('out_of_range', spec.name, min, max);
  return { ok: true, value };
}

function normalizeCronValue(value: number, spec: CronFieldSpec): number {
  return spec.normalizeSunday === true && value === 7 ? 0 : value;
}

function hasImpossibleCalendarDate(expression: ParsedCronExpression): boolean {
  if (
    expression.dayOfMonth.wildcard ||
    expression.month.wildcard ||
    !expression.dayOfWeek.wildcard
  ) {
    return false;
  }
  const maxDays = Math.max(
    ...[...expression.month.values].map((month) => MAX_DAYS_IN_MONTH[month - 1] ?? 0),
  );
  return Math.min(...expression.dayOfMonth.values) > maxDays;
}

function nextCronOccurrence(
  expression: ParsedCronExpression,
  after: number,
  bounds: CronSearchBounds | undefined,
): number | null {
  if (!Number.isFinite(after)) return null;
  if (bounds?.notBefore !== undefined && !Number.isFinite(bounds.notBefore)) return null;
  if (bounds?.notAfter !== undefined && !Number.isFinite(bounds.notAfter)) return null;

  const firstMinuteAfter = (Math.floor(after / MINUTE_MS) + 1) * MINUTE_MS;
  const boundedStart =
    bounds?.notBefore === undefined
      ? firstMinuteAfter
      : Math.max(firstMinuteAfter, Math.ceil(bounds.notBefore / MINUTE_MS) * MINUTE_MS);
  const defaultEnd = firstMinuteAfter + (MAX_SEARCH_MINUTES - 1) * MINUTE_MS;
  const searchEnd = Math.min(defaultEnd, bounds?.notAfter ?? defaultEnd);
  if (
    !Number.isFinite(boundedStart) ||
    !Number.isFinite(searchEnd) ||
    boundedStart > searchEnd ||
    Number.isNaN(new Date(boundedStart).getTime())
  ) {
    return null;
  }

  // Advance in epoch minutes so a local DST fold cannot re-encode a candidate
  // at or before `after` and cause a scheduler re-fire loop.
  for (let candidate = boundedStart; candidate <= searchEnd; candidate += MINUTE_MS) {
    if (cronExpressionMatches(expression, new Date(candidate))) return candidate;
  }
  return null;
}

function cronExpressionMatches(expression: ParsedCronExpression, date: Date): boolean {
  if (!expression.minute.values.has(date.getMinutes())) return false;
  if (!expression.hour.values.has(date.getHours())) return false;
  if (!expression.month.values.has(date.getMonth() + 1)) return false;

  const dayOfMonthMatches = expression.dayOfMonth.values.has(date.getDate());
  const dayOfWeekMatches = expression.dayOfWeek.values.has(date.getDay());
  if (!expression.dayOfMonth.wildcard && !expression.dayOfWeek.wildcard) {
    return dayOfMonthMatches || dayOfWeekMatches;
  }
  return dayOfMonthMatches && dayOfWeekMatches;
}

function parseError<T = never>(
  code: CronCompileErrorCode,
  field?: CronFieldName,
  min?: number,
  max?: number,
): CronParseResult<T> {
  return {
    ok: false,
    error: {
      code,
      ...(field ? { field } : {}),
      ...(min !== undefined ? { min } : {}),
      ...(max !== undefined ? { max } : {}),
    },
  };
}
