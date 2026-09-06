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

/**
 * Prompt composition — what one request's prompt was made of (#2323).
 *
 * Run: `npm run build && npm --workspace @maka/runtime run test:dist`
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  foldPromptComposition,
  readPromptCompositionEvent,
  PROVIDER_REQUEST_ATTEMPT_EVENT_TYPE,
} from '../prompt-composition.js';
import type { SizedRequestSegment } from '../prompt-composition.js';

function segment(overrides: Partial<SizedRequestSegment> = {}): SizedRequestSegment {
  return { kind: 'message', bytes: 10, ...overrides };
}

describe('foldPromptComposition', () => {
  test('folds kinds into the vocabulary /context already uses', () => {
    const composition = foldPromptComposition([
      segment({ kind: 'system_prompt', bytes: 400 }),
      segment({ kind: 'tool_schema', bytes: 300, label: 'Bash' }),
      segment({ kind: 'message', bytes: 200 }),
      segment({ kind: 'provider_options', bytes: 100 }),
    ]);

    assert.deepEqual(composition?.segments, [
      { kind: 'system_instructions', bytes: 400 },
      { kind: 'tool_definitions', bytes: 300 },
      { kind: 'messages', bytes: 200 },
      { kind: 'other', bytes: 100 },
    ]);
  });

  test('sizes each tool on its own, largest first', () => {
    const composition = foldPromptComposition([
      segment({ kind: 'tool_schema', bytes: 300, label: 'Read' }),
      segment({ kind: 'tool_schema', bytes: 900, label: 'Bash' }),
      segment({ kind: 'tool_schema', bytes: 300, label: 'Edit' }),
    ]);

    // Ties broken by name so two reads of one session order identically.
    assert.deepEqual(composition?.tools, [
      { name: 'Bash', bytes: 900 },
      { name: 'Edit', bytes: 300 },
      { name: 'Read', bytes: 300 },
    ]);
    assert.deepEqual(composition?.segments, [{ kind: 'tool_definitions', bytes: 1500 }]);
  });

  test('counts unnamed tool schemas without inventing a name for them', () => {
    const composition = foldPromptComposition([
      segment({ kind: 'tool_schema', bytes: 500, label: 'Bash' }),
      segment({ kind: 'tool_schema', bytes: 250 }),
    ]);

    assert.deepEqual(composition?.tools, [{ name: 'Bash', bytes: 500 }]);
    assert.equal(composition?.unlabelledToolBytes, 250);
    // The kind total still holds every byte, named or not.
    assert.deepEqual(composition?.segments, [{ kind: 'tool_definitions', bytes: 750 }]);
  });

  test('preserves the count carried by a bounded tool remainder', () => {
    const composition = foldPromptComposition([
      segment({ kind: 'tool_schema', bytes: 500, label: 'Bash' }),
      segment({ kind: 'tool_schema', bytes: 9_000, representedSegments: 748 }),
    ]);

    assert.deepEqual(composition?.tools, [{ name: 'Bash', bytes: 500 }]);
    assert.deepEqual(composition?.remainingTools, { count: 748, bytes: 9_000 });
    assert.equal(composition?.unlabelledToolBytes, undefined);
  });

  test('drops a kind nothing contributed to instead of showing it as zero', () => {
    const composition = foldPromptComposition([
      segment({ kind: 'system_prompt', bytes: 400 }),
      segment({ kind: 'message', bytes: 0 }),
    ]);

    assert.deepEqual(composition?.segments, [{ kind: 'system_instructions', bytes: 400 }]);
  });

  test('no segments is no composition, not an empty one', () => {
    assert.equal(foldPromptComposition([]), undefined);
  });

  test('omits the tool list when nothing was a tool', () => {
    const composition = foldPromptComposition([segment({ kind: 'message', bytes: 10 })]);

    assert.equal(composition?.tools, undefined);
    assert.equal(composition?.unlabelledToolBytes, undefined);
  });
});

describe('readPromptCompositionEvent', () => {
  const event = (data: unknown) => ({ type: PROVIDER_REQUEST_ATTEMPT_EVENT_TYPE, data });

  test('reads an attempt capture into its composition', () => {
    const read = readPromptCompositionEvent(
      event({
        attemptId: 'attempt-1',
        requestBytes: 900,
        segments: [
          { kind: 'tool_schema', index: 0, cacheable: true, hash: 'h', bytes: 800, label: 'Bash' },
        ],
      }),
    );

    assert.equal(read?.attemptId, 'attempt-1');
    assert.deepEqual(read?.composition.tools, [{ name: 'Bash', bytes: 800 }]);
  });

  test('ignores every other event on the stream', () => {
    assert.equal(
      readPromptCompositionEvent({ type: 'model_call_attempt_recorded', data: { attemptId: 'a' } }),
      undefined,
    );
  });

  test('drops the whole composition when one segment will not decode', () => {
    // A partial fold would put every share of this request out by the missing
    // segment's size, which is worse than having no breakdown at all.
    const read = readPromptCompositionEvent(
      event({
        attemptId: 'attempt-1',
        requestBytes: 900,
        segments: [
          { kind: 'tool_schema', index: 0, cacheable: true, hash: 'h', bytes: 800, label: 'Bash' },
          { kind: 'tool_schema', index: 1, cacheable: true, hash: 'h', bytes: 'lots' },
        ],
      }),
    );

    assert.equal(read, undefined);
  });

  test('requires an attempt to attach to', () => {
    assert.equal(
      readPromptCompositionEvent(event({ requestBytes: 10, segments: [segment()] })),
      undefined,
    );
  });

  test('rejects a non-string label rather than coercing it', () => {
    const read = readPromptCompositionEvent(
      event({
        attemptId: 'attempt-1',
        requestBytes: 10,
        segments: [
          { kind: 'tool_schema', index: 0, cacheable: true, hash: 'h', bytes: 10, label: 7 },
        ],
      }),
    );

    assert.equal(read, undefined);
  });
});
