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

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import type { LlmConnection } from '@maka/core/llm-connections';
import {
  CONFIG_TRANSFER_SCHEMA_VERSION,
  buildConfigBundle,
  parseConfigBundle,
  planConnectionMerge,
  serializeConfigBundle,
} from '../config-transfer.js';

function conn(slug: string, extra: Partial<LlmConnection> = {}): LlmConnection {
  return {
    slug,
    name: slug,
    providerType: 'deepseek',
    defaultModel: 'deepseek-v4-pro',
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
    ...extra,
  };
}

describe('config-transfer', () => {
  it('records only the selected categories in includedData and round-trips', () => {
    const bundle = buildConfigBundle({
      appVersion: '0.1.0',
      data: {
        connections: [conn('deepseek-main')],
        settings: { theme: 'dark' },
      },
      now: () => new Date('2026-07-02T00:00:00.000Z'),
    });
    assert.equal(bundle.schemaVersion, CONFIG_TRANSFER_SCHEMA_VERSION);
    assert.deepEqual(bundle.includedData, ['connections', 'settings']);
    assert.equal(bundle.exportedAt, '2026-07-02T00:00:00.000Z');

    const parsed = parseConfigBundle(serializeConfigBundle(bundle));
    assert.ok(parsed.ok);
    assert.deepEqual(parsed.bundle.includedData, ['connections', 'settings']);
    assert.deepEqual(parsed.bundle.data.connections, [conn('deepseek-main')]);
    assert.deepEqual(parsed.bundle.data.settings, { theme: 'dark' });
    assert.equal(parsed.bundle.data.memory, undefined);
  });

  it('carries credentials only when the user opted into that category', () => {
    const withCreds = buildConfigBundle({
      appVersion: '0.1.0',
      data: { credentials: [{ slug: 'deepseek-main', kind: 'api_key', value: 'sk-real' }] },
    });
    assert.deepEqual(withCreds.includedData, ['credentials']);
    const parsed = parseConfigBundle(serializeConfigBundle(withCreds));
    assert.ok(parsed.ok);
    assert.deepEqual(parsed.bundle.data.credentials, [
      { slug: 'deepseek-main', kind: 'api_key', value: 'sk-real' },
    ]);
  });

  it('drops a credentials payload that is not declared in includedData', () => {
    // Hand-edited / mislabeled file: data has credentials but manifest omits it.
    const raw = JSON.stringify({
      schemaVersion: 1,
      includedData: ['connections'],
      data: {
        connections: [conn('deepseek-main')],
        credentials: [{ slug: 'x', kind: 'api_key', value: 'sk-should-not-import' }],
      },
    });
    const parsed = parseConfigBundle(raw);
    assert.ok(parsed.ok);
    assert.equal(parsed.bundle.data.credentials, undefined);
    assert.ok(!parsed.bundle.includedData.includes('credentials'));
    assert.ok(!serializeConfigBundle(parsed.bundle).includes('sk-should-not-import'));
  });

  it('fails closed on an unknown schema version', () => {
    const raw = JSON.stringify({ schemaVersion: 999, includedData: [], data: {} });
    const parsed = parseConfigBundle(raw);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.ok === false && parsed.reason, 'unsupported_version');
  });

  it('rejects non-JSON and malformed payloads', () => {
    assert.equal((parseConfigBundle('not json') as { reason: string }).reason, 'not_json');
    assert.equal(
      (parseConfigBundle(JSON.stringify({ schemaVersion: 1, data: {} })) as { reason: string })
        .reason,
      'malformed',
      'missing includedData is malformed',
    );
    assert.equal(
      (
        parseConfigBundle(
          JSON.stringify({ schemaVersion: 1, includedData: ['bogus'], data: {} }),
        ) as { reason: string }
      ).reason,
      'malformed',
      'unknown category in includedData is malformed',
    );
  });

  it('plans connection merges with skip vs overwrite conflict strategies', () => {
    const existing = [conn('a'), conn('b')];
    const incoming = [conn('a', { name: 'A-new' }), conn('c')];

    const skip = planConnectionMerge(existing, incoming, 'skip');
    assert.deepEqual(skip.skipped, [{ slug: 'a', reason: 'exists' }]);
    assert.deepEqual(
      skip.create.map((c) => c.slug),
      ['c'],
    );
    assert.equal(skip.overwrite.length, 0);

    const overwrite = planConnectionMerge(existing, incoming, 'overwrite');
    assert.deepEqual(
      overwrite.overwrite.map((c) => c.slug),
      ['a'],
    );
    assert.deepEqual(
      overwrite.create.map((c) => c.slug),
      ['c'],
    );
    assert.equal(overwrite.skipped.length, 0);
  });

  it('de-dupes repeated slugs within the imported set', () => {
    const plan = planConnectionMerge([], [conn('x'), conn('x'), conn('y')], 'skip');
    assert.deepEqual(
      plan.create.map((c) => c.slug),
      ['x', 'y'],
    );
  });
});
