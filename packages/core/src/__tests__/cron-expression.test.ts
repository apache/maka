import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  type CompiledCronExpression,
  type CompileCronExpressionResult,
  type CronCompatibilityProfile,
  compileCronExpression,
  matchesCronField,
} from '../cron-expression.js';

const compileContract: (
  expression: string,
  options: { readonly profile: CronCompatibilityProfile },
) => CompileCronExpressionResult = compileCronExpression;
const nextContract: CompiledCronExpression['nextAfter'] = assertCompiled(
  '* * * * *',
  'automation-v1',
).nextAfter;
const fieldMatchContract: (field: string, value: number, min: number, max: number) => boolean =
  matchesCronField;
void compileContract;
void nextContract;
void fieldMatchContract;

describe('cron expression authority', () => {
  it('compiles lists, ranges, and steps once and finds the next local minute', () => {
    const cron = assertCompiled('5,20-30/5 9 * * *', 'automation-v1');
    const after = new Date(2026, 0, 5, 8, 0, 0, 0).getTime();

    assert.equal(cron.nextAfter(after), new Date(2026, 0, 5, 9, 5, 0, 0).getTime());
  });

  it('preserves each caller profile for bare-value steps', () => {
    const after = new Date(2026, 0, 5, 0, 5, 0, 0).getTime();
    const plan = assertCompiled('5/10 * * * *', 'plan-reminder-v1');
    const automation = assertCompiled('5/10 * * * *', 'automation-v1');

    assert.equal(plan.nextAfter(after), new Date(2026, 0, 5, 1, 5, 0, 0).getTime());
    assert.equal(automation.nextAfter(after), new Date(2026, 0, 5, 0, 15, 0, 0).getTime());
  });

  it('keeps named tokens in Automation without broadening Plan Reminder', () => {
    const plan = compileCronExpression('0 9 * * MON', { profile: 'plan-reminder-v1' });
    assert.equal(plan.ok, false);
    if (!plan.ok) assert.equal(plan.error.code, 'unsupported_syntax');

    const after = new Date(2026, 0, 5, 8, 0, 0, 0).getTime();
    const named = assertCompiled('0 9 * JAN MON', 'automation-v1').nextAfter(after);
    const numeric = assertCompiled('0 9 * 1 1', 'automation-v1').nextAfter(after);
    assert.equal(named, numeric);

    const namedRange = assertCompiled('0 9 * jan mon-fri', 'automation-v1').nextAfter(after);
    const numericRange = assertCompiled('0 9 * 1 1-5', 'automation-v1').nextAfter(after);
    assert.equal(namedRange, numericRange);
  });

  it('keeps Plan schedules strict outside their normalization entrypoint', () => {
    for (const expression of [' * * * * *', '* * * * * ', '*  * * * *', '*\t* * * *']) {
      assert.equal(
        compileCronExpression(expression, { profile: 'plan-reminder-v1' }).ok,
        false,
        expression,
      );
      assert.equal(
        compileCronExpression(expression, { profile: 'automation-v1' }).ok,
        true,
        expression,
      );
    }
  });

  it('preserves the caller-specific step ceiling', () => {
    const plan = compileCronExpression('*/100 * * * *', { profile: 'plan-reminder-v1' });
    assert.equal(plan.ok, false);
    if (!plan.ok) {
      assert.equal(plan.error.code, 'out_of_range');
      assert.equal(plan.error.min, 1);
      assert.equal(plan.error.max, 60);
    }

    const after = new Date(2026, 0, 5, 0, 0, 0, 0).getTime();
    const automation = assertCompiled('*/100 * * * *', 'automation-v1');
    assert.equal(automation.nextAfter(after), new Date(2026, 0, 5, 1, 0, 0, 0).getTime());
  });

  it('pins each profile wildcard classification for DOM and DOW', () => {
    const friday = new Date(2026, 0, 2, 0, 0, 0, 0).getTime();
    const plan = assertCompiled('0 0 */1 * 5', 'plan-reminder-v1');
    const automation = assertCompiled('0 0 */1 * 5', 'automation-v1');

    assert.equal(plan.nextAfter(friday), new Date(2026, 0, 9, 0, 0, 0, 0).getTime());
    assert.equal(automation.nextAfter(friday), new Date(2026, 0, 3, 0, 0, 0, 0).getTime());
  });

  it('preserves Automation matching for a bare star inside a list', () => {
    const after = new Date(2026, 0, 5, 0, 0, 0, 0).getTime();
    const plan = assertCompiled('*,15 * * * *', 'plan-reminder-v1');
    const automation = assertCompiled('*,15 * * * *', 'automation-v1');

    assert.equal(plan.nextAfter(after), new Date(2026, 0, 5, 0, 1, 0, 0).getTime());
    assert.equal(automation.nextAfter(after), new Date(2026, 0, 5, 0, 15, 0, 0).getTime());
  });

  it('preserves legacy Automation token coercion without broadening Plan Reminder', () => {
    const after = new Date(2026, 0, 5, 0, 0, 0, 0).getTime();
    const cases = [
      ['1x * * * *', 1],
      ['1.9 * * * *', 1],
      ['+1 * * * *', 1],
      ['1-2-3 * * * *', 1],
      ['1/2/3 * * * *', 1],
      ['1x/2y * * * *', 1],
      ['*/2/3 * * * *', 2],
      ['1.5-5.5 * * * *', 2],
    ] as const;

    for (const [expression, expectedMinute] of cases) {
      const automation = assertCompiled(expression, 'automation-v1');
      assert.equal(new Date(automation.nextAfter(after)!).getMinutes(), expectedMinute, expression);
      assert.equal(
        compileCronExpression(expression, { profile: 'plan-reminder-v1' }).ok,
        false,
        expression,
      );
    }
  });

  it('compiles the legacy validator/matcher split into one effective match set', () => {
    const after = new Date(2026, 0, 1, 0, 0, 0, 0).getTime();
    const mixed = assertCompiled('1x-5y,10 * * * *', 'automation-v1');
    assert.equal(mixed.nextAfter(after), new Date(2026, 0, 1, 0, 10, 0, 0).getTime());

    const emptyMinute = assertCompiled('1x-5y * * * *', 'automation-v1');
    const startedAt = Date.now();
    assert.equal(emptyMinute.nextAfter(after), null);
    assert.ok(Date.now() - startedAt < 100, 'an empty effective set must not scan eight years');

    assert.equal(assertCompiled('* 1x-5y * * *', 'automation-v1').nextAfter(after), null);
    assert.equal(assertCompiled('* * * 1x-5y *', 'automation-v1').nextAfter(after), null);
    assert.equal(assertCompiled('* * 1x-5y * *', 'automation-v1').nextAfter(after), null);
    assert.equal(assertCompiled('* * * * 1x-5y', 'automation-v1').nextAfter(after), null);
    assert.equal(assertCompiled('* * 1x-5y * 1x-5y', 'automation-v1').nextAfter(after), null);

    // The invalid DOM range contributed no matches in the old matcher, but its
    // restricted DOW sibling could still fire through Vixie OR semantics.
    const fridayOnly = assertCompiled('0 0 1x-5y * 5', 'automation-v1');
    assert.equal(fridayOnly.nextAfter(after), new Date(2026, 0, 2, 0, 0, 0, 0).getTime());

    const secondOfMonthOnly = assertCompiled('0 0 2 * 1x-5y', 'automation-v1');
    assert.equal(secondOfMonthOnly.nextAfter(after), new Date(2026, 0, 2, 0, 0, 0, 0).getTime());
  });

  it('still rejects fields that legacy Automation validation rejected', () => {
    for (const expression of ['1,,2 * * * *', '*/0 * * * *', 'BADTOKEN * * * *', '60 * * * *']) {
      assert.equal(
        compileCronExpression(expression, { profile: 'automation-v1' }).ok,
        false,
        expression,
      );
    }
  });

  it('validates every field and impossible dates before searching', () => {
    const cases = [
      ['0 9 32 * *', 'day-of-month', 'out_of_range'],
      ['0 25 * * *', 'hour', 'out_of_range'],
      ['0 9 * 13 *', 'month', 'out_of_range'],
      ['0 9 * * BADTOKEN', 'day-of-week', 'invalid_integer'],
      ['0 0 30 2 *', 'day-of-month', 'unsatisfiable'],
      ['0 0 31 4 *', 'day-of-month', 'unsatisfiable'],
    ] as const;
    const startedAt = Date.now();

    for (const [expression, field, code] of cases) {
      const result = compileCronExpression(expression, { profile: 'automation-v1' });
      assert.equal(result.ok, false, expression);
      if (!result.ok) {
        assert.equal(result.error.field, field, expression);
        assert.equal(result.error.code, code, expression);
      }
    }

    assert.ok(Date.now() - startedAt < 100, 'invalid expressions must fail before search');
  });

  it('normalizes both 0 and 7 to Sunday, including ranges', () => {
    const monday = new Date(2026, 0, 5, 0, 0, 0, 0).getTime();
    const sundayZero = assertCompiled('0 0 * * 0', 'automation-v1').nextAfter(monday);
    const sundaySeven = assertCompiled('0 0 * * 7', 'automation-v1').nextAfter(monday);
    assert.equal(sundaySeven, sundayZero);
    assert.equal(new Date(sundaySeven!).getDay(), 0);

    const friday = assertCompiled('0 0 * * 5-7', 'automation-v1').nextAfter(monday);
    assert.equal(new Date(friday!).getDay(), 5);
  });

  it('uses Vixie OR semantics when DOM and DOW are both restricted', () => {
    const after = new Date(2026, 6, 6, 10, 0, 0, 0).getTime();
    const cron = assertCompiled('0 0 13 * 5', 'automation-v1');
    const fires: Date[] = [];
    let cursor = after;
    for (let index = 0; index < 8; index += 1) {
      const next = cron.nextAfter(cursor);
      assert.ok(next);
      fires.push(new Date(next));
      cursor = next;
    }

    assert.ok(fires.every((date) => date.getDate() === 13 || date.getDay() === 5));
    assert.ok(fires.some((date) => date.getDate() === 13 && date.getDay() !== 5));
    assert.ok(fires.some((date) => date.getDate() !== 13 && date.getDay() === 5));
  });

  it('keeps caller policy around impossible and sparse dates', () => {
    const impossibleAutomation = compileCronExpression('0 0 30 2 *', {
      profile: 'automation-v1',
    });
    assert.equal(impossibleAutomation.ok, false);
    if (!impossibleAutomation.ok) assert.equal(impossibleAutomation.error.code, 'unsatisfiable');

    // Legacy impossible-date validation used its parseInt view (month 2 only),
    // not the matcher's Number view (2..20). Keep that validation authority.
    const coercedImpossible = compileCronExpression('0 0 30 2e0-2e1 *', {
      profile: 'automation-v1',
    });
    assert.equal(coercedImpossible.ok, false);
    if (!coercedImpossible.ok) assert.equal(coercedImpossible.error.code, 'unsatisfiable');

    const after = new Date(2026, 0, 1, 0, 0, 0, 0).getTime();
    const impossiblePlan = assertCompiled('0 0 30 2 *', 'plan-reminder-v1');
    assert.equal(
      impossiblePlan.nextAfter(after, { notAfter: after + 366 * 24 * 60 * 60 * 1000 }),
      null,
    );

    const fridayInFebruary = assertCompiled('0 0 30 2 5', 'automation-v1').nextAfter(after);
    assert.ok(fridayInFebruary);
    assert.equal(new Date(fridayInFebruary).getMonth(), 1);
    assert.equal(new Date(fridayInFebruary).getDay(), 5);

    const coercedFriday = assertCompiled('0 0 30 2e0-2e1 5', 'automation-v1').nextAfter(after);
    assert.ok(coercedFriday);
    assert.equal(new Date(coercedFriday).getDay(), 5);

    const leapDay = assertCompiled('0 0 29 2 *', 'automation-v1').nextAfter(after);
    assert.ok(leapDay);
    assert.equal(new Date(leapDay).getMonth(), 1);
    assert.equal(new Date(leapDay).getDate(), 29);
  });

  it('enforces strictly-after, inclusive lower, and inclusive upper bounds', () => {
    const cron = assertCompiled('* * * * *', 'automation-v1');
    const atNine = new Date(2026, 0, 5, 9, 0, 0, 0).getTime();
    const atNineOne = new Date(2026, 0, 5, 9, 1, 0, 0).getTime();
    assert.equal(cron.nextAfter(atNine), atNineOne);
    assert.equal(
      cron.nextAfter(atNine, { notBefore: new Date(2026, 0, 5, 9, 5, 30, 0).getTime() }),
      new Date(2026, 0, 5, 9, 6, 0, 0).getTime(),
    );
    assert.equal(cron.nextAfter(atNine, { notAfter: atNine }), null);
    assert.equal(cron.nextAfter(atNine, { notAfter: atNineOne }), atNineOne);
    assert.equal(cron.nextAfter(Number.NaN), null);
    assert.equal(cron.nextAfter(atNine, { notBefore: Number.POSITIVE_INFINITY }), null);

    assert.equal(cron.nextAfter(-1), 60_000);
    assert.equal(assertCompiled('* * * * *', 'plan-reminder-v1').nextAfter(-1), 0);
  });

  it('keeps the legacy field matcher export on the shared parser', () => {
    assert.equal(matchesCronField('5-15/3', 5, 0, 59), true);
    assert.equal(matchesCronField('5-15/3', 14, 0, 59), true);
    assert.equal(matchesCronField('5-15/3', 15, 0, 59), false);
    assert.equal(matchesCronField('5-15/3', 18, 0, 59), false);
    assert.equal(matchesCronField('1x', 1, 0, 59), true);
    assert.equal(matchesCronField('1x-5y,10', 10, 0, 59), true);
    assert.equal(matchesCronField('1x-5y,10', 2, 0, 59), false);
    assert.equal(matchesCronField('bad,10', 10, 0, 59), true);
    assert.equal(matchesCronField('*/0,10', 10, 0, 59), true);
    assert.equal(matchesCronField('60,10', 10, 0, 59), true);
    assert.equal(matchesCronField(',10', 10, 0, 59), true);
    assert.equal(matchesCronField('1-2', 1.5, 0, 59), true);
    assert.equal(matchesCronField('1', 1, 10, 0), true);
  });

  it('moves forward by epoch minutes across local DST folds and gaps', () => {
    const moduleUrl = pathToFileURL(
      join(dirname(fileURLToPath(import.meta.url)), '..', 'cron-expression.js'),
    ).href;
    const snippet = `
      import(${JSON.stringify(moduleUrl)}).then(({ compileCronExpression }) => {
        const compile = (source) => {
          const result = compileCronExpression(source, { profile: 'automation-v1' });
          if (!result.ok) process.exit(2);
          return result.value;
        };
        const foldFrom = Date.parse('2026-11-01T06:30:00Z');
        const foldNext = compile('30 1 * * *').nextAfter(foldFrom);
        const gapFrom = Date.parse('2026-03-08T06:59:00Z');
        const gapNext = compile('30 2 * * *').nextAfter(gapFrom);
        const gapDate = new Date(gapNext);
        const valid =
          typeof foldNext === 'number' && foldNext > foldFrom &&
          typeof gapNext === 'number' && gapNext > gapFrom &&
          gapDate.getDate() === 9 && gapDate.getHours() === 2 && gapDate.getMinutes() === 30;
        process.exit(valid ? 0 : 1);
      }).catch(() => process.exit(3));
    `;

    assert.doesNotThrow(() =>
      execFileSync(process.execPath, ['--input-type=module', '-e', snippet], {
        env: { ...process.env, TZ: 'America/New_York' },
        stdio: 'pipe',
      }),
    );
  });
});

function assertCompiled(
  expression: string,
  profile: CronCompatibilityProfile,
): CompiledCronExpression {
  const result = compileCronExpression(expression, { profile });
  if (!result.ok) throw new Error(`${expression} did not compile: ${result.error.code}`);
  return result.value;
}
