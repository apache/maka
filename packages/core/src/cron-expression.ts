export const CRON_COMPATIBILITY_PROFILES = ['plan-reminder-v1', 'automation-v1'] as const;

export type CronCompatibilityProfile = (typeof CRON_COMPATIBILITY_PROFILES)[number];

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

/**
 * An opaque, validated five-field cron expression.
 *
 * Field sets and calendar-matching details intentionally stay private so a
 * caller cannot create another interpretation of the grammar.
 */
export interface CompiledCronExpression {
  /**
   * Find the next whole-minute occurrence in the host's local timezone.
   * Returns null when the bounded search contains no matching instant.
   */
  nextAfter(after: number, bounds?: CronSearchBounds): number | null;
}

export type CompileCronExpressionResult =
  | { readonly ok: true; readonly value: CompiledCronExpression }
  | { readonly ok: false; readonly error: CronCompileError };

interface CronFieldSpec {
  readonly name: CronFieldName;
  readonly min: number;
  readonly max: number;
  readonly aliases?: Readonly<Record<string, number>>;
  readonly normalizeSunday?: boolean;
}

interface CronCompatibilityPolicy {
  readonly fieldSeparator: 'single-space' | 'ascii-whitespace';
  readonly allowAliases: boolean;
  readonly singleValueStepExtendsToMax: boolean;
  readonly limitStepToFieldWidth: boolean;
  readonly wildcardMode: 'any-star-base' | 'literal-star';
  readonly ignoreBareStarInList: boolean;
  readonly rejectImpossibleDates: boolean;
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

/** Covers the maximum gap between consecutive leap days across a non-leap century. */
const MAX_SEARCH_MINUTES = 8 * 366 * MINUTES_PER_DAY;

const MONTH_ALIASES: Readonly<Record<string, number>> = Object.freeze({
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
});

const DAY_OF_WEEK_ALIASES: Readonly<Record<string, number>> = Object.freeze({
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
});

const FIELD_SPECS = Object.freeze({
  minute: { name: 'minute', min: 0, max: 59 },
  hour: { name: 'hour', min: 0, max: 23 },
  dayOfMonth: { name: 'day-of-month', min: 1, max: 31 },
  month: { name: 'month', min: 1, max: 12, aliases: MONTH_ALIASES },
  dayOfWeek: {
    name: 'day-of-week',
    min: 0,
    max: 7,
    aliases: DAY_OF_WEEK_ALIASES,
    normalizeSunday: true,
  },
} satisfies Record<string, CronFieldSpec>);

const PROFILE_POLICIES: Readonly<Record<CronCompatibilityProfile, CronCompatibilityPolicy>> =
  Object.freeze({
    'plan-reminder-v1': {
      fieldSeparator: 'single-space',
      allowAliases: false,
      singleValueStepExtendsToMax: false,
      limitStepToFieldWidth: true,
      wildcardMode: 'any-star-base',
      ignoreBareStarInList: false,
      rejectImpossibleDates: false,
    },
    'automation-v1': {
      fieldSeparator: 'ascii-whitespace',
      allowAliases: true,
      singleValueStepExtendsToMax: true,
      limitStepToFieldWidth: false,
      wildcardMode: 'literal-star',
      // The legacy Automation matcher ignored a bare `*` when it appeared as
      // one item in a list (`*,15` matched only 15). Keep that persisted-input
      // behavior while removing the second parser that caused it.
      ignoreBareStarInList: true,
      rejectImpossibleDates: true,
    },
  });

// Leap-year maxima; used only for the impossible-date fast path.
const MAX_DAYS_IN_MONTH = Object.freeze([31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]);

export function compileCronExpression(
  expression: string,
  options: { readonly profile: CronCompatibilityProfile },
): CompileCronExpressionResult {
  const policy = PROFILE_POLICIES[options.profile];
  const parts =
    policy.fieldSeparator === 'single-space'
      ? expression.split(' ')
      : expression.trim().split(/\s+/);
  if (parts.length !== 5) return parseError('invalid_field_count');

  const minute = parseCronField(parts[0] ?? '', FIELD_SPECS.minute, policy);
  if (!minute.ok) return minute;
  const hour = parseCronField(parts[1] ?? '', FIELD_SPECS.hour, policy);
  if (!hour.ok) return hour;
  const dayOfMonth = parseCronField(parts[2] ?? '', FIELD_SPECS.dayOfMonth, policy);
  if (!dayOfMonth.ok) return dayOfMonth;
  const month = parseCronField(parts[3] ?? '', FIELD_SPECS.month, policy);
  if (!month.ok) return month;
  const dayOfWeek = parseCronField(parts[4] ?? '', FIELD_SPECS.dayOfWeek, policy);
  if (!dayOfWeek.ok) return dayOfWeek;

  const parsed: ParsedCronExpression = {
    minute: minute.value,
    hour: hour.value,
    dayOfMonth: dayOfMonth.value,
    month: month.value,
    dayOfWeek: dayOfWeek.value,
  };
  if (policy.rejectImpossibleDates && hasImpossibleCalendarDate(parsed)) {
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

/**
 * Compatibility entry for the existing `@maka/runtime` export.
 *
 * It uses the Automation field dialect but, unlike the retired matcher, fails
 * the whole field closed when any token is malformed.
 */
export function matchesCronField(field: string, value: number, min: number, max: number): boolean {
  if (field === '*') return true;
  if (!Number.isFinite(value) || !Number.isSafeInteger(min) || !Number.isSafeInteger(max)) {
    return false;
  }
  if (min > max) return false;
  const parsed = parseCronField(
    field,
    { name: 'minute', min, max },
    PROFILE_POLICIES['automation-v1'],
  );
  return parsed.ok && parsed.value.values.has(value);
}

function parseCronField(
  input: string,
  spec: CronFieldSpec,
  policy: CronCompatibilityPolicy,
): CronParseResult<ParsedCronField> {
  if (!policy.allowAliases && !/^[\d*,/\-]+$/.test(input)) {
    return parseError('unsupported_syntax', spec.name);
  }

  const rawParts = input.split(',');
  const values = new Set<number>();
  let hasWildcardBase = false;

  for (const rawPart of rawParts) {
    if (rawPart.length === 0) return parseError('empty_list_item', spec.name);
    const stepParts = rawPart.split('/');
    if (stepParts.length > 2) return parseError('invalid_step', spec.name);
    const base = stepParts[0] ?? '';
    const hasStep = stepParts[1] !== undefined;
    const stepMax = policy.limitStepToFieldWidth
      ? spec.max - spec.min + 1
      : Number.MAX_SAFE_INTEGER;
    const step = hasStep
      ? parseCronInteger(stepParts[1] ?? '', 1, stepMax, spec)
      : ({ ok: true, value: 1 } as const);
    if (!step.ok) return step;

    const bareStar = base === '*' && !hasStep;
    if (bareStar && rawParts.length > 1 && policy.ignoreBareStarInList) continue;

    let start: number;
    let end: number;
    if (base === '*') {
      hasWildcardBase = true;
      start = spec.min;
      end = spec.max;
    } else if (base.includes('-')) {
      const range = base.split('-');
      if (range.length !== 2) return parseError('invalid_range', spec.name);
      const parsedStart = parseCronInteger(range[0] ?? '', spec.min, spec.max, spec, policy);
      if (!parsedStart.ok) return parsedStart;
      const parsedEnd = parseCronInteger(range[1] ?? '', spec.min, spec.max, spec, policy);
      if (!parsedEnd.ok) return parsedEnd;
      start = parsedStart.value;
      end = parsedEnd.value;
      if (start > end) return parseError('reversed_range', spec.name);
    } else {
      const parsed = parseCronInteger(base, spec.min, spec.max, spec, policy);
      if (!parsed.ok) return parsed;
      start = parsed.value;
      end = hasStep && policy.singleValueStepExtendsToMax ? spec.max : start;
    }

    for (let candidate = start; candidate <= end; candidate += step.value) {
      values.add(spec.normalizeSunday === true && candidate === 7 ? 0 : candidate);
    }
  }

  if (values.size === 0) return parseError('empty_field', spec.name);
  const wildcard = policy.wildcardMode === 'any-star-base' ? hasWildcardBase : input === '*';
  return { ok: true, value: { wildcard, values } };
}

function parseCronInteger(
  input: string,
  min: number,
  max: number,
  spec: CronFieldSpec,
  policy?: CronCompatibilityPolicy,
): CronParseResult<number> {
  const alias = policy?.allowAliases ? spec.aliases?.[input.toLowerCase()] : undefined;
  if (alias !== undefined) return { ok: true, value: alias };
  if (!/^\d+$/.test(input)) return parseError('invalid_integer', spec.name, min, max);
  const value = Number(input);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    return parseError('out_of_range', spec.name, min, max);
  }
  return { ok: true, value };
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
  const notBefore = bounds?.notBefore;
  const boundedStart =
    notBefore === undefined
      ? firstMinuteAfter
      : Math.max(firstMinuteAfter, Math.ceil(notBefore / MINUTE_MS) * MINUTE_MS);
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

  for (let candidate = boundedStart; candidate <= searchEnd; candidate += MINUTE_MS) {
    const date = new Date(candidate);
    if (cronExpressionMatches(expression, date)) return candidate;
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
