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

/**
 * A refusal written by the codec rather than by the tool.
 *
 * `summarize` is what turns an executor outcome into the line the model reads,
 * and it is reached only after the tool has accepted the call and dispatched
 * it. Every other surface in this file stops short of that.
 */
async function refusedDispatch(): Promise<{ text: string; modelText?: string }> {
  return dispatchOnce({
    ok: false as const,
    error: 'dispatch_refused' as const,
    message: 'AXPress returned -25205',
    messageIsAppTextFree: true,
    evidence: { path: 'ax_action' as const, effect: 'unverifiable' as const },
  });
}

/** The same, for a dispatch that worked: `summarize` writes both headlines. */
async function deliveredDispatch(): Promise<{ text: string; modelText?: string }> {
  return dispatchOnce({ ok: true as const, tier: 'ax' as const, verified: true });
}

async function dispatchOnce(
  outcome: Awaited<ReturnType<NonNullable<CuDispatchBackend['runSemantic']>>>['outcome'],
): Promise<{ text: string; modelText?: string }> {
  const backend: CuDispatchBackend = {
    async preflight() {
      return { accessibility: true, screenRecording: true };
    },
    async observeApp() {
      return observation();
    },
    async captureObservation() {
      return observation();
    },
    async run() {
      return { outcome: { ok: true, tier: 'ax', verified: true } };
    },
    async runSemantic() {
      return { outcome };
    },
  };
  const [tool] = buildComputerUseTools({ backend });
  const context = ctx({ sessionId: `b6-${outcome.ok ? 'ok' : 'refused'}` });
  const observed = (await tool.impl({ action: 'observe', app: 'Fixture' } as never, context)) as {
    modelText?: string;
  };
  return (await tool.impl(
    {
      action: 'click_element',
      observation_id: observationIdOf(observed.modelText),
      element_id: '5',
    } as never,
    context,
  )) as { text: string; modelText?: string };
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
      // The executor's own refusal, which is where the wrong name actually
      // was. Every surface sampled above is written by the tool; this one is
      // written by `summarize` in the codec, which said `computer.<action>`
      // — a tool the model cannot call — on every post-dispatch failure. The
      // assertion below passed while that shipped, because nothing in the
      // sample reached it.
      await refusedDispatch(),
      // Both branches of `summarize`: the failure headline and the ok one, and
      // both said `computer.<action>`.
      await deliveredDispatch(),
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
    assert.match(
      description,
      /shipping maka-cu host keeps compatibility key and coordinate dispatch disabled/i,
    );
    assert.doesNotMatch(description, /reach a background window normally/i);
  });
});

