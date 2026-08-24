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
import type { ContextDiagnostics } from '@maka/runtime/context-diagnostics';
import { formatContextDiagnostics } from '../pi-tui-runner.js';

/**
 * `/context` prints the same snapshot the Inspector renders (#2323), so this
 * covers the two things that are easy to get wrong in text: that every derived
 * figure is marked as an estimate, and that a request with no capture says so
 * instead of printing zeros.
 */
function diagnostics(
  overrides: Partial<Extract<ContextDiagnostics, { status: 'available' }>> = {},
) {
  return {
    status: 'available',
    providerId: 'anthropic',
    modelId: 'claude-test',
    completedAt: 20,
    inputTokens: 40,
    contextWindow: 200,
    ...overrides,
  } as ContextDiagnostics;
}

test('names each tool, and marks every derived figure as an estimate', () => {
  const out = formatContextDiagnostics(
    diagnostics({
      composition: {
        segments: [
          { kind: 'system_instructions', bytes: 400 },
          { kind: 'tool_definitions', bytes: 800 },
        ],
        tools: [
          { name: 'Bash', bytes: 500 },
          { name: 'Read', bytes: 300 },
        ],
        remainingTools: { count: 3, bytes: 120 },
      },
    }),
  ).replace(/\s+/g, ' ');

  assert.match(out, /System instructions: ≈100 tokens Tool definitions: ≈200 tokens/);
  // Per tool, because that is the only row a reader can act on.
  assert.match(out, /By tool Bash: ≈125 tokens Read: ≈75 tokens/);
  assert.match(out, /3 more tools: ≈30 tokens/);
  // The provider-reported figures keep naming their source; the estimates
  // never borrow that authority.
  assert.match(out, /Used: 40 tokens provider-reported/);
});

test('says a request left no composition rather than printing an empty one', () => {
  const out = formatContextDiagnostics(diagnostics()).replace(/\s+/g, ' ');

  assert.match(out, /Estimated breakdown Unavailable this request left no composition on record/);
  assert.doesNotMatch(out, /≈0 tokens/);
});
