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

describe('ToolAvailabilityRuntime — full mode', () => {
  test('economy off advertises every tool, no connector / gating / diagnostics', () => {
    const plan = runtime(false).prepare([]);
    assert.ok(
      plan.activeTools.includes('rive_run'),
      'grouped tools are active when economy is off',
    );
    assert.ok(plan.activeTools.includes('docs_edit'));
    assert.ok(!plan.activeTools.includes(LOAD_TOOLS_NAME), 'no connector in full mode');
    assert.equal(plan.projectActiveTools, undefined);
    assert.equal(plan.gating, undefined);
    assert.equal(plan.diagnostics([], 0), undefined);
  });

  test('economy on but no hideable groups falls back to full mode', () => {
    const r = new ToolAvailabilityRuntime([tool('Read')], { economy: true }, invalid);
    const plan = r.prepare([]);
    assert.equal(plan.gating, undefined, 'nothing to hide → no gating');
    assert.ok(plan.activeTools.includes('Read'));
  });
});

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

  test('unknown required tool names are ignored', () => {
    const plan = runtime(true).prepare([], new Set(['not-a-tool']));
    assert.ok(!plan.activeTools.includes('not-a-tool'));
    assert.ok(!plan.activeTools.includes('rive_run'));
  });

  test('providerTools keeps every tool dispatchable, including hidden groups + invalid', () => {
    const names = runtime(true)
      .prepare([])
      .providerTools.map((t) => t.name);
    for (const n of [
      'Read',
      'Write',
      'rive_run',
      'docs_edit',
      'docs_read',
      LOAD_TOOLS_NAME,
      'invalid',
    ]) {
      assert.ok(names.includes(n), `${n} present in providerTools`);
    }
  });

  test('the connector activates a group in the next request projection', () => {
    const plan = runtime(true).prepare([]);
    assert.ok(plan.projectActiveTools);
    const next = plan.projectActiveTools!({ completedSteps: [loadStep('docs')] });
    assert.ok(next.activeTools.includes('docs_edit'), 'docs group active after load_tools(docs)');
    assert.ok(next.activeTools.includes('docs_read'));
    assert.ok(!next.activeTools.includes('rive_run'), 'an unloaded group stays hidden');
  });

  test('gating exposes group members and tracks the current step snapshot', () => {
    const plan = runtime(true).prepare([]);
    assert.ok(plan.gating);
    assert.deepEqual([...plan.gating!.gatedNames].sort(), ['docs_edit', 'docs_read', 'rive_run']);
    assert.ok(!plan.gating!.activeNames().has('rive_run'), 'rive hidden at step 0');
    plan.projectActiveTools!({ completedSteps: [loadStep('rive')] });
    assert.ok(plan.gating!.activeNames().has('rive_run'), 'snapshot updated after rive load');
  });

  test('connector impl returns the group tool names; unknown group throws', async () => {
    const connector = runtime(true)
      .prepare([])
      .providerTools.find((t) => t.name === LOAD_TOOLS_NAME);
    assert.ok(connector);
    assert.deepEqual(await connector!.impl({ group: 'docs' }, ctx), {
      loaded: ['docs_edit', 'docs_read'],
    });
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

  test('historical load_tool (PR#30) and connect_tool_source (PR#34) calls also seed', () => {
    const fromDeferred = runtime(true).prepare([event('load_tool', { namespace: 'docs' })]);
    assert.ok(
      fromDeferred.activeTools.includes('docs_edit'),
      'load_tool namespace seeds the group',
    );

    const fromEconomy = runtime(true).prepare([event('connect_tool_source', { source: 'rive' })]);
    assert.ok(
      fromEconomy.activeTools.includes('rive_run'),
      'connect_tool_source source seeds the group',
    );
  });

  test('an unknown seeded group id is ignored (forward compatible)', () => {
    const plan = runtime(true).prepare([event(LOAD_TOOLS_NAME, { group: 'ghost' })]);
    assert.ok(!plan.activeTools.includes('rive_run'));
    assert.ok(!plan.activeTools.includes('docs_edit'));
  });
});

