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
import { test } from 'node:test';
import { evaluateShippedAudit } from './audit-shipped-dependencies.mjs';

test('blocks a valid report that reaches a shipped dependency', () => {
  const result = evaluateShippedAudit(
    {
      status: 1,
      stdout: JSON.stringify({
        vulnerabilities: {
          react: {
            name: 'react',
            severity: 'high',
            nodes: ['node_modules/react'],
            via: [],
          },
          tooling: {
            name: 'tooling',
            severity: 'critical',
            nodes: ['node_modules/tooling'],
            via: [],
          },
        },
      }),
    },
    new Map([['react', new Set(['19.2.4'])]]),
    {
      'node_modules/react': { version: '19.2.4' },
      'node_modules/tooling': { version: '1.0.0' },
    },
  );

  assert.equal(result.outcome, 'blocked');
  assert.deepEqual(
    result.flagged.map(({ vulnerability }) => vulnerability.name),
    ['react'],
  );
});

test('classifies an audit service error as unavailable', () => {
  const result = evaluateShippedAudit(
    {
      status: 1,
      stdout: JSON.stringify({ error: { summary: '', detail: '' } }),
      stderr: 'npm warn audit network timeout',
      error: new Error('npm audit timed out'),
    },
    new Map(),
    {},
  );

  assert.equal(result.outcome, 'unavailable');
  assert.equal(result.detail, 'npm audit timed out');
});
