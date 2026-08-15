/**
 * Prompt composition — what one request's prompt was made of (#2323).
 *
 * Run: `npm --workspace @maka/runtime run test`
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  foldPromptComposition,
  readPromptCompositionEvent,
  PROVIDER_REQUEST_ATTEMPT_EVENT_TYPE,
} from '../prompt-composition.js';
import type { SizedRequestSegment } from '../prompt-composition.js';
import { capturePreparedProviderRequest } from '../request-shape.js';

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

describe('a real capture survives the whole chain into one fold', () => {
  test('capture -> JSON -> decode -> fold keeps the same breakdown', () => {
    // Every other test here writes its own segments, so a field renamed on one
    // side and not the other would pass all of them; and the decode side reads
    // `label` and `bytes` off an untyped record, so a hand-written fixture
    // agrees with itself by construction. This is the one test where the
    // writer, the storage encoding, the reader and the fold all meet.
    const capture = capturePreparedProviderRequest({
      providerId: 'anthropic',
      modelId: 'claude-test',
      instructions: 'you are a helpful assistant',
      messages: [{ role: 'user', content: 'hello' }],
      tools: [
        { name: 'Bash', description: 'Run a command', inputSchema: { type: 'object' } },
        { name: 'Read', inputSchema: { type: 'object' } },
      ],
      providerOptions: { anthropic: { thinking: { type: 'enabled' } } },
    });

    const composition = foldPromptComposition(capture.segments);

    assert.deepEqual(
      composition?.tools?.map((tool) => tool.name),
      ['Bash', 'Read'],
      'the tool names survive capture, storage shape and fold',
    );
    assert.equal(composition?.unlabelledToolBytes, undefined, 'both tools were named');
    assert.deepEqual(
      composition?.segments.map((part) => part.kind),
      ['system_instructions', 'tool_definitions', 'messages', 'other'],
    );
    assert.equal(
      composition?.segments.find((part) => part.kind === 'tool_definitions')?.bytes,
      composition!.tools!.reduce((carry, tool) => carry + tool.bytes, 0),
      'the per-tool rows sum to the tool total above them',
    );

    const stored = JSON.parse(
      JSON.stringify({
        type: PROVIDER_REQUEST_ATTEMPT_EVENT_TYPE,
        data: {
          attemptId: 'attempt-1',
          requestBytes: capture.requestBytes,
          segments: capture.segments,
        },
      }),
    );

    assert.deepEqual(
      readPromptCompositionEvent(stored)?.composition,
      composition,
      'and the ledger round-trip changes none of it',
    );
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
