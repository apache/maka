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
  readonly legacyTokenCoercion: boolean;
  readonly singleValueStepExtendsToMax: boolean;
  readonly limitStepToFieldWidth: boolean;
  readonly wildcardMode: 'any-star-base' | 'literal-star';
  readonly ignoreBareStarInList: boolean;
  readonly allowEmptyMatchSet: boolean;
  readonly rejectImpossibleDates: boolean;
  readonly nextMinuteRounding: 'floor' | 'truncate';
}

interface ParsedCronField {
  readonly wildcard: boolean;
  readonly values: ReadonlySet<number>;
  /** Values admitted by the legacy validator before matcher coercion. */
  readonly validationValues: ReadonlySet<number>;
  readonly validationWildcard: boolean;
}

interface ParseCronFieldOptions {
  /** Preserve the retired standalone matcher's skip-invalid, no-validation contract. */
  readonly matcherOnly?: boolean;
  /** Candidate values to project instead of the field's normal integer domain. */
  readonly candidates?: readonly number[];
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

/**
 * A sparse valid expression such as Feb 29 can be eight years away when a
 * century year is not divisible by 400 (2096 -> 2104). This bound covers that
 * maximum gap while still making an impossible expression terminate.
 */
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
      legacyTokenCoercion: false,
      singleValueStepExtendsToMax: false,
      limitStepToFieldWidth: true,
      wildcardMode: 'any-star-base',
      ignoreBareStarInList: false,
      allowEmptyMatchSet: false,
      rejectImpossibleDates: false,
      nextMinuteRounding: 'floor',
    },
    'automation-v1': {
      fieldSeparator: 'ascii-whitespace',
      allowAliases: true,
      // Existing persisted Automation schedules inherit parseInt-prefix
      // coercion and ignored extra slash/range segments from the retired parser.
      legacyTokenCoercion: true,
      singleValueStepExtendsToMax: true,
      limitStepToFieldWidth: false,
      wildcardMode: 'literal-star',
      // The legacy Automation matcher ignored a bare `*` when it appeared as
      // one item in a list (`*,15` matched only 15). Keep that persisted-input
      // behavior while removing the second parser that caused it.
      ignoreBareStarInList: true,
      // A legacy range could pass validation but contribute no matches because
      // the old matcher used Number where validation used parseInt. Preserve
      // that effective empty set, especially for Vixie DOM/DOW OR schedules.
      allowEmptyMatchSet: true,
      rejectImpossibleDates: true,
      nextMinuteRounding: 'truncate',
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
        return nextCronOccurrence(parsed, after, bounds, policy.nextMinuteRounding);
      },
    }),
  };
}

/**
 * Compatibility entry for the existing `@maka/runtime` export.
 *
 * Fields admitted by the full-expression compiler use the same Automation
 * parser and effective match set. Malformed standalone calls additionally keep
 * the retired matcher's fail-soft contract by skipping invalid list items.
 */
export function matchesCronField(field: string, value: number, min: number, max: number): boolean {
  if (field === '*') return true;
  const parsed = parseCronField(
    field,
    { name: 'minute', min, max },
    PROFILE_POLICIES['automation-v1'],
    { matcherOnly: true, candidates: [value] },
  );
  return parsed.ok && parsed.value.values.has(value);
}

