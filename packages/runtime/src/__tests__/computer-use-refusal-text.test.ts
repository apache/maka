import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  buildComputerUseTools,
  type CuDispatchBackend,
  type CuObservation,
  type CuRunResult,
} from '../computer-use-tools.js';
import type { MakaToolContext } from '../tool-runtime.js';

/**
 * Every refusal this tool returns is read by a model that has to pick its next
 * call from it. These assert the part of each message that is not the error
 * code: what to do about it. A code on its own is a state machine label, and a
 * model handed one either re-sends the same call or gives up — both observed on
 * real traces before these sentences existed.
 */

function ctx(overrides: Partial<MakaToolContext> = {}): MakaToolContext {
  return {
    sessionId: 's1',
    turnId: 't1',
    cwd: '/tmp',
    toolCallId: 'call1',
    abortSignal: new AbortController().signal,
    emitOutput: () => {},
    ...overrides,
  };
}

function observation(): CuObservation {
  return {
    observationId: 'backend-obs-1',
    appId: 'Fixture',
    pid: 42,
    windowId: 7,
    elements: [
      {
        elementId: '5',
        role: 'AXButton',
        label: 'Continue',
        identity: { token: 'button-token', role: 'AXButton', label: 'Continue' },
      },
    ],
    screenshot: { base64: 'AA==', mimeType: 'image/png', widthPx: 100, heightPx: 80 },
  };
}

/**
 * `observe` works; nothing else captures. That leaves a dispatched action with
 * no way to confirm itself, which is the shape the `outcome_unknown` sentence
 * exists for.
 */
function observeOnlyBackend(over: { screenRecording?: boolean } = {}): CuDispatchBackend {
  return {
    async preflight() {
      return { accessibility: true, screenRecording: over.screenRecording ?? true };
    },
    async run() {
      return { outcome: { ok: true, tier: 'ax', verified: true } };
    },
    async observeApp() {
      return observation();
    },
  };
}

async function call(
  backend: CuDispatchBackend,
  args: Record<string, unknown>,
  context: MakaToolContext = ctx(),
) {
  const [tool] = buildComputerUseTools({ backend });
  return (await tool.impl(args as never, context)) as {
    text: string;
    modelText?: string;
    error?: string;
  };
}

function observationIdOf(modelText: string | undefined): string {
  return /observation_id=(\S+)/.exec(modelText ?? '')?.[1] ?? '';
}

describe('B1 — a blocked session says which call clears the block', () => {
  test('no_active_frame names observe rather than only the state', async () => {
    const result = await call(observeOnlyBackend(), {
      action: 'left_click',
      coordinate: [10, 10],
      observation_id: 'nothing-yet',
    });
    assert.match(result.text, /no_active_frame/);
    assert.match(result.text, /action:"observe"/);
  });

  test('reobserve_required carries the observe instruction, not just the label', async () => {
    const backend = observeOnlyBackend();
    const [tool] = buildComputerUseTools({ backend });
    const context = ctx();
    const observed = (await tool.impl({ action: 'observe', app: 'Fixture' } as never, context)) as {
      modelText?: string;
    };
    const observationId = observationIdOf(observed.modelText);
    await tool.impl(
      { action: 'left_click', coordinate: [10, 10], observation_id: observationId } as never,
      context,
    );
    const second = (await tool.impl(
      { action: 'left_click', coordinate: [11, 11], observation_id: observationId } as never,
      context,
    )) as { text: string };
    assert.match(second.text, /reobserve_required/);
    assert.match(second.text, /call action:"observe"/i);
  });
});

describe('B2 — a rejected binding names the action and the way out', () => {
  test('an observation_id that is not the current one says to observe again', async () => {
    const backend = observeOnlyBackend();
    const [tool] = buildComputerUseTools({ backend });
    const context = ctx();
    await tool.impl({ action: 'observe', app: 'Fixture' } as never, context);
    const stale = (await tool.impl(
      {
        action: 'left_click',
        coordinate: [10, 10],
        observation_id: 'observation-that-was-never-handed-out',
      } as never,
      context,
    )) as { text: string };
    assert.match(stale.text, /maka_computer\.left_click failed:/);
    assert.match(stale.text, /action:"observe"/);
  });
});

