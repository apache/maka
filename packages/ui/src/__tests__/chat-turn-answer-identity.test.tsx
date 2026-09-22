/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterEach, test } from 'node:test';
import { act, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { LocalizedChatMessage, TurnView } from '../chat-turn.js';
import { LocaleProvider } from '../locale-context.js';
import type { TurnTimelineItem, TurnViewModel } from '../materialize.js';
import { applyThinkingDelta } from '../thinking-stream.js';

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

const originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');

const mountedRoots: ReturnType<typeof createRoot>[] = [];

afterEach(async () => {
  // Unmount before restoring globals: React's cleanup reads `document`.
  for (const root of mountedRoots.splice(0)) await act(() => root.unmount());
  if (originalClipboard) Object.defineProperty(navigator, 'clipboard', originalClipboard);
  else Reflect.deleteProperty(navigator, 'clipboard');
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
  liveStreaming?: { runningStatus?: boolean; onStreamingSettled?: (messageId?: string) => void },
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

test('message accessibility labels preserve literal ICU syntax', async () => {
  const { container, root } = domRoot();
  const label = "Maka's response · <redacted> {value} <tag>it's literal</tag>";
  await act(() => {
    root.render(<LocaleProvider locale="en"><LocalizedChatMessage sender="assistant" accessibleLabel={label}>{null}</LocalizedChatMessage></LocaleProvider>);
  });
  assert.equal(container.querySelector('article')?.getAttribute('aria-label'), label);
});

test('renders an aborted turn outcome in the turn status row', async () => {
  const { container, root } = domRoot();
  await renderTurn(root, {
    ...turnWith([{ ...ANSWER, live: false }]),
    status: 'aborted',
  });

  const statusbar = container.querySelector('.maka-turn-statusbar');
  assert.ok(statusbar, 'the aborted outcome is announced in the turn status row');
  assert.equal(statusbar.getAttribute('data-turn-status'), 'aborted');
  assert.equal(statusbar.textContent, 'Stopped');
});

test('places the turn status row at the top of the assistant content', async () => {
  const { container, root } = domRoot();
  await renderTurn(root, {
    ...turnWith([{ ...ANSWER, live: false }]),
    status: 'aborted',
  });

  const content = container.querySelector('.maka-assistant-answer-content');
  const statusbar = container.querySelector('.maka-turn-statusbar');
  const answer = container.querySelector('.maka-chat-message-bubble-assistant');
  assert.ok(content && statusbar && answer);
  // No work log: the standalone status row leads the assistant content.
  assert.equal(content.firstElementChild?.isSameNode(statusbar), true);
});

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

test('keeps reasoning expanded when its last neighboring tool is projected away', async () => {
  const { container, root } = domRoot();
  const thinking: TurnTimelineItem = {
    kind: 'thinking', messageId: 'reason-1', text: 'First observation', live: false,
  };
  await renderTurn(root, turnWith([thinking, RUNNING_TOOL, ANSWER]));
  const header = container.querySelector('[data-slot="activity-card-header"]');
  assert.ok(header);
  await act(() => { header.dispatchEvent(new window.Event('click', { bubbles: true })); });
  assert.equal(header.getAttribute('aria-expanded'), 'true');
  await renderTurn(root, turnWith([thinking, ANSWER]));
  const after = container.querySelector('[data-slot="activity-card-header"]');
  assert.ok(after);
  assert.ok(after.isSameNode(header));
  assert.equal(after.getAttribute('aria-expanded'), 'true');
});

test('redacts secrets before rendering a settled collapsed reasoning preview', async () => {
  const { container, root } = domRoot();
  await renderTurn(root, turnWith([
    {
      kind: 'thinking',
      text: 'Authorization: Bearer sk-live-1234567890abcdef\n\nSafe detail',
      messageId: 'thinking-1',
      live: false,
    },
  ]));

  const header = container.querySelector('[data-slot="activity-card-header"]');
  assert.ok(header);
  assert.match(header.textContent ?? '', /<redacted>/);
  assert.doesNotMatch(header.textContent ?? '', /sk-live-1234567890abcdef/);
});

test('preserves currency in a settled collapsed reasoning preview', async () => {
  const { container, root } = domRoot();
  await renderTurn(root, turnWith([
    {
      kind: 'thinking',
      text: 'The estimated cost is $5, not $$x + 1$$.',
      messageId: 'thinking-1',
      live: false,
    },
  ]));

  const header = container.querySelector('[data-slot="activity-card-header"]');
  assert.ok(header);
  assert.match(header.textContent ?? '', /cost is \$5, not x \+ 1/);
});

test('expanded truncated reasoning shows the current tail without replaying its marker', async () => {
  const { container, root } = domRoot();
  let thinking = applyThinkingDelta('', 'Earlier observations. '.repeat(8) + 'Current observation.', { locale: 'en', maxTotalChars: 128 });
  const renderThinking = () => renderTurn(root, turnWith([{
    kind: 'thinking', messageId: 'thinking-1', live: true,
    text: thinking.text, truncated: thinking.truncated,
  }]));
  await renderThinking();
  const header = container.querySelector('[data-slot="activity-card-header"]');
  assert.ok(header);
  await act(() => { header.dispatchEvent(new window.Event('click', { bubbles: true })); });
  const body = container.querySelector('.maka-chat-reasoning-content');
  assert.ok(body);
  assert.match(body.textContent ?? '', /Current observation\./);
  thinking = applyThinkingDelta(thinking.text, '\nNewest observation.', { locale: 'en', maxTotalChars: 128, redactionState: thinking.redactionState });
  await renderThinking();
  assert.equal(container.querySelector('.maka-chat-reasoning-content'), body);
  assert.match(body.textContent ?? '', /Newest observation\./);
  assert.match(body.textContent ?? '', /Current observation\./);
});

test('preserves a model-authored single newline in plain reasoning', async () => {
  const { container, root } = domRoot();
  await renderTurn(root, turnWith([
    {
      kind: 'thinking',
      text: 'First observation\nSecond observation',
      messageId: 'thinking-1',
      live: false,
    },
  ]));

  const header = container.querySelector('[data-slot="activity-card-header"]');
  assert.ok(header);
  await act(() => { header.dispatchEvent(new window.Event('click', { bubbles: true })); });
  const body = container.querySelector('.maka-chat-reasoning-content');
  assert.ok(body);
  assert.match(body.textContent ?? '', /First observation\nSecond observation/);

  const css = await readFile(resolve(import.meta.dirname, '..', '..', 'src', 'styles.css'), 'utf8');
  const rule = /\.maka-chat-reasoning-content\s*\{([^}]*)\}/.exec(css);
  assert.ok(rule, 'the reasoning body style contract is missing');
  assert.match(
    rule[1] ?? '',
    /white-space\s*:\s*pre-wrap/,
    'single model-authored newlines must remain visible after Markdown renders a soft break',
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

test('uses human conversation context instead of raw ids in action names', async () => {
  const { container, root } = domRoot();
  const turn = {
    ...turnWith([{ ...ANSWER, live: false }]),
    status: 'completed' as const,
    turnId: '019f-secret-turn-id',
    user: {
      id: '019f-secret-message-id',
      role: 'user' as const,
      text: 'Summarize the accessibility findings',
      ts: 1,
    },
  };

  await act(() => {
    root.render(
      <LocaleProvider locale="en">
        <TurnView
          turn={turn}
          footerActions={[{ id: 'copy', label: 'Copy', enabled: true }]}
          onEditUserMessage={() => undefined}
        />
      </LocaleProvider>,
    );
  });

  const actionNames = [...container.querySelectorAll('[aria-label]')]
    .map((element) => element.getAttribute('aria-label'))
    .filter((label): label is string => label !== null);
  assert.match(
    container.querySelector('.maka-assistant-answer')?.getAttribute('aria-label') ?? '',
    /^Maka's response · Summarize the accessibility findings/,
  );
  assert.ok(actionNames.some((label) => label.startsWith(
    'Copy message: Summarize the accessibility findings',
  )));
  assert.ok(actionNames.some((label) => label.startsWith(
    'Edit & resend message: Summarize the accessibility findings',
  )));
  assert.ok(actionNames.some((label) => label.startsWith(
    'Response actions: Summarize the accessibility findings',
  )));
  assert.ok(actionNames.some((label) => label.startsWith(
    'Copy response: Summarize the accessibility findings',
  )));
  assert.equal(
    container.querySelector('[data-message-id="019f-secret-message-id"]') !== null,
    true,
    'the real message identity remains available as machine data',
  );
  assert.equal(
    actionNames.some((label) => label.includes('019f-secret')),
    false,
    'raw storage identities stay out of spoken action names',
  );
  assert.equal(
    actionNames.some((label) => /\bmessage \d+\b/i.test(label)),
    false,
    'message actions do not claim a turn-local ordinal',
  );
});

test('does not edit and resend a message with folder references', async () => {
  const { container, root } = domRoot();
  let editCalls = 0;
  const turn = {
    ...turnWith([{ ...ANSWER, live: false }]),
    status: 'completed' as const,
    user: {
      id: 'ask-with-folder',
      role: 'user' as const,
      text: 'Inspect this folder',
      ts: 1,
      directoryReferences: [{ hostId: 'host-a', path: '/workspace/source' }],
    },
  };

  await act(() => {
    root.render(
      <LocaleProvider locale="en">
        <TurnView turn={turn} onEditUserMessage={() => { editCalls += 1; }} />
      </LocaleProvider>,
    );
  });

  const editButton = container.querySelector('[data-action="edit"]');
  assert.ok(editButton);
  assert.match(
    editButton.getAttribute('aria-label') ?? '',
    /does not yet support messages with folder references/,
  );
  await act(() => editButton.dispatchEvent(new window.Event('click', { bubbles: true })));
  assert.equal(editCalls, 0, 'folder references must not be silently dropped by revision');
});

/**
 * A structured-only user message (#4804) — empty inline text carrying a
 * quote — must render the quote without an empty text bubble, while keeping
 * the metadata row (timestamp, copy) and its edit entry, which used to be
 * dropped together with the bubble.
 */
test('renders a quote-only user message without an empty bubble but with metadata', async () => {
  const { container, root } = domRoot();
  const turn = {
    ...turnWith([]),
    status: 'completed' as const,
    user: {
      id: 'quote-only',
      role: 'user' as const,
      text: '',
      ts: 1,
      quotes: [{ text: 'selected excerpt' }],
    },
  };

  await act(() => {
    root.render(
      <LocaleProvider locale="en">
        <TurnView turn={turn} onEditUserMessage={() => undefined} />
      </LocaleProvider>,
    );
  });

  assert.equal(
    container.querySelector('.maka-chat-message-bubble-user'),
    null,
    'an empty text must not render an empty user bubble',
  );
  const quotes = container.querySelector('.maka-user-quotes');
  assert.ok(quotes, 'the staged quote still renders');
  assert.match(quotes?.textContent ?? '', /selected excerpt/);
  assert.ok(
    container.querySelector('.maka-message-meta'),
    'a structured-only message keeps its metadata row',
  );
});

test('a user message with text still renders its bubble', async () => {
  const { container, root } = domRoot();
  const turn = {
    ...turnWith([]),
    status: 'completed' as const,
    user: {
      id: 'with-text',
      role: 'user' as const,
      text: 'explain this',
      ts: 1,
      quotes: [{ text: 'selected excerpt' }],
    },
  };

  await renderTurn(root, turn);

  const bubble = container.querySelector('.maka-chat-message-bubble-user');
  assert.ok(bubble, 'a text message keeps its bubble');
  assert.match(bubble?.textContent ?? '', /explain this/);
});

test('keeps Astryx auto formatting live for user-message timestamps', async (context) => {
  const now = Date.UTC(2026, 7, 27, 12);
  context.mock.timers.enable({ apis: ['Date', 'setInterval'], now });
  const { container, root } = domRoot();
  const twoHoursAgo = now - 2 * 60 * 60 * 1_000;
  const turn = {
    ...turnWith([{ ...ANSWER, live: false }]),
    user: { id: 'ask', role: 'user' as const, text: 'ask', ts: twoHoursAgo },
  };

  await renderTurn(root, turn);

  const timestamp = container.querySelector('.maka-message-time-inline time');
  assert.ok(timestamp, 'Astryx Timestamp renders the semantic time element');
  assert.match(timestamp.textContent ?? '', /2 hours ago/);
  assert.equal(timestamp.getAttribute('tabindex'), '0', 'the absolute-time hover card is keyboard reachable');

  await act(() => context.mock.timers.tick(60 * 60 * 1_000));
  assert.match(timestamp.textContent ?? '', /3 hours ago/);
});

test('rotates working phrases on the elapsed clock without announcing each phrase', async (context) => {
  const now = Date.UTC(2026, 8, 14, 12);
  context.mock.timers.enable({ apis: ['Date', 'setInterval'], now });
  const { container, root } = domRoot();
  const turn: TurnViewModel = {
    turnId: 'turn-1', status: 'running', tools: [], notes: [], startedAt: now, timeline: [],
  };
  const render = (next: TurnViewModel) => act(() => root.render(
    <LocaleProvider locale="en"><TurnView turn={next} liveStreaming={{ runningStatus: true }} /></LocaleProvider>,
  ));
  await render(turn);
  // The running cue lives on the turn's status row at the TOP of the turn;
  // scope the query to it rather than "the first role=status", which other
  // surfaces also use.
  const status = container.querySelector('.maka-turn-statusbar [role="status"]')!;
  assert.match(status.textContent, /Pondering/);
  assert.equal(status.getAttribute('aria-label'), 'Working…');
  await act(() => context.mock.timers.tick(20_000));
  assert.match(status.textContent, /Tinkering/);
  assert.match(status.textContent, /20s/);
  assert.equal(status.getAttribute('aria-label'), 'Working…');
  // Concrete activity takes precedence over the playful phrase.
  await render({ ...turn, tools: [{
    toolUseId: 'cu-1', toolName: 'maka_computer', activityKind: 'computer', status: 'running', args: { app: 'Safari' },
  }] });
  assert.doesNotMatch(status.textContent ?? '', /Pondering|Tinkering/);
  assert.notEqual(status.getAttribute('aria-label'), 'Working…');
});

test('keeps elapsed time while system motion preference changes the working phrase', async (context) => {
  const now = Date.UTC(2026, 8, 14, 12);
  context.mock.timers.enable({ apis: ['Date', 'setInterval'], now });
  const { container, root } = domRoot();
  let reduced = true;
  const listeners = new Set<() => void>();
  Object.assign(globalThis, { matchMedia: () => ({
    get matches() { return reduced; },
    addEventListener(_type: string, listener: () => void) { listeners.add(listener); },
    removeEventListener(_type: string, listener: () => void) { listeners.delete(listener); },
  }) });
  const turn: TurnViewModel = {
    turnId: 'turn-1', status: 'running', tools: [], notes: [], startedAt: now, timeline: [],
  };
  await act(() => root.render(
    <LocaleProvider locale="en"><TurnView turn={turn} liveStreaming={{ runningStatus: true }} /></LocaleProvider>,
  ));
  await act(() => context.mock.timers.tick(20_000));
  assert.equal(container.querySelector('.maka-turn-status-label')?.textContent, 'Pondering…');
  assert.equal(container.querySelector('.maka-turn-elapsed')?.textContent, '20s');
  await act(() => { reduced = false; listeners.forEach((listener) => listener()); });
  assert.equal(container.querySelector('.maka-turn-status-label')?.textContent, 'Tinkering…');
  await act(() => { reduced = true; listeners.forEach((listener) => listener()); });
  await act(() => context.mock.timers.tick(20_000));
  assert.equal(container.querySelector('.maka-turn-status-label')?.textContent, 'Pondering…');
  assert.equal(container.querySelector('.maka-turn-elapsed')?.textContent, '40s');
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

async function renderCopyFooter(writeText: (text: string) => Promise<void>) {
  const { container, root } = domRoot();
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  // A secret-shaped value distinguishes original-text copy from the hook's default redaction.
  const text = 'Authorization: Bearer sk-test-1234567890abcdef';
  await act(async () => root.render(
    <StrictMode>
      <LocaleProvider locale="en">
        <TurnView
          turn={{ ...turnWith([{ kind: 'text', text, messageId: 'answer-1', live: false }]), status: 'completed' }}
          footerActions={[{ id: 'copy', label: 'Copy', enabled: true }]}
        />
      </LocaleProvider>
    </StrictMode>,
  ));
  const button = container.querySelector<HTMLButtonElement>('[data-action="copy"]');
  assert.ok(button, 'the completed answer exposes its real footer copy action');
  return { root, button, text };
}

test('footer copy preserves raw text, blocks overlapping writes and resets success after 1400ms', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = Promise.withResolvers<void>();
  const writeText = t.mock.fn((_text: string) => pending.promise);
  const { button, text } = await renderCopyFooter(writeText);

  await act(async () => {
    button.click();
    button.click();
  });
  assert.equal(writeText.mock.callCount(), 1);
  assert.equal(writeText.mock.calls[0]?.arguments[0], text);
  assert.equal(button.getAttribute('data-copy-feedback'), 'pending');
  assert.equal(button.getAttribute('aria-busy'), 'true');

  await act(async () => pending.resolve());
  assert.equal(button.getAttribute('data-copy-feedback'), 'copied');
  assert.notEqual(button.getAttribute('aria-busy'), 'true');
  await act(async () => t.mock.timers.tick(1399));
  assert.equal(button.getAttribute('data-copy-feedback'), 'copied');
  await act(async () => t.mock.timers.tick(1));
  assert.equal(button.hasAttribute('data-copy-feedback'), false);
});

test('footer copy cancels the previous reset and restarts feedback after another copy', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = Promise.withResolvers<void>();
  const writeText = t.mock.fn(async (_text: string): Promise<void> => {});
  const { button } = await renderCopyFooter(writeText);
  await act(async () => button.click());
  assert.equal(button.getAttribute('data-copy-feedback'), 'copied');
  await act(async () => t.mock.timers.tick(500));

  writeText.mock.mockImplementation(() => pending.promise);
  await act(async () => button.click());
  assert.equal(writeText.mock.callCount(), 2);
  await act(async () => t.mock.timers.tick(900));
  assert.equal(button.getAttribute('data-copy-feedback'), 'pending', 'the first reset must not clear the second write');

  await act(async () => pending.resolve());
  assert.equal(button.getAttribute('data-copy-feedback'), 'copied');
  await act(async () => t.mock.timers.tick(1399));
  assert.equal(button.getAttribute('data-copy-feedback'), 'copied');
  await act(async () => t.mock.timers.tick(1));
  assert.equal(button.hasAttribute('data-copy-feedback'), false);
});

test('footer copy cancels its active reset timer on unmount', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { root, button } = await renderCopyFooter(async () => {});
  const setTimeout = t.mock.method(window, 'setTimeout');
  await act(async () => button.click());
  assert.equal(button.getAttribute('data-copy-feedback'), 'copied');
  const reset = setTimeout.mock.calls.find((call) => call.arguments[1] === 1400);
  assert.ok(reset, 'successful copying schedules a feedback reset');
  await act(async () => t.mock.timers.tick(500));

  const clearTimeout = t.mock.method(window, 'clearTimeout');
  await act(async () => root.unmount());
  mountedRoots.splice(mountedRoots.indexOf(root), 1);
  assert.ok(clearTimeout.mock.calls.some((call) => call.arguments[0] === reset.result), 'unmount cancels the scheduled reset');
});

test('footer copy reports clipboard failure and allows a successful retry', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const writeText = t.mock.fn(async (_text: string): Promise<void> => {
    throw new Error('Clipboard unavailable');
  });
  const { button } = await renderCopyFooter(writeText);
  await act(async () => button.click());
  assert.equal(button.getAttribute('data-copy-feedback'), 'failed');
  await act(async () => t.mock.timers.tick(1400));
  assert.equal(button.hasAttribute('data-copy-feedback'), false);

  writeText.mock.mockImplementation(async (_text: string) => {});
  await act(async () => button.click());
  assert.equal(writeText.mock.callCount(), 2);
  assert.equal(button.getAttribute('data-copy-feedback'), 'copied');
});

test('footer copy does not schedule feedback after it unmounts with a write pending', async (t) => {
  const pending = Promise.withResolvers<void>();
  const { root, button } = await renderCopyFooter(() => pending.promise);
  await act(async () => button.click());
  await act(async () => root.unmount());
  mountedRoots.splice(mountedRoots.indexOf(root), 1);

  const setTimeout = t.mock.method(window, 'setTimeout');
  await act(async () => pending.resolve());
  assert.equal(setTimeout.mock.callCount(), 0, 'a late clipboard completion must not start a reset timer');
});

const PROCESS_TEXT: TurnTimelineItem = {
  kind: 'text', messageId: 'progress-1', text: 'Checking the login state.',
};
const COMPLETED_TOOL: TurnTimelineItem = {
  kind: 'tools',
  items: [{ toolUseId: 'read-1', toolName: 'read', status: 'completed', args: { path: 'auth.ts' } }],
};

test('collapses the whole completed process and leaves the final answer outside', async () => {
  const { container, root } = domRoot();
  // A real start (not the placeholder 0): the footer states the finish time,
  // which needs a timestamp the transcript could actually have carried.
  const turn = { ...turnWith([PROCESS_TEXT, COMPLETED_TOOL, { ...ANSWER, live: false }]), status: 'completed' as const, durationMs: 213_000, startedAt: Date.UTC(2026, 8, 19, 9, 0) };
  await renderTurn(root, turn);
  const process = container.querySelector('details.maka-processing-sequence');
  const summary = process?.querySelector('summary');
  assert.ok(process && summary);
  assert.equal(process.hasAttribute('open'), false);
  // The disclosure's summary IS the turn's status row: outcome + duration.
  assert.equal(summary.textContent?.trim(), 'Done · Worked for 3m 33s');
  assert.equal(
    summary.querySelector('.maka-turn-statusbar')?.getAttribute('data-turn-status'),
    'completed',
  );
  // The finish time lives in the footer as a semantic timestamp — the fact
  // that makes a transcript reviewable after the fact.
  assert.ok(container.querySelector('.maka-turn-footer time'));
  assert.match(process.textContent ?? '', /Checking the login state/);
  assert.doesNotMatch(process.textContent ?? '', /the answer/);
  const answer = container.querySelectorAll('.maka-chat-message-bubble-assistant')[1];
  assert.ok(answer);
  await act(() => { summary.dispatchEvent(new window.Event('click', { bubbles: true, cancelable: true })); });
  assert.equal(process.hasAttribute('open'), true);
  assert.equal(summary.getAttribute('aria-expanded'), 'true');
  await act(() => { summary.dispatchEvent(new window.Event('click', { bubbles: true, cancelable: true })); });
  assert.equal(process.hasAttribute('open'), false);
  assert.equal(container.querySelectorAll('.maka-chat-message-bubble-assistant')[1]?.isSameNode(answer), true);
});

test('moves the live clock into the process and settles it to recorded duration without remounting the answer', async (context) => {
  const startedAt = Date.UTC(2026, 8, 20, 9);
  context.mock.timers.enable({ apis: ['Date', 'setInterval'], now: startedAt + 12_000 });
  const { container, root } = domRoot();
  await renderTurn(root, { ...turnWith([ANSWER]), startedAt }, { runningStatus: true });
  assert.equal(container.querySelector('.maka-turn-statusbar .maka-turn-elapsed')?.textContent, '12s');
  const timeline = [PROCESS_TEXT, COMPLETED_TOOL, ANSWER];
  await renderTurn(root, { ...turnWith(timeline), startedAt }, { runningStatus: true });
  const process = container.querySelector('details.maka-processing-sequence');
  const summary = process?.querySelector('summary');
  assert.ok(process && summary);
  assert.equal(process.hasAttribute('open'), true);
  assert.equal(summary.querySelector('.maka-turn-elapsed')?.textContent, '12s');
  assert.equal(container.querySelectorAll('.maka-turn-elapsed').length, 1);
  assert.equal(container.querySelector('.maka-turn-footer .maka-turn-processing'), null);
  await act(() => context.mock.timers.tick(5_000));
  assert.equal(summary.querySelector('.maka-turn-elapsed')?.textContent, '17s');
  const answer = container.querySelectorAll('.maka-chat-message-bubble-assistant')[1];
  await renderTurn(root, {
    ...turnWith([PROCESS_TEXT, COMPLETED_TOOL, { ...ANSWER, live: false }]),
    startedAt, status: 'completed', durationMs: 21_000,
  });
  assert.equal(process.hasAttribute('open'), false);
  assert.equal(summary.textContent, 'Done · Worked for 21s');
  assert.equal(container.querySelector('.maka-turn-processing'), null);
  assert.doesNotMatch(container.querySelector('.maka-turn-footer')?.textContent ?? '', /Worked for/);
  await act(() => context.mock.timers.tick(5_000));
  assert.equal(summary.textContent, 'Done · Worked for 21s');
  assert.equal(container.querySelectorAll('.maka-chat-message-bubble-assistant')[1]?.isSameNode(answer!), true);
});

test('copy uses the visible final reply after completion and disclosure toggles', async () => {
  const { container, root } = domRoot();
  const copied: string[] = [];
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
    writeText: async (text: string) => { copied.push(text); },
  } });
  const timeline = [PROCESS_TEXT, COMPLETED_TOOL, { ...ANSWER, live: false }];
  await renderTurn(root, turnWith(timeline));
  await act(() => root.render(<LocaleProvider locale="en"><TurnView
    turn={{ ...turnWith(timeline), status: 'completed' }}
    footerActions={[{ id: 'copy', label: 'Copy', enabled: true }]}
  /></LocaleProvider>));
  const process = container.querySelector('details.maka-processing-sequence');
  const summary = process?.querySelector('summary');
  const copy = container.querySelector('[data-action="copy"]');
  assert.ok(process && summary && copy);
  assert.equal(process.hasAttribute('open'), false);
  assert.doesNotMatch(process.textContent ?? '', /the answer/);
  for (let index = 0; index < 3; index += 1) {
    await act(async () => { copy.dispatchEvent(new window.Event('click', { bubbles: true })); });
    await act(() => { summary.dispatchEvent(new window.Event('click', { bubbles: true, cancelable: true })); });
  }
  assert.deepEqual(copied, [ANSWER.text, ANSWER.text, ANSWER.text]);
});

