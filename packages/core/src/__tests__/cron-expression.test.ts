/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  type CompiledCronExpression,
  type CompileCronExpressionResult,
  compileCronExpression,
} from '../cron-expression.js';

const compileContract: (expression: string) => CompileCronExpressionResult = compileCronExpression;
const nextContract: CompiledCronExpression['nextAfter'] = assertCompiled('* * * * *').nextAfter;
void compileContract;
void nextContract;

describe('cron expression authority', () => {
  it('compiles the canonical lists, ranges, and steps grammar', () => {
    const cron = assertCompiled('5,20-30/5 9 * * *');
    const after = new Date(2026, 0, 5, 8, 0, 0, 0).getTime();
    assert.equal(cron.nextAfter(after), new Date(2026, 0, 5, 9, 5, 0, 0).getTime());

    const steppedValue = assertCompiled('5/10 * * * *');
    assert.equal(
      steppedValue.nextAfter(new Date(2026, 0, 5, 0, 5, 0, 0).getTime()),
      new Date(2026, 0, 5, 0, 15, 0, 0).getTime(),
    );
  });

  it('rejects aliases, coercion, irregular spacing, and malformed fields', () => {
    for (const expression of [
      '0 9 * * MON',
      '1x * * * *',
      '1.9 * * * *',
      '+1 * * * *',
      '1-2-3 * * * *',
      '1/2/3 * * * *',
      '1,,2 * * * *',
      '*/0 * * * *',
      '60 * * * *',
      ' * * * * *',
      '* * * * * ',
      '*  * * * *',
      '*\t* * * *',
    ]) {
      assert.equal(compileCronExpression(expression).ok, false, expression);
    }
  });

  it('reports bounded field errors before searching', () => {
    const cases = [
      ['0 9 32 * *', 'day-of-month', 'out_of_range'],
      ['0 25 * * *', 'hour', 'out_of_range'],
      ['0 9 * 13 *', 'month', 'out_of_range'],
      ['*/100 * * * *', 'minute', 'invalid_step'],
      ['0 0 30 2 *', 'day-of-month', 'unsatisfiable'],
      ['0 0 31 4 *', 'day-of-month', 'unsatisfiable'],
    ] as const;

    for (const [expression, field, code] of cases) {
      const result = compileCronExpression(expression);
      assert.equal(result.ok, false, expression);
      if (!result.ok) {
        assert.equal(result.error.field, field, expression);
        assert.equal(result.error.code, code, expression);
      }
    }
  });

  it('normalizes Sunday and uses Vixie DOM/DOW OR semantics', () => {
    const monday = new Date(2026, 0, 5, 0, 0, 0, 0).getTime();
    assert.equal(
      assertCompiled('0 0 * * 7').nextAfter(monday),
      assertCompiled('0 0 * * 0').nextAfter(monday),
    );
    assert.equal(new Date(assertCompiled('0 0 * * 5-7').nextAfter(monday)!).getDay(), 5);

    const cron = assertCompiled('0 0 13 * 5');
    const fires: Date[] = [];
    let cursor = new Date(2026, 6, 6, 10, 0, 0, 0).getTime();
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

  it('finds sparse valid dates within the bounded search', () => {
    const after = new Date(2096, 2, 1, 0, 0, 0, 0).getTime();
    const leapDay = assertCompiled('0 0 29 2 *').nextAfter(after);
    assert.ok(leapDay);
    assert.equal(new Date(leapDay).getFullYear(), 2104);
    assert.equal(new Date(leapDay).getMonth(), 1);
    assert.equal(new Date(leapDay).getDate(), 29);
  });

  it('enforces strictly-after and inclusive search bounds', () => {
    const cron = assertCompiled('* * * * *');
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
    assert.equal(cron.nextAfter(-1), 0);
  });

  it('moves forward by epoch minutes across local DST folds and gaps', () => {
    const moduleUrl = pathToFileURL(
      join(dirname(fileURLToPath(import.meta.url)), '..', 'cron-expression.js'),
    ).href;
    const snippet = `
      import(${JSON.stringify(moduleUrl)}).then(({ compileCronExpression }) => {
        const compile = (source) => {
          const result = compileCronExpression(source);
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

function assertCompiled(expression: string): CompiledCronExpression {
  const result = compileCronExpression(expression);
  if (!result.ok) throw new Error(`${expression} did not compile: ${result.error.code}`);
  return result.value;
}