describe('B3 — unsupported_action distinguishes a missing capability from a missing element action', () => {
  test('launch_app says the build has no such capability and offers a route', async () => {
    const backend = observeOnlyBackend();
    const result = await call(backend, { action: 'launch_app', app: 'Fixture' });
    assert.match(result.text, /unsupported_action/);
    assert.match(result.text, /does not provide that capability/);
    assert.match(result.text, /action:"observe"/);
  });

  test('a semantic action says another element will not help either', async () => {
    const backend = observeOnlyBackend();
    const [tool] = buildComputerUseTools({ backend });
    const context = ctx();
    const observed = (await tool.impl({ action: 'observe', app: 'Fixture' } as never, context)) as {
      modelText?: string;
    };
    const result = (await tool.impl(
      {
        action: 'click_element',
        element_id: '5',
        observation_id: observationIdOf(observed.modelText),
      } as never,
      context,
    )) as { text: string };
    assert.match(result.text, /unsupported_action/);
    assert.match(result.text, /does not provide that capability/);
    assert.match(result.text, /No element offers it either/i);
    assert.match(result.text, /different element/i);
  });
});

describe('B4 — outcome_unknown forbids the resend that can double-apply', () => {
  test('a delivered action with no confirming observation says not to send it again', async () => {
    const backend = observeOnlyBackend();
    const [tool] = buildComputerUseTools({ backend });
    const context = ctx();
    const observed = (await tool.impl({ action: 'observe', app: 'Fixture' } as never, context)) as {
      modelText?: string;
    };
    const clicked = (await tool.impl(
      {
        action: 'left_click',
        coordinate: [10, 10],
        observation_id: observationIdOf(observed.modelText),
      } as never,
      context,
    )) as { text: string; modelText?: string; error?: string };
    assert.equal(clicked.error, 'outcome_unknown');
    for (const surface of [clicked.text, clicked.modelText ?? '']) {
      assert.match(surface, /Do not send it again/i);
      assert.match(surface, /action:"observe"/);
    }
  });
});

describe('B5 — a missing Screen Recording grant names the parameter that does not need it', () => {
  test('observe points at the parameter that drops the screenshot', async () => {
    const result = await call(observeOnlyBackend({ screenRecording: false }), {
      action: 'observe',
      app: 'Fixture',
      include_screenshot: true,
    });
    assert.match(result.text, /permission_missing/);
    assert.match(result.text, /include_screenshot/);
    assert.match(result.text, /element list/i);
  });
});

