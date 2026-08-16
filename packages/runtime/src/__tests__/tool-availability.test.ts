import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { z } from 'zod';

import {
  ToolAvailabilityRuntime,
  LOAD_TOOLS_NAME,
  toolAvailabilityHash,
  type RuntimeEventLike,
  type StepLike,
} from '../tool-availability.js';
import type { MakaTool } from '../tool-runtime.js';

function tool(name: string): MakaTool {
  return { name, description: name, parameters: z.object({}), impl: () => ({ ok: true }) };
}

const invalid: MakaTool = {
  name: 'invalid',
  description: 'invalid',
  parameters: z.object({}),
  impl: () => ({}),
};

const ctx = {
  sessionId: 's',
  turnId: 't',
  cwd: '/tmp',
  toolCallId: 'tc',
  abortSignal: new AbortController().signal,
  emitOutput: () => {},
};

test('tool availability hash captures policy while canonicalizing group members', () => {
  const full = toolAvailabilityHash({ economy: false });
  const economy = toolAvailabilityHash({
    economy: true,
    groups: [{ id: 'docs', toolNames: ['docs_read', 'docs_edit', 'docs_read'] }],
  });
  const reordered = toolAvailabilityHash({
    economy: true,
    groups: [{ id: 'docs', toolNames: ['docs_edit', 'docs_read'] }],
  });

  assert.notEqual(full, economy);
  assert.equal(economy, reordered);
});

// rive/docs grouped; Read/Write ungrouped (always visible).
function runtime(economy: boolean) {
  return new ToolAvailabilityRuntime(
    [tool('Read'), tool('Write'), tool('rive_run'), tool('docs_edit'), tool('docs_read')],
    {
      economy,
      groups: [
        { id: 'rive', toolNames: ['rive_run'], label: 'Rive' },
        { id: 'docs', toolNames: ['docs_edit', 'docs_read'], description: 'Document tools' },
      ],
    },
    invalid,
  );
}

function loadStep(group: string): StepLike {
  return { toolCalls: [{ toolName: LOAD_TOOLS_NAME, input: { group } }] };
}

describe('ToolAvailabilityRuntime — economy mode', () => {
  test('only ungrouped tools + connector are active at step 0; group tools hidden', () => {
    const plan = runtime(true).prepare([]);
    assert.ok(plan.activeTools.includes('Read'), 'ungrouped tool is visible');
    assert.ok(plan.activeTools.includes('Write'), 'ungrouped defaults to visible');
    assert.ok(plan.activeTools.includes(LOAD_TOOLS_NAME), 'connector is always visible');
    assert.ok(!plan.activeTools.includes('rive_run'), 'grouped tool hidden until loaded');
    assert.ok(!plan.activeTools.includes('docs_edit'));
  });

  test('a required orchestration tool stays pinned for the whole turn', () => {
    const plan = runtime(true).prepare([], new Set(['rive_run']));
    assert.ok(plan.activeTools.includes('rive_run'), 'required tool is visible at step 0');
    assert.ok(plan.gating?.activeNames().has('rive_run'));
    const next = plan.projectActiveTools!({ completedSteps: [] });
    assert.ok(next.activeTools.includes('rive_run'), 'required tool remains visible later');
    assert.ok(!next.activeTools.includes('docs_edit'), 'other deferred groups remain hidden');
  });

  test('the connector activates a group in the next request projection', () => {
    const plan = runtime(true).prepare([]);
    assert.ok(plan.projectActiveTools);
    const next = plan.projectActiveTools!({ completedSteps: [loadStep('docs')] });
    assert.ok(next.activeTools.includes('docs_edit'), 'docs group active after load_tools(docs)');
    assert.ok(next.activeTools.includes('docs_read'));
    assert.ok(!next.activeTools.includes('rive_run'), 'an unloaded group stays hidden');
  });

  test('connector rejects an unknown group', async () => {
    const connector = runtime(true)
      .prepare([])
      .providerTools.find((t) => t.name === LOAD_TOOLS_NAME);
    assert.ok(connector);
    await assert.rejects(async () => connector!.impl({ group: 'nope' }, ctx), /Unknown tool group/);
  });
});

describe('ToolAvailabilityRuntime — durable ledger seed', () => {
  function event(name: string, args: unknown): RuntimeEventLike {
    return { content: { kind: 'function_call', name, args } };
  }

  test('a prior-turn load_tools call re-activates the group at step 0', () => {
    const plan = runtime(true).prepare([event(LOAD_TOOLS_NAME, { group: 'rive' })]);
    assert.ok(plan.activeTools.includes('rive_run'), 'seeded group active from turn start');
    assert.ok(!plan.activeTools.includes('docs_edit'), 'unseeded group still hidden');
  });
});

describe('ToolAvailabilityRuntime — activation robustness', () => {
  test('parses a stringified connector input, ignores malformed input', () => {
    const plan = runtime(true).prepare([]);
    const ok = plan.projectActiveTools!({
      completedSteps: [
        { toolCalls: [{ toolName: LOAD_TOOLS_NAME, input: JSON.stringify({ group: 'rive' }) }] },
      ],
    });
    assert.ok(ok.activeTools.includes('rive_run'), 'stringified { group } is parsed');

    const bad = runtime(true).prepare([]);
    const after = bad.projectActiveTools!({
      completedSteps: [{ toolCalls: [{ toolName: LOAD_TOOLS_NAME, input: 'not json' }] }],
    });
    assert.ok(!after.activeTools.includes('rive_run'), 'malformed input activates nothing');
  });

  test('a non-function_call ledger event does not seed a group', () => {
    const plan = runtime(true).prepare([
      { content: { kind: 'function_response', name: LOAD_TOOLS_NAME, args: { group: 'rive' } } },
    ]);
    assert.ok(!plan.activeTools.includes('rive_run'), 'only committed function_call events seed');
  });
});
