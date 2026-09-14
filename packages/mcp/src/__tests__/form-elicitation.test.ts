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
import { describe, test } from 'node:test';
import type { InteractionFormResult } from '@maka/core/interaction';
import { prepareMcpForm } from '../form-elicitation.js';

const requester = { name: 'ask_user', source: 'Example server' };
function request(properties: Record<string, unknown>, required: string[] = []) {
  return {
    method: 'elicitation/create',
    params: {
      message: 'Please provide details',
      requestedSchema: { type: 'object', properties, required },
    },
  };
}

function invalidAnswer(prepared: ReturnType<typeof prepareMcpForm>, result: unknown) {
  assert.throws(
    () => prepared.respond(result as InteractionFormResult),
    /^Error: Invalid MCP form response$/,
  );
}

describe('MCP form elicitation adapter', () => {
  test('preserves types, defaults, optional fields and validation constraints', () => {
    const prepared = prepareMcpForm(
      request(
        {
          name: { type: 'string', title: 'Your name', minLength: 2, maxLength: 10, default: 'Ada' },
          email: { type: 'string', format: 'email', maxLength: 100, description: 'Contact email' },
          age: { type: 'integer', minimum: 18, maximum: 120, default: 30 },
          amount: { type: 'number', minimum: 0, maximum: 1, default: 0.5 },
          confirm: { type: 'boolean', default: false },
        },
        ['name', 'confirm'],
      ),
      requester,
    );
    assert.deepEqual(prepared.form.requester, requester);
    assert.deepEqual(
      prepared.form.fields.map((field) => field.kind),
      ['string', 'string', 'integer', 'number', 'boolean'],
    );
    assert.deepEqual(prepared.form.fields[0], {
      kind: 'string',
      name: 'name',
      label: 'Your name',
      required: true,
      minLength: 2,
      maxLength: 10,
      default: 'Ada',
    });
    assert.deepEqual(
      prepared.respond({ action: 'accept', values: { name: 'Ada', confirm: false } }),
      { action: 'accept', content: { name: 'Ada', confirm: false } },
    );
    invalidAnswer(prepared, { action: 'accept', values: { name: 'A', confirm: true } });
    invalidAnswer(prepared, { action: 'accept', values: { name: 'Ada' } });
    invalidAnswer(prepared, {
      action: 'accept',
      values: { name: 'Ada', confirm: true, age: 18.5 },
    });
    invalidAnswer(prepared, {
      action: 'accept',
      values: { name: 'Ada', confirm: true, email: 'invalid' },
    });
    invalidAnswer(prepared, {
      action: 'accept',
      values: { name: 'Ada', confirm: true, extra: 'unrequested' },
    });
  });

  test('applies a visible client limit to unbounded server strings', () => {
    const prepared = prepareMcpForm(
      request(
        {
          name: { type: 'string' },
          email: { type: 'string', format: 'email' },
          confirm: { type: 'boolean' },
        },
        ['name', 'email', 'confirm'],
      ),
      requester,
    );
    assert.equal((prepared.form.fields[0] as { maxLength: number }).maxLength, 256);
    assert.equal((prepared.form.fields[1] as { maxLength: number }).maxLength, 256);
    assert.deepEqual(
      prepared.respond({
        action: 'accept',
        values: { name: 'Ada', email: 'ada@example.com', confirm: true },
      }),
      { action: 'accept', content: { name: 'Ada', email: 'ada@example.com', confirm: true } },
    );
    invalidAnswer(prepared, {
      action: 'accept',
      values: { name: 'x'.repeat(257), email: 'ada@example.com', confirm: true },
    });
    for (const schema of [
      { type: 'string', minLength: 257 },
      { type: 'string', default: 'x'.repeat(257) },
    ]) {
      assert.throws(() => prepareMcpForm(request({ field: schema }), requester));
    }
    assert.throws(() =>
      prepareMcpForm(
        request(
          Object.fromEntries(
            Array.from({ length: 6 }, (_, index) => [String(index), { type: 'string' }]),
          ),
        ),
        requester,
      ),
    );
    const explicit = prepareMcpForm(
      request({ field: { type: 'string', maxLength: 300 } }),
      requester,
    );
    assert.equal((explicit.form.fields[0] as { maxLength: number }).maxLength, 300);
  });

  test('normalizes all protocol enum variants without changing choice values', () => {
    const prepared = prepareMcpForm(
      request({
        plain: { type: 'string', enum: ['a', 'b'], default: 'a' },
        legacy: { type: 'string', enum: ['a', 'b'], enumNames: ['Alpha', 'Beta'] },
        titled: {
          type: 'string',
          oneOf: [
            { const: 'a', title: 'Alpha' },
            { const: 'b', title: 'Beta' },
          ],
        },
        multi: {
          type: 'array',
          items: { type: 'string', enum: ['a', 'b'] },
          minItems: 1,
          maxItems: 2,
          default: ['a'],
        },
        titledMulti: {
          type: 'array',
          items: {
            anyOf: [
              { const: 'a', title: 'Alpha' },
              { const: 'b', title: 'Beta' },
            ],
          },
        },
      }),
      requester,
    );
    assert.deepEqual(
      prepared.form.fields.map((field) => field.kind),
      ['single_select', 'single_select', 'single_select', 'multi_select', 'multi_select'],
    );
    for (const index of [1, 2, 4])
      assert.deepEqual((prepared.form.fields[index] as { options: unknown }).options, [
        { value: 'a', label: 'Alpha' },
        { value: 'b', label: 'Beta' },
      ]);
    assert.deepEqual(
      prepared.respond({
        action: 'accept',
        values: { legacy: 'a', multi: ['b'], titledMulti: [] },
      }),
      { action: 'accept', content: { legacy: 'a', multi: ['b'], titledMulti: [] } },
    );
    invalidAnswer(prepared, { action: 'accept', values: { plain: 'c' } });
    invalidAnswer(prepared, { action: 'accept', values: { multi: [] } });
    invalidAnswer(prepared, { action: 'accept', values: { multi: ['a', 'a'] } });
  });

  test('returns bare decline and cancel responses and rejects attached answers', () => {
    const prepared = prepareMcpForm(
      request({ confirm: { type: 'boolean' } }, ['confirm']),
      requester,
    );
    assert.deepEqual(prepared.respond({ action: 'decline' }), { action: 'decline' });
    assert.deepEqual(prepared.respond({ action: 'cancel' }), { action: 'cancel' });
    invalidAnswer(prepared, { action: 'decline', values: { confirm: true } });
    invalidAnswer(prepared, { action: 'accept', values: { confirm: 'true' } });
  });

  test('rejects unsupported constraints and impossible schemas before showing a form', () => {
    for (const schema of [
      { type: 'object', properties: {} },
      { type: 'string', pattern: 'secret-pattern' },
      { type: 'number', exclusiveMinimum: 0 },
      { type: 'string', enum: ['a'], minLength: 2 },
      { type: 'string', enum: ['a'], enumNames: ['A', 'B'] },
      { type: 'string', oneOf: [{ const: 'a', title: 'A', pattern: 'x' }] },
      { type: 'array', items: { type: 'string' } },
      { type: 'array', items: { type: 'string', enum: ['a'] }, minItems: 2 },
      { type: 'string', minLength: 2, maxLength: 1 },
      { type: 'integer', minimum: 0.1, maximum: 0.9 },
      { type: 'number', minimum: 2, default: 1 },
      { type: 'string', title: null },
      { type: 'string', enum: ['a', 'a'] },
      {
        type: 'string',
        oneOf: [
          { const: 'a', title: 'same' },
          { const: 'b', title: 'same' },
        ],
      },
      { type: 'boolean', default: 'false' },
    ])
      assert.throws(
        () => prepareMcpForm(request({ field: schema }), requester),
        /^Error: Unsupported or invalid MCP form request$/,
      );
    assert.throws(() =>
      prepareMcpForm(request({ field: { type: 'string' } }, ['missing']), requester),
    );
    assert.throws(() =>
      prepareMcpForm(request({ field: { type: 'string' } }, ['field', 'field']), requester),
    );
  });

  test('rejects non-form requests and unsupported root constraints', () => {
    const original = request({ field: { type: 'string' } });
    assert.throws(() =>
      prepareMcpForm(
        {
          ...original,
          params: {
            ...original.params,
            requestedSchema: { ...original.params.requestedSchema, required: null },
          },
        },
        requester,
      ),
    );
    for (const input of [
      null,
      [],
      { ...original, method: 'sampling/createMessage' },
      { ...original, params: { ...original.params, mode: 'url' } },
      {
        ...original,
        params: {
          ...original.params,
          requestedSchema: {
            ...original.params.requestedSchema,
            dependentRequired: { field: ['other'] },
          },
        },
      },
    ]) {
      assert.throws(
        () => prepareMcpForm(input, requester),
        /^Error: Unsupported or invalid MCP form request$/,
      );
    }
  });

  test('uses canonical form bounds and strips display controls without changing protocol values', () => {
    const prepared = prepareMcpForm(
      request({
        field: {
          type: 'string',
          title: 'Your\u001b[31m name',
          maxLength: 100,
          default: 'literal\nvalue',
        },
      }),
      requester,
    );
    assert.equal(prepared.form.fields[0]?.label.includes('\u001b'), false);
    assert.equal(prepared.form.fields[0]?.default, undefined);
    assert.deepEqual(prepared.respond({ action: 'accept', values: { field: 'literal\nvalue' } }), {
      action: 'accept',
      content: { field: 'literal\nvalue' },
    });
    assert.throws(() =>
      prepareMcpForm(
        request({ field: { type: 'string', default: 'x'.repeat(100_000) } }),
        requester,
      ),
    );
    const bounded = prepareMcpForm(
      request({ field: { type: 'string', maxLength: 100 } }),
      requester,
    );
    invalidAnswer(bounded, { action: 'accept', values: { field: 'x'.repeat(100_000) } });
  });

  test('fails closed when canonical admission cannot represent a field identity', () => {
    const properties = JSON.parse('{"__proto__":{"type":"string","maxLength":100}}');
    assert.throws(
      () => prepareMcpForm(request(properties, ['__proto__']), requester),
      /^Error: Unsupported or invalid MCP form request$/,
    );
  });
});
