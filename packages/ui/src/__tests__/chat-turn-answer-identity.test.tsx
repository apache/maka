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

const mountedRoots: ReturnType<typeof createRoot>[] = [];

afterEach(async () => {
  // Unmount before restoring globals: React's cleanup reads `document`.
  for (const root of mountedRoots.splice(0)) await act(() => root.unmount());
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
  const root = createRoot(container);
  mountedRoots.push(root);
  return { container, root };
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
  liveStreaming?: { onStreamingSettled?: (messageId?: string) => void },
): Promise<void> {
  return act(() => {
    root.render(
      <LocaleProvider locale="en">
        <TurnView turn={turn} liveStreaming={liveStreaming} />
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

const RUNNING_TOOL: TurnTimelineItem = {
  kind: 'tools',
  items: [{ toolUseId: 'tool-1', toolName: 'read', status: 'running', args: {} }],
};

/**
 * Keying the answer by its first timeline entry made the key change whenever
 * that entry did, so React unmounted the answer and mounted a copy — taking
 * the scroll position, any open disclosure, and any text Selection inside it.
 *
 * The transition here is the real one from `timeline-fold.ts`: a run's last
 * tools group is projected away, so the Processing block dissolves and the
 * leading entry stops being a fold.
 *
 * Both halves of the fix are pinned: the segment `<article>` (the key), and the
 * bubble inside it (the single component type). Splitting the bubble back into
 * a streaming and a historical component leaves the article identical and
 * remounts only the bubble — which is the node a Selection actually lives in.
 */
test('keeps the assistant answer element as a turn settles around it', async () => {
  const { container, root } = domRoot();

  await renderTurn(root, turnWith([RUNNING_TOOL, ANSWER]));
  const streaming = container.querySelector('.maka-assistant-answer');
  const streamingBubble = container.querySelector('.maka-chat-message-bubble-assistant');
  assert.ok(streaming, 'the answer renders while the turn runs');
  assert.ok(streamingBubble, 'the answer bubble renders while the turn runs');

  await renderTurn(root, turnWith([{ ...ANSWER, live: false }]));
  const settled = container.querySelector('.maka-assistant-answer');
  const settledBubble = container.querySelector('.maka-chat-message-bubble-assistant');
  assert.ok(settled, 'the answer still renders once the turn settles');
  assert.ok(settledBubble, 'the answer bubble still renders once the turn settles');
  assert.equal(settled.isSameNode(streaming), true, 'the answer element survives the turn settling');
  assert.equal(
    settledBubble.isSameNode(streamingBubble),
    true,
    'the answer bubble survives the turn settling',
  );
});

/**
 * Extends the regression above to a steered turn: both segments exist side by
 * side and each keeps its own element across the settle. It does not pin the
 * keying scheme — React reconciles duplicate-key siblings of one component type
 * by position, so a key collision would still leave both elements identical.
 */
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

/**
 * The live handoff announces itself exactly once, when the answer enters its
 * settled phase. A bubble replayed from history mounts already past the
 * stream; letting it consume that announcement left the real handoff silent
 * and the answer stuck wearing the live marker until a timeout cleaned up.
 */
test('announces settlement when a persisted answer is promoted to a completed live one', async () => {
  const { container, root } = domRoot();
  const settled: string[] = [];
  const onStreamingSettled = (messageId?: string) => { settled.push(messageId ?? '?'); };

  await renderTurn(root, turnWith([{ ...ANSWER, live: false }]));
  assert.deepEqual(settled, [], 'history alone announces nothing');

  await renderTurn(
    root,
    turnWith([{ ...ANSWER, live: true, complete: true }]),
    { onStreamingSettled },
  );
  assert.deepEqual(settled, ['answer-1'], 'the handoff is announced once');
  assert.equal(
    container.querySelector('.maka-bubble-streaming') === null,
    false,
    'the live marker is still present while the turn is being followed',
  );

  await renderTurn(
    root,
    turnWith([{ ...ANSWER, live: true, complete: true }]),
    { onStreamingSettled },
  );
  assert.deepEqual(settled, ['answer-1'], 'staying settled does not re-announce');
});
