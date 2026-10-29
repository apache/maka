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
import { formSubmission, initialForm } from '../app/interaction-form.ts';

const string = (name, extra = {}) => ({
  kind: 'string',
  name,
  label: name,
  required: true,
  ...extra,
});

test('forms aggregate typed Unicode defaults and omit untouched optional fields', () => {
  const fields = [
    string('note', { default: '原文😀\n完整结尾' }),
    { kind: 'number', name: 'ratio', label: 'Ratio', required: true, default: 1.25 },
    { kind: 'integer', name: 'retries', label: 'Retries', required: true, default: 0 },
    { kind: 'boolean', name: 'confirmed', label: 'Confirmed', required: true, default: false },
    {
      kind: 'single_select',
      name: 'plan',
      label: 'Plan',
      required: true,
      default: 'basic',
      options: [
        { value: 'basic', label: 'Basic' },
        { value: 'full', label: 'Full' },
      ],
    },
    {
      kind: 'multi_select',
      name: 'extras',
      label: 'Extras',
      required: true,
      default: ['logs', 'metrics'],
      options: [
        { value: 'logs', label: 'Logs' },
        { value: 'metrics', label: 'Metrics' },
      ],
    },
    string('omitted', { required: false }),
  ];
  const result = formSubmission(fields, initialForm(fields));
  assert.deepEqual(result.problems, Array(fields.length).fill(null));
  assert.deepEqual(JSON.parse(JSON.stringify(result.answer)), {
    kind: 'form',
    action: 'accept',
    values: {
      note: '原文😀\n完整结尾',
      ratio: 1.25,
      retries: 0,
      confirmed: false,
      plan: 'basic',
      extras: ['logs', 'metrics'],
    },
  });
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
