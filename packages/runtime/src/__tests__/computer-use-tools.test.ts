import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { CuAction } from '@maka/core';
import { zodSchema } from 'ai';
import {
  adaptToCuAction,
  buildComputerUseTools,
  snapshotComputerParams,
  type CuDispatchBackend,
  type CuObservation,
  type CuRunContext,
  type CuRunResult,
} from '../computer-use-tools.js';
import type { MakaToolContext } from '../tool-runtime.js';

function ctx(signal?: AbortSignal, overrides: Partial<MakaToolContext> = {}): MakaToolContext {
  return {
    sessionId: 's1',
    turnId: 't1',
    cwd: '/tmp',
    toolCallId: 'call1',
    abortSignal: signal ?? new AbortController().signal,
    emitOutput: () => {},
    ...overrides,
  };
}

/** Fake backend: records the last action, returns a scripted result. */
function fakeBackend(
  over: Partial<{
    accessibility: boolean;
    screenRecording: boolean;
    result: CuRunResult;
  }> = {},
): CuDispatchBackend & {
  last?: CuAction;
  lastContext?: CuRunContext;
} {
  const b: CuDispatchBackend & {
    last?: CuAction;
    lastContext?: CuRunContext;
  } = {
    async preflight() {
      return {
        accessibility: over.accessibility ?? true,
        screenRecording: over.screenRecording ?? true,
      };
    },
    async run(action, _signal, context) {
      b.last = action;
      b.lastContext = context;
      return over.result ?? { outcome: { ok: true, tier: 'ax', verified: true } };
    },
  };
  return b;
}

async function callComputer(
  backend: CuDispatchBackend,
  args: Record<string, unknown>,
  signal?: AbortSignal,
) {
  const [tool] = buildComputerUseTools({ backend });
  return (await tool.impl(args as never, ctx(signal))) as { kind: string; text: string };
}

function observation(over: Partial<CuObservation> = {}): CuObservation {
  return {
    observationId: 'backend-obs-1',
    appId: 'Fixture',
    pid: 42,
    windowId: 7,
    contentFingerprint: 'ax-structure-1',
    elements: [
      {
        elementId: '5',
        role: 'AXButton',
        label: 'Continue',
        identity: { token: 'button-token', role: 'AXButton', label: 'Continue' },
      },
    ],
    screenshot: {
      base64: 'AA==',
      mimeType: 'image/png',
      widthPx: 100,
      heightPx: 80,
    },
    ...over,
  };
}

describe('adaptToCuAction — flat Anthropic grammar → discriminated CuAction', () => {
  test('screenshot / cursor_position take no coordinate', () => {
    assert.deepEqual(adaptToCuAction({ action: 'screenshot' } as never), { type: 'screenshot' });
    assert.deepEqual(adaptToCuAction({ action: 'cursor_position' } as never), {
      type: 'cursor_position',
    });
  });

  test('left_click maps coordinate tuple → {x,y} and carries modifier text', () => {
    const a = adaptToCuAction({
      action: 'left_click',
      coordinate: [12, 34],
      text: 'super',
    } as never);
    assert.deepEqual(a, { type: 'left_click', coordinate: { x: 12, y: 34 }, text: 'super' });
  });

  test('scroll fills direction/amount defaults', () => {
    const a = adaptToCuAction({ action: 'scroll', coordinate: [1, 2] } as never) as Extract<
      CuAction,
      { type: 'scroll' }
    >;
    assert.equal(a.scrollDirection, 'down');
    assert.equal(a.scrollAmount, 3);
  });

  test('left_click_drag needs both start and end coordinates', () => {
    const a = adaptToCuAction({
      action: 'left_click_drag',
      start_coordinate: [1, 2],
      coordinate: [3, 4],
    } as never);
    assert.deepEqual(a, {
      type: 'left_click_drag',
      startCoordinate: { x: 1, y: 2 },
      coordinate: { x: 3, y: 4 },
      text: undefined,
    });
  });

  test('hold_key/wait convert seconds → ms', () => {
    assert.deepEqual(adaptToCuAction({ action: 'wait', duration: 1.5 } as never), {
      type: 'wait',
      durationMs: 1500,
    });
    assert.deepEqual(adaptToCuAction({ action: 'hold_key', text: 'shift', duration: 2 } as never), {
      type: 'hold_key',
      text: 'shift',
      durationMs: 2000,
    });
  });

  test('a click without a coordinate throws invalid_coordinate', () => {
    assert.throws(() => adaptToCuAction({ action: 'left_click' } as never), /invalid_coordinate/);
  });

  test('type without text throws', () => {
    assert.throws(() => adaptToCuAction({ action: 'type' } as never), /requires text/);
  });

  test('provider function schema rejects unrelated fields and invalid coordinates', () => {
    const [tool] = buildComputerUseTools({ backend: fakeBackend() });
    const schema = tool.parameters as {
      safeParse(value: unknown): { success: boolean };
    };
    assert.equal(
      schema.safeParse({
        action: 'screenshot',
        app: 'Fixture',
        coordinate: [1, 2],
      }).success,
      true,
    );
    assert.equal(schema.safeParse({ action: 'left_click', coordinate: [-1, 2] }).success, false);
    assert.equal(schema.safeParse({ action: 'left_click', coordinate: [1.5, 2] }).success, false);
    assert.equal(schema.safeParse({ action: 'left_click', coordinate: [1, 2] }).success, true);
  });

  test('runtime strict parsing rejects fields that are irrelevant to the selected action', async () => {
    const [tool] = buildComputerUseTools({ backend: fakeBackend() });
    await assert.rejects(() =>
      Promise.resolve(
        tool.impl(
          {
            action: 'screenshot',
            app: 'Fixture',
            coordinate: [1, 2],
          } as never,
          ctx(),
        ),
      ),
    );
  });

  test('targetless observe and screenshot fail before permission or execution', async () => {
    const [tool] = buildComputerUseTools({ backend: fakeBackend() });
    assert.throws(
      () =>
        tool.permissionArgs?.({ action: 'observe' } as never, {
          sessionId: 's1',
          turnId: 't1',
          toolCallId: 'observe',
        }),
      /observe requires app or window_id/,
    );
    await assert.rejects(
      () => Promise.resolve(tool.impl({ action: 'screenshot' } as never, ctx())),
      /screenshot requires app or window_id/,
    );
  });
});

test('provider schema explains the required semantic action fields', async () => {
  const [tool] = buildComputerUseTools({ backend: fakeBackend() });
  const schema = (await zodSchema(tool.parameters as never).jsonSchema) as {
    properties?: Record<string, { description?: string }>;
  };

  assert.match(schema.properties?.action?.description ?? '', /set_value requires/);
  assert.match(schema.properties?.observation_id?.description ?? '', /Required for every action/);
  assert.match(
    schema.properties?.element_id?.description ?? '',
    /Required for click_element, set_value/,
  );
  assert.match(schema.properties?.value?.description ?? '', /Required only for set_value/);
});

test('computer params are copied and frozen before asynchronous policy checks', () => {
  const coordinate = [10, 20] as [number, number];
  const input = { action: 'left_click', coordinate } as never;
  const snapshot = snapshotComputerParams(input);
  coordinate[0] = 999;
  (input as { action: string }).action = 'right_click';

  assert.deepEqual(snapshot, { action: 'left_click', coordinate: [10, 20] });
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.coordinate), true);
});

test('computer params reject accessors before policy or execution', () => {
  const input = {};
  Object.defineProperty(input, 'action', {
    enumerable: true,
    get() {
      throw new Error('getter must not run');
    },
  });
  assert.throws(() => snapshotComputerParams(input as never), /must be a plain data property/);
});

