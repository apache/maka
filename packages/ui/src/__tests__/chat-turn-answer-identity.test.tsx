import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { TurnView } from '../chat-turn.js';
import { LocaleProvider } from '../locale-context.js';
import type { TurnTimelineItem, TurnViewModel } from '../materialize.js';

const originalGlobals = {
  document: globalThis.document,
  matchMedia: globalThis.matchMedia,
  requestAnimationFrame: globalThis.requestAnimationFrame,
  cancelAnimationFrame: globalThis.cancelAnimationFrame,
  window: globalThis.window,
};
const originalActEnvironment = (globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
}).IS_REACT_ACT_ENVIRONMENT;

afterEach(() => {
  Object.assign(globalThis, {
    ...originalGlobals,
    IS_REACT_ACT_ENVIRONMENT: originalActEnvironment,
  });
});

function domRoot() {
  const { document, window } = parseHTML('<div id="root"></div>');
  Object.assign(globalThis, {
    document,
    window,
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    requestAnimationFrame: () => 1,
    cancelAnimationFrame() {},
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const container = document.querySelector('#root');
  assert.ok(container);
  return { container, root: createRoot(container) };
}

function turnWith(timeline: TurnTimelineItem[]): TurnViewModel {
  return {
    turnId: 'turn-1',
    status: 'running',
    partialOutputRetained: false,
    user: { id: 'ask', role: 'user', text: 'ask', ts: 1 },
    tools: [],
    notes: [],
    startedAt: 1,
    timeline,
  };
}

function renderTurn(
  root: ReturnType<typeof createRoot>,
  turn: TurnViewModel,
): Promise<void> {
  return act(() => {
    root.render(
      <LocaleProvider locale="en">
        <TurnView turn={turn} />
      </LocaleProvider>,
    );
  }) as unknown as Promise<void>;
}

const ANSWER: TurnTimelineItem = {
  kind: 'text',
  text: 'the answer',
  messageId: 'answer-1',
  live: true,
};

/**
 * The bug this pins: keying the answer by its first timeline entry made the
 * key change whenever that entry did, so React unmounted the answer and
 * mounted a copy. The browser drops any Selection inside a removed subtree, so
 * text selected while the answer streamed lost its highlight — and the quote
 * affordance that reads from the Selection never appeared.
 */
test('keeps the assistant answer element as a turn settles around it', async () => {
  const { container, root } = domRoot();

  // While the turn runs, a tools group folds the leading entries into a
  // Processing block. The answer is the second entry.
  await renderTurn(root, turnWith([
    { kind: 'tools', items: [] },
    ANSWER,
  ]));
  const streaming = container.querySelector('.maka-assistant-answer');
  assert.ok(streaming, 'the answer renders while the turn runs');

  // The last tools group is projected away, the Processing block dissolves,
  // and the leading entry becomes something else entirely.
  await renderTurn(root, turnWith([
    { kind: 'thinking', text: 'reasoning', messageId: 'think-1' },
    { ...ANSWER, live: false },
  ]));
  const settled = container.querySelector('.maka-assistant-answer');
  assert.ok(settled, 'the answer still renders once the turn settles');
  assert.equal(settled.isSameNode(streaming), true, 'the answer element survives the turn settling');
});

/** Each answer in a turn is identified by the steering message that opened it. */
test('gives each answer in a steered turn its own stable element', async () => {
  const { container, root } = domRoot();

  const steered: TurnTimelineItem[] = [
    { kind: 'text', text: 'first answer', messageId: 'answer-1', live: true },
    {
      kind: 'user',
      message: { id: 'steer-1', role: 'user', text: 'actually...', ts: 2 },
      messageId: 'steer-1',
    },
    { kind: 'text', text: 'second answer', messageId: 'answer-2', live: true },
  ];
  await renderTurn(root, turnWith(steered));
  const answers = [...container.querySelectorAll('.maka-assistant-answer')];
  assert.equal(answers.length, 2, 'steering splits the turn into two answers');

  await renderTurn(root, turnWith(steered.map((item) =>
    item.kind === 'text' ? { ...item, live: false } : item,
  )));
  const settledAnswers = [...container.querySelectorAll('.maka-assistant-answer')];
  assert.equal(settledAnswers.length, 2);
  assert.equal(settledAnswers[0]?.isSameNode(answers[0]), true, 'the first answer keeps its element');
  assert.equal(settledAnswers[1]?.isSameNode(answers[1]), true, 'the second answer keeps its element');
});