test('keeps running work expanded and allows manual disclosure after settlement', async () => {
  const { container, root } = domRoot();
  await renderTurn(root, turnWith([PROCESS_TEXT, COMPLETED_TOOL]), { runningStatus: true });
  const process = container.querySelector('details.maka-processing-sequence');
  const summary = process?.querySelector('summary');
  assert.ok(process && summary);
  const click = () => act(() => { summary.dispatchEvent(new window.Event('click', { bubbles: true, cancelable: true })); });
  assert.equal(summary.getAttribute('aria-disabled'), 'true');
  assert.equal(summary.getAttribute('tabindex'), '-1');
  await click(); // pointer activation cannot hide live work
  await renderTurn(root, turnWith([PROCESS_TEXT, COMPLETED_TOOL, ANSWER]), { runningStatus: true });
  assert.equal(process.hasAttribute('open'), true);
  await renderTurn(root, { ...turnWith([PROCESS_TEXT, COMPLETED_TOOL, { ...ANSWER, live: false }]), status: 'completed' });
  assert.equal(process.hasAttribute('open'), false);
  assert.equal(summary.hasAttribute('aria-disabled'), false);
  assert.equal(summary.getAttribute('tabindex'), '0');
  await click();
  await renderTurn(root, { ...turnWith([PROCESS_TEXT, COMPLETED_TOOL, { ...ANSWER, live: false }]), status: 'completed', durationMs: 2000 });
  assert.equal(process.hasAttribute('open'), true);
});

