import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { CuAction } from '@maka/core/computer-use';
import { buildComputerUseTools } from '@maka/runtime/computer-use-tools';
import {
  type CuDispatchBackend,
  type CuObservation,
  type CuRunContext,
} from '@maka/runtime/computer-use-types';
import { parseObservationText } from '@maka/runtime/test-only/observation-text-reader';
import {
  createComputerUseOverlayHook,
  type OverlayCursorSink,
} from '../computer-use-overlay-hook.js';

/**
 * The observation id the tool just handed the model.
 *
 * The model-facing observation is a rendered document, not JSON, so this reads
 * it with the runtime's own test-only reader rather than a fourth copy of a
 * parser. It was `JSON.parse` here, which is how this suite went red the day
 * the rendering changed.
 */
function observationIdOf(modelText: string | undefined): string {
  const parsed = parseObservationText(modelText ?? '');
  assert.ok(parsed, 'the tool did not return a rendered observation');
  return parsed.observation_id;
}

function context(overrides: Partial<CuRunContext> = {}) {
  return {
    sessionId: 'session-1',
    turnId: 'turn-1',
    toolCallId: 'tool-1',
    cwd: '/tmp',
    abortSignal: new AbortController().signal,
    emitOutput: () => {},
    ...overrides,
  };
}

function fixtureObservation(overrides: Partial<CuObservation> = {}): CuObservation {
  return {
    observationId: 'backend-observation-1',
    appId: 'Fixture',
    pid: 100,
    windowId: 10,
    windowBounds: { x: 100, y: 100, width: 600, height: 400 },
    sourceBoundsPx: { x: 0, y: 0, width: 1200, height: 800 },
    contentFingerprint: 'fixture-structure-a',
    zIndex: 5,
    elements: [
      {
        elementId: '5',
        role: 'AXButton',
        label: 'Commit target',
        identity: {
          token: 'target-button-token',
          role: 'AXButton',
          label: 'Commit target',
        },
      },
    ],
    screenshot: {
      base64: 'AA==',
      mimeType: 'image/png',
      widthPx: 1200,
      heightPx: 800,
    },
    ...overrides,
  };
}

function overlayRecorder() {
  const events: Array<{
    type: 'move' | 'complete' | 'cancel';
    actionId: string;
    sessionId: string;
    x?: number;
    y?: number;
  }> = [];
  const sink: OverlayCursorSink = {
    ensure() {},
    move(input) {
      events.push({
        type: 'move',
        actionId: input.actionId,
        sessionId: input.sessionId,
        x: input.screenX,
        y: input.screenY,
      });
      return {
        readyForInteraction: Promise.resolve(),
        finished: Promise.resolve(),
      };
    },
    complete(input) {
      events.push({
        type: 'complete',
        actionId: input.actionId,
        sessionId: input.sessionId,
        x: input.screenX,
        y: input.screenY,
      });
    },
    cancel(input) {
      events.push({
        type: 'cancel',
        actionId: input.actionId,
        sessionId: input.sessionId,
      });
    },
  };
  return { events, overlay: createComputerUseOverlayHook(sink) };
}