function parseCronField(
  input: string,
  spec: CronFieldSpec,
  policy: CronCompatibilityPolicy,
  options?: ParseCronFieldOptions,
): CronParseResult<ParsedCronField> {
  if (!policy.allowAliases && !/^[\d*,/\-]+$/.test(input)) {
    return parseError('unsupported_syntax', spec.name);
  }

  const matcherOnly = options?.matcherOnly === true;
  const normalizedInput =
    policy.allowAliases && spec.aliases ? translateCronAliases(input, spec.aliases) : input;
  const rawParts = normalizedInput.split(',');
  const values = new Set<number>();
  const validationValues = new Set<number>();
  let hasWildcardBase = false;

  for (const rawPart of rawParts) {
    if (rawPart.length === 0) {
      if (matcherOnly) continue;
      return parseError('empty_list_item', spec.name);
    }
    const stepParts = rawPart.split('/');
    if (stepParts.length > 2 && !policy.legacyTokenCoercion) {
      return parseError('invalid_step', spec.name);
    }
    const base = stepParts[0] ?? '';
    const hasStep = stepParts[1] !== undefined;
    let step = 1;
    if (hasStep) {
      if (matcherOnly) {
        step = Number.parseInt(stepParts[1] ?? '', 10);
        if (Number.isNaN(step) || step <= 0) continue;
      } else {
        const stepMax = policy.limitStepToFieldWidth
          ? spec.max - spec.min + 1
          : Number.POSITIVE_INFINITY;
        const parsedStep = parseCronInteger(stepParts[1] ?? '', 1, stepMax, spec, policy);
        if (!parsedStep.ok) return parsedStep;
        step = parsedStep.value;
      }
    }

    const bareStar = base === '*' && !hasStep;
    if (matcherOnly && bareStar) continue;
    const ignoreEffectivePart = bareStar && rawParts.length > 1 && policy.ignoreBareStarInList;

    let start = 0;
    let end = -1;
    let validationStart = 0;
    let validationEnd = -1;
    let contributesEffectiveMatches = true;
    if (base === '*') {
      hasWildcardBase = true;
      start = spec.min;
      end = spec.max;
      validationStart = spec.min;
      validationEnd = spec.max;
    } else if (base.includes('-')) {
      const range = base.split('-');
      if (matcherOnly) {
        start = Number(range[0] ?? '');
        end = Number(range[1] ?? '');
        if (Number.isNaN(start) || Number.isNaN(end)) continue;
      } else if (range.length !== 2 && !policy.legacyTokenCoercion) {
        return parseError('invalid_range', spec.name);
      } else {
        const parsedStart = parseCronInteger(range[0] ?? '', spec.min, spec.max, spec, policy);
        if (!parsedStart.ok) return parsedStart;
        const parsedEnd = parseCronInteger(range[1] ?? '', spec.min, spec.max, spec, policy);
        if (!parsedEnd.ok) return parsedEnd;
        if (parsedStart.value > parsedEnd.value) {
          return parseError('reversed_range', spec.name);
        }
        validationStart = parsedStart.value;
        validationEnd = parsedEnd.value;

        if (policy.legacyTokenCoercion) {
          // The old Automation validator used parseInt for ranges while its
          // matcher used Number. Validate once above, then compile the matcher's
          // effective values so callers never interpret the source again.
          start = Number(range[0] ?? '');
          end = Number(range[1] ?? '');
          contributesEffectiveMatches = !Number.isNaN(start) && !Number.isNaN(end);
        } else {
          start = parsedStart.value;
          end = parsedEnd.value;
        }
      }
    } else {
      if (matcherOnly) {
        start = Number.parseInt(base, 10);
        if (Number.isNaN(start)) continue;
      } else {
        const parsed = parseCronInteger(base, spec.min, spec.max, spec, policy);
        if (!parsed.ok) return parsed;
        start = parsed.value;
        validationStart = parsed.value;
      }
      end = hasStep && (matcherOnly || policy.singleValueStepExtendsToMax) ? spec.max : start;
      validationEnd = end;
    }

    if (!matcherOnly) {
      for (let candidate = validationStart; candidate <= validationEnd; candidate += step) {
        validationValues.add(spec.normalizeSunday === true && candidate === 7 ? 0 : candidate);
      }
    }
    if (ignoreEffectivePart || !contributesEffectiveMatches) continue;

    // Enumerating the field's tiny integer domain also reproduces legacy range
    // coercions such as `1.5-5.5` without leaking raw-token logic into matching.
    const addCandidate = (candidate: number): void => {
      if (!(candidate >= start && candidate <= end)) return;
      if (hasStep && (candidate - start) % step !== 0) return;
      values.add(spec.normalizeSunday === true && candidate === 7 ? 0 : candidate);
    };
    if (options?.candidates) {
      for (const candidate of options.candidates) addCandidate(candidate);
    } else {
      for (let candidate = spec.min; candidate <= spec.max; candidate += 1) {
        addCandidate(candidate);
      }
    }
  }

  if (values.size === 0 && !matcherOnly && !policy.allowEmptyMatchSet) {
    return parseError('empty_field', spec.name);
  }
  const wildcard =
    policy.wildcardMode === 'any-star-base' ? hasWildcardBase : normalizedInput === '*';
  return {
    ok: true,
    value: {
      wildcard,
      values,
      validationValues,
      validationWildcard: normalizedInput === '*',
    },
  };
}

