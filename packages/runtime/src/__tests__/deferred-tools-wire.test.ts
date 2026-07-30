import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { z } from 'zod';
import { MockLanguageModelV4, convertArrayToReadableStream } from 'ai/test';
import type { LanguageModelV4StreamPart, LanguageModelV4Usage } from '@ai-sdk/provider';

const ZERO_USAGE: LanguageModelV4Usage = {
  inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 0, text: 0, reasoning: 0 },
};

// Minimal valid V3 stream: start then immediately finish. Annotated so the
// 'stop' / 'stream-start' literals are checked against the part union.
const STREAM_PARTS: LanguageModelV4StreamPart[] = [
  { type: 'stream-start', warnings: [] },
  { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage: ZERO_USAGE },
];

import { ModelAdapter } from '../model-adapter.js';
import type { ModelStreamEvent, ModelToolSet } from '../model-protocol.js';
import { canonicalizeToolSet } from '../request-shape.js';
import type { MakaTool } from '../tool-runtime.js';

// A tool with a real (non-trivial) zod schema so the AI SDK actually serializes it.
function tool(name: string): MakaTool {
  return {
    name,
    description: `${name} tool`,
    parameters: z.object({ q: z.string().describe('an argument') }),
    impl: () => ({ ok: true }),
  };
}

function newAdapter(): ModelAdapter {
  return new ModelAdapter({
    connection: { providerType: 'openai' } as never,
    apiKey: 'test',
    modelId: 'mock',
    modelFactory: () => ({}),
    providerOptions: {},
    newId: () => 'id',
    now: () => 0,
  });
}

/**
 * Drive the real ModelAdapter.startStream path with a mock model and report the
 * tool names the provider actually received in doStream — i.e. what crosses the
 * wire after the AI SDK applies `activeTools`.
 */
async function toolNamesSeenByProvider(activeNames: ReadonlySet<string>): Promise<string[]> {
  const tools: MakaTool[] = [tool('Read'), tool('load_tools'), tool('Rive')];
  const invalid = tool('invalid');
  const canonical = canonicalizeToolSet(tools, invalid, activeNames);

  const modelTools: ModelToolSet = {};
  for (const t of canonical.providerTools) {
    modelTools[t.name] = { description: t.description, inputSchema: t.parameters };
  }

  let seen: string[] = [];
  const model = new MockLanguageModelV4({
    doStream: async ({ tools }) => {
      seen = (tools ?? []).map((t) => t.name);
      return { stream: convertArrayToReadableStream(STREAM_PARTS) };
    },
  });

  const result = await newAdapter().startStream({
    model,
    messages: [{ role: 'user', content: 'hi' }],
    tools: modelTools,
    activeTools: canonical.activeTools,
    system: 'sys',
    abortSignal: new AbortController().signal,
    repairToolCall: async () => null,
  });
  // Drain the stream so streamText materializes the provider call.
  for await (const _chunk of result.events) {
    void _chunk;
  }
  return seen;
}

describe('hidden tools are trimmed from the provider request (wire-level)', () => {
  test('a tool outside the active set never reaches the model; invalid is never advertised', async () => {
    const seen = await toolNamesSeenByProvider(new Set(['Read', 'load_tools']));
    assert.ok(seen.includes('Read'), 'active Read should reach the provider');
    assert.ok(seen.includes('load_tools'), 'load_tools should reach the provider');
    assert.ok(!seen.includes('Rive'), 'unloaded Rive must NOT reach the provider');
    assert.ok(!seen.includes('invalid'), 'invalid is providerTools-only, never advertised');
  });

  test('a tool added to the active set does reach the model (ratchet activates it)', async () => {
    const seen = await toolNamesSeenByProvider(new Set(['Read', 'load_tools', 'Rive']));
    assert.ok(seen.includes('Rive'), 'activated Rive should reach the provider');
    assert.ok(seen.includes('Read'), 'active tools stay present after a load');
  });
});

describe('ModelAdapter provider-step boundary', () => {
  test('one startStream call ends after the provider returns tool calls', async () => {
    let providerCalls = 0;
    const model = new MockLanguageModelV4({
      doStream: async () => {
        providerCalls += 1;
        return {
          stream: convertArrayToReadableStream<LanguageModelV4StreamPart>(
            providerCalls === 1
              ? [
                  { type: 'stream-start', warnings: [] },
                  {
                    type: 'tool-call',
                    toolCallId: 'tool-1',
                    toolName: 'Read',
                    input: JSON.stringify({ q: 'README.md' }),
                  },
                  {
                    type: 'finish',
                    finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
                    usage: ZERO_USAGE,
                  },
                ]
              : [
                  { type: 'stream-start', warnings: [] },
                  {
                    type: 'finish',
                    finishReason: { unified: 'stop', raw: 'stop' },
                    usage: ZERO_USAGE,
                  },
                ],
          ),
        };
      },
    });
    const result = await newAdapter().startStream({
      model,
      messages: [{ role: 'user', content: 'read it' }],
      tools: {
        Read: {
          inputSchema: z.object({ q: z.string() }),
        },
      },
      activeTools: ['Read'],
      abortSignal: new AbortController().signal,
      repairToolCall: async () => null,
    });

    for await (const _event of result.events) {
      void _event;
    }

    assert.equal(providerCalls, 1);
  });

  test('returns provider tool calls without executing tool behavior inside the SDK', async () => {
    let executeCalls = 0;
    const toolsWithExecutableBehavior = {
      Read: {
        inputSchema: z.object({ q: z.string() }),
        execute: async () => {
          executeCalls += 1;
          return { leaked: true };
        },
      },
    };
    const model = new MockLanguageModelV4({
      doStream: {
        stream: convertArrayToReadableStream<LanguageModelV4StreamPart>([
          { type: 'stream-start', warnings: [] },
          {
            type: 'tool-call',
            toolCallId: 'tool-1',
            toolName: 'Read',
            input: JSON.stringify({ q: 'README.md' }),
          },
          {
            type: 'finish',
            finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
            usage: ZERO_USAGE,
          },
        ]),
      },
    });
    const result = await newAdapter().startStream({
      model,
      messages: [{ role: 'user', content: 'read it' }],
      tools: toolsWithExecutableBehavior,
      activeTools: ['Read'],
      abortSignal: new AbortController().signal,
      repairToolCall: async () => null,
    });

    const events: ModelStreamEvent[] = [];
    for await (const event of result.events) events.push(event);

    assert.deepEqual(
      events.filter((event) => event.kind === 'tool-call').map((event) => event.toolCall),
      [
        {
          type: 'tool-call',
          toolCallId: 'tool-1',
          toolName: 'Read',
          input: { q: 'README.md' },
        },
      ],
    );
    assert.equal(executeCalls, 0, 'ModelAdapter must strip executable behavior before streamText');
  });
});
