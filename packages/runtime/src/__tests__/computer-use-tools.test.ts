import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { CuAction } from '@maka/core/computer-use';
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

/**
 * Pull the observation id out of the model-facing text.
 *
 * It is the first field of the header line precisely because the model has to
 * quote it back on every bound action.
 */
function observationIdOf(modelText: string | undefined): string {
  return /observation_id=(\S+)/.exec(modelText ?? '')?.[1] ?? '';
}

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
    const observationId = observationIdOf(observed.modelText);
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
    const observationId = observationIdOf(observed.modelText);
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

  test('presentation receives the window the action is bound to', async () => {
    // The overlay decides its window level from this field: with a window to
    // order against, the resting cursor is placed directly above it instead of
    // floating over every application window. Nothing outside this function
    // sets it, so if the runtime stops producing it the cursor silently goes
    // back to hanging over whatever the user is reading — with every unit test
    // in the overlay still green, because they supply the field by hand.
    let seen: number | undefined | 'never called' = 'never called';
    const backend = fakeBackend() as CuDispatchBackend & {
      observeApp: NonNullable<CuDispatchBackend['observeApp']>;
    };
    backend.observeApp = async () =>
      observation({
        windowId: 4321,
        windowBounds: { x: 100, y: 50, width: 400, height: 300 },
        sourceBoundsPx: { x: 0, y: 0, width: 800, height: 600 },
      });
    const [tool] = buildComputerUseTools({
      backend,
      overlay: {
        onActionBegin(_action, context) {
          seen = context.targetWindowId;
        },
      },
    });
    const observed = (await tool.impl({ action: 'observe', app: 'Fixture' } as never, ctx())) as {
      modelText?: string;
    };
    const observationId = observationIdOf(observed.modelText);
    await tool.impl(
      {
        action: 'left_click',
        observation_id: observationId,
        coordinate: [400, 300],
      } as never,
      ctx(),
    );
    assert.equal(seen, 4321);
  });

  test('a fence that declares its own worst case is not cut short by the default', async () => {
    // The backstop is a safety net for a presentation layer that died, not a
    // second opinion on how long a motion takes. The cursor overlay derives its
    // deadline from the same spring its release gate is read against; a shorter
    // default here resolves the action mid-flight, which is the click firing
    // while the glyph is still travelling.
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
          return {
            readyForInteraction,
            finished: new Promise<void>(() => {}),
            readyTimeoutMs: 10_000,
          };
        },
      },
      presentationReadyTimeoutMs: 5,
    });
    const pending = tool.impl({ action: 'wait' } as never, ctx());
    // Ten times the default the caller configured. Without the fence's own
    // deadline winning, dispatch has already happened by now.
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(events, [], 'the short default did not release the action');
    ready();
    await pending;
    assert.deepEqual(events, ['dispatch']);
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
    const observationId = observationIdOf(observed.modelText);
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

  test('launch_app starts an app and hands back a directly targetable window', async () => {
    // Without this the model can only drive apps that already happen to be
    // running. The launch returns pid + windows so the next call can be
    // observe(window_id) rather than list_apps-then-guess.
    const backend = fakeBackend() as CuDispatchBackend & {
      launchApp: NonNullable<CuDispatchBackend['launchApp']>;
    };
    const seen: Array<{ app: string }> = [];
    backend.launchApp = async (input) => {
      seen.push(input);
      return {
        pid: 5150,
        bundleId: 'com.example.fixture',
        name: 'Fixture App',
        windows: [{ windowId: 501, title: 'Fixture Main' }],
        focusHeld: true,
      };
    };
    const [tool] = buildComputerUseTools({ backend });

    const launched = (await tool.impl(
      { action: 'launch_app', app: 'com.example.fixture' } as never,
      ctx(),
    )) as { text: string; modelText?: string };

    assert.deepEqual(seen, [{ app: 'com.example.fixture' }]);
    assert.deepEqual(JSON.parse(launched.text), { pid: 5150, window_count: 1 });
    // Window titles are model-facing only, the same split list_apps uses.
    assert.doesNotMatch(launched.text, /Fixture Main/);
    assert.deepEqual(JSON.parse(launched.modelText ?? ''), {
      pid: 5150,
      bundle_id: 'com.example.fixture',
      name: 'Fixture App',
      windows: [{ window_id: 501, title: 'Fixture Main' }],
    });
  });

  test('launch_app reports when the app took the foreground anyway', async () => {
    // A background launch that fronts the app disturbed the user. The model
    // should know, because what it sees next may not be what it expected.
    const backend = fakeBackend() as CuDispatchBackend & {
      launchApp: NonNullable<CuDispatchBackend['launchApp']>;
    };
    backend.launchApp = async () => ({
      pid: 5150,
      windows: [],
      focusHeld: false,
    });
    const [tool] = buildComputerUseTools({ backend });

    const launched = (await tool.impl(
      { action: 'launch_app', app: 'Fixture App' } as never,
      ctx(),
    )) as { modelText?: string };
    assert.equal(JSON.parse(launched.modelText ?? '').took_foreground, true);
  });

  test('launch_app on a backend without support fails rather than silently doing nothing', async () => {
    const backend = fakeBackend();
    delete (backend as { launchApp?: unknown }).launchApp;
    const [tool] = buildComputerUseTools({ backend });
    const result = (await tool.impl(
      { action: 'launch_app', app: 'Fixture App' } as never,
      ctx(),
    )) as { text: string };
    assert.match(result.text, /unsupported_action/);
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
    const observationLines = (observation.modelText ?? '').split('\n');
    assert.equal(
      observationLines[0]?.replace(/observation_id=\S+/, 'observation_id=<runtime-generated>'),
      'observation_id=<runtime-generated> app=Fixture pid=42 window_id=7 ' +
        'window="Fixture Window" elements=1',
    );
    assert.deepEqual(observationLines.slice(1), ['5 AXButton "Continue"']);
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

  test('an element action may repeat the target it already named, and the host still resolves it', async () => {
    // The tool schema the model reads is one flat object: `window_id` is a
    // documented top-level parameter. A model being careful about which window
    // it drives supplies it, and the action union used to reject that as an
    // unrecognized key — six of eleven calls on a real desktop run, with only
    // "arguments failed validation" to go on.
    const backend = fakeBackend() as CuDispatchBackend & {
      observeApp: NonNullable<CuDispatchBackend['observeApp']>;
      runSemantic: NonNullable<CuDispatchBackend['runSemantic']>;
    };
    backend.observeApp = async () => observation();
    let dispatched = 0;
    backend.runSemantic = async () => {
      dispatched += 1;
      return { outcome: { ok: true, tier: 'ax', verified: true } };
    };
    const [tool] = buildComputerUseTools({ backend });
    const observed = (await tool.impl(
      { action: 'observe', app: 'Fixture', window_id: 7 } as never,
      ctx(),
    )) as { text: string };
    const observationId = JSON.parse(observed.text).observation_id as string;

    const result = (await tool.impl(
      {
        action: 'click_element',
        observation_id: observationId,
        element_id: '5',
        app: 'Fixture',
        window_id: 7,
      } as never,
      ctx(undefined, { toolCallId: 'click-with-hints' }),
    )) as { text: string };
    // What matters is that the arguments were accepted and the action reached
    // the executor. What the executor then reports is another test's business.
    assert.equal(dispatched, 1);
    assert.doesNotMatch(result.text, /failed validation/);
  });

  test('a stale frame comes back with a current one, a latched refusal does not', async () => {
    // 97 calls across a real seven-application matrix, 51 of them failures, and
    // 42% of every call made was pure observation: between one and five calls
    // in twenty actually did anything, and six of seven scenarios ran out of
    // time. Only successes carried a fresh observation, so every refusal left
    // the model holding a frame it had just been told was stale, with one move
    // available — spend another round trip asking to look again.
    //
    // `user_intervened` is different and stays different: it is a latch whose
    // release is the user stopping, and observing on its behalf would open it.
    const observationCalls: string[] = [];
    const backend = fakeBackend() as CuDispatchBackend & {
      observeApp: NonNullable<CuDispatchBackend['observeApp']>;
      captureObservation: NonNullable<CuDispatchBackend['captureObservation']>;
      runSemantic: NonNullable<CuDispatchBackend['runSemantic']>;
    };
    let failure: 'target_changed' | 'user_intervened' = 'target_changed';
    backend.observeApp = async () => observation();
    backend.captureObservation = async () => {
      observationCalls.push('capture');
      return observation();
    };
    backend.runSemantic = async () => ({
      outcome: { ok: false, error: failure, message: 'refused' },
    });
    const [tool] = buildComputerUseTools({ backend });
    const observed = (await tool.impl(
      { action: 'observe', app: 'Fixture', window_id: 7 } as never,
      ctx(),
    )) as { text: string };
    const observationId = JSON.parse(observed.text).observation_id as string;

    const stale = (await tool.impl(
      { action: 'click_element', observation_id: observationId, element_id: '5' } as never,
      ctx(undefined, { toolCallId: 'stale' }),
    )) as { text: string; modelText?: string };
    assert.match(stale.modelText ?? stale.text, /Fresh observation/);

    const reobserved = (await tool.impl(
      { action: 'observe', app: 'Fixture', window_id: 7 } as never,
      ctx(undefined, { toolCallId: 'observe-2' }),
    )) as { text: string };
    failure = 'user_intervened';
    const latched = (await tool.impl(
      {
        action: 'click_element',
        observation_id: JSON.parse(reobserved.text).observation_id,
        element_id: '5',
      } as never,
      ctx(undefined, { toolCallId: 'latched' }),
    )) as { text: string; modelText?: string };
    assert.doesNotMatch(latched.modelText ?? latched.text, /Fresh observation/);
  });

  test('a sequence takes four presses in one call, looking again between each', async () => {
    // `element_id` is an index into one snapshot, spent the moment anything
    // happens, so pressing 7 × 8 = cost four observations and four actions.
    // A label is not an index: it is true of the control before and after the
    // press, so the host can take a step, look again with its own eyes, and
    // take the next.
    const dispatched: string[] = [];
    let captures = 0;
    const backend = fakeBackend() as CuDispatchBackend & {
      observeApp: NonNullable<CuDispatchBackend['observeApp']>;
      captureObservation: NonNullable<CuDispatchBackend['captureObservation']>;
      runSemantic: NonNullable<CuDispatchBackend['runSemantic']>;
    };
    const keypad = (): CuObservation =>
      observation({
        elements: ['7', '×', '8', '='].map((label, index) => ({
          elementId: String(index + 1),
          role: 'AXButton',
          label,
          identity: { role: 'AXButton', label },
        })),
      });
    backend.observeApp = async () => keypad();
    backend.captureObservation = async () => {
      captures += 1;
      return keypad();
    };
    backend.runSemantic = async (action) => {
      dispatched.push(
        'elementId' in action && action.elementId !== undefined ? action.elementId : action.type,
      );
      return { outcome: { ok: true, tier: 'ax', verified: true } };
    };
    const [tool] = buildComputerUseTools({ backend });
    const observed = (await tool.impl(
      { action: 'observe', app: 'Fixture', window_id: 7 } as never,
      ctx(),
    )) as { text: string };

    const result = (await tool.impl(
      {
        action: 'element_sequence',
        observation_id: JSON.parse(observed.text).observation_id,
        steps: [{ label: '7' }, { label: '×' }, { label: '8' }, { label: '=' }],
      } as never,
      ctx(undefined, { toolCallId: 'sequence' }),
    )) as { text: string; modelText?: string };

    assert.deepEqual(dispatched, ['1', '2', '3', '4']);
    // Three re-observations between the four steps, plus the closing one.
    assert.equal(captures, 4);
    assert.match(result.text, /ok \(4 of 4 steps\)/);
  });

  test('a sequence stops at the step it cannot resolve, and says which', async () => {
    const backend = fakeBackend() as CuDispatchBackend & {
      observeApp: NonNullable<CuDispatchBackend['observeApp']>;
      captureObservation: NonNullable<CuDispatchBackend['captureObservation']>;
      runSemantic: NonNullable<CuDispatchBackend['runSemantic']>;
    };
    let dispatched = 0;
    const twoButtons = (): CuObservation =>
      observation({
        elements: [
          {
            elementId: '1',
            role: 'AXButton',
            label: 'Yes',
            identity: { role: 'AXButton', label: 'Yes' },
          },
        ],
      });
    backend.observeApp = async () => twoButtons();
    backend.captureObservation = async () => twoButtons();
    backend.runSemantic = async () => {
      dispatched += 1;
      return { outcome: { ok: true, tier: 'ax', verified: true } };
    };
    const [tool] = buildComputerUseTools({ backend });
    const observed = (await tool.impl(
      { action: 'observe', app: 'Fixture', window_id: 7 } as never,
      ctx(),
    )) as { text: string };
    const result = (await tool.impl(
      {
        action: 'element_sequence',
        observation_id: JSON.parse(observed.text).observation_id,
        steps: [{ label: 'Yes' }, { label: 'Nope' }, { label: 'Yes' }],
      } as never,
      ctx(undefined, { toolCallId: 'sequence-stop' }),
    )) as { text: string; modelText?: string };
    assert.equal(dispatched, 1, 'nothing after the unresolved step runs');
    assert.match(result.text, /stopped at step 2 of 3: target_missing/);
  });

  test('a sequence walks its steps without asking for a picture each time', async () => {
    // Measured on a real run: `stopped at step 1 of 9: capture_failed` with
    // step 1 reported `ok`. The capture between steps exists to find the next
    // control by name — ids are renumbered per snapshot and a calculator's
    // 全部清除 becomes 清除 once a digit is entered — and a name needs no
    // pixels. Asking for them let one slow capture end a nine-key calculation
    // after its first key.
    const backend = fakeBackend() as CuDispatchBackend & {
      observeApp: NonNullable<CuDispatchBackend['observeApp']>;
      captureObservation: NonNullable<CuDispatchBackend['captureObservation']>;
      runSemantic: NonNullable<CuDispatchBackend['runSemantic']>;
    };
    const asked: boolean[] = [];
    const oneButton = (): CuObservation =>
      observation({
        elements: [
          {
            elementId: '1',
            role: 'AXButton',
            label: 'Yes',
            identity: { role: 'AXButton', label: 'Yes' },
          },
        ],
      });
    backend.observeApp = async () => oneButton();
    backend.captureObservation = async (request) => {
      asked.push(request.includeScreenshot);
      return oneButton();
    };
    backend.runSemantic = async () => ({ outcome: { ok: true, tier: 'ax', verified: true } });
    const [tool] = buildComputerUseTools({ backend });
    const observed = (await tool.impl(
      { action: 'observe', app: 'Fixture', window_id: 7 } as never,
      ctx(),
    )) as { text: string };

    const result = (await tool.impl(
      {
        action: 'element_sequence',
        observation_id: JSON.parse(observed.text).observation_id,
        steps: [{ label: 'Yes' }, { label: 'Yes' }, { label: 'Yes' }],
      } as never,
      ctx(undefined, { toolCallId: 'sequence-pictures' }),
    )) as { text: string };

    assert.match(result.text, /ok \(3 of 3 steps\)/);
    assert.ok(asked.length >= 2, 'the sequence re-observed between steps');
    // Every capture but the last one is between steps and wants no picture.
    assert.deepEqual(
      asked.slice(0, -1),
      asked.slice(0, -1).map(() => false),
      'a between-steps capture must not ask for a screenshot',
    );
    // The last one is the frame the mirror shows, and nothing waits behind it.
    assert.equal(asked.at(-1), true);
  });

  test('scroll_element reaches the executor at all', async () => {
    // It was in the action union, in the approval classes and in the semantic
    // dispatch branch — and missing from the one list that grants an action
    // lease, which the semantic branch refuses without. Every call returned
    // `no_active_frame` however fresh the observation was. Nothing noticed
    // because nothing called it: the schema never said what it needed, so the
    // model never tried.
    const backend = fakeBackend() as CuDispatchBackend & {
      observeApp: NonNullable<CuDispatchBackend['observeApp']>;
      runSemantic: NonNullable<CuDispatchBackend['runSemantic']>;
    };
    let scrolled: unknown;
    backend.observeApp = async () => observation();
    backend.runSemantic = async (action) => {
      scrolled = action;
      return { outcome: { ok: true, tier: 'ax', verified: true } };
    };
    const [tool] = buildComputerUseTools({ backend });
    const observed = (await tool.impl(
      { action: 'observe', app: 'Fixture', window_id: 7 } as never,
      ctx(),
    )) as { text: string };
    const observationId = JSON.parse(observed.text).observation_id as string;

    const result = (await tool.impl(
      {
        action: 'scroll_element',
        observation_id: observationId,
        element_id: '5',
        scroll_direction: 'down',
        scroll_amount: 20,
      } as never,
      ctx(undefined, { toolCallId: 'scroll-1' }),
    )) as { text: string };
    assert.doesNotMatch(result.text, /no_active_frame/);
    assert.equal((scrolled as { type?: string } | undefined)?.type, 'scroll_element');
  });

  test('a target hint that disagrees with the observation is reported, not ignored', async () => {
    const backend = fakeBackend() as CuDispatchBackend & {
      observeApp: NonNullable<CuDispatchBackend['observeApp']>;
      runSemantic: NonNullable<CuDispatchBackend['runSemantic']>;
    };
    let dispatched = 0;
    backend.observeApp = async () => observation();
    backend.runSemantic = async () => {
      dispatched += 1;
      return { outcome: { ok: true, tier: 'ax', verified: true } };
    };
    const [tool] = buildComputerUseTools({ backend });
    const observed = (await tool.impl(
      { action: 'observe', app: 'Fixture', window_id: 7 } as never,
      ctx(),
    )) as { text: string };
    const observationId = JSON.parse(observed.text).observation_id as string;

    const result = (await tool.impl(
      {
        action: 'click_element',
        observation_id: observationId,
        element_id: '5',
        window_id: 999,
      } as never,
      ctx(undefined, { toolCallId: 'click-wrong-window' }),
    )) as { text: string };
    assert.match(result.text, /target_mismatch/);
    assert.match(result.text, /window 7/);
    assert.equal(dispatched, 0, 'a contradicted target must not be dispatched');
  });

  test('the name that resolved an observation is not a contradiction of it', async () => {
    // macOS reports a localized display name and that name is the identity, so
    // "Dictionary" resolves through `list_apps` to 词典 and the observation
    // comes back as 词典. The model keeps saying "Dictionary" — it is the name
    // it was given — and `targetHintConflict` compares strings.
    //
    // `CuObservation.appAlias` and the `hinted.app !== record.appAlias` escape
    // that reads it were both written for this, and nothing ever set the field:
    // the escape could not fire, so a name that had just worked was answered
    // with `target_mismatch`. This is the producer.
    const backend = fakeBackend() as CuDispatchBackend & {
      observeApp: NonNullable<CuDispatchBackend['observeApp']>;
      runSemantic: NonNullable<CuDispatchBackend['runSemantic']>;
      listApps: NonNullable<CuDispatchBackend['listApps']>;
    };
    let dispatched = 0;
    backend.listApps = async () => [{ appId: '词典', name: 'Dictionary', pid: 42, windowCount: 1 }];
    backend.observeApp = async () => observation({ appId: '词典' });
    backend.captureObservation = async () => observation({ appId: '词典' });
    backend.runSemantic = async () => {
      dispatched += 1;
      return { outcome: { ok: true, tier: 'ax', verified: true } };
    };
    const [tool] = buildComputerUseTools({ backend });
    const observed = (await tool.impl(
      { action: 'observe', app: 'Dictionary' } as never,
      ctx(),
    )) as { text: string };
    const observationId = JSON.parse(observed.text).observation_id as string;

    const result = (await tool.impl(
      {
        action: 'click_element',
        observation_id: observationId,
        element_id: '5',
        app: 'Dictionary',
      } as never,
      ctx(undefined, { toolCallId: 'click-by-alias' }),
    )) as { text: string };

    assert.doesNotMatch(result.text, /target_mismatch/);
    assert.equal(dispatched, 1, 'the name that resolved the observation must still address it');

    // And it survives the fresh observation every dispatch takes afterwards.
    // Only `observe` knows the name the model used; re-registering the record
    // from a capture cleared the alias, so `Dictionary` worked exactly once.
    const later = (await tool.impl(
      {
        action: 'click_element',
        observation_id: observationId,
        element_id: '5',
        app: 'Dictionary',
      } as never,
      ctx(undefined, { toolCallId: 'click-by-alias-again' }),
    )) as { text: string };
    assert.doesNotMatch(later.text, /target_mismatch/);

    // The canonical id is not a contradiction either, and a third name still is.
    const wrong = (await tool.impl(
      {
        action: 'click_element',
        observation_id: observationId,
        element_id: '5',
        app: 'Calculator',
      } as never,
      ctx(undefined, { toolCallId: 'click-wrong-app' }),
    )) as { text: string };
    assert.match(wrong.text, /target_mismatch/);
  });

  test('an unverified target hint never reaches the approval summary', async () => {
    // The approval summary is what a person reads before allowing the action.
    // With no active frame confirming it, `app` here is the model's claim.
    const backend = fakeBackend();
    const [tool] = buildComputerUseTools({ backend });
    assert.deepEqual(
      tool.permissionArgs?.(
        {
          action: 'click_element',
          observation_id: 'no-such-frame',
          element_id: '5',
          app: 'Some Other App',
          window_id: 4242,
        } as never,
        { sessionId: 's1', turnId: 't1', toolCallId: 'unbound' },
      ),
      {
        action: 'click_element',
        observation_id: 'no-such-frame',
        element_id: '5',
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

  test('semantic action recaptures a pictureless result for presentation', async () => {
    const captures: boolean[] = [];
    const presented: Array<CuRunResult | undefined> = [];
    const backend = fakeBackend() as CuDispatchBackend & {
      observeApp: NonNullable<CuDispatchBackend['observeApp']>;
      captureObservation: NonNullable<CuDispatchBackend['captureObservation']>;
      runSemantic: NonNullable<CuDispatchBackend['runSemantic']>;
    };
    backend.observeApp = async () => observation();
    backend.runSemantic = async () => ({
      outcome: { ok: true, tier: 'ax', verified: true },
      observation: observation({
        observationId: 'pictureless-post-action',
        screenshot: undefined,
      }),
    });
    backend.captureObservation = async (input) => {
      captures.push(input.includeScreenshot);
      return observation({ observationId: 'presentation-frame' });
    };
    const [tool] = buildComputerUseTools({
      backend,
      overlay: {
        onActionBegin() {},
        onActionEnd(_action, result) {
          presented.push(result);
        },
      },
    });
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
    )) as { screenshot?: { base64: string; mimeType: string } };

    assert.deepEqual(captures, [true]);
    assert.deepEqual(result.screenshot, {
      base64: 'AA==',
      mimeType: 'image/png',
    });
    assert.equal(presented.length, 1);
    assert.ok(presented[0]?.observation?.screenshot);
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

  test('press_key binds the observation window without requiring an element id', async () => {
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
        text: 'ENTER',
      } as never,
      ctx(),
    )) as { text: string };

    assert.deepEqual(seen[0]?.action, {
      type: 'press_key',
      observationId: 'backend-obs-1',
      key: 'ENTER',
    });
    assert.equal(seen[0]?.context.boundAction?.elementId, undefined);
    assert.equal(seen[0]?.context.boundAction?.target?.windowId, 7);
    assert.match(result.text, /Fresh observation/);
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

  test('requests Accessibility once on first use while every action still preflights', async () => {
    let preflights = 0;
    let requests = 0;
    const backend = fakeBackend({ accessibility: false });
    backend.preflight = async () => {
      preflights += 1;
      return { accessibility: false, screenRecording: true };
    };
    backend.requestAccessibilityPermission = async () => {
      requests += 1;
    };
    const [tool] = buildComputerUseTools({ backend });

    const first = (await tool.impl({ action: 'wait' } as never, ctx())) as { text: string };
    const second = (await tool.impl({ action: 'wait' } as never, ctx())) as { text: string };

    assert.match(first.text, /permission_missing/);
    assert.match(second.text, /permission_missing/);
    assert.equal(preflights, 2);
    assert.equal(requests, 1);
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
    const freshObservationId = observationIdOf(
      (result.modelText ?? '').split('Fresh observation:\n')[1],
    );
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

  test('S20: observe takes the name a person uses, not only a bundle id', async () => {
    // Across 37 recorded runs, 34 spent their first call turning 计算器 into
    // com.apple.calculator, and 39 of those 44 list_apps calls already carried
    // an app filter — the model knew which application it wanted and was only
    // asking for the spelling. 100% of runs, 100% success, 0% of them doing
    // anything.
    const backend = fakeBackend() as CuDispatchBackend & {
      observeApp: NonNullable<CuDispatchBackend['observeApp']>;
      listApps: NonNullable<CuDispatchBackend['listApps']>;
    };
    const asked: Array<string | undefined> = [];
    backend.listApps = async () => [
      { appId: 'com.apple.calculator', pid: 1, name: '计算器', windowCount: 1 },
      { appId: 'com.apple.TextEdit', pid: 2, name: '文本编辑', windowCount: 1 },
    ];
    backend.observeApp = async (request) => {
      asked.push(request.app);
      return observation();
    };
    const [tool] = buildComputerUseTools({ backend });

    for (const name of ['计算器', 'Calculator', 'calculator']) {
      await tool.impl(
        { action: 'observe', app: name } as never,
        ctx(undefined, { sessionId: name }),
      );
    }
    assert.deepEqual(asked, [
      'com.apple.calculator',
      'com.apple.calculator',
      'com.apple.calculator',
    ]);

    // A string that could already be an id goes through untouched, so an
    // executor that knows ids this host has never seen keeps working.
    asked.length = 0;
    await tool.impl(
      { action: 'observe', app: 'com.example.unheard' } as never,
      ctx(undefined, { sessionId: 'passthrough' }),
    );
    assert.deepEqual(asked, ['com.example.unheard']);
  });

  test("S21: a name matching two applications is the model's to settle", async () => {
    const backend = fakeBackend() as CuDispatchBackend & {
      observeApp: NonNullable<CuDispatchBackend['observeApp']>;
      listApps: NonNullable<CuDispatchBackend['listApps']>;
    };
    let observed = 0;
    backend.listApps = async () => [
      { appId: 'com.apple.Safari', pid: 1, name: 'Safari', windowCount: 1 },
      {
        appId: 'com.apple.SafariTechnologyPreview',
        pid: 2,
        name: 'Safari Preview',
        windowCount: 2,
      },
    ];
    backend.observeApp = async () => {
      observed += 1;
      return observation();
    };
    const [tool] = buildComputerUseTools({ backend });

    const result = (await tool.impl({ action: 'observe', app: 'Safari' } as never, ctx())) as {
      text: string;
    };

    // Picking one silently would drive the wrong window and report success.
    assert.match(result.text, /ambiguous_target/);
    assert.match(result.text, /com\.apple\.Safari/);
    assert.match(result.text, /com\.apple\.SafariTechnologyPreview/);
    assert.equal(observed, 0, 'nothing was observed while the target was in doubt');
  });

  test('S22: a lookup that fails leaves the name alone', async () => {
    // The executor has its own account of an application it cannot find, and
    // that account is better than one invented from an empty list.
    const backend = fakeBackend() as CuDispatchBackend & {
      observeApp: NonNullable<CuDispatchBackend['observeApp']>;
      listApps: NonNullable<CuDispatchBackend['listApps']>;
    };
    const asked: Array<string | undefined> = [];
    backend.listApps = async () => {
      throw new Error('the executor is not answering');
    };
    backend.observeApp = async (request) => {
      asked.push(request.app);
      return observation();
    };
    const [tool] = buildComputerUseTools({ backend });

    await tool.impl({ action: 'observe', app: 'Calculator' } as never, ctx());
    assert.deepEqual(asked, ['Calculator']);
  });

  test('S19: a window that did not answer in time is not reported as missing', async () => {
    // Every observe failure was `target_missing`, including a timeout — so the
    // failure said "no such app" about an app that was running, in the same
    // sentence that listed it among the apps that were. Three models read that
    // and re-sent the identical call.
    const backend = fakeBackend() as CuDispatchBackend & {
      observeApp: NonNullable<CuDispatchBackend['observeApp']>;
      listApps: NonNullable<CuDispatchBackend['listApps']>;
    };
    backend.observeApp = async () => {
      throw new Error('timeout: the operation did not finish in time');
    };
    backend.listApps = async () => [
      { appId: 'com.apple.TextEdit', pid: 1, name: 'TextEdit', windowCount: 1 },
    ];
    const [tool] = buildComputerUseTools({ backend });

    const failed = (await tool.impl(
      { action: 'observe', app: 'com.apple.TextEdit' } as never,
      ctx(),
    )) as { text: string; modelText?: string };
    const said = failed.modelText ?? failed.text;

    assert.match(said, /timeout/);
    assert.doesNotMatch(said, /target_missing/);
    // The recovery names the cause. A capture costs a flat 66–85ms while
    // walking a large window costs hundreds, so `query` is the lever that
    // matches — and telling it to drop a screenshot it did not ask for names
    // something it cannot act on.
    assert.match(said, /query/);
    assert.doesNotMatch(said, /include_screenshot/);
    assert.doesNotMatch(said, /Apps with windows/);
  });
});
