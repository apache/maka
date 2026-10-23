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

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  formSubmission,
  initialForm,
  utf8Bytes,
} from '../../products/maka/workbench/app/interaction-form.ts';

const string = (name, extra = {}) => ({
  kind: 'string',
  name,
  label: name,
  required: true,
  ...extra,
});

// Exercise the same pure validator and message carriers imported by the actual
// terminal InteractionPanel. Node strips types; no native module or UI is emulated.
test('terminal forms preserve complete multibyte defaults and aggregate answers', () => {
  const original = `原文😀${'甲😀'.repeat(1500)}完整结尾`;
  assert.ok([...original].length > 2048);
  assert.ok(utf8Bytes(original) > 8192);
  const fields = [string('note', { default: original })];
  const draft = initialForm(fields);
  assert.equal(draft[0].included, true);
  assert.ok(draft[0].value === original, 'the complete original default must initialize the draft');
  const complete = formSubmission(fields, draft);
  assert.ok(complete.answer, 'a complete default without an authored maximum must remain valid');
  assert.deepEqual(complete.problems, [null]);
  assert.ok(
    complete.answer.values.note === original,
    'submission must retain every original UTF-8 byte, including the final marker',
  );

  // Every field fits the former per-field byte bound, while the complete answer
  // exceeds the independent whole-answer bound. Optional omission stays distinct.
  const value = '界'.repeat(600);
  assert.ok(utf8Bytes(value) < 2048);
  const aggregateFields = Array.from({ length: 6 }, (_, index) =>
    string(`field-${index}`, { default: value, maxLength: 600 }),
  );
  aggregateFields.push(string('omitted', { required: false }));
  assert.ok(
    utf8Bytes(
      JSON.stringify(
        Object.fromEntries(aggregateFields.slice(0, 6).map((field) => [field.name, value])),
      ),
    ) > 8192,
  );
  const aggregate = formSubmission(aggregateFields, initialForm(aggregateFields));
  assert.ok(aggregate.answer, 'complete valid fields must not acquire an aggregate answer ceiling');
  assert.deepEqual(
    Object.keys(aggregate.answer.values),
    aggregateFields.slice(0, 6).map((field) => field.name),
  );
  assert.deepEqual(aggregate.problems, Array(7).fill(null));
  for (const field of aggregateFields.slice(0, 6)) {
    assert.ok(
      aggregate.answer.values[field.name] === value,
      `${field.name} must retain its complete value`,
    );
  }
});

test('terminal forms preserve authored limits, omission, and malformed-value rejection', () => {
  const bounded = string('value', { minLength: 2, maxLength: 3, default: '甲😀' });
  const valid = formSubmission([bounded], initialForm([bounded]));
  assert.equal(valid.answer.values.value, '甲😀', 'authored character limits count Unicode points');
  for (const [value, key, count] of [
    ['a', 'Use at least {count} characters.', 2],
    ['甲😀ab', 'Use at most {count} characters.', 3],
  ]) {
    const result = formSubmission([bounded], [{ included: true, value, hidden: false }]);
    assert.equal(result.answer, null);
    assert.ok(
      result.problems[0],
      'an explicit authored minimum or maximum must remain authoritative',
    );
    assert.deepEqual(result.problems[0], { key, values: { count } });
  }
  const missing = formSubmission([bounded], [{ included: false, value: '甲😀', hidden: false }]);
  assert.equal(missing.answer, null);
  assert.deepEqual(missing.problems[0], {
    key: 'This field is required.',
    values: undefined,
  });

  for (const [field, value] of [
    [string('value', { format: 'date' }), '2025-02-29'],
    [{ kind: 'integer', name: 'value', label: 'value', required: true }, '9007199254740992'],
    [
      {
        kind: 'single_select',
        name: 'value',
        label: 'value',
        required: true,
        options: [{ value: 'known', label: 'Known' }],
      },
      'unknown',
    ],
    [
      {
        kind: 'multi_select',
        name: 'value',
        label: 'value',
        required: true,
        options: [{ value: 'known', label: 'Known' }],
        maxItems: 1,
      },
      ['known', 'known'],
    ],
  ]) {
    const result = formSubmission([field], [{ included: true, value, hidden: false }]);
    assert.equal(result.answer, null);
    assert.ok(result.problems[0], 'malformed or out-of-domain values must stay invalid');
  }
});