describe('observe does not capture a picture unless asked', () => {
  /**
   * Asserted on the request the backend receives, not on the parameter the
   * model sent. The default is only worth anything if it reaches the capture:
   * a default that is read but not passed through costs the same timeout.
   *
   * The default is worth having because a picture roughly triples what an
   * observation costs in tokens, not because capturing is slow: a window
   * capture measures 66-85ms, while walking a large window costs hundreds of
   * milliseconds with no picture at all.
   */
  function recordingBackend(): CuDispatchBackend & { requests: Array<boolean | undefined> } {
    const requests: Array<boolean | undefined> = [];
    return {
      requests,
      async preflight() {
        return { accessibility: true, screenRecording: true };
      },
      async run() {
        return { outcome: { ok: true, tier: 'ax', verified: true } };
      },
      async observeApp(request) {
        requests.push(request.includeScreenshot);
        return observation();
      },
    };
  }

  test('an observe with no include_screenshot asks the backend for no screenshot', async () => {
    const backend = recordingBackend();
    const [tool] = buildComputerUseTools({ backend });
    await tool.impl({ action: 'observe', app: 'Fixture' } as never, ctx());
    assert.deepEqual(backend.requests, [false]);
  });

  test('include_screenshot:true still reaches the backend', async () => {
    const backend = recordingBackend();
    const [tool] = buildComputerUseTools({ backend });
    await tool.impl(
      { action: 'observe', app: 'Fixture', include_screenshot: true } as never,
      ctx(),
    );
    assert.deepEqual(backend.requests, [true]);
  });

  test('a pictureless observe needs no Screen Recording grant', async () => {
    const backend = recordingBackend();
    backend.preflight = async () => ({ accessibility: true, screenRecording: false });
    const [tool] = buildComputerUseTools({ backend });
    const result = (await tool.impl({ action: 'observe', app: 'Fixture' } as never, ctx())) as {
      text: string;
    };
    assert.doesNotMatch(result.text, /permission_missing/);
    assert.deepEqual(backend.requests, [false]);
  });

  test('a timeout points at the size of the window, which is what costs', async () => {
    // An earlier version blamed the screenshot. Measured per window, a capture
    // is a flat 66-85ms while walking System Settings is 684ms and Finder 175ms
    // with no picture at all — so dropping the picture saves a tenth of a
    // second on a call whose cost is the element count, and on the default path
    // there is no picture to drop.
    const backend = recordingBackend();
    backend.observeApp = async () => {
      throw new Error('observe timeout');
    };
    const [tool] = buildComputerUseTools({ backend });

    for (const [label, args] of [
      ['default', { action: 'observe', app: 'Fixture' }],
      ['with a picture', { action: 'observe', app: 'Fixture', include_screenshot: true }],
    ] as const) {
      const result = (await tool.impl(args as never, ctx({ sessionId: label }))) as {
        text: string;
      };
      assert.match(result.text, /timeout/, label);
      assert.match(result.text, /query/, label);
      assert.doesNotMatch(result.text, /include_screenshot/, label);
    }
  });
});

describe('the session log keeps dispatch evidence the model is not shown', () => {
  test('a coordinate result splits the host summary from the model summary', async () => {
    const backend: CuDispatchBackend = {
      async preflight() {
        return { accessibility: true, screenRecording: true };
      },
      async run() {
        return {
          outcome: {
            ok: true,
            tier: 'coordinate-background',
            verified: false,
            evidence: { path: 'cg_event_pid', effect: 'unverifiable', reason: 'dispatch.key:none' },
          },
        } as never;
      },
      async observeApp() {
        return observation();
      },
      async captureObservation() {
        return observation();
      },
    };
    const [tool] = buildComputerUseTools({ backend });
    const context = ctx();
    const observed = (await tool.impl({ action: 'observe', app: 'Fixture' } as never, context)) as {
      modelText?: string;
    };
    const clicked = (await tool.impl(
      {
        action: 'left_click',
        coordinate: [10, 10],
        observation_id: observationIdOf(observed.modelText),
      } as never,
      context,
    )) as { text: string; modelText?: string };
    // The host record keeps the route; the model is shown what it can act on.
    assert.match(clicked.text, /path=/);
    assert.doesNotMatch(clicked.modelText ?? '', /path=|cg_event_pid|coordinate-background/);
    assert.match(clicked.modelText ?? '', /effect=/);
  });
});

