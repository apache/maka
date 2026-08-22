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
import { formatMcpDiagnosticText, MCP_ERROR_DIAGNOSTIC_CODE_POINTS } from '../diagnostic-text.js';

test('fails closed before processing oversized input', () => {
  const rendered = formatMcpDiagnosticText('x'.repeat(100_000));

  assert.equal(rendered, '[MCP diagnostic omitted: input exceeded limit]');
});

test('redacts a secret that crosses the visible output boundary', () => {
  const rendered = formatMcpDiagnosticText(
    `${'x'.repeat(78)}sk-live-secret-token-value${'y'.repeat(500)}`,
  );

  assert.equal([...rendered].length, 80);
  assert.doesNotMatch(rendered, /sk-live|secret-token/u);
  assert.match(rendered, /\u2026$/u);
});

test('sanitizes control and format characters across the diagnostic boundary', () => {
  const rendered = formatMcpDiagnosticText(
    'before\r\n\u00ad\u2028\u2029\u206a\u202eafter token=secret-value',
    MCP_ERROR_DIAGNOSTIC_CODE_POINTS,
  );

  assert.doesNotMatch(rendered, /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u);
  assert.doesNotMatch(rendered, /secret-value/u);
  assert.match(rendered, /\[redacted\]/u);
});
