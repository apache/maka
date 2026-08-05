import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { LanguageModelV4CallOptions, LanguageModelV4StreamPart } from '@ai-sdk/provider';
import type { RuntimeExecutionConnection } from '@maka/core';
import { getAIModel } from '@maka/runtime';

/**
 * Regression guard for #1967 and #1976. Both are the same modelling defect: the streamed
 * `tool_calls[].index` is an association label a gateway may omit, repeat, or number freely,
 * and it was being used as the storage slot, the identity, and the ordering all at once.
 *
 * #1967 — index as a storage slot. Anthropic→OpenAI translators reuse the Anthropic
 * content-block index, so the first tool call arrives as index 1 once a text block
 * consumed index 0, leaving a hole that crashed the flush.
 *
 * #1976 — index as identity. Ollama labels every tool call in a turn with index 0
 * (vercel/ai#14277), which merged distinct calls into one: arguments concatenated into
 * invalid JSON, the second `id` and `name` dropped, and no error anywhere. Also covered
 * here: deltas that omit `index` entirely, which used to pick a fresh slot per chunk and
 * throw `Expected 'id' to be a string.`
 *
 * The fix is not "identity lives in `id`" — that was tried, and `id` is equally untrustworthy:
 * gateways repeat it across calls and send `''` for absent. A delta continues a call only when
 * every alias it carries agrees, and a call whose wire id cannot address it emits a generated
 * one while keeping the wire's as an alias — conflating those two was a defect of its own, and
 * the `duplicated id echoed on continuations` cases are what pin them apart. The shapes below
 * are grouped by which rule they pin, and each is checked on both provider paths where both
 * can express it.
 */

const connection: RuntimeExecutionConnection = {
  slug: 'relay',
  providerType: 'openai-compatible',
  baseUrl: 'https://relay.invalid/v1',
  defaultModel: 'claude-opus-4-8',
};

const prompt: LanguageModelV4CallOptions['prompt'] = [
  { role: 'user', content: [{ type: 'text', text: 'read a.txt' }] },
];

const tools: LanguageModelV4CallOptions['tools'] = [
  {
    type: 'function',
    name: 'read_file',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
  },
];