describe('ToolAvailabilityRuntime — diagnostics', () => {
  test('reports the active subset, enabled/available groups, and schema reduction', () => {
    const plan = runtime(true).prepare([]);
    const d = plan.diagnostics(plan.activeTools, 100);
    assert.ok(d);
    assert.equal(d!.mode, 'economy');
    assert.equal(d!.connectorToolName, LOAD_TOOLS_NAME);
    assert.deepEqual(d!.enabledSourceIds, [], 'no group loaded at step 0');
    assert.deepEqual(d!.availableSourceIds, ['docs', 'rive']);
    assert.deepEqual(d!.visibleToolNamesBySource, {
      docs: ['docs_edit', 'docs_read'],
      rive: ['rive_run'],
    });
    assert.ok(
      (d!.fullToolSchemaChars ?? 0) > (d!.visibleToolSchemaChars ?? 0),
      'hidden schemas reduce the visible chars',
    );
    assert.ok((d!.toolSchemaCharReduction ?? 0) > 0);
    // full = visible + hidden must hold (the connector is counted on both
    // sides, so it cancels — guards against the hiddenToolCount off-by-one).
    assert.equal(d!.hiddenToolCount, 3, 'rive(1) + docs(2) tools are hidden at step 0');
    assert.equal(d!.fullToolCount, (d!.visibleToolCount ?? 0) + (d!.hiddenToolCount ?? 0));
  });

  test('enabledSourceIds grows once a group is loaded', () => {
    const plan = runtime(true).prepare([]);
    const active = plan.projectActiveTools!({ completedSteps: [loadStep('rive')] }).activeTools;
    const d = plan.diagnostics(active, 100);
    assert.deepEqual(d!.enabledSourceIds, ['rive']);
    assert.deepEqual(d!.availableSourceIds, ['docs']);
  });
});

describe('ToolAvailabilityRuntime — connector shape', () => {
  function connector() {
    const found = runtime(true)
      .prepare([])
      .providerTools.find((t) => t.name === LOAD_TOOLS_NAME);
    assert.ok(found);
    return found!;
  }

  test('lists every group in its description and never requires permission', () => {
    const c = connector();
    assert.match(c.description, /rive/);
    assert.match(c.description, /docs/);
    assert.match(c.description, /Rive/); // rive group's label
    assert.match(c.description, /Document tools/); // docs group's description
  });

  test('loading a group returns exactly its tool names — a thin result, no schema', async () => {
    const result = await connector().impl({ group: 'docs' }, ctx);
    assert.deepEqual(result, { loaded: ['docs_edit', 'docs_read'] });
    const keys = Object.keys(result as object);
    assert.ok(
      !keys.includes('schema') && !keys.includes('parameters') && !keys.includes('inputSchema'),
    );
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

  test('same-turn activation honors only load_tools({group}) — historical names and other keys are inert', () => {
    const cases: Array<{ toolName: string; input: unknown }> = [
      { toolName: 'load_tool', input: { namespace: 'rive' } }, // PR#30 name — ledger-only
      { toolName: 'connect_tool_source', input: { source: 'rive' } }, // PR#34 name — ledger-only
      { toolName: LOAD_TOOLS_NAME, input: { namespace: 'rive' } }, // right name, wrong key
      { toolName: LOAD_TOOLS_NAME, input: { source: 'rive' } }, // right name, wrong key
    ];
    for (const c of cases) {
      const plan = runtime(true).prepare([]);
      const next = plan.projectActiveTools!({ completedSteps: [{ toolCalls: [c] }] });
      assert.ok(
        !next.activeTools.includes('rive_run'),
        `step ${c.toolName}(${JSON.stringify(c.input)}) must NOT activate a group`,
      );
    }
    // Only the live connector with the `group` arg activates same-turn.
    const ok = runtime(true).prepare([]).projectActiveTools!({
      completedSteps: [loadStep('rive')],
    });
    assert.ok(ok.activeTools.includes('rive_run'));
  });

  test('a non-function_call ledger event does not seed a group', () => {
    const plan = runtime(true).prepare([
      { content: { kind: 'function_response', name: LOAD_TOOLS_NAME, args: { group: 'rive' } } },
    ]);
    assert.ok(!plan.activeTools.includes('rive_run'), 'only committed function_call events seed');
  });
});