function parseCronInteger(
  input: string,
  min: number,
  max: number,
  spec: CronFieldSpec,
  policy: CronCompatibilityPolicy,
): CronParseResult<number> {
  const value = policy.legacyTokenCoercion ? Number.parseInt(input, 10) : Number(input);
  const validSyntax = policy.legacyTokenCoercion || /^\d+$/.test(input);
  const validInteger = policy.legacyTokenCoercion
    ? Number.isInteger(value)
    : Number.isSafeInteger(value);
  if (!validSyntax || !validInteger) {
    return parseError('invalid_integer', spec.name, min, max);
  }
  if (value < min || value > max) {
    return parseError('out_of_range', spec.name, min, max);
  }
  return { ok: true, value };
}

function translateCronAliases(input: string, aliases: Readonly<Record<string, number>>): string {
  return input.replace(/[a-zA-Z]+/g, (token) => {
    const alias = aliases[token.toLowerCase()];
    return alias === undefined ? token : String(alias);
  });
}

function hasImpossibleCalendarDate(expression: ParsedCronExpression): boolean {
  if (
    expression.dayOfMonth.validationWildcard ||
    expression.month.validationWildcard ||
    !expression.dayOfWeek.validationWildcard
  ) {
    return false;
  }
  const maxDays = Math.max(
    ...[...expression.month.validationValues].map((month) => MAX_DAYS_IN_MONTH[month - 1] ?? 0),
  );
  return Math.min(...expression.dayOfMonth.validationValues) > maxDays;
}

function nextCronOccurrence(
  expression: ParsedCronExpression,
  after: number,
  bounds: CronSearchBounds | undefined,
  nextMinuteRounding: CronCompatibilityPolicy['nextMinuteRounding'],
): number | null {
  if (!Number.isFinite(after)) return null;
  if (bounds?.notBefore !== undefined && !Number.isFinite(bounds.notBefore)) return null;
  if (bounds?.notAfter !== undefined && !Number.isFinite(bounds.notAfter)) return null;
  if (!hasPotentialEffectiveMatch(expression)) return null;

  // Advance in epoch minutes. Mutating local Date fields during a DST fold can
  // re-encode the repeated wall-clock time with the earlier offset and produce
  // a candidate at or before `after`, causing a scheduler re-fire loop. The
  // truncation branch retains Automation's pre-epoch behavior; both profiles
  // are identical for every normal positive timestamp.
  const firstMinuteAfter =
    nextMinuteRounding === 'truncate'
      ? after - (after % MINUTE_MS) + MINUTE_MS
      : (Math.floor(after / MINUTE_MS) + 1) * MINUTE_MS;
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

/**
 * Detect effective empty sets before the bounded minute scan. DOM and DOW use
 * Vixie OR only when both are restricted, so one restricted side may remain
 * empty when the other can still match.
 */
function hasPotentialEffectiveMatch(expression: ParsedCronExpression): boolean {
  if (
    expression.minute.values.size === 0 ||
    expression.hour.values.size === 0 ||
    expression.month.values.size === 0
  ) {
    return false;
  }

  const hasDayOfMonth = expression.dayOfMonth.values.size > 0;
  const hasDayOfWeek = expression.dayOfWeek.values.size > 0;
  if (!expression.dayOfMonth.wildcard && !expression.dayOfWeek.wildcard) {
    return hasDayOfMonth || hasDayOfWeek;
  }
  return hasDayOfMonth && hasDayOfWeek;
}

function cronExpressionMatches(expression: ParsedCronExpression, date: Date): boolean {
  if (!expression.minute.values.has(date.getMinutes())) return false;
  if (!expression.hour.values.has(date.getHours())) return false;
  if (!expression.month.values.has(date.getMonth() + 1)) return false;

  const dayOfMonthMatches = expression.dayOfMonth.values.has(date.getDate());
  const dayOfWeekMatches = expression.dayOfWeek.values.has(date.getDay());
  // Vixie cron treats DOM and DOW as OR only when both fields are restricted.
  // When either field is a wildcard it is a no-op, so matching stays AND.
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
