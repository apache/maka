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

import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AssistantCard } from '@maka/core/assistant-card';
import { MessageCard, MessageCardSendContext, MessageCardActionsContext } from '../message-card.js';
import { MessageSummary } from '../message-summary.js';
import { act } from 'react';
import { installDom } from './mermaid-test-dom.js';
import { LocaleProvider } from '../locale-context.js';
import { materializeTurns } from '../materialize.js';
const card: AssistantCard = { type: 'recommendation', title: '周末摄影', items: [{ title: '城市光影', description: '可以顺路去看看。', facts: [{ label: '时间', value: '周六下午' }], actions: [{ kind: 'reply', label: '安排一下', value: '帮我安排周六下午的城市光影摄影展行程。' }] }, { title: '街头日常', actions: [{ kind: 'link', label: '详情', value: 'https://example.com/exhibit' }] }] };
test('renders multiple choices and facts; card stays outside collapsed prose', () => {
 const html = renderToStaticMarkup(<LocaleProvider locale="zh-CN"><MessageSummary summary="短摘要"><p>长正文</p></MessageSummary><MessageCardSendContext.Provider value={async () => true}><MessageCard card={card} /></MessageCardSendContext.Provider></LocaleProvider>);
 assert.match(html, /城市光影/); assert.match(html, /街头日常/); assert.match(html, /周六下午/);
 assert.match(html, /data-count="2"/); assert.doesNotMatch(html, /点击选项/);
 assert.ok(html.indexOf('maka-message-card') > html.indexOf('maka-message-summary-toggle'));
 assert.match(html, /https:\/\/example.com\/exhibit/);
});
test('renders ordinary text safely and refuses invalid persisted cards', () => {
 const render = (c: AssistantCard) => renderToStaticMarkup(<LocaleProvider locale="en"><MessageCard card={c} /></LocaleProvider>);
 assert.match(render({ ...card, title: '<script>alert(1)</script>' }), /&lt;script&gt;/);
 assert.equal(render({ ...card, items: [{ title: 'x', actions: [{ kind: 'link', label: 'run', value: 'javascript:alert(1)' }] }] }), '');
 assert.match(render(card), /disabled/);
});
test('live committed messages and reloaded history carry the same card', () => {
 const m = { type: 'assistant' as const, id: 'a', turnId: 't', ts: 1, text: '看看这些。', modelId: 'bot', card };
 for (const message of [m, JSON.parse(JSON.stringify({ ...m, contentOrder: ['text'] }))]) {
  const item = materializeTurns([message], 'en')[0].timeline.find(x => x.kind === 'text');
  assert.deepEqual(item?.kind === 'text' && item.card, card);
 }
});


test('a card click submits immediately, deduplicates while pending and permits retry after refusal', async () => {
 const dom = installDom();
 const { createRoot } = await import('react-dom/client');
 const root = createRoot(dom.document.getElementById('root')!);
 const calls: string[] = [];
 let finish!: (accepted: boolean) => void;
 const send = (text: string) => { calls.push(text); return new Promise<boolean>(resolve => { finish = resolve; }); };
 try {
  await act(async () => root.render(<LocaleProvider locale="en"><MessageCardSendContext.Provider value={send}><MessageCard card={card} /></MessageCardSendContext.Provider></LocaleProvider>));
  const button = () => dom.document.querySelector('button')!;
  await act(async () => { button().click(); button().click(); });
  assert.deepEqual(calls, [card.items[0]!.actions![0]!.value]);
  assert.equal(button().hasAttribute('disabled'), true);
  await act(async () => finish(false));
  assert.match(dom.document.querySelector('[role="alert"]')?.textContent ?? '', /try again/);
  await act(async () => button().click());
  assert.equal(calls.length, 2);
  await act(async () => finish(true));
  assert.match(button().textContent ?? '', /Sent/);
  assert.equal(button().hasAttribute('disabled'), true);
  assert.equal(dom.document.querySelector('textarea, [contenteditable]'), null);
 } finally { await act(async () => root.unmount()); dom.restore(); }
});


test('one reply disables all items and links; a failed send leaves every choice retryable', async () => {
 const dom = installDom();
 const { createRoot } = await import('react-dom/client');
 const root = createRoot(dom.document.getElementById('root')!);
 let calls = 0;
 const choices: AssistantCard = { ...card, items: [...card.items, { title: '另一个', actions: [{ kind: 'reply', label: '选另一个', value: '另一个' }] }] };
 try {
  await act(async () => root.render(<LocaleProvider locale="en"><MessageCardSendContext.Provider value={async () => ++calls > 1}><MessageCard card={choices} /></MessageCardSendContext.Provider></LocaleProvider>));
  const buttons = () => [...dom.document.querySelectorAll('button')];
  await act(async () => buttons()[0]!.click());
  assert.ok(buttons().every(b => !b.disabled));
  await act(async () => buttons()[1]!.click());
  assert.ok(buttons().every(b => b.disabled));
  assert.equal(dom.document.querySelector('a[href="https://example.com/exhibit"]'), null);
  assert.ok(dom.document.querySelector('[aria-disabled="true"]'));
  await act(async () => buttons()[0]!.click());
  assert.equal(calls, 2);
 } finally { await act(async () => root.unmount()); dom.restore(); }
});
test('authoritative choice restores disabled state on remount, without resubmitting', async () => {
 const dom = installDom();
 const { createRoot } = await import('react-dom/client');
 const root = createRoot(dom.document.getElementById('root')!);
 let selectedKey: string | null = null; let calls = 0;
 const actions = { read: async () => ({ selectedKey }), choose: async (_: string, key: string) => { calls++; selectedKey ??= key; return { selectedKey }; } };
 const render = (key: number) => <LocaleProvider locale="en"><MessageCardActionsContext.Provider value={actions}><MessageCard key={key} card={card} messageId="card" /></MessageCardActionsContext.Provider></LocaleProvider>;
 try {
  await act(async () => root.render(render(0)));
  await act(async () => dom.document.querySelector('button')!.click());
  assert.equal(calls, 1);
  await act(async () => root.render(render(1)));
  assert.equal(dom.document.querySelector('button')!.disabled, true);
  assert.match(dom.document.querySelector('button')!.textContent ?? '', /Sent/);
  assert.equal(calls, 1);
 } finally { await act(async () => root.unmount()); dom.restore(); }
});