test('keeps failed-tool details folded with duration while turn recovery stays outside', async () => {
  const { container, root } = domRoot();
  await renderTurn(root, turnWith([PROCESS_TEXT, RUNNING_TOOL]), { runningStatus: true });
  const process = container.querySelector('details.maka-processing-sequence');
  const summary = process?.querySelector('summary');
  assert.ok(process && summary);
  assert.equal(process.hasAttribute('open'), true);
  await act(() => root.render(<LocaleProvider locale="en"><TurnView
    turn={{ ...turnWith([PROCESS_TEXT, { kind: 'tools', items: [{ toolUseId: 'tool-1', toolName: 'read', args: {}, status: 'errored' }] }]), status: 'failed', durationMs: 2000 }}
    failedReasonLabel="Read failed"
    safeResumeAction={{ pending: false, onResume() {} }}
  /></LocaleProvider>));
  // A failed tool is an ordinary row: no label, no reveal.
  assert.doesNotMatch(summary.textContent ?? '', /Needs attention/);
  assert.equal(summary.textContent, 'Failed · Worked for 2s');
  assert.equal(
    container.querySelector('.maka-turn-statusbar')?.getAttribute('data-turn-status'),
    'failed',
  );
  assert.equal(process.hasAttribute('open'), false);
  assert.doesNotMatch(process.textContent ?? '', /Continue this turn/);
  assert.match(container.textContent ?? '', /Continue this turn/);
  await act(() => { summary.dispatchEvent(new window.Event('click', { bubbles: true, cancelable: true })); });
  assert.equal(process.hasAttribute('open'), true);
  assert.equal(container.querySelectorAll('.maka-processing-summary').length, 1);
});

test('states the outcome without a duration when none is recorded, and localizes it when there is one', async () => {
  const { container, root } = domRoot();
  const turn = { ...turnWith([PROCESS_TEXT, COMPLETED_TOOL, { ...ANSWER, live: false }]), status: 'completed' as const };
  await renderTurn(root, turn);
  // No recorded duration: the status row still states that the turn is done,
  // rather than inventing a duration it does not have.
  assert.equal(
    container.querySelector('.maka-processing-summary')?.textContent?.trim(),
    'Done',
  );
  await act(() => root.render(<LocaleProvider locale="zh-CN"><TurnView turn={{ ...turn, durationMs: 213_000 }} /></LocaleProvider>));
  assert.match(
    container.querySelector('.maka-processing-summary')?.textContent ?? '',
    /^已完成 · 用时 3 分 33 秒$/,
  );
});
