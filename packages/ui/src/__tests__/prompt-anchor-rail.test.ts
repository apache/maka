import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  holdJumpDestination,
  isRepeatedPromptRailActivation,
  observeActivePromptRailVisibility,
  PromptAnchorRail,
  type PromptRailFrameScheduler,
} from '../prompt-anchor-rail.js';
import { LocaleProvider } from '../locale-context.js';

test('carries optional Work identity onto rail ticks without changing ordinary landmarks', () => {
  const markup = renderToStaticMarkup(createElement(LocaleProvider, {
    locale: 'zh',
    children: createElement(PromptAnchorRail, {
      scrollRef: { current: null },
      turns: [
        { turnId: 'one', label: '普通消息' },
        {
          turnId: 'two',
          label: '排查登录超时',
          contextLabel: '登录稳定性',
          accentColor: '#b91c1c',
          groupId: 'work-login',
        },
        {
          turnId: 'three',
          label: '继续处理',
          accentColor: '#b91c1c',
          groupId: 'work-login',
        },
      ],
      selectedGroupId: 'work-login',
    }),
  }));

  assert.equal((markup.match(/data-prompt-turn-id=/gu) ?? []).length, 3);
  assert.equal((markup.match(/data-has-accent="true"/gu) ?? []).length, 2);
  assert.equal((markup.match(/data-group-selected="true"/gu) ?? []).length, 2);
  assert.match(markup, /--maka-prompt-rail-accent:#b91c1c/u);
});

test('recognizes only a consecutive click on the same landmark as the filter action', () => {
  assert.equal(isRepeatedPromptRailActivation(null, 'turn-a'), false);
  assert.equal(isRepeatedPromptRailActivation('turn-a', 'turn-b'), false);
  assert.equal(isRepeatedPromptRailActivation('turn-a', 'turn-a'), true);
});

test('can retain a single landmark for a filtered product view', () => {
  const markup = renderToStaticMarkup(createElement(LocaleProvider, {
    locale: 'zh',
    children: createElement(PromptAnchorRail, {
      scrollRef: { current: null },
      minimumTurns: 1,
      turns: [{ turnId: 'only', label: '唯一消息' }],
    }),
  }));

  assert.match(markup, /data-prompt-turn-id="only"/u);
});

/**
 * The e2e suite cannot stage what these cover. Whether a jump survives depends
 * on which frame the virtual window lands on, and the e2e case went green
 * against a renderer that did not survive it. Driving the frames here makes it
 * deterministic.
 */
function railHoldHarness() {
  // The helper builds its selector with `CSS.escape`, which the renderer has
  // and Node does not. Stubbed rather than worked around in the source: the
  // escaping is what keeps a turn id safe inside a selector, and a fallback
  // that only exists for tests would be the wrong thing to ship.
  const priorCss = (globalThis as { CSS?: unknown }).CSS;
  (globalThis as { CSS?: unknown }).CSS = { escape: (value: string) => value };

  const frames: Array<() => void> = [];
  const scheduler: PromptRailFrameScheduler = {
    request: (callback) => {
      frames.push(callback);
      return frames.length;
    },
    cancel: () => {},
  };
  const scrolled: Array<ScrollIntoViewOptions | undefined> = [];
  const listeners = new Map<string, EventListener>();
  const state = {
    scrollHeight: 1_000,
    scrollTop: 900,
    /** The target's top edge, relative to the scrollport's. 0 = landed. */
    targetTop: 600,
    targetPresent: true,
    queried: '',
    settled: 0,
  };
  const target = {
    getBoundingClientRect: () => ({ top: state.targetTop }) as DOMRect,
    scrollIntoView: (options?: ScrollIntoViewOptions) => {
      scrolled.push(options);
      // A real scroller lands the target at the top and moves to get there.
      state.scrollTop += state.targetTop;
      state.targetTop = 0;
    },
  };
  const root = {
    get scrollHeight() {
      return state.scrollHeight;
    },
    get scrollTop() {
      return state.scrollTop;
    },
    getBoundingClientRect: () => ({ top: 0 }) as DOMRect,
    querySelector: (selector: string) => {
      state.queried = selector;
      return state.targetPresent ? target : null;
    },
    addEventListener: (type: string, listener: EventListener) => listeners.set(type, listener),
    removeEventListener: (type: string) => listeners.delete(type),
  } as unknown as Element;

  return {
    root,
    scheduler,
    scrolled,
    state,
    listeners,
    /** Runs the frame the hold has queued, and only that one. */
    runFrame: (): void => frames.shift()?.(),
    restore: (): void => {
      (globalThis as { CSS?: unknown }).CSS = priorCss;
    },
  };
}

test('a jump re-aims at its destination every time the transcript grows', () => {
  const harness = railHoldHarness();
  const { root, scheduler, scrolled, state } = harness;

  const release = holdJumpDestination({
    root,
    readTargetId: () => 'turn-7',
    onSettled: () => {
      state.settled += 1;
    },
    scheduler,
  });

  state.scrollHeight = 1_400;
  harness.runFrame();
  assert.equal(scrolled.length, 1, 'a fill step re-aims the jump');
  assert.deepEqual(scrolled[0], { behavior: 'auto', block: 'start' });
  assert.equal(state.queried, '[data-turn-id="turn-7"]');

  harness.runFrame();
  assert.equal(scrolled.length, 1, 'a target already at the top is left alone');

  // Every later fill step moves it again, and every one is followed back.
  state.scrollHeight = 1_800;
  state.targetTop = 320;
  harness.runFrame();
  assert.equal(scrolled.length, 2, 'every later fill step re-aims too');

  // A scroll that was cancelled part-way leaves the target off-target on an
  // otherwise still frame. That is the other way a jump used to be lost.
  state.targetTop = 240;
  harness.runFrame();
  assert.equal(scrolled.length, 3, 'a stalled jump is corrected, not accepted');

  release();
  harness.restore();
});

test('a jump holds until the mounted destination is still', () => {
  const harness = railHoldHarness();
  const { root, scheduler, state } = harness;

  holdJumpDestination({
    root,
    readTargetId: () => 'turn-7',
    onSettled: () => {
      state.settled += 1;
    },
    scheduler,
  });

  // Landed already, so nothing below is a correction — only the boundary.
  state.targetTop = 0;

  harness.runFrame();
  harness.runFrame();
  assert.equal(state.settled, 0, 'settling waits for a few still frames');
  harness.runFrame();
  assert.equal(state.settled, 1, 'a mounted and still destination ends the hold');

  harness.restore();
});

test('a jump waits for an unloaded destination before settling', () => {
  const harness = railHoldHarness();
  const { root, scheduler, state } = harness;
  state.targetPresent = false;

  holdJumpDestination({
    root,
    readTargetId: () => 'turn-7',
    onSettled: () => {
      state.settled += 1;
    },
    scheduler,
  });

  for (let index = 0; index < 10; index += 1) harness.runFrame();
  assert.equal(state.settled, 0, 'a sparse transcript cannot settle before the target arrives');

  state.targetPresent = true;
  harness.runFrame();
  assert.equal(harness.scrolled.length, 1, 'the arriving target is placed at the top');
  harness.runFrame();
  harness.runFrame();
  harness.runFrame();
  assert.equal(state.settled, 1, 'the landed target settles normally');

  harness.restore();
});

test('a jump gives the transcript back the moment the reader touches it', () => {
  const harness = railHoldHarness();
  const { root, scheduler, state, listeners } = harness;

  holdJumpDestination({
    root,
    readTargetId: () => 'turn-7',
    onSettled: () => {
      state.settled += 1;
    },
    scheduler,
  });

  assert.deepEqual(
    [...listeners.keys()],
    ['wheel', 'touchstart', 'pointerdown', 'keydown'],
    'every way a reader can take over is listened for',
  );

  state.targetTop = 0;
  listeners.get('wheel')?.(new Event('wheel'));
  assert.equal(state.settled, 1, 'a wheel ends the hold even mid-fill');
  assert.equal(listeners.size, 0, 'and the hold stops listening');

  // Whatever the transcript does next is no longer the jump's business.
  state.scrollHeight = 9_000;
  harness.runFrame();
  assert.equal(harness.scrolled.length, 0, 'a released hold does not re-aim');
  assert.equal(state.settled, 1, 'and settles exactly once');

  harness.restore();
});

test('keeps the active tick visible when the rail viewport resizes', () => {
  let railBox = box(0, 600);
  let tickBox = box(570, 590);
  let onResize: (() => void) | undefined;
  let observed: Element | undefined;
  let disconnected = false;
  const tick = {
    getBoundingClientRect: () => tickBox,
  } as HTMLElement;
  const rail = {
    scrollTop: 384,
    getBoundingClientRect: () => railBox,
    querySelector: () => tick,
  } as unknown as HTMLElement;

  const cleanup = observeActivePromptRailVisibility(rail, (callback) => {
    onResize = callback;
    return {
      observe: (target) => {
        observed = target;
      },
      disconnect: () => {
        disconnected = true;
      },
    };
  });

  assert.equal(observed, rail);
  assert.equal(rail.scrollTop, 384, 'the initial visible tick does not move the rail');

  railBox = box(0, 286);
  onResize?.();
  assert.equal(rail.scrollTop, 688, 'a shorter rail brings the active tick back from below');

  tickBox = box(-30, -10);
  onResize?.();
  assert.equal(rail.scrollTop, 658, 'the same observer also restores a tick above the rail');

  cleanup();
  assert.equal(disconnected, true);
});

function box(top: number, bottom: number): DOMRect {
  return { top, bottom } as DOMRect;
}