function chunk(delta: unknown, finishReason: string | null = null): unknown {
  return {
    id: 'chatcmpl-1',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'claude-opus-4-8',
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

interface StreamedToolCall {
  index: number;
  id: string;
  path: string;
}

/** A gateway turn that emits one text block, then the given tool calls. */
function streamingRelay(toolCalls: StreamedToolCall[]): typeof globalThis.fetch {
  const payloads = [
    chunk({ role: 'assistant', content: 'Reading it.' }),
    ...toolCalls.flatMap(({ index, id, path }) => [
      chunk({
        tool_calls: [
          { index, id, type: 'function', function: { name: 'read_file', arguments: '' } },
        ],
      }),
      chunk({ tool_calls: [{ index, function: { arguments: `{"path":"${path}"}` } }] }),
    ]),
    chunk({}, 'tool_calls'),
  ];
  const body = `${payloads.map((payload) => `data: ${JSON.stringify(payload)}\n\n`).join('')}data: [DONE]\n\n`;
  return async () =>
    new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

async function collectStream(toolCalls: StreamedToolCall[]): Promise<LanguageModelV4StreamPart[]> {
  const model = getAIModel({
    connection,
    apiKey: 'test-key',
    modelId: 'claude-opus-4-8',
    fetch: streamingRelay(toolCalls),
  });
  const { stream } = await model.doStream({ prompt, tools });
  const parts: LanguageModelV4StreamPart[] = [];
  for await (const part of stream) parts.push(part);
  return parts;
}

function toolCallsOf(parts: LanguageModelV4StreamPart[]) {
  return parts
    .filter((part) => part.type === 'tool-call')
    .map(({ toolCallId, toolName, input }) => ({ toolCallId, toolName, input }));
}

function assertStreamSucceeded(parts: LanguageModelV4StreamPart[]): void {
  assert.equal(
    parts.at(-1)?.type,
    'finish',
    'the stream must close cleanly instead of failing the whole turn',
  );
  assert.deepEqual(
    parts.filter((part) => part.type === 'error'),
    [],
    'a non-zero tool call index is not a stream error',
  );
}

describe('getAIModel: OpenAI-compatible streamed tool_calls index', () => {
  for (const index of [0, 1]) {
    test(`emits the tool call when the gateway labels it index ${index}`, async () => {
      const parts = await collectStream([{ index, id: 'call_1', path: 'a.txt' }]);

      assert.deepEqual(toolCallsOf(parts), [
        { toolCallId: 'call_1', toolName: 'read_file', input: '{"path":"a.txt"}' },
      ]);
      assertCallsSeparable(parts);
      assertStreamSucceeded(parts);
    });
  }

  // Holes must not merge, drop, or reorder calls either. A fix that appends every
  // new index instead of honouring it would still pass the single-call cases above.
  test('keeps two tool calls distinct and ordered when index 0 is a hole', async () => {
    const parts = await collectStream([
      { index: 1, id: 'call_1', path: 'a.txt' },
      { index: 2, id: 'call_2', path: 'b.txt' },
    ]);

    assert.deepEqual(toolCallsOf(parts), [
      { toolCallId: 'call_1', toolName: 'read_file', input: '{"path":"a.txt"}' },
      { toolCallId: 'call_2', toolName: 'read_file', input: '{"path":"b.txt"}' },
    ]);
    assertCallsSeparable(parts);
    assertStreamSucceeded(parts);
  });
});

/**
 * A streamed `tool_calls[]` delta exactly as a gateway may put it on the wire, including
 * the shapes the OpenAI protocol does not allow. The tests below drive these directly
 * because the defect lives in how deltas associate, which `streamingRelay`'s well-formed
 * shape cannot express.
 */
interface ToolCallDelta {
  index?: number | null;
  id?: string;
  type?: 'function';
  function?: { name?: string; arguments?: string };
}

const twoTools: LanguageModelV4CallOptions['tools'] = [
  {
    type: 'function',
    name: 'read_file',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
  },
  {
    type: 'function',
    name: 'write_file',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
  },
];

/** A gateway turn that emits each delta in its own chunk, then finishes on `tool_calls`. */
function deltaRelay(deltas: readonly ToolCallDelta[]): typeof globalThis.fetch {
  const payloads = [
    ...deltas.map((delta) => chunk({ tool_calls: [delta] })),
    chunk({}, 'tool_calls'),
  ];
  const body = `${payloads.map((payload) => `data: ${JSON.stringify(payload)}\n\n`).join('')}data: [DONE]\n\n`;
  return async () =>
    new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

/**
 * Collects a turn, capturing a mid-stream throw instead of failing the test on it.
 *
 * `providerType` matters because `openai` and `openai-compatible` construct the same
 * `StreamingToolCallTracker` but reach it differently: the compatible adapter keeps its own
 * index-keyed buffer in front, and its chunk schema allows an absent `index`, while
 * `openai`'s requires one. A defect in the shared tracker can therefore surface on one path
 * and not the other, so the shapes both paths can express are checked on both.
 */
async function collectDeltas(
  deltas: readonly ToolCallDelta[],
  providerType: 'openai-compatible' | 'openai' = 'openai-compatible',
): Promise<{ parts: LanguageModelV4StreamPart[]; failure: unknown }> {
  const model = getAIModel({
    connection: { ...connection, providerType },
    apiKey: 'test-key',
    modelId: 'claude-opus-4-8',
    fetch: deltaRelay(deltas),
  });
  const { stream } = await model.doStream({ prompt, tools: twoTools });
  const parts: LanguageModelV4StreamPart[] = [];
  try {
    for await (const part of stream) parts.push(part);
  } catch (error) {
    return { parts, failure: error };
  }
  const errorPart = parts.find((part) => part.type === 'error');
  return { parts, failure: errorPart ? (errorPart as { error: unknown }).error : undefined };
}

/**
 * The property that must hold for every shape in this file: an emitted input is either empty
 * or parses on its own. Splicing two calls' arguments together always breaks this, including
 * when the fragments interleave (`{"path"{"path":"a"}:"b"}`) rather than append cleanly, which
 * a substring check for `}{` would miss. Asserted as a property so the file keeps catching
 * the defect class rather than only the exact outputs these cases happen to produce.
 */
function assertInputsSelfContained(parts: LanguageModelV4StreamPart[]): void {
  for (const { toolCallId, input } of toolCallsOf(parts)) {
    if (input === '') continue;
    try {
      JSON.parse(input);
    } catch {
      assert.fail(`tool call ${JSON.stringify(toolCallId)} input does not parse alone: ${input}`);
    }
  }
}

/**
 * The second property: every emitted call is separately addressable. Splitting a merge into
 * two calls that share one `toolCallId` only moves the failure downstream, where the id is
 * the identity — `tool-runtime.ts` derives `operationId` from it, so a duplicate collides and
 * the second `commitToolPrepared` is rejected *after* the first tool's side effects have run,
 * and an empty one throws out of `runtime-commit-sink.ts` before the call is even recorded.
 * Asserting only `toolName` and `input` hides all of that, which is how it went unnoticed.
 */
function assertToolCallIdsUsable(parts: LanguageModelV4StreamPart[]): void {
  const ids = toolCallsOf(parts).map(({ toolCallId }) => toolCallId);
  // Blank rather than empty, for the same reason the tracker normalizes blank aliases: a
  // whitespace id is truthy, so it passes `runtime-commit-sink.ts`'s falsy check and reaches
  // `operationId` as a key that names nothing. Two of them collide and the distinctness check
  // below catches that, but one alone would slip through an `id === ''` test.
  assert.deepEqual(
    ids.filter((id) => id.trim() === ''),
    [],
    'a blank id cannot address a tool call downstream',
  );
  assert.equal(new Set(ids).size, ids.length, `tool call ids must be distinct, got ${ids}`);
}

/**
 * The third property: the streamed event contract. A consumer that renders incrementally acts
 * on `tool-input-start` and `tool-input-delta`, not on the final `tool-call`, so those events
 * must carry the same id and arrive in order, and their deltas must reconstruct the input the
 * `tool-call` finally reports. Asserting only `tool-call` leaves this entirely unpinned —
 * every `tool-input-*` enqueue can be deleted from the tracker with the rest of this file
 * still green, which is exactly the state this replaced.
 */
function assertEventLifecycle(parts: LanguageModelV4StreamPart[]): void {
  // Derived rather than passed in, so no case can opt out of the stricter rule by omission.
  const failed = parts.at(-1)?.type !== 'finish';
  const letters = new Map([
    ['tool-input-start', 's'],
    ['tool-input-delta', 'd'],
    ['tool-input-end', 'e'],
    ['tool-call', 'c'],
  ]);
  const sequences = new Map<string, string>();
  for (const part of parts) {
    const letter = letters.get(part.type);
    if (letter === undefined) continue;
    const id = part.type === 'tool-call' ? part.toolCallId : (part as { id: string }).id;
    sequences.set(id, `${sequences.get(id) ?? ''}${letter}`);
  }
  for (const [id, sequence] of sequences) {
    // Only a turn that failed mid-stream may leave a call unfinished. Accepting `sd*`
    // unconditionally would let a silently dropped call — started, never finished, never
    // emitted — pass as well formed, which is the exact shape a lost call takes.
    const expected = failed ? /^(sd*ec|sd*)$/ : /^sd*ec$/;
    assert.match(sequence, expected, `tool call ${JSON.stringify(id)} events out of order`);
  }
  for (const { toolCallId, toolName, input } of toolCallsOf(parts)) {
    const streamed = parts
      .filter((part) => part.type === 'tool-input-delta' && part.id === toolCallId)
      .map((part) => (part as { delta: string }).delta)
      .join('');
    assert.equal(streamed, input, `deltas streamed for ${toolCallId} must reconstruct its input`);
    // The start carries the tool name a renderer commits to before any argument arrives; if
    // it disagrees with the call that follows, the user watched the wrong tool run.
    const started = parts.find(
      (part) => part.type === 'tool-input-start' && part.id === toolCallId,
    );
    assert.equal(
      started === undefined ? undefined : (started as { toolName: string }).toolName,
      toolName,
      `the start announced for ${toolCallId} must name the tool the call runs`,
    );
  }
}

/** Every property. Asserted on every shape below, so each keeps its full detection power. */
function assertCallsSeparable(parts: LanguageModelV4StreamPart[]): void {
  assertInputsSelfContained(parts);
  assertToolCallIdsUsable(parts);
  assertEventLifecycle(parts);
}

describe('getAIModel: streamed tool call identity is `id`, not `index`', () => {
  // The Ollama shape (vercel/ai#14277): every call in the turn is labelled index 0, each
  // arriving complete in one delta. This is the case that silently produced one call with
  // concatenated invalid JSON arguments.
  test('keeps two calls distinct when a gateway labels both index 0', async () => {
    const { parts, failure } = await collectDeltas([
      {
        index: 0,
        id: 'call_a',
        type: 'function',
        function: { name: 'read_file', arguments: '{"path":"a"}' },
      },
      {
        index: 0,
        id: 'call_b',
        type: 'function',
        function: { name: 'write_file', arguments: '{"path":"b"}' },
      },
    ]);

    assert.equal(failure, undefined);
    assertCallsSeparable(parts);
    assert.deepEqual(toolCallsOf(parts), [
      { toolCallId: 'call_a', toolName: 'read_file', input: '{"path":"a"}' },
      { toolCallId: 'call_b', toolName: 'write_file', input: '{"path":"b"}' },
    ]);
  });

  // The second call's `name` must survive too. Merging dropped it, so the second call ran
  // under the first call's tool name whenever the concatenation happened to stay parsable.
  test('keeps each call name when a reused index spreads arguments over chunks', async () => {
    const { parts, failure } = await collectDeltas([
      {
        index: 0,
        id: 'call_a',
        type: 'function',
        function: { name: 'read_file', arguments: '{"path"' },
      },
      { index: 0, function: { arguments: ':"a"}' } },
      {
        index: 0,
        id: 'call_b',
        type: 'function',
        function: { name: 'write_file', arguments: '{"path"' },
      },
      { index: 0, function: { arguments: ':"b"}' } },
    ]);

    assert.equal(failure, undefined);
    assertCallsSeparable(parts);
    assert.deepEqual(toolCallsOf(parts), [
      { toolCallId: 'call_a', toolName: 'read_file', input: '{"path":"a"}' },
      { toolCallId: 'call_b', toolName: 'write_file', input: '{"path":"b"}' },
    ]);
  });

  // The worst shape: the merge stays valid JSON, so nothing downstream can notice. The
  // second call used to vanish with no error, no log, and a successful-looking turn.
  test('does not swallow a reused-index call whose arguments are empty', async () => {
    const { parts, failure } = await collectDeltas([
      {
        index: 0,
        id: 'call_a',
        type: 'function',
        function: { name: 'read_file', arguments: '{"path":"a"}' },
      },
      { index: 0, id: 'call_b', type: 'function', function: { name: 'write_file', arguments: '' } },
    ]);

    assert.equal(failure, undefined);
    assertCallsSeparable(parts);
    assert.deepEqual(toolCallsOf(parts), [
      { toolCallId: 'call_a', toolName: 'read_file', input: '{"path":"a"}' },
      { toolCallId: 'call_b', toolName: 'write_file', input: '' },
    ]);
  });

  // Once an index has been reused, an argument-only delta belongs to the call that most
  // recently claimed that index — the new one, not the one it displaced.
  test('routes an index-only continuation to the call that last claimed the index', async () => {
    const { parts, failure } = await collectDeltas([
      {
        index: 0,
        id: 'call_a',
        type: 'function',
        function: { name: 'read_file', arguments: '{"path":"a"}' },
      },
      {
        index: 0,
        id: 'call_b',
        type: 'function',
        function: { name: 'write_file', arguments: '{"path"' },
      },
      { index: 0, function: { arguments: ':"b"}' } },
    ]);

    assert.equal(failure, undefined);
    assertCallsSeparable(parts);
    assert.deepEqual(toolCallsOf(parts), [
      { toolCallId: 'call_a', toolName: 'read_file', input: '{"path":"a"}' },
      { toolCallId: 'call_b', toolName: 'write_file', input: '{"path":"b"}' },
    ]);
  });

  // Deltas with no `index` at all used to pick a fresh slot per chunk via the
  // `?? toolCalls.length` fallback and throw `Expected 'id' to be a string.`
  test('accumulates a call whose deltas omit index entirely', async () => {
    const { parts, failure } = await collectDeltas([
      { id: 'call_a', type: 'function', function: { name: 'read_file', arguments: '{"pa' } },
      { function: { arguments: 'th":"a"}' } },
    ]);

    assert.equal(failure, undefined);
    assertCallsSeparable(parts);
    assert.deepEqual(toolCallsOf(parts), [
      { toolCallId: 'call_a', toolName: 'read_file', input: '{"path":"a"}' },
    ]);
  });

  // A delta with neither field can only be attributed when there is nothing to confuse it
  // with. Guessing a target — "the last created call", "the call the stream last touched" —
  // is how one call's arguments end up on another, which is the defect this file exists for.
  test('refuses to guess a target for a bare delta while several calls are open', async () => {
    const { parts, failure } = await collectDeltas([
      { index: 0, id: 'call_a', type: 'function', function: { name: 'read_file', arguments: '' } },
      {
        index: 1,
        id: 'call_b',
        type: 'function',
        function: { name: 'write_file', arguments: '{}' },
      },
      { function: { arguments: '{"path":"a"}' } },
    ]);

    assert.notEqual(failure, undefined, 'an unattributable delta must not be absorbed');
    assertCallsSeparable(parts);
  });

  // When every call has its own index, that index is a usable final position and ordering
  // must follow it rather than arrival — a gateway may stream a later slot first.
  test('emits in index order when out-of-order indices are unique', async () => {
    const { parts, failure } = await collectDeltas([
      {
        index: 2,
        id: 'call_second',
        type: 'function',
        function: { name: 'write_file', arguments: '{}' },
      },
      {
        index: 1,
        id: 'call_first',
        type: 'function',
        function: { name: 'read_file', arguments: '{}' },
      },
    ]);

    assert.equal(failure, undefined);
    assertCallsSeparable(parts);
    assert.deepEqual(
      toolCallsOf(parts).map(({ toolCallId }) => toolCallId),
      ['call_first', 'call_second'],
    );
  });

  /**
   * Known boundary, deliberately locked in. `@ai-sdk/openai-compatible` keeps its own
   * index-keyed buffer in front of the tracker and forwards a delta as soon as it has a
   * `name`; once an index has been forwarded, later deltas on it bypass that buffer. So a
   * reused index whose new call has not sent its `name` yet reaches the tracker as an
   * unnamed new identity and the turn fails.
   *
   * Failing is the point: the old behaviour appended those arguments to the previous call.
   * Closing this properly means folding the adapter's buffer into the tracker so a call
   * can stay pending until its name arrives, which is a rewrite of both layers rather than
   * this fix. What must never come back is the silent merge.
   */
  test('fails loudly rather than merging when a reused index delays its name', async () => {
    const { parts, failure } = await collectDeltas([
      {
        index: 0,
        id: 'call_a',
        type: 'function',
        function: { name: 'read_file', arguments: '{"path":"a"}' },
      },
      { index: 0, id: 'call_b', type: 'function', function: { arguments: '{"path"' } },
      { index: 0, function: { name: 'write_file', arguments: ':"b"}' } },
    ]);

    assert.notEqual(failure, undefined, 'an unnamed new identity must not pass silently');
    assertCallsSeparable(parts);
  });

  // The Ollama shape at its full width: THREE calls all labelled index 0, with the tool name
  // repeating. Two calls were not enough to catch this. Resolution walks the records newest
  // first; when a name mismatch merely SKIPPED a candidate instead of rejecting the delta, the
  // scan ran past `write_file` — the current claimant of index 0 — and reached the superseded
  // `read_file` record, filing a complete new call as its continuation. Result: two calls, one
  // with concatenated unparsable arguments, the third silently gone. Verbatim #1976, still open
  // after three rounds of fixing it, because every case until now used two distinct names.
  for (const providerType of ['openai-compatible', 'openai'] as const) {
    test(`keeps three calls distinct when index 0 is reused and a name repeats (${providerType})`, async () => {
      const { parts, failure } = await collectDeltas(
        [
          {
            index: 0,
            type: 'function',
            function: { name: 'read_file', arguments: '{"path":"p0"}' },
          },
          {
            index: 0,
            type: 'function',
            function: { name: 'write_file', arguments: '{"path":"p1"}' },
          },
          {
            index: 0,
            type: 'function',
            function: { name: 'read_file', arguments: '{"path":"p2"}' },
          },
        ],
        providerType,
      );

      assert.equal(failure, undefined);
      assertCallsSeparable(parts);
      assert.deepEqual(
        toolCallsOf(parts).map(({ toolName, input }) => ({ toolName, input })),
        [
          { toolName: 'read_file', input: '{"path":"p0"}' },
          { toolName: 'write_file', input: '{"path":"p1"}' },
          { toolName: 'read_file', input: '{"path":"p2"}' },
        ],
      );
    });
  }

  // `index` may also be the alias that arrives late, with nothing else on the continuation.
  // The single open call has no index of its own, so `index: 0` cannot contradict it — which
  // is what distinguishes this from an index another call has already claimed. This is the
  // narrowest form of the fallback that replaced upstream's `latestToolCall`: upstream resolves
  // it too, by recency rather than by agreement, and fails the shape for its own reasons.
  test('continues the only open call when an index arrives with nothing else', async () => {
    const { parts, failure } = await collectDeltas([
      { id: 'call_a', type: 'function', function: { name: 'read_file', arguments: '{"path"' } },
      { index: 0, function: { arguments: ':"a"}' } },
    ]);

    assert.equal(failure, undefined, 'this shape must not regress against unpatched upstream');
    assertCallsSeparable(parts);
    assert.deepEqual(toolCallsOf(parts), [
      { toolCallId: 'call_a', toolName: 'read_file', input: '{"path":"a"}' },
    ]);
  });

  // That fallback must still respect the name. Without the agreement check a differently named
  // call arriving with no alias at all is absorbed into the open one and lost.
  test('does not absorb a differently named call into the only open one', async () => {
    const { parts, failure } = await collectDeltas([
      {
        index: 0,
        id: 'call_a',
        type: 'function',
        function: { name: 'read_file', arguments: '{}' },
      },
      { type: 'function', function: { name: 'write_file', arguments: '{"path":"b"}' } },
    ]);

    assert.equal(failure, undefined);
    assertCallsSeparable(parts);
    assert.deepEqual(
      toolCallsOf(parts).map(({ toolName, input }) => ({ toolName, input })),
      [
        { toolName: 'read_file', input: '{}' },
        { toolName: 'write_file', input: '{"path":"b"}' },
      ],
    );
  });

  // The fallback is for aliases the open call has not claimed, not for aliases that disagree
  // with it. Dropping either condition turns "one call is open" into a licence to absorb any
  // delta at all, which is the misattribution this whole file exists to prevent.
  //
  // Known boundary, deliberately locked in — same cause as `fails loudly rather than merging
  // when a reused index delays its name`. The delta becomes a new identity, and a new identity
  // with no name fails. An implementation that could hold a call pending until its name arrives
  // would emit two calls here instead and be *better*, so read a green result on these two as
  // "the layers below improved", not as "the guard passed".
  for (const [alias, delta] of [
    ['an id', { id: 'call_zzz', function: { arguments: '{"path":"x"}' } }],
    ['an index', { index: 5, function: { arguments: '{"path":"x"}' } }],
  ] satisfies [string, ToolCallDelta][]) {
    test(`refuses ${alias} that disagrees with the only open call`, async () => {
      const { parts, failure } = await collectDeltas([
        {
          index: 0,
          id: 'call_a',
          type: 'function',
          function: { name: 'read_file', arguments: '{}' },
        },
        delta,
      ]);

      assert.notEqual(failure, undefined, 'a single open call is not a licence to absorb');
      assertCallsSeparable(parts);
    });
  }

  // `index: null` must be absent for ordering too, not a zero. Read as a number it satisfies
  // the presence guard in `flush()` and then sorts ahead of every real index, silently moving
  // a later call to the front of the turn.
  test('does not let a null index reorder the turn', async () => {
    const { parts, failure } = await collectDeltas([
      {
        index: 1,
        id: 'call_first',
        type: 'function',
        function: { name: 'read_file', arguments: '{}' },
      },
      {
        index: null,
        id: 'call_second',
        type: 'function',
        function: { name: 'write_file', arguments: '{}' },
      },
    ]);

    assert.equal(failure, undefined);
    assertCallsSeparable(parts);
    assert.deepEqual(
      toolCallsOf(parts).map(({ toolCallId }) => toolCallId),
      ['call_first', 'call_second'],
    );
  });

  // `@ai-sdk/openai-compatible` declares `index: z.number().nullish()`, so an explicit null is
  // legal wire, not a malformed shape. Read literally it is neither absent nor a number.
  test('treats an explicit null index as absent', async () => {
    const { parts, failure } = await collectDeltas([
      {
        index: null,
        id: 'call_a',
        type: 'function',
        function: { name: 'read_file', arguments: '{"pa' },
      },
      { index: null, id: 'call_a', function: { arguments: 'th":"a"}' } },
    ]);

    assert.equal(failure, undefined, 'a null index is legal and must not fail the turn');
    assertCallsSeparable(parts);
    assert.deepEqual(toolCallsOf(parts), [
      { toolCallId: 'call_a', toolName: 'read_file', input: '{"path":"a"}' },
    ]);
  });

  // A duplicated wire `id` echoed on every continuation. The call that had to mint an id
  // keeps the wire's `dup` as an alias, so the continuation still resolves; comparing the
  // *minted* id against the wire's instead made this shape unresolvable, and the delta fell
  // through to a new call with no name — killing a turn upstream had handled. Which is the
  // point of separating the two: an alias is what the wire said, the id is what we emit.
  for (const providerType of ['openai-compatible', 'openai'] as const) {
    test(`continues each call when a duplicated id is echoed on continuations (${providerType})`, async () => {
      const { parts, failure } = await collectDeltas(
        [
          {
            index: 0,
            id: 'dup',
            type: 'function',
            function: { name: 'read_file', arguments: '{"path"' },
          },
          {
            index: 1,
            id: 'dup',
            type: 'function',
            function: { name: 'write_file', arguments: '{"path"' },
          },
          { index: 0, id: 'dup', function: { arguments: ':"a"}' } },
          { index: 1, id: 'dup', function: { arguments: ':"b"}' } },
        ],
        providerType,
      );

      assert.equal(failure, undefined);
      assertCallsSeparable(parts);
      assert.deepEqual(
        toolCallsOf(parts).map(({ toolName, input }) => ({ toolName, input })),
        [
          { toolName: 'read_file', input: '{"path":"a"}' },
          { toolName: 'write_file', input: '{"path":"b"}' },
        ],
      );
    });
  }

  // An alias may also arrive late. A call whose first delta carried no `id` is still addressed
  // by its `index`, so an `id` appearing later is an alias it has simply not seen yet — not a
  // disagreement, and not a new identity. Rejecting a candidate for that, or resolving from one
  // alias only, turns both of these shapes into a dead turn.
  for (const providerType of ['openai-compatible', 'openai'] as const) {
    test(`does not restart a call whose id arrives only on a later delta (${providerType})`, async () => {
      const { parts, failure } = await collectDeltas(
        [
          { index: 0, type: 'function', function: { name: 'read_file', arguments: '{"path"' } },
          { index: 0, id: 'late', function: { arguments: ':"a"}' } },
        ],
        providerType,
      );

      assert.equal(failure, undefined);
      assertCallsSeparable(parts);
      assert.deepEqual(
        toolCallsOf(parts).map(({ toolName, input }) => ({ toolName, input })),
        [{ toolName: 'read_file', input: '{"path":"a"}' }],
      );
    });
  }

  // A late alias is not just tolerated, it is recorded — the record learns it, so the call
  // stays reachable by it afterwards. Here the third delta binds `late` to the first call and
  // the fourth carries nothing else; without the binding the id resolves to no record, and
  // with another call open the bare-delta fallback does not apply either, so the turn dies.
  test('reaches a call again by an id it only learned from a later delta', async () => {
    const { parts, failure } = await collectDeltas([
      { index: 0, type: 'function', function: { name: 'read_file', arguments: '{"pa' } },
      {
        index: 1,
        id: 'call_b',
        type: 'function',
        function: { name: 'write_file', arguments: '{}' },
      },
      { index: 0, id: 'late', function: { arguments: 'th"' } },
      { id: 'late', function: { arguments: ':"a"}' } },
    ]);

    assert.equal(failure, undefined, 'a learned alias must keep addressing its call');
    assertCallsSeparable(parts);
    assert.deepEqual(
      toolCallsOf(parts).map(({ toolName, input }) => ({ toolName, input })),
      [
        { toolName: 'read_file', input: '{"path":"a"}' },
        { toolName: 'write_file', input: '{}' },
      ],
    );
  });

  // The same binding decides ordering. Every call here ends up with a unique index, but one of
  // them only supplies it on a continuation: without recording it, `flush()` sees an absent
  // index, abandons index order, and emits the calls in arrival order — reversing the execution
  // order the gateway asked for.
  test('orders by an index a call only supplied on a later delta', async () => {
    const { parts, failure } = await collectDeltas([
      { id: 'call_second', type: 'function', function: { name: 'read_file', arguments: '{}' } },
      {
        index: 0,
        id: 'call_first',
        type: 'function',
        function: { name: 'write_file', arguments: '{}' },
      },
      { index: 1, id: 'call_second', function: { arguments: '' } },
    ]);

    assert.equal(failure, undefined);
    assertCallsSeparable(parts);
    assert.deepEqual(
      toolCallsOf(parts).map(({ toolCallId }) => toolCallId),
      ['call_first', 'call_second'],
    );
  });

  test('does not restart a call whose index arrives only on a later delta', async () => {
    const { parts, failure } = await collectDeltas([
      { id: 'call_a', type: 'function', function: { name: 'read_file', arguments: '{"path"' } },
      { index: 7, id: 'call_a', function: { arguments: ':"a"}' } },
    ]);

    assert.equal(failure, undefined);
    assertCallsSeparable(parts);
    assert.deepEqual(toolCallsOf(parts), [
      { toolCallId: 'call_a', toolName: 'read_file', input: '{"path":"a"}' },
    ]);
  });

  // Agreement is not the same as absence of disagreement: an alias the candidate has never
  // seen cannot disagree with it, so at least one alias has to actually match. Without that,
  // a call created from a delta carrying no alias at all would absorb any later delta whose
  // index or id belongs to nothing — the widest possible misattribution.
  test('refuses a delta whose index no call has ever claimed', async () => {
    const { parts, failure } = await collectDeltas([
      { type: 'function', function: { name: 'read_file', arguments: '{}' } },
      {
        index: 1,
        id: 'call_b',
        type: 'function',
        function: { name: 'write_file', arguments: '{"path"' },
      },
      { index: 0, function: { arguments: ':"a"}' } },
    ]);

    assert.notEqual(failure, undefined, 'an unclaimed index must not resolve to an open call');
    assertCallsSeparable(parts);
  });

  // Aliases that contradict each other resolve to nothing rather than to whichever field is
  // consulted first. This is what makes the rule "every alias agrees" instead of a priority
  // order: with a priority order this delta lands on a call the gateway did not address.
  test('refuses a delta whose index and id address different calls', async () => {
    const { parts, failure } = await collectDeltas([
      { index: 0, id: 'call_a', type: 'function', function: { name: 'read_file', arguments: '' } },
      { index: 1, id: 'call_b', type: 'function', function: { name: 'write_file', arguments: '' } },
      { index: 0, id: 'call_b', function: { arguments: '{"path":"a"}' } },
    ]);

    assert.notEqual(failure, undefined, 'contradicting aliases must not resolve to either call');
    assertCallsSeparable(parts);
  });

  // The same contradiction, with the call the delta's index reaches never having claimed an id.
  // Scanning stops at that call and its own aliases do not disagree — nothing about *it* is
  // contradicted — so the disagreement is only visible in the call the id belongs to, which the
  // scan already skipped for its index. Reading agreement per-candidate rather than across the
  // record set made this the one contradiction that resolved anyway, and silently: the fragment
  // landed on the wrong call, which then learned the other call's id as a late alias. Both
  // orderings are here because the alias the candidate is missing decides which one it is.
  for (const [shape, deltas] of Object.entries({
    'whose index reaches a call that never claimed an id': [
      { index: 0, type: 'function', function: { name: 'read_file', arguments: '{"pa' } },
      {
        index: 1,
        id: 'call_b',
        type: 'function',
        function: { name: 'write_file', arguments: '{"path":"b"}' },
      },
      { index: 0, id: 'call_b', function: { arguments: 'th":"a"}' } },
    ],
    'whose id reaches a call that never claimed an index': [
      {
        index: 1,
        id: 'call_b',
        type: 'function',
        function: { name: 'write_file', arguments: '{"pa' },
      },
      { index: 0, type: 'function', function: { name: 'read_file', arguments: '{"path":"a"}' } },
      { index: 0, id: 'call_b', function: { arguments: 'th":"b"}' } },
    ],
  } satisfies Record<string, ToolCallDelta[]>)) {
    test(`refuses a delta ${shape}`, async () => {
      const { parts, failure } = await collectDeltas(deltas);

      assert.notEqual(
        failure,
        undefined,
        'an alias belonging to another call contradicts the match just as an alias on the match does',
      );
      assertCallsSeparable(parts);
    });
  }

  // Minting covers every id a call cannot be addressed by, and blank is one of those — the same
  // normalization the aliases get. Pinned on the path that *emits* an id, because the existing
  // whitespace cases are continuations, where the wire id is consumed as an alias and never
  // reaches the output. Without this, narrowing `absentIfBlank` to `''` on the minting side
  // leaves the whole file green while a turn emits an id that addresses nothing.
  test('mints a fresh id for a new call whose only id is blank', async () => {
    const { parts, failure } = await collectDeltas([
      { index: 0, id: ' ', type: 'function', function: { name: 'read_file', arguments: '{}' } },
      { index: 1, id: '\t', type: 'function', function: { name: 'write_file', arguments: '{}' } },
    ]);

    assert.equal(failure, undefined, 'a blank id is not a reason to fail the turn');
    assertCallsSeparable(parts);
    assert.deepEqual(
      toolCallsOf(parts).map(({ toolName }) => toolName),
      ['read_file', 'write_file'],
    );
  });

  // The intersection of the two shapes this file already treats as real: a gateway that both
  // reuses one index AND repeats (or blanks) the id. Then `index` and `id` both agree, and
  // `function.name` is the only discriminator left. Ignoring it merged the calls into
  // concatenated invalid JSON on both provider paths — verbatim the #1976 symptom, still open
  // after the first two attempts at this fix. Every alias a delta carries has to agree.
  for (const id of ['', 'dup']) {
    for (const providerType of ['openai-compatible', 'openai'] as const) {
      test(`splits a reused index whose id ${JSON.stringify(id)} repeats under a new name (${providerType})`, async () => {
        const { parts, failure } = await collectDeltas(
          [
            {
              index: 0,
              id,
              type: 'function',
              function: { name: 'read_file', arguments: '{"path":"a"}' },
            },
            {
              index: 0,
              id,
              type: 'function',
              function: { name: 'write_file', arguments: '{"path":"b"}' },
            },
          ],
          providerType,
        );

        assert.equal(failure, undefined);
        assertCallsSeparable(parts);
        assert.deepEqual(
          toolCallsOf(parts).map(({ toolName, input }) => ({ toolName, input })),
          [
            { toolName: 'read_file', input: '{"path":"a"}' },
            { toolName: 'write_file', input: '{"path":"b"}' },
          ],
        );
      });
    }
  }

  // A wire id that cannot address a call — absent, empty, or already taken — is replaced with
  // a generated one. Upstream already reaches for `_generateId()` when finalizing, but threw on
  // an absent id before that could ever fire; minting here is what makes two calls that share a
  // wire id separately addressable instead of merely separately stored.
  test('mints a usable id when the wire cannot supply a distinct one', async () => {
    const { parts, failure } = await collectDeltas([
      { index: 0, type: 'function', function: { name: 'read_file', arguments: '{"path":"a"}' } },
      {
        index: 1,
        id: '',
        type: 'function',
        function: { name: 'write_file', arguments: '{"path":"b"}' },
      },
    ]);

    assert.equal(failure, undefined, 'an unusable id is not a reason to fail the turn');
    assertCallsSeparable(parts);
    assert.deepEqual(
      toolCallsOf(parts).map(({ toolName, input }) => ({ toolName, input })),
      [
        { toolName: 'read_file', input: '{"path":"a"}' },
        { toolName: 'write_file', input: '{"path":"b"}' },
      ],
    );
  });

  // The `id`-only lookup: two calls open, neither carrying an index, each continued by id.
  // Nothing else in this file reaches that branch — the single-call omit-index case falls
  // through to the one-open-call fallback instead — so without this, deleting the `byId` map
  // leaves the suite green while index-less multi-call turns die.
  test('continues the right call by id when no delta carries an index', async () => {
    const { parts, failure } = await collectDeltas([
      { id: 'call_a', type: 'function', function: { name: 'read_file', arguments: '{"path"' } },
      { id: 'call_b', type: 'function', function: { name: 'write_file', arguments: '{"path"' } },
      { id: 'call_a', function: { arguments: ':"a"}' } },
      { id: 'call_b', function: { arguments: ':"b"}' } },
    ]);

    assert.equal(failure, undefined);
    assertCallsSeparable(parts);
    assert.deepEqual(toolCallsOf(parts), [
      { toolCallId: 'call_a', toolName: 'read_file', input: '{"path":"a"}' },
      { toolCallId: 'call_b', toolName: 'write_file', input: '{"path":"b"}' },
    ]);
  });

  // Ordering needs three calls to tell a correct implementation from one that sorts
  // unconditionally: with two calls sharing an index a stable sort is indistinguishable from no
  // sort at all. A duplicate index means the index has stopped ordering anything, so arrival
  // order is what is left. Sorting anyway would let a malformed index reorder tool execution.
  test('keeps arrival order for three calls when an index is duplicated', async () => {
    const { parts, failure } = await collectDeltas([
      {
        index: 1,
        id: 'c_first',
        type: 'function',
        function: { name: 'read_file', arguments: '{}' },
      },
      {
        index: 0,
        id: 'c_second',
        type: 'function',
        function: { name: 'write_file', arguments: '{}' },
      },
      {
        index: 1,
        id: 'c_third',
        type: 'function',
        function: { name: 'read_file', arguments: '{}' },
      },
    ]);

    assert.equal(failure, undefined);
    assertCallsSeparable(parts);
    assert.deepEqual(
      toolCallsOf(parts).map(({ toolCallId }) => toolCallId),
      ['c_first', 'c_second', 'c_third'],
    );
  });

  // Mixed index presence is the other half of that guard: sorting a set where one call has no
  // index compares against `undefined`, and every such comparison is false, so the sort neither
  // orders nor preserves — it scrambles. Five calls with arrival order deliberately unlike index
  // order is the smallest shape where that is observable; with three, V8's insertion sort
  // happens to leave them alone and the bug hides.
  test('keeps arrival order when one call carries no index', async () => {
    const indices = [3, 1, undefined, 0, 2];
    const { parts, failure } = await collectDeltas(
      indices.map((index, position) => ({
        ...(index === undefined ? {} : { index }),
        id: `c${position}`,
        type: 'function' as const,
        function: { name: 'read_file', arguments: '{}' },
      })),
    );

    assert.equal(failure, undefined);
    assertCallsSeparable(parts);
    assert.deepEqual(
      toolCallsOf(parts).map(({ toolCallId }) => toolCallId),
      ['c0', 'c1', 'c2', 'c3', 'c4'],
    );
  });

  // Some gateways blank an optional field on continuation deltas instead of omitting it, and a
  // blank field carries no information either way: an id that addresses nothing, or a name no
  // tool can have. Read literally, though, each one is a claim. A blank `id` contradicts the
  // call it belongs to, so the delta becomes a new identity with no name and kills the whole
  // turn; a blank `name` disagrees with every open call, so the arguments land under a call
  // named `" "`. Both are worse than the unpatched code, which emitted the call correctly by
  // never consulting either field.
  //
  // This is the axis the file kept missing: every earlier case varied which aliases a
  // continuation carries, never what they contain. It cost two rounds — first the empty string,
  // then whitespace, found the same way and fixed the same way. Whitespace is not a convention
  // the way `''` is, but the rule does not depend on one: `name` is the field that *rejects* a
  // match rather than proposing one, so a value that cannot be a name must not be allowed to
  // reject. A phantom call reaches `repairMakaToolCall` as an unknown tool while the real call
  // runs with empty input.
  const blanked = {
    'empty id': { index: 0, id: '', function: { arguments: ':"a"}' } },
    'whitespace id': { index: 0, id: ' ', function: { arguments: ':"a"}' } },
    'empty name': { index: 0, function: { name: '', arguments: ':"a"}' } },
    'tab name': { index: 0, function: { name: '\t', arguments: ':"a"}' } },
  } satisfies Record<string, ToolCallDelta>;

  for (const [field, continuation] of Object.entries(blanked)) {
    for (const providerType of ['openai-compatible', 'openai'] as const) {
      test(`treats a ${field} on a continuation as absent (${providerType})`, async () => {
        const { parts, failure } = await collectDeltas(
          [
            {
              index: 0,
              id: 'call_a',
              type: 'function',
              function: { name: 'read_file', arguments: '{"path"' },
            },
            continuation,
          ],
          providerType,
        );

        assert.equal(failure, undefined, 'a blank field must not be read as a new identity');
        assertCallsSeparable(parts);
        assert.deepEqual(toolCallsOf(parts), [
          { toolCallId: 'call_a', toolName: 'read_file', input: '{"path":"a"}' },
        ]);
      });
    }
  }

  // The same normalization has to reach the new-call path, or a blank name diverges from an
  // absent one in the other direction: minting a call nobody can name where an absent name
  // throws. Upstream's rule is that a call without a name is a protocol violation, and a blank
  // one is that same condition spelled differently.
  for (const name of ['', ' ']) {
    test(`refuses a new call whose name is ${JSON.stringify(name)} rather than absent`, async () => {
      const { failure } = await collectDeltas([
        { index: 3, id: '', type: 'function', function: { name, arguments: '{"x":1}' } },
      ]);

      assert.notEqual(failure, undefined, 'a call nobody can name is not a call');
    });
  }

  // Minting scans every emitted id, not just the previous call's. A gateway that repeats one id
  // can put an unrelated call between the repeats, and comparing against the last one only lets
  // the duplicate through — two `tool-call`s with the same id, which collide on `operationId`
  // downstream after the first tool has already run. Same blind spot as the reused-index bug:
  // every other duplicate-id case here puts the duplicates next to each other.
  test('mints a fresh id for a duplicate that is not adjacent to its original', async () => {
    const { parts, failure } = await collectDeltas([
      { index: 0, id: 'dup', type: 'function', function: { name: 'read_file', arguments: '{}' } },
      {
        index: 1,
        id: 'other',
        type: 'function',
        function: { name: 'write_file', arguments: '{}' },
      },
      { index: 2, id: 'dup', type: 'function', function: { name: 'read_file', arguments: '{}' } },
    ]);

    assert.equal(failure, undefined);
    assertCallsSeparable(parts);
    assert.equal(toolCallsOf(parts).length, 3);
  });

  // The `openai` provider builds the same tracker with no buffer in front of it. Its chunk
  // schema requires `index`, so it cannot express the index-omitted shapes, but it can express
  // both reuse defects. The cases above that name a provider already run on it; these are the
  // ones where the buffer's absence is the point rather than an incidental difference.
  describe('the openai provider shares this tracker', () => {
    test('keeps two calls distinct when both are labelled index 0', async () => {
      const { parts, failure } = await collectDeltas(
        [
          {
            index: 0,
            id: 'call_a',
            type: 'function',
            function: { name: 'read_file', arguments: '{"path":"a"}' },
          },
          {
            index: 0,
            id: 'call_b',
            type: 'function',
            function: { name: 'write_file', arguments: '{"path":"b"}' },
          },
        ],
        'openai',
      );

      assert.equal(failure, undefined);
      assertCallsSeparable(parts);
      assert.deepEqual(toolCallsOf(parts), [
        { toolCallId: 'call_a', toolName: 'read_file', input: '{"path":"a"}' },
        { toolCallId: 'call_b', toolName: 'write_file', input: '{"path":"b"}' },
      ]);
    });
  });
});

/**
 * Shapes that stay wrong, recorded so the boundary is a decision rather than a surprise.
 *
 * Every one of them is an alias claimed by more than one call, with the continuation carrying
 * nothing that singles one out. Nothing in the delta says which call it belongs to, and the
 * tracker cannot see whether the gateway is streaming sequentially or interleaving — so it
 * attributes the fragment to the call that most recently claimed the alias. That is required for
 * the sequential shape Ollama actually produces (pinned above by `routes an index-only
 * continuation to the call that last claimed the index`) and wrong for an interleaved one. A
 * gateway that interleaves fragments while reusing one label emits a stream nobody can
 * demultiplex.
 *
 * Mostly what downstream depends on still holds: every call is emitted, once, under its own name
 * and its own usable id, and only the argument text lands on the wrong call. Two shapes break
 * even that, in opposite directions, so each case states its own expectation. These cases are
 * also why `assertInputsSelfContained` is a property of the shapes above and not of the
 * implementation — anyone reading the guard to decide whether the patch is still needed has to
 * know that self-containment was never claimed for a shared alias.
 */
describe('getAIModel: streamed tool call shapes that cannot be demultiplexed', () => {
  const boundaries = {
    'an index shared by two open calls, continued by index only': [
      {
        index: 0,
        id: 'call_a',
        type: 'function',
        function: { name: 'read_file', arguments: '{"path"' },
      },
      {
        index: 0,
        id: 'call_b',
        type: 'function',
        function: { name: 'write_file', arguments: '{"path"' },
      },
      { index: 0, function: { arguments: ':"a"}' } },
      { index: 0, function: { arguments: ':"b"}' } },
    ],
    'a shared id and a shared name with no index to separate them': [
      { id: 'dup', type: 'function', function: { name: 'read_file', arguments: '{"path":"p0"}' } },
      { id: 'dup', type: 'function', function: { name: 'read_file', arguments: '{"path":"p1"}' } },
    ],
    'a reused index carrying the same id and the same name': [
      {
        index: 0,
        id: 'dup',
        type: 'function',
        function: { name: 'read_file', arguments: '{"p":0}' },
      },
      {
        index: 0,
        id: 'dup',
        type: 'function',
        function: { name: 'read_file', arguments: '{"p":1}' },
      },
    ],
    'a duplicated id as the only alias on a continuation': [
      {
        index: 0,
        id: 'dup',
        type: 'function',
        function: { name: 'read_file', arguments: '{"path"' },
      },
      {
        index: 1,
        id: 'dup',
        type: 'function',
        function: { name: 'write_file', arguments: '{"path"' },
      },
      { id: 'dup', function: { arguments: ':"a"}' } },
      { id: 'dup', function: { arguments: ':"b"}' } },
    ],
    'a continuation naming a call the shared index no longer claims': [
      { index: 0, id: 'p0', type: 'function', function: { name: 'read_file', arguments: '{}' } },
      { index: 0, id: 'p1', type: 'function', function: { name: 'write_file', arguments: '{}' } },
      { index: 0, id: 'p2', type: 'function', function: { name: 'read_file', arguments: '{}' } },
      { index: 0, function: { name: 'write_file', arguments: '{"late":1}' } },
    ],
    'a continuation carrying only a name while several calls are open': [
      {
        index: 0,
        id: 'call_a',
        type: 'function',
        function: { name: 'read_file', arguments: '{"path"' },
      },
      {
        index: 1,
        id: 'call_b',
        type: 'function',
        function: { name: 'write_file', arguments: '{}' },
      },
      { type: 'function', function: { name: 'read_file', arguments: ':"a"}' } },
    ],
  } satisfies Record<string, ToolCallDelta[]>;

  // What survives differs by shape, so each states its own guarantee rather than sharing one.
  // Two keep both calls and misplace only argument text. Two lose a call: when every alias the
  // second call sends already belongs to the first — and its name too — nothing distinguishes a
  // second call from a continuation, whether or not an index is present. Two go the other way
  // and invent a call. `a continuation naming a call the shared index no longer claims` is the
  // direct price of `keeps three calls distinct when index 0 is reused and a name repeats`:
  // resolution stops at the newest claimant of an alias, so a continuation naming an older one
  // cannot reach it. Honouring the name instead fixes this shape and breaks that one. Pinned
  // here so a future attempt at either sees both.
  //
  // `a continuation carrying only a name while several calls are open` is the same trade seen
  // from the other end: `name` rejects a match but never proposes one, so a delta whose only
  // field is a name claims nothing and starts a call. Letting the name resolve it is the
  // obvious repair and is the same change that breaks the reused-index shape. Both calls it
  // splits keep unparsable input, which is why this suite asserts ids and lifecycle but not
  // self-containment — a shared alias makes that unachievable, not merely unachieved.
  const emitted = {
    'an index shared by two open calls, continued by index only': ['read_file', 'write_file'],
    'a shared id and a shared name with no index to separate them': ['read_file'],
    'a reused index carrying the same id and the same name': ['read_file'],
    'a duplicated id as the only alias on a continuation': ['read_file', 'write_file'],
    'a continuation naming a call the shared index no longer claims': [
      'read_file',
      'write_file',
      'read_file',
      'write_file',
    ],
    'a continuation carrying only a name while several calls are open': [
      'read_file',
      'write_file',
      'read_file',
    ],
  } satisfies Record<keyof typeof boundaries, string[]>;

  for (const [shape, deltas] of Object.entries(boundaries)) {
    test(`emits what is still decidable for ${shape}`, async () => {
      const { parts, failure } = await collectDeltas(deltas);

      assert.equal(failure, undefined);
      assertToolCallIdsUsable(parts);
      assertEventLifecycle(parts);
      assert.deepEqual(
        toolCallsOf(parts).map(({ toolName }) => toolName),
        emitted[shape as keyof typeof emitted],
      );
    });
  }
});