describe('Computer Use cross-layer deterministic contract', () => {
  test('bound target propagation, presentation order, fresh state, and duplicate rejection', async () => {
    const overlay = overlayRecorder();
    const dispatches: Array<{ action: CuAction; context: CuRunContext }> = [];
    let revision = 0;
    const backend: CuDispatchBackend = {
      async preflight() {
        return { accessibility: true, screenRecording: true };
      },
      async observeApp(input) {
        assert.equal(input.windowId, 10);
        return fixtureObservation();
      },
      async run(action, _signal, runContext) {
        dispatches.push({ action, context: runContext });
        assert.equal(runContext.boundAction?.target.pid, 100);
        assert.equal(runContext.boundAction?.target.windowId, 10);
        revision += 1;
        return {
          outcome: {
            ok: true,
            tier: 'ax',
            verified: true,
            evidence: { effect: 'confirmed' },
          },
          resolvedScreenPoint: { x: 300, y: 200 },
          observation: fixtureObservation({
            observationId: `backend-observation-${revision + 1}`,
            contentFingerprint: `fixture-structure-${revision + 1}`,
          }),
        };
      },
    };
    const tools = buildComputerUseTools({
      backend,
      overlay: overlay.overlay,
    });
    const [tool] = tools;
    const observed = (await tool.impl(
      {
        action: 'observe',
        app: 'Fixture',
        window_id: 10,
      } as never,
      context(),
    )) as { text: string; modelText?: string };
    const observationId = observationIdOf(observed.modelText);
    const result = (await tool.impl(
      {
        action: 'left_click',
        observation_id: observationId,
        coordinate: [400, 200],
      } as never,
      context({ toolCallId: 'click-target' }),
    )) as {
      text: string;
      modelText?: string;
    };

    assert.equal(dispatches.length, 1);
    assert.match(result.modelText ?? '', /Fresh observation/);
    assert.deepEqual(overlay.events, [
      {
        type: 'move',
        actionId: 'click-target',
        sessionId: 'session-1',
        x: 300,
        y: 200,
      },
      {
        type: 'complete',
        actionId: 'click-target',
        sessionId: 'session-1',
        x: 300,
        y: 200,
      },
    ]);

    const replay = (await tool.impl(
      {
        action: 'left_click',
        observation_id: observationId,
        coordinate: [400, 200],
      } as never,
      context({ toolCallId: 'duplicate' }),
    )) as { text: string };
    assert.match(replay.text, /duplicate_action|stale_frame|reobserve_required/);
    assert.equal(dispatches.length, 1);
  });

  test('typed target change and unknown outcome both cancel, while unknown requires re-observation', async () => {
    const overlay = overlayRecorder();
    let mode: 'target_change' | 'unknown' = 'target_change';
    const backend: CuDispatchBackend = {
      async preflight() {
        return { accessibility: true, screenRecording: true };
      },
      async observeApp() {
        return fixtureObservation();
      },
      async run() {
        return mode === 'target_change'
          ? {
              outcome: {
                ok: false,
                error: 'target_changed',
                message: 'application process identity changed',
              },
            }
          : {
              outcome: {
                ok: false,
                error: 'outcome_unknown',
                message: 'child exited after delivery',
              },
            };
      },
    };
    const tools = buildComputerUseTools({
      backend,
      overlay: overlay.overlay,
    });
    const [tool] = tools;

    const firstObservation = (await tool.impl(
      {
        action: 'observe',
        app: 'Fixture',
        window_id: 10,
      } as never,
      context(),
    )) as { modelText?: string };
    await tool.impl(
      {
        action: 'left_click',
        observation_id: observationIdOf(firstObservation.modelText),
        coordinate: [400, 200],
      } as never,
      context({ toolCallId: 'target-change' }),
    );
    assert.equal(overlay.events.at(-1)?.type, 'cancel');

    tools.sessionEvents.reobserveRequired('session-1');
    const secondObservation = (await tool.impl(
      {
        action: 'observe',
        app: 'Fixture',
        window_id: 10,
      } as never,
      context({ turnId: 'turn-2' }),
    )) as { modelText?: string };
    mode = 'unknown';
    await tool.impl(
      {
        action: 'left_click',
        observation_id: observationIdOf(secondObservation.modelText),
        coordinate: [400, 200],
      } as never,
      context({ turnId: 'turn-2', toolCallId: 'unknown' }),
    );
    assert.equal(tools.sessionEvents.snapshot('session-1').status, 'reobserve_required');
    assert.equal(overlay.events.at(-1)?.type, 'cancel');
  });

  test('explicit session cleanup fences late work and persisted projection omits private UI content', async () => {
    const backend: CuDispatchBackend = {
      async preflight() {
        return { accessibility: true, screenRecording: true };
      },
      async observeApp() {
        return fixtureObservation({
          windowTitle: 'Private Window Title',
          elements: [
            {
              elementId: '5',
              role: 'AXButton',
              label: 'Private Customer Label',
            },
          ],
        });
      },
      async run() {
        return {
          outcome: { ok: true, tier: 'ax', verified: true },
          observation: fixtureObservation({
            windowTitle: 'Private Window Title',
          }),
        };
      },
    };
    const tools = buildComputerUseTools({ backend });
    const [tool] = tools;
    const observed = (await tool.impl(
      {
        action: 'observe',
        app: 'Fixture',
        window_id: 10,
      } as never,
      context(),
    )) as { text: string; modelText?: string };
    assert.doesNotMatch(observed.text, /Private Window Title|Private Customer Label/);
    assert.match(observed.modelText ?? '', /Private Window Title|Private Customer Label/);

    tools.clearSession('session-1');
    assert.equal(tools.sessionEvents.snapshot('session-1').status, 'user_stopped');
    const afterTurn = (await tool.impl(
      {
        action: 'left_click',
        observation_id: observationIdOf(observed.modelText),
        coordinate: [400, 200],
      } as never,
      context({ toolCallId: 'late-action' }),
    )) as { text: string };
    assert.match(afterTurn.text, /user_stopped|no_active_frame/);
  });
});