describe('the mirror gets a frame even when the dispatch failed', () => {
  /**
   * `presentToPip` draws `result.screenshot ?? result.observation?.screenshot`,
   * and the executor attaches those only when the action succeeded. Across 30
   * traces the split had no exception: the 11 runs where the mirror appeared
   * all had at least one success carrying a screenshot, and the 19 where it
   * never appeared had none — so the mirror was blank on exactly the turns
   * worth watching.
   */
  async function endOfAction(
    outcome: CuRunResult['outcome'],
    ownScreenshot?: CuObservation['screenshot'],
  ) {
    const ends: Array<CuRunResult | undefined> = [];
    const backend: CuDispatchBackend = {
      async preflight() {
        return { accessibility: true, screenRecording: true };
      },
      async run() {
        return { outcome, ...(ownScreenshot ? { screenshot: ownScreenshot } : {}) } as never;
      },
      async observeApp() {
        return observation();
      },
      async captureObservation() {
        return observation();
      },
    };
    const [tool] = buildComputerUseTools({
      backend,
      overlay: {
        onActionBegin() {
          return { readyForInteraction: Promise.resolve(), finished: Promise.resolve() };
        },
        onActionEnd(_action, result) {
          ends.push(result);
        },
      },
    });
    const context = ctx();
    const observed = (await tool.impl({ action: 'observe', app: 'Fixture' } as never, context)) as {
      modelText?: string;
    };
    await tool.impl(
      {
        action: 'left_click',
        coordinate: [10, 10],
        observation_id: observationIdOf(observed.modelText),
      } as never,
      context,
    );
    return ends;
  }

  test('a refused dispatch hands the overlay the observation it captured afterwards', async () => {
    // `target_occluded` rather than `dispatch_refused`: only the failures in
    // REOBSERVABLE_FAILURES are followed by a fresh capture, so those are the
    // ones that have a frame to hand over at all.
    const ends = await endOfAction({
      ok: false,
      error: 'target_occluded',
      message: 'another window was over it',
      tier: 'ax',
      verified: false,
    } as never);
    assert.equal(ends.length, 1);
    const shown = ends[0]?.screenshot ?? ends[0]?.observation?.screenshot;
    assert.ok(shown, 'the overlay was handed a result with nothing to draw');
    assert.equal(shown?.mimeType, 'image/png');
  });

  test('a dispatch that carries its own frame keeps it', async () => {
    const own = { base64: 'BB==', mimeType: 'image/png' as const, widthPx: 5, heightPx: 5 };
    const ends = await endOfAction({ ok: true, tier: 'ax', verified: true } as never, own);
    assert.equal(ends.length, 1);
    assert.equal(ends[0]?.screenshot?.base64, 'BB==');
    assert.equal(ends[0]?.observation, undefined);
  });
});

describe('B6 — every failure names the tool the model actually calls', () => {
  test('no result headline uses a name other than maka_computer', async () => {
    const backend = observeOnlyBackend();
    const [tool] = buildComputerUseTools({ backend });
    const context = ctx();
    const observed = (await tool.impl({ action: 'observe', app: 'Fixture' } as never, context)) as {
      text: string;
      modelText?: string;
    };
    const surfaces = [
      observed,
      // Delivered but unconfirmed: the headline the model reads most often
      // after a coordinate action.
      (await tool.impl(
        {
          action: 'left_click',
          coordinate: [10, 10],
          observation_id: observationIdOf(observed.modelText),
        } as never,
        context,
      )) as { text: string; modelText?: string },
      await call(observeOnlyBackend(), { action: 'launch_app', app: 'Fixture' }),
      await call(observeOnlyBackend({ screenRecording: false }), {
        action: 'observe',
        app: 'Fixture',
      }),
      await call(observeOnlyBackend(), {
        action: 'left_click',
        coordinate: [10, 10],
        observation_id: 'nothing-yet',
      }),
      // Accessibility refused outright: the one headline that named no action
      // at all.
      await call(
        {
          async preflight() {
            return { accessibility: false, screenRecording: true };
          },
          async run() {
            return { outcome: { ok: true, tier: 'ax', verified: true } };
          },
        },
        { action: 'screenshot', app: 'Fixture' },
      ),
    ];
    for (const surface of surfaces) {
      for (const text of [surface.text, surface.modelText ?? '']) {
        for (const [, name] of text.matchAll(/(\S*computer\S*) (?:failed|ok)\b/gi)) {
          assert.equal(
            name.startsWith('maka_computer'),
            true,
            `headline names "${name}", which is not a tool the model can call`,
          );
        }
      }
    }
  });
});

describe('B7 — the tool description states nothing the model cannot act on', () => {
  test('host-internal mechanisms are gone from the description', async () => {
    const [tool] = buildComputerUseTools({ backend: observeOnlyBackend() });
    const description = tool.description ?? '';
    assert.doesNotMatch(description, /frame binding/i);
    assert.doesNotMatch(description, /approval class/i);
    assert.doesNotMatch(description, /retained background mutation/i);
    assert.doesNotMatch(description, /DOM\/CDP/i);
    assert.doesNotMatch(description, /uniquely resolved page identity/i);
  });
});
