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
import { afterEach, test } from 'node:test';
import { act, useEffect, useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { ChatReasoning } from '../astryx-chat-reasoning.js';
import { TurnView } from '../chat-turn.js';
import { LocaleProvider } from '../locale-context.js';
import type { TurnViewModel } from '../materialize.js';

const originalGlobals = {
  document: globalThis.document,
  window: globalThis.window,
  matchMedia: globalThis.matchMedia,
  requestAnimationFrame: globalThis.requestAnimationFrame,
  cancelAnimationFrame: globalThis.cancelAnimationFrame,
  IS_REACT_ACT_ENVIRONMENT: (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT,
};
const roots: ReturnType<typeof createRoot>[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await act(() => root.unmount());
  Object.assign(globalThis, originalGlobals);
});

function setup() {
  const { document, window } = parseHTML('<!doctype html><html><body><div id="root"></div></body></html>');
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
  roots.push(root);
  return {
    container,
    render: async (children: ReactNode) => { await act(() => root.render(children)); },
    header: () => {
      const header = container.querySelector<HTMLElement>('[data-slot="activity-card-header"]');
      assert.ok(header);
      return header;
    },
    body: () => {
      const body = container.querySelector('.maka-chat-reasoning-content');
      assert.ok(body);
      return body;
    },
  };
}

async function activate(header: HTMLElement, key?: string) {
  const event = new window.Event(key === undefined ? 'click' : 'keydown', { bubbles: true, cancelable: true });
  if (key !== undefined) Object.defineProperty(event, 'key', { value: key });
  await act(() => { header.dispatchEvent(event); });
  if (key !== undefined) assert.equal(event.defaultPrevented, true);
}

test('never-opened reasoning keeps its header and empty wrappers without evaluating children', async () => {
  const view = setup();
  let renders = 0;
  function Body() { renders += 1; return <p>Hidden body</p>; }
  await view.render(
    <ChatReasoning label="Reasoned" duration="2s" previewText="Preview" title="Details" className="custom">
      <Body />
    </ChatReasoning>,
  );
  assert.equal(renders, 0);
  assert.equal(view.body().childNodes.length, 0);
  assert.equal(view.header().getAttribute('aria-expanded'), 'false');
  assert.equal(view.header().getAttribute('role'), 'button');
  assert.equal(view.header().getAttribute('tabindex'), '0');
  assert.equal(view.header().textContent, 'Reasoned·2s—Preview');
  assert.equal(view.container.querySelector('.custom')?.getAttribute('title'), 'Details');
  assert.equal(view.body().parentElement?.parentElement?.className, 'xrvj5dj xihq33y xb0j27v');
});

for (const props of [{ defaultIsExpanded: true }, { isExpanded: true }]) {
  test(`initial ${Object.keys(props)[0]} mounts children immediately`, async () => {
    const view = setup();
    let renders = 0;
    function Body() { renders += 1; return <p>Ready</p>; }
    await view.render(<ChatReasoning {...props}><Body /></ChatReasoning>);
    assert.equal(renders, 1);
    assert.equal(view.body().textContent, 'Ready');
    assert.equal(view.header().getAttribute('aria-expanded'), 'true');
  });
}

test('controlled expansion waits for its owner, then retains child state and updates after closing', async () => {
  const view = setup();
  const changes: boolean[] = [];
  let mounts = 0;
  let unmounts = 0;
  let renders = 0;
  function Body({ text }: { text: string }) {
    renders += 1;
    const [count, setCount] = useState(0);
    useEffect(() => { mounts += 1; return () => { unmounts += 1; }; }, []);
    return <button type="button" onClick={() => setCount(count + 1)}>{text}:{count}</button>;
  }
  const render = (expanded: boolean, text: string) => view.render(
    <ChatReasoning isExpanded={expanded} defaultIsExpanded onExpandedChange={(next) => changes.push(next)}>
      <Body text={text} />
    </ChatReasoning>,
  );
  await render(false, 'old');
  await activate(view.header());
  assert.deepEqual(changes, [true]);
  assert.equal(renders, 0, 'a controlled click alone does not mount the body');
  await render(false, 'latest');
  assert.equal(renders, 0);
  await render(true, 'latest');
  const button = view.body().querySelector('button');
  assert.ok(button);
  assert.equal(button.textContent, 'latest:0');
  await activate(button);
  await render(false, 'closed update');
  assert.equal(view.body().querySelector('button'), button);
  assert.equal(button.textContent, 'closed update:1');
  await render(true, 'reopened');
  assert.equal(view.body().querySelector('button'), button);
  assert.equal(button.textContent, 'reopened:1');
  assert.equal(mounts, 1);
  assert.equal(unmounts, 0);
});

for (const firstAction of [undefined, 'Enter', ' ']) {
  test(`${firstAction ?? 'click'} opens once and retains the body through keyboard collapse`, async () => {
    const view = setup();
    const changes: boolean[] = [];
    await view.render(<ChatReasoning onExpandedChange={(next) => changes.push(next)}><p>Body</p></ChatReasoning>);
    await activate(view.header(), firstAction);
    const paragraph = view.body().firstChild;
    assert.ok(paragraph);
    assert.equal(view.header().getAttribute('aria-expanded'), 'true');
    await activate(view.header(), ' ');
    assert.equal(view.header().getAttribute('aria-expanded'), 'false');
    assert.equal(view.body().firstChild, paragraph);
    await activate(view.header(), 'Enter');
    assert.equal(view.body().firstChild, paragraph);
    assert.deepEqual(changes, [true, false, true]);
  });
}

test('streaming and default prop updates stay folded and first expansion receives current children', async () => {
  const view = setup();
  const seen: string[] = [];
  function Body({ text }: { text: string }) { seen.push(text); return <p>{text}</p>; }
  const render = (text: string, streaming: boolean, defaultOpen = false) => view.render(
    <ChatReasoning defaultIsExpanded={defaultOpen} isStreaming={streaming} previewText={text} duration="2s">
      <Body text={text} />
    </ChatReasoning>,
  );
  await render('old', false);
  await render('live revision', true, true);
  assert.deepEqual(seen, []);
  assert.equal(view.header().getAttribute('aria-expanded'), 'false');
  assert.equal(view.header().textContent, 'Thinking');
  await activate(view.header());
  assert.deepEqual(seen, ['live revision']);
  await activate(view.header());
  await render('settled revision', false);
  assert.equal(view.body().textContent, 'settled revision');
  assert.equal(view.header().textContent, 'Thinking·2s—settled revision');
});

test('a reasoning-only TurnView opens the latest Markdown and preserves rendered nodes on close', async () => {
  const view = setup();
  const render = (text: string) => {
    const turn: TurnViewModel = {
      turnId: 'reasoning-only', status: 'completed', tools: [], notes: [], startedAt: 0,
      timeline: [{ kind: 'thinking', messageId: 'reason-1', text, live: false }],
    };
    return view.render(<LocaleProvider locale="en"><TurnView turn={turn} /></LocaleProvider>);
  };
  await render('Old summary\n\n**Old detail**');
  await render('New summary\n\n**Latest detail**');
  assert.equal(view.body().childNodes.length, 0);
  assert.equal(view.container.querySelector('.maka-markdown'), null);
  await activate(view.header());
  // First-open Markdown may initially use its safe text fallback while the
  // cold dynamic import resolves. Wait for that real module, not a timer.
  await act(async () => { await import('../markdown-body.js'); });
  const strong = view.body().querySelector('strong');
  assert.ok(strong, 'the ordinary Markdown renderer eventually loads on first expansion');
  assert.equal(strong.textContent, 'Latest detail');
  await activate(view.header());
  assert.equal(view.body().querySelector('strong'), strong);
  await activate(view.header());
  assert.equal(view.body().querySelector('strong'), strong);
});
