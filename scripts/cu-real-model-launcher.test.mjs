import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  actionRecords,
  allActionTargetsOwned,
  bindActionTargets,
  discoverFixtureIdentity,
  parseFixtureReady,
  waitForTraceFlush,
} from './cu-real-model-launcher.mjs';

test('fixture identity is discovered independently and a wrong action window cannot join it', async () => {
  const fixtureIdentity = await discoverFixtureIdentity(4242, [{ title: 'Fixture Target' }], {
    listApps: async () => [
      {
        pid: 4242,
        windows: [
          { title: 'Fixture Target', windowId: 7 },
          { title: 'Wrong Window', windowId: 99 },
        ],
      },
    ],
    timeoutMs: 50,
    pollIntervalMs: 1,
  });
  const actions = [
    {
      type: 'observe',
      toolCallId: 'observe-wrong',
      resultObservationId: 'wrong-observation',
      targetPid: 4242,
      targetWindowId: 99,
      success: true,
    },
    {
      type: 'click_element',
      toolCallId: 'click-wrong',
      sourceObservationId: 'wrong-observation',
      success: true,
    },
    {
      type: 'click_element',
      toolCallId: 'click-result-only',
      targetPid: 4242,
      targetWindowId: 7,
      success: true,
    },
  ];
  const bound = bindActionTargets(
    actions,
    [
      {
        type: 'dispatch',
        toolCallId: 'click-wrong',
        actionType: 'click_element',
        pid: 4242,
        windowId: 99,
        address: 'ax',
      },
    ],
    fixtureIdentity,
  );

  assert.deepEqual(fixtureIdentity, {
    instances: [{ pid: 4242, windowIds: [7] }],
  });
  assert.equal(bound[0].targetOwned, false);
  assert.equal(bound[1].targetOwned, false);
  assert.equal(bound[1].targetWindowId, 99);
  assert.equal(bound[2].targetOwned, false);
  assert.equal(allActionTargetsOwned(bound), false);
});

test('policy rejection remains canonical action-attempt evidence', () => {
  const records = actionRecords([
    {
      type: 'tool_start',
      toolName: 'maka_computer',
      toolUseId: 'disallowed-1',
      args: { action: 'left_click', observation_id: 'owned-observation' },
    },
    {
      type: 'tool_result',
      toolUseId: 'disallowed-1',
      content: {
        kind: 'text',
        text: 'maka_computer.left_click failed: unsupported_action_policy',
      },
      durationMs: 1,
      isError: true,
    },
    {
      type: 'tool_start',
      toolName: 'maka_computer',
      toolUseId: 'budget-1',
      args: { action: 'observe', app: 'Fixture Target' },
    },
    {
      type: 'tool_result',
      toolUseId: 'budget-1',
      content: {
        kind: 'text',
        text: 'maka_computer failed: total_action_budget_exceeded',
      },
      durationMs: 1,
      isError: true,
    },
  ]);

  assert.deepEqual(
    records.map(({ type, success, resultCode }) => ({ type, success, resultCode })),
    [
      {
        type: 'left_click',
        success: false,
        resultCode: 'unsupported_action_policy',
      },
      {
        type: 'observe',
        success: false,
        resultCode: 'total_action_budget_exceeded',
      },
    ],
  );
});

test('fixture READY identity and window discovery fail closed', async () => {
  assert.equal(parseFixtureReady('CU_FIXTURE_READY 4242\n', 4242), 4242);
  assert.throws(
    () => parseFixtureReady('CU_FIXTURE_READY 99\n', 4242),
    /does not match launcher child pid/,
  );
  await assert.rejects(
    discoverFixtureIdentity(4242, [{ title: 'Fixture Target' }], {
      listApps: async () => [{ pid: 4242, windows: [] }],
      timeoutMs: 5,
      pollIntervalMs: 1,
    }),
    /fixture identity discovery failed/,
  );
});

test('trace flush waits for every corresponding dispatch tool call', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'maka-cu-trace-test-'));
  const path = join(directory, 'trace.jsonl');
  try {
    await writeFile(
      path,
      `${JSON.stringify({
        type: 'dispatch',
        toolCallId: 'first',
      })}\n`,
    );
    const pending = waitForTraceFlush(path, ['first', 'second'], 500);
    setTimeout(() => {
      void writeFile(
        path,
        [
          JSON.stringify({ type: 'dispatch', toolCallId: 'first' }),
          JSON.stringify({ type: 'dispatch', toolCallId: 'second' }),
          '',
        ].join('\n'),
      );
    }, 30);
    const traces = await pending;
    assert.deepEqual(
      traces.map((trace) => trace.toolCallId),
      ['first', 'second'],
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