describe('B8 — a refusal is recorded as one, and says the thing that is true', () => {
  /** `observeOnlyBackend` has no `runSemantic`, which refuses before the target is compared. */
  function semanticBackend(runSemantic: CuDispatchBackend['runSemantic']): CuDispatchBackend {
    return {
      async preflight() {
        return { accessibility: true, screenRecording: true };
      },
      async observeApp() {
        return observation();
      },
      async run() {
        return { outcome: { ok: true, tier: 'ax', verified: true } };
      },
      runSemantic,
    };
  }

  const dispatchOk: CuDispatchBackend['runSemantic'] = async () => ({
    outcome: { ok: true, tier: 'ax', verified: true },
    observation: observation(),
  });

  test('target_mismatch carries an error code rather than passing as a success', async () => {
    const [tool] = buildComputerUseTools({ backend: semanticBackend(dispatchOk) });
    const context = ctx();
    const observed = (await tool.impl({ action: 'observe', app: 'Fixture' } as never, context)) as {
      modelText?: string;
    };
    const result = (await tool.impl(
      {
        action: 'click_element',
        observation_id: observationIdOf(observed.modelText),
        element_id: '5',
        app: 'SomeOtherApp',
      } as never,
      context,
    )) as { text: string; error?: string };

    assert.match(result.text, /target_mismatch/);
    // Both returns were bare `{ text }`. A refusal with no error field is
    // recorded as a successful invocation, and `target_mismatch` was a word in
    // no table the model has.
    assert.equal(result.error, 'target_mismatch');
  });

  test('a replayed placeholder from the call record is refused, not typed', async () => {
    const backend = observeOnlyBackend();
    const [tool] = buildComputerUseTools({ backend });
    const context = ctx();
    const observed = (await tool.impl({ action: 'observe', app: 'Fixture' } as never, context)) as {
      modelText?: string;
    };
    const result = (await tool.impl(
      {
        action: 'set_value',
        observation_id: observationIdOf(observed.modelText),
        element_id: '5',
        // What the model reads back as its own last set_value. Both schemas
        // accept it as a string, so nothing above this refused it and the
        // characters went into the user's field.
        value: '<text:18>',
      } as never,
      context,
    )) as { text: string; error?: string };

    assert.equal(result.error, 'withheld_value_replayed');
    assert.match(result.text, /placeholder from your own call record/);
    assert.match(result.text, /Nothing was sent/);
  });

  test('a placeholder in any argument is refused, not only in value and text', async () => {
    // The guard named `value`, `text` and `steps[].value`, which were the three
    // arguments a shape could reach when it was written. `observe`'s `query` and
    // `menu`, `wait`'s `wait_for_text`, and a step's `label` are plain strings
    // the schemas accept, so a placeholder there was acted on: a query that
    // matches nothing answers `showing 0 of 1200`, which a model reads as proof
    // the control does not exist.
    const [tool] = buildComputerUseTools({ backend: observeOnlyBackend() });
    const context = ctx();
    const observed = (await tool.impl({ action: 'observe', app: 'Fixture' } as never, context)) as {
      modelText?: string;
    };
    const observationId = observationIdOf(observed.modelText);
    const attempts: Array<[string, Record<string, unknown>]> = [
      ['query', { action: 'observe', app: 'Fixture', query: '<text:2>' }],
      ['menu', { action: 'observe', app: 'Fixture', menu: '<text:2>' }],
      ['wait_for_text', { action: 'wait', duration: 1, wait_for_text: '<text:4>' }],
      [
        'steps[].label',
        {
          action: 'element_sequence',
          observation_id: observationId,
          steps: [{ label: '<text:1>' }],
        },
      ],
      // Bare `<text>` is what the previous release wrote. A conversation that
      // started under it still carries the string in history.
      [
        'value',
        { action: 'set_value', observation_id: observationId, element_id: '5', value: '<text>' },
      ],
    ];

    for (const [named, args] of attempts) {
      const result = (await tool.impl(args as never, context)) as { text: string; error?: string };
      assert.equal(result.error, 'withheld_value_replayed', `${named} was acted on`);
      assert.match(result.text, new RegExp(named.replace(/[[\].]/g, '\\$&')));
      assert.match(result.text, /Nothing was sent/);
    }
  });

  test('a real value that merely contains a placeholder is still sent', async () => {
    const sent: string[] = [];
    const [tool] = buildComputerUseTools({
      backend: semanticBackend(async (action) => {
        if (action.type === 'set_value') sent.push(action.value);
        return { outcome: { ok: true, tier: 'ax', verified: true }, observation: observation() };
      }),
    });
    const context = ctx();
    const observed = (await tool.impl({ action: 'observe', app: 'Fixture' } as never, context)) as {
      modelText?: string;
    };
    await tool.impl(
      {
        action: 'set_value',
        observation_id: observationIdOf(observed.modelText),
        element_id: '5',
        value: '<text:18> is a thing I meant to write',
      } as never,
      context,
    );

    assert.deepEqual(sent, ['<text:18> is a thing I meant to write']);
  });

  test('a repeat of a refusal that never ran is not told to observe for a change', async () => {
    // The executor refuses without dispatching, so the action is retired and
    // the frame survives. Sending it again used to come back `duplicate_action`
    // — "observe to see whether it took effect" — directly contradicting the
    // refusal one call earlier, which said nothing was dispatched and observing
    // again was the round trip to skip.
    const backend: CuDispatchBackend = {
      async preflight() {
        return { accessibility: true, screenRecording: true };
      },
      async observeApp() {
        return observation();
      },
      async run() {
        return { outcome: { ok: true, tier: 'ax', verified: true } };
      },
      async runSemantic() {
        return {
          outcome: {
            ok: false,
            error: 'unsupported_action',
            message: 'this element does not offer that',
            evidence: { path: 'none' },
          },
        } as CuRunResult;
      },
    };
    const [tool] = buildComputerUseTools({ backend });
    const context = ctx();
    const observed = (await tool.impl({ action: 'observe', app: 'Fixture' } as never, context)) as {
      modelText?: string;
    };
    const args = {
      action: 'click_element',
      observation_id: observationIdOf(observed.modelText),
      element_id: '5',
    };
    const first = (await tool.impl(args as never, context)) as { text: string };
    assert.match(first.text, /nothing was dispatched/i);

    const second = (await tool.impl(args as never, ctx({ toolCallId: 'call2' }))) as {
      text: string;
      error?: string;
    };
    assert.equal(second.error, 'duplicate_action');
    assert.match(second.text, /nothing was dispatched either time/);
    assert.doesNotMatch(second.text, /see whether it took effect/);
  });
});

describe('B9 — an observation says what it is showing, whatever the executor returned', () => {
  test('a query filters and announces itself even when the executor ignores it', async () => {
    // The renderer filters from `observation.query` and the executor was
    // expected to echo it. The one that shipped did not, so a model asking for
    // a filtered view of a large window received all of it under a header that
    // said nothing about a query.
    const backend: CuDispatchBackend = {
      async preflight() {
        return { accessibility: true, screenRecording: true };
      },
      async observeApp() {
        return {
          ...observation(),
          elements: [
            { elementId: '1', role: 'AXButton', label: 'Downloads' },
            { elementId: '2', role: 'AXButton', label: 'Documents' },
          ],
        };
      },
      async run() {
        return { outcome: { ok: true, tier: 'ax', verified: true } };
      },
    };
    const result = await call(backend, { action: 'observe', app: 'Fixture', query: 'Downloads' });
    assert.match(result.modelText ?? '', /query="Downloads"/);
    assert.match(result.modelText ?? '', /Downloads/);
    assert.doesNotMatch(result.modelText ?? '', /Documents/);
  });

  test('a menu the executor cannot open says so instead of saying nothing', async () => {
    const result = await call(observeOnlyBackend(), {
      action: 'observe',
      app: 'Fixture',
      menu: 'File',
    });
    assert.match(result.modelText ?? '', /menu_bar=unavailable/);
    assert.match(result.modelText ?? '', /did not return the menu bar/);
  });
});