describe('buildComputerUseTools — the `maka_computer` MakaTool', () => {
  test('uses the Maka-owned function name in the computer_use category', () => {
    const [tool] = buildComputerUseTools({ backend: fakeBackend() });
    assert.equal(tool.name, 'maka_computer');
    assert.equal(tool.categoryHint, 'computer_use');
    assert.ok(tool.parameters, 'carries a zod parameter schema');
  });

  test('waits for presentation readiness before dispatch without waiting for finish', async () => {
    const events: string[] = [];
    let ready!: () => void;
    const readyForInteraction = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const [tool] = buildComputerUseTools({
      backend: {
        async preflight() {
          return { accessibility: true, screenRecording: true };
        },
        async run() {
          events.push('dispatch');
          return { outcome: { ok: true, tier: 'ax', verified: true } };
        },
      },
      overlay: {
        onActionBegin() {
          events.push('presentation');
          return {
            readyForInteraction,
            finished: new Promise<void>(() => {}),
          };
        },
        onActionEnd() {
          events.push('end');
        },
      },
      presentationReadyTimeoutMs: 10_000,
    });

    const pending = tool.impl({ action: 'wait' } as never, ctx());
    while (events.length === 0) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.deepEqual(events, ['presentation']);
    ready();
    await pending;
    assert.deepEqual(events, ['presentation', 'dispatch', 'end']);
  });

  test('presentation readiness timeout fails open', async () => {
    const events: string[] = [];
    const [tool] = buildComputerUseTools({
      backend: {
        async preflight() {
          return { accessibility: true, screenRecording: true };
        },
        async run() {
          events.push('dispatch');
          return { outcome: { ok: true, tier: 'ax', verified: true } };
        },
      },
      overlay: {
        onActionBegin() {
          return {
            readyForInteraction: new Promise<void>(() => {}),
            finished: new Promise<void>(() => {}),
          };
        },
      },
      presentationReadyTimeoutMs: 5,
    });
    await tool.impl({ action: 'wait' } as never, ctx());
    assert.deepEqual(events, ['dispatch']);
  });

  test('user stop while presentation is pending prevents native dispatch', async () => {
    const readyForInteraction = new Promise<void>(() => {});
    let dispatchCount = 0;
    const backend = fakeBackend() as CuDispatchBackend & {
      observeApp: NonNullable<CuDispatchBackend['observeApp']>;
    };
    backend.observeApp = async () => observation();
    backend.run = async () => {
      dispatchCount += 1;
      return { outcome: { ok: true, tier: 'ax', verified: true } };
    };
    const tools = buildComputerUseTools({
      backend,
      overlay: {
        onActionBegin() {
          return {
            readyForInteraction,
            finished: new Promise<void>(() => {}),
          };
        },
      },
      presentationReadyTimeoutMs: 10_000,
    });
    const [tool] = tools;
    const observed = (await tool.impl(
      {
        action: 'observe',
        app: 'Fixture',
      } as never,
      ctx(),
    )) as {
      modelText?: string;
    };
    const observationId = JSON.parse(observed.modelText ?? '{}').observation_id;
    const pending = tool.impl(
      {
        action: 'left_click',
        observation_id: observationId,
        coordinate: [10, 10],
      } as never,
      ctx(),
    );
    await Promise.resolve();
    tools.clearSession('s1');
    const result = (await pending) as { error?: string };
    assert.equal(dispatchCount, 0);
    assert.ok(
      result.error === 'user_stopped' || result.error === 'no_active_frame',
      `unexpected stop rejection: ${result.error}`,
    );
  });

  test('abort while presentation is pending prevents native dispatch', async () => {
    const abortController = new AbortController();
    let dispatchCount = 0;
    const [tool] = buildComputerUseTools({
      backend: {
        async preflight() {
          return { accessibility: true, screenRecording: true };
        },
        async run() {
          dispatchCount += 1;
          return { outcome: { ok: true, tier: 'ax', verified: true } };
        },
      },
      overlay: {
        onActionBegin() {
          return {
            readyForInteraction: new Promise<void>(() => {}),
            finished: new Promise<void>(() => {}),
          };
        },
      },
      presentationReadyTimeoutMs: 10_000,
    });
    const pending = tool.impl({ action: 'wait' } as never, ctx(abortController.signal));
    await Promise.resolve();
    abortController.abort(new Error('stopped'));
    await assert.rejects(Promise.resolve(pending), /stopped/);
    assert.equal(dispatchCount, 0);
  });

  test('presentation receives the observation-bound screen point', async () => {
    let point: { x: number; y: number } | undefined;
    const backend = fakeBackend() as CuDispatchBackend & {
      observeApp: NonNullable<CuDispatchBackend['observeApp']>;
    };
    backend.observeApp = async () =>
      observation({
        windowBounds: { x: 100, y: 50, width: 400, height: 300 },
        sourceBoundsPx: { x: 0, y: 0, width: 800, height: 600 },
      });
    const [tool] = buildComputerUseTools({
      backend,
      overlay: {
        onActionBegin(_action, context) {
          point = context.presentationScreenPoint;
        },
      },
    });
    const observed = (await tool.impl(
      {
        action: 'observe',
        app: 'Fixture',
      } as never,
      ctx(),
    )) as {
      modelText?: string;
    };
    const observationId = JSON.parse(observed.modelText ?? '{}').observation_id;
    await tool.impl(
      {
        action: 'left_click',
        observation_id: observationId,
        coordinate: [400, 300],
      } as never,
      ctx(),
    );
    assert.deepEqual(point, { x: 300, y: 200 });
  });

  test('discarded dispatch result cancels presentation instead of showing success', async () => {
    const ended: Array<boolean | undefined> = [];
    let tools: ReturnType<typeof buildComputerUseTools>;
    const backend = fakeBackend() as CuDispatchBackend & {
      observeApp: NonNullable<CuDispatchBackend['observeApp']>;
      captureObservation: NonNullable<CuDispatchBackend['captureObservation']>;
    };
    backend.observeApp = async () => observation();
    backend.captureObservation = async () =>
      observation({
        observationId: 'backend-obs-2',
      });
    backend.run = async () => {
      tools.sessionEvents.physicalUserIntervened('s1');
      return { outcome: { ok: true, tier: 'ax', verified: true } };
    };
    tools = buildComputerUseTools({
      backend,
      overlay: {
        onActionBegin() {
          return {
            readyForInteraction: Promise.resolve(),
            finished: Promise.resolve(),
          };
        },
        onActionEnd(_action, result) {
          ended.push(result?.outcome.ok);
        },
      },
    });
    const [tool] = tools;
    const observed = (await tool.impl(
      {
        action: 'observe',
        app: 'Fixture',
      } as never,
      ctx(),
    )) as {
      modelText?: string;
    };
    const observationId = JSON.parse(observed.modelText ?? '{}').observation_id;
    const result = (await tool.impl(
      {
        action: 'left_click',
        observation_id: observationId,
        coordinate: [10, 10],
      } as never,
      ctx(),
    )) as { error?: string };
    assert.equal(result.error, 'user_intervened');
    assert.deepEqual(ended, [undefined]);
  });

  test('presentation promise rejections are isolated from execution', async () => {
    const [tool] = buildComputerUseTools({
      backend: fakeBackend(),
      overlay: {
        onActionBegin() {
          return {
            readyForInteraction: Promise.resolve(),
            finished: Promise.reject(new Error('finished failed')),
          };
        },
        async onActionEnd() {
          throw new Error('end failed');
        },
      },
    });
    const result = (await tool.impl({ action: 'wait' } as never, ctx())) as {
      text: string;
    };
    assert.match(result.text, /computer\.wait ok/);
    await new Promise((resolve) => setImmediate(resolve));
  });

  test('one visual overlay serializes presentation across independent sessions', async () => {
    const events: string[] = [];
    const ready = new Map<string, () => void>();
    const finished = new Map<string, () => void>();
    const backend: CuDispatchBackend = {
      async preflight() {
        return { accessibility: true, screenRecording: true };
      },
      async run(_action, _signal, context) {
        events.push(`dispatch:${context.sessionId}`);
        return { outcome: { ok: true, tier: 'ax', verified: true } };
      },
    };
    const [tool] = buildComputerUseTools({
      backend,
      overlay: {
        onActionBegin(_action, context) {
          events.push(`presentation:${context.sessionId}`);
          return {
            readyForInteraction: new Promise<void>((resolve) => {
              ready.set(context.sessionId, resolve);
            }),
            finished: new Promise<void>((resolve) => {
              finished.set(context.sessionId, resolve);
            }),
          };
        },
      },
      presentationReadyTimeoutMs: 10_000,
      presentationFinishedTimeoutMs: 10_000,
    });
    const first = tool.impl(
      { action: 'wait' } as never,
      ctx(undefined, { sessionId: 's1', toolCallId: 'a1' }),
    );
    const second = tool.impl(
      { action: 'wait' } as never,
      ctx(undefined, { sessionId: 's2', toolCallId: 'a2' }),
    );
    while (!ready.has('s1')) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.deepEqual(events, ['presentation:s1']);
    ready.get('s1')?.();
    await first;
    await Promise.resolve();
    assert.deepEqual(events, ['presentation:s1', 'dispatch:s1']);
    finished.get('s1')?.();
    while (!ready.has('s2')) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.deepEqual(events, ['presentation:s1', 'dispatch:s1', 'presentation:s2']);
    ready.get('s2')?.();
    await second;
    finished.get('s2')?.();
  });

  test('clearSession releases an action queued behind another presentation', async () => {
    let releaseFirst!: () => void;
    const firstReady = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstDispatchStarted!: () => void;
    const dispatchStarted = new Promise<void>((resolve) => {
      firstDispatchStarted = resolve;
    });
    let releaseDispatch!: () => void;
    const dispatchGate = new Promise<void>((resolve) => {
      releaseDispatch = resolve;
    });
    const backend: CuDispatchBackend = {
      async preflight() {
        return { accessibility: true, screenRecording: true };
      },
      async run(_action, _signal, context) {
        if (context.sessionId === 's1') {
          firstDispatchStarted();
          await dispatchGate;
        }
        return { outcome: { ok: true, tier: 'ax', verified: true } };
      },
    };
    const tools = buildComputerUseTools({
      backend,
      overlay: {
        onActionBegin(_action, context) {
          return {
            readyForInteraction: context.sessionId === 's1' ? firstReady : Promise.resolve(),
            finished: Promise.resolve(),
          };
        },
      },
      presentationReadyTimeoutMs: 10_000,
    });
    const [tool] = tools;
    const first = tool.impl(
      { action: 'wait' } as never,
      ctx(undefined, { sessionId: 's1', toolCallId: 'a1' }),
    );
    releaseFirst();
    await dispatchStarted;
    const second = tool.impl(
      { action: 'wait' } as never,
      ctx(undefined, { sessionId: 's2', toolCallId: 'a2' }),
    );
    await Promise.resolve();
    tools.clearSession('s2');
    const secondResult = (await second) as { error?: string };
    assert.equal(secondResult.error, 'user_stopped');
    releaseDispatch();
    await first;
  });

  test('list_apps and observe expose one provider-neutral Sky-like surface', async () => {
    const backend = fakeBackend() as CuDispatchBackend & {
      listApps: NonNullable<CuDispatchBackend['listApps']>;
      observeApp: NonNullable<CuDispatchBackend['observeApp']>;
    };
    backend.listApps = async () => [
      {
        appId: 'Fixture',
        pid: 42,
        name: 'Fixture',
        windowCount: 1,
        windows: [{ windowId: 7, title: 'Fixture Window' }],
      },
    ];
    backend.observeApp = async () => ({
      observationId: 'obs-1',
      appId: 'Fixture',
      pid: 42,
      windowId: 7,
      windowTitle: 'Fixture Window',
      elements: [
        {
          elementId: '5',
          role: 'AXButton',
          label: 'Continue',
        },
      ],
      screenshot: {
        base64: 'AA==',
        mimeType: 'image/png',
        widthPx: 100,
        heightPx: 80,
      },
    });
    const [tool] = buildComputerUseTools({ backend });

    const apps = (await tool.impl({ action: 'list_apps' } as never, ctx())) as { text: string };
    assert.deepEqual(JSON.parse(apps.text), {
      app_count: 1,
      window_count: 1,
    });
    assert.doesNotMatch(apps.text, /Fixture|Fixture Window/);
    const appsModelOutput = tool.toModelOutput?.({
      toolCallId: 'tool-1',
      input: {},
      output: apps,
    });
    assert.match(JSON.stringify(appsModelOutput), /Fixture Window/);
    const observation = (await tool.impl(
      {
        action: 'observe',
        app: 'Fixture',
        window_id: 7,
      } as never,
      ctx(),
    )) as { text: string; modelText?: string; screenshot?: unknown };
    assert.deepEqual(
      {
        ...JSON.parse(observation.modelText ?? ''),
        observation_id: '<runtime-generated>',
      },
      {
        observation_id: '<runtime-generated>',
        app: 'Fixture',
        pid: 42,
        window_id: 7,
        window_title: 'Fixture Window',
        elements: [{ element_id: '5', role: 'AXButton', label: 'Continue' }],
      },
    );
    assert.doesNotMatch(observation.text, /Fixture Window|Continue/);
    assert.ok(observation.screenshot);
    const modelOutput = tool.toModelOutput?.({
      toolCallId: 'tool-1',
      input: {},
      output: observation,
    });
    assert.match(JSON.stringify(modelOutput), /Fixture Window|Continue/);
  });

  test('targeted screenshot captures only the approved app window', async () => {
    const seen: unknown[] = [];
    const backend = fakeBackend() as CuDispatchBackend & {
      observeApp: NonNullable<CuDispatchBackend['observeApp']>;
    };
    backend.observeApp = async (input) => {
      seen.push(input);
      return observation();
    };
    const [tool] = buildComputerUseTools({ backend });
    const result = (await tool.impl(
      {
        action: 'screenshot',
        app: 'Fixture',
        window_id: 7,
      } as never,
      ctx(),
    )) as {
      text: string;
      screenshot?: { base64: string; mimeType: string };
    };
    assert.deepEqual(seen, [
      {
        app: 'Fixture',
        windowId: 7,
        includeScreenshot: true,
      },
    ]);
    assert.deepEqual(result.screenshot, {
      base64: 'AA==',
      mimeType: 'image/png',
    });
  });

  test('permission args bind mutations to the Runtime-owned observation target', async () => {
    const backend = fakeBackend() as CuDispatchBackend & {
      observeApp: NonNullable<CuDispatchBackend['observeApp']>;
    };
    backend.observeApp = async () => observation();
    const [tool] = buildComputerUseTools({ backend });
    const observed = (await tool.impl(
      { action: 'observe', app: 'Fixture', window_id: 7 } as never,
      ctx(),
    )) as { text: string };
    const observationId = JSON.parse(observed.text).observation_id as string;
    assert.deepEqual(
      tool.permissionArgs?.(
        {
          action: 'left_click',
          observation_id: observationId,
          coordinate: [25, 30],
        } as never,
        {
          sessionId: 's1',
          turnId: 't1',
          toolCallId: 'click',
        },
      ),
      {
        action: 'left_click',
        observation_id: observationId,
        coordinate: [25, 30],
        app: 'Fixture',
        window_id: 7,
      },
    );
    assert.deepEqual(
      tool.permissionArgs?.(
        {
          action: 'left_click',
          observation_id: 'wrong-frame',
          coordinate: [25, 30],
        } as never,
        {
          sessionId: 's1',
          turnId: 't1',
          toolCallId: 'click-wrong',
        },
      ),
      {
        action: 'left_click',
        observation_id: 'wrong-frame',
        coordinate: [25, 30],
      },
    );
  });

  test('semantic action uses the runtime observation id, forwards identity hints, and returns fresh state', async () => {
    const seen: Array<{ action: unknown; context: CuRunContext }> = [];
    const backend = fakeBackend() as CuDispatchBackend & {
      observeApp: NonNullable<CuDispatchBackend['observeApp']>;
      runSemantic: NonNullable<CuDispatchBackend['runSemantic']>;
    };
    backend.observeApp = async () => observation();
    backend.runSemantic = async (action, _signal, context) => {
      seen.push({ action, context });
      return {
        outcome: { ok: true, tier: 'ax', verified: true },
        observation: observation({
          observationId: 'backend-obs-2',
          elements: [{ elementId: '8', role: 'AXStaticText', label: 'Done' }],
        }),
      };
    };
    const [tool] = buildComputerUseTools({ backend });
    const observed = (await tool.impl({ action: 'observe', app: 'Fixture' } as never, ctx())) as {
      text: string;
    };
    const observationId = JSON.parse(observed.text).observation_id as string;

    const result = (await tool.impl(
      {
        action: 'click_element',
        observation_id: observationId,
        element_id: '5',
      } as never,
      ctx(),
    )) as {
      text: string;
      screenshot?: { base64: string; mimeType: string };
    };

    assert.equal((seen[0].action as { observationId: string }).observationId, 'backend-obs-1');
    assert.deepEqual((seen[0].action as { elementIdentity?: unknown }).elementIdentity, {
      token: 'button-token',
      role: 'AXButton',
      label: 'Continue',
    });
    assert.equal(seen[0]?.context.boundAction?.target?.windowId, 7);
    assert.match(result.text, /Fresh observation/);
    assert.doesNotMatch(result.text, new RegExp(observationId));
    assert.deepEqual(result.screenshot, {
      base64: 'AA==',
      mimeType: 'image/png',
    });
  });

  test('semantic set_value keeps its semantic action name in the model summary', async () => {
    const backend = fakeBackend() as CuDispatchBackend & {
      observeApp: NonNullable<CuDispatchBackend['observeApp']>;
      runSemantic: NonNullable<CuDispatchBackend['runSemantic']>;
    };
    backend.observeApp = async () =>
      observation({
        elements: [
          {
            elementId: '5',
            role: 'AXTextField',
            label: 'Field',
            value: '',
          },
        ],
      });
    backend.runSemantic = async () => ({
      outcome: {
        ok: true,
        tier: 'ax',
        verified: true,
        evidence: { path: 'ax', effect: 'confirmed' },
      },
      observation: observation({
        observationId: 'backend-obs-2',
        elements: [
          {
            elementId: '5',
            role: 'AXTextField',
            label: 'Field',
            value: 'updated',
          },
        ],
      }),
    });
    const [tool] = buildComputerUseTools({ backend });
    const observed = (await tool.impl({ action: 'observe', app: 'Fixture' } as never, ctx())) as {
      text: string;
    };
    const observationId = JSON.parse(observed.text).observation_id as string;

    const result = (await tool.impl(
      {
        action: 'set_value',
        observation_id: observationId,
        element_id: '5',
        value: 'updated',
      } as never,
      ctx(),
    )) as { text: string };

    assert.match(result.text, /computer\.set_value ok via ax/);
    assert.doesNotMatch(result.text, /computer\.type/);
  });

  test('semantic recovery keeps the action name when fresh observation is unavailable', async () => {
    for (const captureMode of ['missing', 'throws'] as const) {
      const backend = fakeBackend() as CuDispatchBackend & {
        observeApp: NonNullable<CuDispatchBackend['observeApp']>;
        runSemantic: NonNullable<CuDispatchBackend['runSemantic']>;
        captureObservation?: NonNullable<CuDispatchBackend['captureObservation']>;
      };
      backend.observeApp = async () =>
        observation({
          elements: [
            {
              elementId: '5',
              role: 'AXTextField',
              label: 'Field',
              value: '',
            },
          ],
        });
      backend.runSemantic = async () => ({
        outcome: { ok: true, tier: 'ax', verified: true },
      });
      if (captureMode === 'throws') {
        backend.captureObservation = async () => {
          throw new Error('capture failed');
        };
      }
      const [tool] = buildComputerUseTools({ backend });
      const observed = (await tool.impl({ action: 'observe', app: 'Fixture' } as never, ctx())) as {
        text: string;
      };
      const observationId = JSON.parse(observed.text).observation_id as string;

      const result = (await tool.impl(
        {
          action: 'set_value',
          observation_id: observationId,
          element_id: '5',
          value: 'updated',
        } as never,
        ctx(),
      )) as { text: string; error?: string };

      assert.equal(result.error, 'outcome_unknown');
      assert.match(result.text, /computer\.set_value failed: outcome_unknown/);
      assert.doesNotMatch(result.text, /computer\.type/);
    }
  });

  test('coordinate action is bound to a window-local screenshot and consumes the observation', async () => {
    const backend = fakeBackend() as CuDispatchBackend & {
      observeApp: NonNullable<CuDispatchBackend['observeApp']>;
      captureObservation: NonNullable<CuDispatchBackend['captureObservation']>;
      lastContext?: CuRunContext;
    };
    backend.observeApp = async () => observation();
    backend.captureObservation = async () =>
      observation({
        observationId: 'backend-obs-2',
      });
    const [tool] = buildComputerUseTools({ backend });
    const observed = (await tool.impl({ action: 'observe', app: 'Fixture' } as never, ctx())) as {
      text: string;
    };
    const observationId = JSON.parse(observed.text).observation_id as string;

    const result = (await tool.impl(
      {
        action: 'left_click',
        observation_id: observationId,
        coordinate: [25, 30],
      } as never,
      ctx(),
    )) as {
      text: string;
      screenshot?: { base64: string; mimeType: string };
    };

    assert.equal(backend.lastContext?.boundAction?.coordinateSpace, 'window-screenshot-local');
    assert.equal(backend.lastContext?.boundAction?.target.contentFingerprint, 'ax-structure-1');
    assert.deepEqual(backend.lastContext?.boundAction?.windowCoordinate, { x: 25, y: 30 });
    assert.match(result.text, /Fresh observation/);
    assert.deepEqual(result.screenshot, {
      base64: 'AA==',
      mimeType: 'image/png',
    });

    const replay = (await tool.impl(
      {
        action: 'left_click',
        observation_id: observationId,
        coordinate: [25, 30],
      } as never,
      ctx(),
    )) as { text: string };
    assert.match(replay.text, /duplicate_action|stale_frame|reobserve_required/);
  });

  test('successful bound action fails closed without a fresh full observation', async () => {
    const backend = fakeBackend() as CuDispatchBackend & {
      observeApp: NonNullable<CuDispatchBackend['observeApp']>;
    };
    backend.observeApp = async () => observation();
    const [tool] = buildComputerUseTools({ backend });
    const observed = (await tool.impl({ action: 'observe', app: 'Fixture' } as never, ctx())) as {
      text: string;
    };
    const observationId = JSON.parse(observed.text).observation_id as string;

    const result = (await tool.impl(
      {
        action: 'left_click',
        observation_id: observationId,
        coordinate: [25, 30],
      } as never,
      ctx(),
    )) as { text: string };

    assert.match(result.text, /outcome_unknown/);
  });

  test('bound mutating actions require Screen Recording before dispatch', async () => {
    let dispatches = 0;
    const backend = fakeBackend({ screenRecording: false }) as CuDispatchBackend & {
      observeApp: NonNullable<CuDispatchBackend['observeApp']>;
      runSemantic: NonNullable<CuDispatchBackend['runSemantic']>;
    };
    backend.observeApp = async () => observation({ screenshot: undefined });
    backend.runSemantic = async () => {
      dispatches += 1;
      return {
        outcome: { ok: true, tier: 'ax', verified: true },
        observation: observation({ observationId: 'backend-obs-2' }),
      };
    };
    backend.run = async () => {
      dispatches += 1;
      return { outcome: { ok: true, tier: 'coordinate-background' } };
    };
    const [tool] = buildComputerUseTools({ backend });
    const observed = (await tool.impl(
      {
        action: 'observe',
        app: 'Fixture',
        include_screenshot: false,
      } as never,
      ctx(),
    )) as { text: string };
    const observationId = JSON.parse(observed.text).observation_id as string;

    const semantic = (await tool.impl(
      {
        action: 'click_element',
        observation_id: observationId,
        element_id: '5',
      } as never,
      ctx(),
    )) as { text: string };
    assert.match(semantic.text, /permission_missing/);
    assert.equal(dispatches, 0);

    const observedAgain = (await tool.impl(
      {
        action: 'observe',
        app: 'Fixture',
        include_screenshot: false,
      } as never,
      ctx(),
    )) as { text: string };
    const coordinate = (await tool.impl(
      {
        action: 'left_click',
        observation_id: JSON.parse(observedAgain.text).observation_id,
        coordinate: [25, 30],
      } as never,
      ctx(),
    )) as { text: string };
    assert.match(coordinate.text, /permission_missing/);
    assert.equal(dispatches, 0);
  });

  test('zoom consumes the source observation and cannot reuse crop coordinates as the old frame', async () => {
    const backend = fakeBackend() as CuDispatchBackend & {
      observeApp: NonNullable<CuDispatchBackend['observeApp']>;
    };
    backend.observeApp = async () => observation();
    const [tool] = buildComputerUseTools({ backend });
    const observed = (await tool.impl({ action: 'observe', app: 'Fixture' } as never, ctx())) as {
      text: string;
    };
    const observationId = JSON.parse(observed.text).observation_id as string;

    const zoom = (await tool.impl(
      {
        action: 'zoom',
        observation_id: observationId,
        region: [0, 0, 50, 40],
      } as never,
      ctx(),
    )) as { text: string };
    assert.match(zoom.text, /outcome_unknown/);

    const click = (await tool.impl(
      {
        action: 'left_click',
        observation_id: observationId,
        coordinate: [10, 10],
      } as never,
      ctx(),
    )) as { text: string };
    assert.match(click.text, /stale_frame|no_active_frame|reobserve_required/);
  });

  test('runtime does not infer user intervention from observation content changes', async () => {
    const backend = fakeBackend() as CuDispatchBackend & {
      observeApp: NonNullable<CuDispatchBackend['observeApp']>;
      runSemantic: NonNullable<CuDispatchBackend['runSemantic']>;
    };
    backend.observeApp = async () => observation({ contentFingerprint: 'tree-a' });
    backend.runSemantic = async () => ({
      outcome: { ok: true, tier: 'ax', verified: false },
      observation: observation({
        observationId: 'backend-obs-2',
        contentFingerprint: 'tree-completely-different',
      }),
    });
    const [tool] = buildComputerUseTools({ backend });
    const observed = (await tool.impl({ action: 'observe', app: 'Fixture' } as never, ctx())) as {
      text: string;
    };
    const observationId = JSON.parse(observed.text).observation_id as string;

    const result = (await tool.impl(
      {
        action: 'click_element',
        observation_id: observationId,
        element_id: '5',
      } as never,
      ctx(),
    )) as { text: string };

    assert.doesNotMatch(result.text, /user_intervened/);
    assert.match(result.text, /verified=false/);
  });

  test('press_key binds the exact observed element and forwards its identity', async () => {
    const seen: Array<{ action: unknown; context: CuRunContext }> = [];
    const backend = fakeBackend() as CuDispatchBackend & {
      observeApp: NonNullable<CuDispatchBackend['observeApp']>;
      runSemantic: NonNullable<CuDispatchBackend['runSemantic']>;
    };
    backend.observeApp = async () => observation();
    backend.runSemantic = async (action, _signal, context) => {
      seen.push({ action, context });
      return {
        outcome: { ok: true, tier: 'ax', verified: true },
        observation: observation({ observationId: 'backend-obs-2' }),
      };
    };
    const [tool] = buildComputerUseTools({ backend });
    const observed = (await tool.impl({ action: 'observe', app: 'Fixture' } as never, ctx())) as {
      text: string;
    };
    const observationId = JSON.parse(observed.text).observation_id as string;

    const result = (await tool.impl(
      {
        action: 'press_key',
        observation_id: observationId,
        element_id: '5',
        text: 'ENTER',
      } as never,
      ctx(),
    )) as { text: string };

    assert.deepEqual(seen[0]?.action, {
      type: 'press_key',
      observationId: 'backend-obs-1',
      elementId: '5',
      key: 'ENTER',
      elementIdentity: {
        token: 'button-token',
        role: 'AXButton',
        label: 'Continue',
      },
    });
    assert.equal(seen[0]?.context.boundAction?.elementId, '5');
    assert.equal(seen[0]?.context.boundAction?.target?.windowId, 7);
    assert.match(result.text, /Fresh observation/);
  });

  test('press_key requires an element id from the referenced observation', async () => {
    const [tool] = buildComputerUseTools({ backend: fakeBackend() });
    await assert.rejects(
      Promise.resolve(
        tool.impl(
          {
            action: 'press_key',
            observation_id: 'frame-1',
            text: 'Return',
          } as never,
          ctx(),
        ),
      ),
      /element_id/,
    );
  });

  test('select_text forwards the identity hint for unique semantic refetch', async () => {
    const seen: unknown[] = [];
    const backend = fakeBackend() as CuDispatchBackend & {
      observeApp: NonNullable<CuDispatchBackend['observeApp']>;
      runSemantic: NonNullable<CuDispatchBackend['runSemantic']>;
    };
    backend.observeApp = async () => observation();
    backend.runSemantic = async (action) => {
      seen.push(action);
      return {
        outcome: { ok: true, tier: 'ax', verified: true },
        observation: observation({ observationId: 'backend-obs-2' }),
      };
    };
    const [tool] = buildComputerUseTools({ backend });
    const observed = (await tool.impl({ action: 'observe', app: 'Fixture' } as never, ctx())) as {
      text: string;
    };
    const observationId = JSON.parse(observed.text).observation_id as string;

    await tool.impl(
      {
        action: 'select_text',
        observation_id: observationId,
        element_id: '5',
        text: 'hello',
      } as never,
      ctx(),
    );

    assert.deepEqual((seen[0] as { elementIdentity?: unknown }).elementIdentity, {
      token: 'button-token',
      role: 'AXButton',
      label: 'Continue',
    });
  });

  test('S12: re-checks TCC and fails closed when Accessibility is not granted', async () => {
    const r = await callComputer(fakeBackend({ accessibility: false }), { action: 'wait' });
    assert.match(r.text, /permission_missing/);
    assert.match(r.text, /Accessibility/);
  });

  test('S12: a capture action fails closed when Screen Recording is not granted', async () => {
    const backend = fakeBackend({ screenRecording: false });
    backend.observeApp = async () => observation();
    const r = await callComputer(backend, {
      action: 'screenshot',
      app: 'Fixture',
    });
    assert.match(r.text, /permission_missing/);
    assert.match(r.text, /Screen Recording/);
  });

  test('dispatches the adapted action to the backend and summarizes success + tier', async () => {
    const backend = fakeBackend();
    const r = await callComputer(backend, { action: 'wait', duration: 0.01 });
    assert.deepEqual(backend.last, { type: 'wait', durationMs: 10 });
    assert.match(r.text, /computer\.wait ok via ax/);
  });

  test('passes the full runtime context to the dispatch backend', async () => {
    const backend = fakeBackend();
    await callComputer(backend, { action: 'wait' });
    assert.deepEqual(backend.lastContext, {
      sessionId: 's1',
      turnId: 't1',
      toolCallId: 'call1',
    });
  });

  test('serializes preflight and dispatch in tool-call arrival order', async () => {
    const events: string[] = [];
    let releaseFirstPreflight!: () => void;
    const firstPreflight = new Promise<void>((resolve) => {
      releaseFirstPreflight = resolve;
    });
    let preflightCount = 0;
    const backend: CuDispatchBackend = {
      async preflight() {
        preflightCount += 1;
        const call = preflightCount;
        events.push(`preflight:${call}:start`);
        if (call === 1) await firstPreflight;
        events.push(`preflight:${call}:end`);
        return { accessibility: true, screenRecording: true };
      },
      async run(action) {
        events.push(`run:${action.type}`);
        return { outcome: { ok: true, tier: 'ax', verified: true } };
      },
    };
    const [tool] = buildComputerUseTools({ backend });
    const first = tool.impl({ action: 'wait' } as never, { ...ctx(), toolCallId: 'call-wait-1' });
    const second = tool.impl({ action: 'wait' } as never, { ...ctx(), toolCallId: 'call-wait-2' });
    await Promise.resolve();
    await Promise.resolve();
    assert.deepEqual(events, ['preflight:1:start']);

    releaseFirstPreflight();
    await Promise.all([first, second]);
    assert.deepEqual(events, [
      'preflight:1:start',
      'preflight:1:end',
      'run:wait',
      'preflight:2:start',
      'preflight:2:end',
      'run:wait',
    ]);
  });

  test('does not serialize independent sessions behind one invocation queue', async () => {
    const events: string[] = [];
    let releaseFirstPreflight!: () => void;
    const firstPreflight = new Promise<void>((resolve) => {
      releaseFirstPreflight = resolve;
    });
    const backend: CuDispatchBackend = {
      async preflight(_signal) {
        const session = events.includes('preflight:s1:start') ? 's2' : 's1';
        events.push(`preflight:${session}:start`);
        if (session === 's1') await firstPreflight;
        events.push(`preflight:${session}:end`);
        return { accessibility: true, screenRecording: true };
      },
      async run(action, _signal, context) {
        events.push(`run:${context.sessionId}:${action.type}`);
        return { outcome: { ok: true, tier: 'ax', verified: true } };
      },
    };
    const [tool] = buildComputerUseTools({ backend });
    const first = tool.impl(
      { action: 'wait' } as never,
      ctx(undefined, { sessionId: 's1', toolCallId: 'call-s1' }),
    );
    const second = tool.impl(
      { action: 'wait' } as never,
      ctx(undefined, { sessionId: 's2', toolCallId: 'call-s2' }),
    );
    await Promise.resolve();
    await Promise.resolve();
    assert.ok(events.includes('preflight:s2:end'), `events=${events.join(',')}`);
    assert.ok(events.includes('run:s2:wait'), `events=${events.join(',')}`);

    releaseFirstPreflight();
    await Promise.all([first, second]);
  });

  test('physical intervention during dispatch discards a backend success', async () => {
    let markDispatchStarted!: () => void;
    const dispatchStarted = new Promise<void>((resolve) => {
      markDispatchStarted = resolve;
    });
    let releaseDispatch!: () => void;
    const dispatchGate = new Promise<void>((resolve) => {
      releaseDispatch = resolve;
    });
    const backend = fakeBackend() as CuDispatchBackend & {
      observeApp: NonNullable<CuDispatchBackend['observeApp']>;
      captureObservation: NonNullable<CuDispatchBackend['captureObservation']>;
    };
    backend.observeApp = async () => observation();
    backend.captureObservation = async () =>
      observation({
        observationId: 'backend-obs-2',
      });
    backend.run = async () => {
      markDispatchStarted();
      await dispatchGate;
      return { outcome: { ok: true, tier: 'ax', verified: true } };
    };
    const tools = buildComputerUseTools({ backend });
    const [tool] = tools;
    const observed = (await tool.impl({ action: 'observe', app: 'Fixture' } as never, ctx())) as {
      text: string;
    };
    const action = tool.impl(
      {
        action: 'left_click',
        observation_id: JSON.parse(observed.text).observation_id,
        coordinate: [25, 30],
      } as never,
      ctx(),
    );

    await dispatchStarted;
    tools.sessionEvents.physicalUserIntervened('s1');
    releaseDispatch();
    const result = (await action) as { text: string };

    assert.match(result.text, /user_intervened/);
    assert.equal(tools.sessionEvents.snapshot('s1').status, 'intervention_debounce');
  });

  test('screen lock blocks a new observation until unlock and explicit reobserve', async () => {
    const backend = fakeBackend() as CuDispatchBackend & {
      observeApp: NonNullable<CuDispatchBackend['observeApp']>;
    };
    backend.observeApp = async () => observation();
    const tools = buildComputerUseTools({ backend });
    const [tool] = tools;
    tools.sessionEvents.screenLocked('s1');

    const locked = (await tool.impl({ action: 'observe', app: 'Fixture' } as never, ctx())) as {
      text: string;
    };
    assert.match(locked.text, /screen_locked/);

    tools.sessionEvents.screenUnlocked('s1');
    const unlocked = (await tool.impl({ action: 'observe', app: 'Fixture' } as never, ctx())) as {
      text: string;
    };
    assert.doesNotMatch(unlocked.text, /screen_locked|reobserve_required/);
  });

  for (const [error, expectedStatus] of [
    ['user_intervened', 'reobserve_required'],
    ['screen_locked', 'screen_locked'],
    ['blocked_url', 'blocked_url'],
    ['outcome_unknown', 'reobserve_required'],
    ['service_unavailable', 'reobserve_required'],
  ] as const) {
    test(`typed ${error} outcome advances Runtime to ${expectedStatus}`, async () => {
      const backend = fakeBackend() as CuDispatchBackend & {
        observeApp: NonNullable<CuDispatchBackend['observeApp']>;
        captureObservation: NonNullable<CuDispatchBackend['captureObservation']>;
      };
      backend.observeApp = async () => observation();
      backend.captureObservation = async () =>
        observation({
          observationId: 'backend-obs-2',
        });
      backend.run = async () => ({
        outcome: {
          ok: false,
          error,
          message: error,
        },
      });
      const tools = buildComputerUseTools({ backend });
      const [tool] = tools;
      const observed = (await tool.impl(
        {
          action: 'observe',
          app: 'Fixture',
        } as never,
        ctx(),
      )) as { text: string };
      await tool.impl(
        {
          action: 'left_click',
          observation_id: JSON.parse(observed.text).observation_id,
          coordinate: [25, 30],
        } as never,
        ctx(),
      );
      assert.equal(tools.sessionEvents.snapshot('s1').status, expectedStatus);
    });
  }

  test('generic outcome_unknown remains model-visible while requiring reobserve', async () => {
    const backend = fakeBackend() as CuDispatchBackend & {
      observeApp: NonNullable<CuDispatchBackend['observeApp']>;
    };
    backend.observeApp = async () => observation();
    backend.run = async () => ({
      outcome: {
        ok: false,
        error: 'outcome_unknown',
        message: 'delivery may have occurred',
      },
    });
    const tools = buildComputerUseTools({ backend });
    const [tool] = tools;
    const observed = (await tool.impl({ action: 'observe', app: 'Fixture' } as never, ctx())) as {
      text: string;
    };

    const result = (await tool.impl(
      {
        action: 'left_click',
        observation_id: JSON.parse(observed.text).observation_id,
        coordinate: [25, 30],
      } as never,
      ctx(),
    )) as { text: string };

    assert.match(result.text, /outcome_unknown/);
    assert.doesNotMatch(result.text, /failed: reobserve_required/);
    assert.equal(tools.sessionEvents.snapshot('s1').status, 'reobserve_required');
  });

  test('semantic outcome_unknown remains model-visible while requiring reobserve', async () => {
    const backend = fakeBackend() as CuDispatchBackend & {
      observeApp: NonNullable<CuDispatchBackend['observeApp']>;
      runSemantic: NonNullable<CuDispatchBackend['runSemantic']>;
    };
    backend.observeApp = async () => observation();
    backend.runSemantic = async () => ({
      outcome: {
        ok: false,
        error: 'outcome_unknown',
        message: 'semantic delivery may have occurred',
      },
    });
    const tools = buildComputerUseTools({ backend });
    const [tool] = tools;
    const observed = (await tool.impl({ action: 'observe', app: 'Fixture' } as never, ctx())) as {
      text: string;
    };

    const result = (await tool.impl(
      {
        action: 'click_element',
        observation_id: JSON.parse(observed.text).observation_id,
        element_id: '5',
      } as never,
      ctx(),
    )) as { text: string };

    assert.match(result.text, /outcome_unknown/);
    assert.doesNotMatch(result.text, /failed: reobserve_required/);
    assert.equal(tools.sessionEvents.snapshot('s1').status, 'reobserve_required');
  });

  for (const semantic of [false, true]) {
    test(`clearSession cannot mask a delivered ${semantic ? 'semantic ' : ''}mutation outcome`, async () => {
      let release!: () => void;
      let started!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const entered = new Promise<void>((resolve) => {
        started = resolve;
      });
      const backend = fakeBackend() as CuDispatchBackend & {
        observeApp: NonNullable<CuDispatchBackend['observeApp']>;
        runSemantic: NonNullable<CuDispatchBackend['runSemantic']>;
      };
      backend.observeApp = async () => observation();
      backend.run = async () => {
        started();
        await gate;
        return {
          outcome: {
            ok: false,
            error: 'outcome_unknown',
            message: 'coordinate delivery may have occurred',
          },
        };
      };
      backend.runSemantic = async () => {
        started();
        await gate;
        return {
          outcome: {
            ok: false,
            error: 'capture_failed',
            message: 'semantic verification failed after delivery',
            completedSubSteps: 1,
          },
        };
      };
      const tools = buildComputerUseTools({ backend });
      const [tool] = tools;
      const observed = (await tool.impl({ action: 'observe', app: 'Fixture' } as never, ctx())) as {
        text: string;
      };
      const observationId = JSON.parse(observed.text).observation_id as string;
      const pending = tool.impl(
        semantic
          ? ({
              action: 'click_element',
              observation_id: observationId,
              element_id: '5',
            } as never)
          : ({
              action: 'left_click',
              observation_id: observationId,
              coordinate: [25, 30],
            } as never),
        ctx(),
      );
      await entered;

      tools.clearSession('s1');
      release();

      const result = (await pending) as { text: string; error?: string };
      assert.equal(result.error, 'outcome_unknown');
      assert.match(result.text, /outcome_unknown/);
      assert.doesNotMatch(result.text, /user_stopped|no_active_frame/);
      assert.equal(tools.sessionEvents.snapshot('s1').status, 'user_stopped');
    });
  }

  test('a queued keyboard mutation cannot silently target a newer frame', async () => {
    let releaseClick!: () => void;
    const clickGate = new Promise<void>((resolve) => {
      releaseClick = resolve;
    });
    let dispatches = 0;
    const backend = fakeBackend() as CuDispatchBackend & {
      observeApp: NonNullable<CuDispatchBackend['observeApp']>;
      captureObservation: NonNullable<CuDispatchBackend['captureObservation']>;
    };
    backend.observeApp = async () => observation();
    backend.captureObservation = async () =>
      observation({
        observationId: 'backend-obs-2',
      });
    backend.run = async (action) => {
      dispatches += 1;
      if (action.type === 'left_click') await clickGate;
      return { outcome: { ok: true, tier: 'ax', verified: true } };
    };
    const [tool] = buildComputerUseTools({ backend });
    const observed = (await tool.impl({ action: 'observe', app: 'Fixture' } as never, ctx())) as {
      text: string;
    };
    const observationId = JSON.parse(observed.text).observation_id as string;

    const click = tool.impl(
      {
        action: 'left_click',
        observation_id: observationId,
        coordinate: [25, 30],
      } as never,
      ctx(undefined, { toolCallId: 'click' }),
    );
    const type = tool.impl(
      {
        action: 'type',
        observation_id: observationId,
        text: 'hello',
      } as never,
      ctx(undefined, { toolCallId: 'type' }),
    );

    await Promise.resolve();
    releaseClick();
    await click;
    const typed = (await type) as { text: string };

    assert.match(typed.text, /stale_frame|stale_epoch|reobserve_required/);
    assert.equal(dispatches, 1);
  });

  test('an unknown dispatch outcome requires a fresh observation', async () => {
    const backend = fakeBackend() as CuDispatchBackend & {
      observeApp: NonNullable<CuDispatchBackend['observeApp']>;
    };
    backend.observeApp = async () => observation();
    backend.run = async () => {
      throw new Error('child exited after dispatch');
    };
    const tools = buildComputerUseTools({ backend });
    const [tool] = tools;
    const observed = (await tool.impl({ action: 'observe', app: 'Fixture' } as never, ctx())) as {
      text: string;
    };

    await assert.rejects(() =>
      Promise.resolve(
        tool.impl(
          {
            action: 'left_click',
            observation_id: JSON.parse(observed.text).observation_id,
            coordinate: [25, 30],
          } as never,
          ctx(),
        ),
      ),
    );
    assert.equal(tools.sessionEvents.snapshot('s1').status, 'reobserve_required');
  });

  test('clearSession keeps a same-turn tombstone but a new turn can reopen', async () => {
    const backend = fakeBackend() as CuDispatchBackend & {
      observeApp: NonNullable<CuDispatchBackend['observeApp']>;
    };
    backend.observeApp = async () => observation();
    const tools = buildComputerUseTools({ backend });
    const [tool] = tools;

    await tool.impl({ action: 'observe', app: 'Fixture' } as never, ctx());
    tools.clearSession('s1');
    const sameTurn = (await tool.impl({ action: 'observe', app: 'Fixture' } as never, ctx())) as {
      text: string;
    };
    assert.match(sameTurn.text, /user_stopped/);

    const nextTurn = (await tool.impl(
      { action: 'observe', app: 'Fixture' } as never,
      ctx(undefined, { turnId: 't2', toolCallId: 'observe-t2' }),
    )) as { text: string };
    assert.doesNotMatch(nextTurn.text, /user_stopped/);
  });

  test('clearSession fences a first invocation that is already queued', async () => {
    let observeAppCalls = 0;
    const backend = fakeBackend() as CuDispatchBackend & {
      observeApp: NonNullable<CuDispatchBackend['observeApp']>;
    };
    backend.observeApp = async () => {
      observeAppCalls += 1;
      return observation();
    };
    const tools = buildComputerUseTools({ backend });
    const tool = tools[0];

    const pending = tool.impl(
      {
        action: 'observe',
        app: 'Fixture',
      } as never,
      ctx(),
    );
    tools.clearSession('s1');

    const result = (await pending) as { text: string };
    assert.match(result.text, /user_stopped/);
    assert.equal(observeAppCalls, 0);
  });

  test('clearSession fences a later turn that was queued before stop', async () => {
    let release!: () => void;
    let entered!: () => void;
    let observeAppCalls = 0;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const backend = fakeBackend() as CuDispatchBackend & {
      observeApp: NonNullable<CuDispatchBackend['observeApp']>;
    };
    backend.observeApp = async () => {
      observeAppCalls += 1;
      if (observeAppCalls === 1) {
        entered();
        await gate;
      }
      return observation();
    };
    const tools = buildComputerUseTools({ backend });
    const [tool] = tools;
    const first = tool.impl({ action: 'observe', app: 'Fixture' } as never, ctx());
    await started;
    const second = tool.impl(
      { action: 'observe', app: 'Fixture' } as never,
      ctx(undefined, { turnId: 't2', toolCallId: 'observe-t2' }),
    );
    tools.clearSession('s1');
    release();

    const [firstResult, secondResult] = (await Promise.all([first, second])) as Array<{
      text: string;
    }>;
    assert.match(firstResult.text, /user_stopped/);
    assert.match(secondResult.text, /user_stopped/);
    assert.equal(observeAppCalls, 1);
  });

  test('clearSession after a non-CU turn does not block the next turn observe', async () => {
    let observeAppCalls = 0;
    const backend = fakeBackend() as CuDispatchBackend & {
      observeApp: NonNullable<CuDispatchBackend['observeApp']>;
    };
    backend.observeApp = async () => {
      observeAppCalls += 1;
      return observation();
    };
    const tools = buildComputerUseTools({ backend });
    const tool = tools[0];

    tools.clearSession('s1');
    const result = (await tool.impl(
      { action: 'observe', app: 'Fixture' } as never,
      ctx(undefined, { turnId: 'next-turn', toolCallId: 'observe-next' }),
    )) as { text: string };

    assert.doesNotMatch(result.text, /user_stopped/);
    assert.equal(observeAppCalls, 1);
  });

  test('clearSession fences host-reading results that complete after stop', async () => {
    for (const input of [
      { action: 'list_apps' },
      { action: 'screenshot', app: 'Fixture' },
      { action: 'cursor_position' },
      { action: 'wait', duration: 0.001 },
    ] as const) {
      let release!: () => void;
      let started!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const entered = new Promise<void>((resolve) => {
        started = resolve;
      });
      const backend = fakeBackend() as CuDispatchBackend & {
        listApps: NonNullable<CuDispatchBackend['listApps']>;
        observeApp: NonNullable<CuDispatchBackend['observeApp']>;
      };
      backend.listApps = async () => {
        started();
        await gate;
        return [];
      };
      backend.observeApp = async () => {
        started();
        await gate;
        return observation();
      };
      backend.run = async (action) => {
        started();
        await gate;
        return action.type === 'cursor_position'
          ? {
              outcome: { ok: true, tier: 'coordinate-background' },
              resolvedScreenPoint: { x: 10, y: 20 },
            }
          : { outcome: { ok: true, tier: 'coordinate-background' } };
      };
      const tools = buildComputerUseTools({ backend });
      const tool = tools[0];
      const pending = tool.impl(input as never, ctx());
      await entered;
      tools.clearSession('s1');
      release();

      const result = (await pending) as { text: string; screenshot?: unknown };
      assert.match(result.text, /user_stopped/, input.action);
      assert.equal(result.screenshot, undefined, input.action);
    }
  });

  test('clearSession fences failed host-reading results that complete after stop', async () => {
    for (const action of ['cursor_position', 'wait'] as const) {
      let release!: () => void;
      let started!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const entered = new Promise<void>((resolve) => {
        started = resolve;
      });
      const backend = fakeBackend();
      backend.run = async () => {
        started();
        await gate;
        return {
          outcome: {
            ok: false,
            error: 'service_unavailable',
            message: 'service failed after stop',
          },
        };
      };
      const tools = buildComputerUseTools({ backend });
      const [tool] = tools;
      const pending = tool.impl(
        action === 'wait' ? ({ action, duration: 0.001 } as never) : ({ action } as never),
        ctx(),
      );
      await entered;
      tools.clearSession('s1');
      release();

      const result = (await pending) as { text: string };
      assert.match(result.text, /user_stopped/, action);
      assert.doesNotMatch(result.text, /service_unavailable/, action);
    }
  });

  test('ordinary failed host reads preserve their typed backend error', async () => {
    for (const action of ['cursor_position', 'wait'] as const) {
      const backend = fakeBackend({
        result: {
          outcome: {
            ok: false,
            error: 'service_unavailable',
            message: 'service is unavailable',
          },
        },
      });
      const [tool] = buildComputerUseTools({ backend });
      const result = (await tool.impl(
        action === 'wait' ? ({ action, duration: 0.001 } as never) : ({ action } as never),
        ctx(),
      )) as { text: string; error?: string };

      assert.equal(result.error, 'service_unavailable', action);
      assert.match(result.text, /service_unavailable/, action);
      assert.doesNotMatch(result.text, /reobserve_required/, action);
    }
  });

  test('cursor_position returns the resolved screen point to the model', async () => {
    const backend = fakeBackend({
      result: {
        outcome: { ok: true, tier: 'coordinate-background', verified: true },
        resolvedScreenPoint: { x: 10, y: 20 },
      },
    });
    const [tool] = buildComputerUseTools({ backend });
    const result = (await tool.impl({ action: 'cursor_position' } as never, ctx())) as {
      text: string;
    };

    assert.match(result.text, /screen_point=10,20/);
  });

  test('fresh observations inherit a separately returned screenshot', async () => {
    const backend = fakeBackend() as CuDispatchBackend & {
      observeApp: NonNullable<CuDispatchBackend['observeApp']>;
    };
    backend.observeApp = async () => observation();
    backend.run = async () => ({
      outcome: { ok: true, tier: 'ax', verified: true },
      observation: observation({
        observationId: 'backend-obs-2',
        screenshot: undefined,
      }),
      screenshot: {
        base64: 'AQ==',
        mimeType: 'image/png',
        widthPx: 120,
        heightPx: 90,
      },
    });
    const [tool] = buildComputerUseTools({ backend });
    const observed = (await tool.impl({ action: 'observe', app: 'Fixture' } as never, ctx())) as {
      text: string;
    };
    const result = (await tool.impl(
      {
        action: 'left_click',
        observation_id: JSON.parse(observed.text).observation_id,
        coordinate: [25, 30],
      } as never,
      ctx(),
    )) as {
      modelText?: string;
      screenshot?: { base64: string; mimeType: string };
    };

    assert.deepEqual(result.screenshot, {
      base64: 'AQ==',
      mimeType: 'image/png',
    });
    const freshObservationId = JSON.parse(
      (result.modelText ?? '').split('Fresh observation:\n')[1] ?? '{}',
    ).observation_id as string;
    const followUp = (await tool.impl(
      {
        action: 'left_click',
        observation_id: freshObservationId,
        coordinate: [30, 35],
      } as never,
      ctx(),
    )) as { text: string };
    assert.match(followUp.text, /computer\.left_click ok/);
  });

  test('S17: surfaces the typed backend failure code without leaking raw driver text', async () => {
    const backend = fakeBackend({
      result: {
        outcome: {
          ok: false,
          error: 'capture_failed',
          message: 'AXPress err -25202',
          completedSubSteps: 0,
        },
      },
    });
    const r = await callComputer(backend, { action: 'wait' });
    assert.match(r.text, /failed: capture_failed/);
    assert.doesNotMatch(r.text, /AXPress err -25202/);
  });

  test('an unverified dispatch tells the model to re-screenshot (no silent success)', async () => {
    const backend = fakeBackend({ result: { outcome: { ok: true, tier: 'ax', verified: false } } });
    const r = await callComputer(backend, { action: 'wait' });
    assert.match(r.text, /verified=false/);
    assert.match(r.text, /re-screenshot/);
  });

  test('a confirmed effect tells the model not to repeat the action', async () => {
    const r = await callComputer(
      fakeBackend({
        result: {
          outcome: {
            ok: true,
            tier: 'semantic-background',
            verified: true,
            evidence: { path: 'cdp', effect: 'confirmed' },
          },
        },
      }),
      { action: 'wait' },
    );
    assert.match(r.text, /effect confirmed/);
    assert.match(r.text, /do not repeat/);
    assert.doesNotMatch(r.text, /re-screenshot/);
  });

  test('surfaces controlled dispatch evidence without escalation reason or AX text', async () => {
    const backend = fakeBackend({
      result: {
        outcome: {
          ok: true,
          tier: 'coordinate-background',
          verified: false,
          evidence: {
            path: 'cgevent',
            effect: 'unverifiable',
            reason: 'window Secret Draft, api_key=super-secret-value',
          },
        },
      },
    });
    const r = await callComputer(backend, { action: 'wait' });
    assert.match(r.text, /path=cgevent/);
    assert.match(r.text, /effect=unverifiable/);
    assert.doesNotMatch(r.text, /Secret Draft/);
    assert.doesNotMatch(r.text, /super-secret-value/);
  });

  test('redacts synthetic tool errors again at the model-output boundary', () => {
    const [tool] = buildComputerUseTools({ backend: fakeBackend() });
    const output = tool.toModelOutput?.({
      output: { error: 'api_key=super-secret-value' },
    } as never) as { value: Array<{ type: string; text?: string }> };
    assert.equal(output.value[0]?.type, 'text');
    assert.match(output.value[0]?.text ?? '', /\[redacted\]/);
    assert.doesNotMatch(output.value[0]?.text ?? '', /super-secret-value/);
  });

  test('S18: an already-aborted signal short-circuits before any dispatch', async () => {
    const ac = new AbortController();
    ac.abort();
    const backend = fakeBackend();
    const r = await callComputer(backend, { action: 'left_click', coordinate: [1, 1] }, ac.signal);
    assert.match(r.text, /aborted/);
    assert.equal(backend.last, undefined, 'backend.run must not be called after abort');
  });
});
