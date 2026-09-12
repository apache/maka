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

test('message accessibility labels preserve literal ICU syntax', async () => {
  const { container, root } = domRoot();
  const label = "Maka's response · <redacted> {value} <tag>it's literal</tag>";
  await act(() => {
    root.render(<LocaleProvider locale="en"><LocalizedChatMessage sender="assistant" accessibleLabel={label}>{null}</LocalizedChatMessage></LocaleProvider>);
  });
  assert.equal(container.querySelector('article')?.getAttribute('aria-label'), label);
});

test('renders an aborted turn outcome as an inline system status notice', async () => {
  const { container, root } = domRoot();
  await renderTurn(root, {
    ...turnWith([{ ...ANSWER, live: false }]),
    status: 'aborted',
    abortSource: 'renderer.stop_button',
  });

  const outcome = container.querySelector('.astryx-chat-system-message[role="status"]');
  assert.ok(outcome, 'the aborted outcome is announced through the Chat status-notice primitive');
  assert.equal(outcome.getAttribute('data-variant'), 'default');
  assert.equal(outcome.textContent, 'Interrupted \u00b7 Stop button');
});

test('places the aborted turn outcome after its timeline content', async () => {
  const { container, root } = domRoot();
  await renderTurn(root, {
    ...turnWith([{ ...ANSWER, live: false }]),
    status: 'aborted',
  });

  const answer = container.querySelector('.maka-chat-message-bubble-assistant');
  const assistantMessage = container.querySelector('.maka-assistant-answer');
  const outcome = container.querySelector('.astryx-chat-system-message[role="status"]');
  assert.ok(answer && assistantMessage && outcome);
  assert.equal(assistantMessage.nextElementSibling?.isSameNode(outcome), true);
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
