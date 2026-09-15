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
import { test } from 'node:test';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { parseHTML } from 'linkedom';
import type { ClientCapabilityRequestEvent } from '@maka/core/events';
import { ClientCapabilityPrompt } from '../client-capability-prompt.js';
import { getConversationCopy } from '../conversation-copy.js';
import { LocaleProvider } from '../locale-context.js';

const request: ClientCapabilityRequestEvent = {
  type: 'client_capability_request',
  id: 'event-1',
  ts: 1,
  turnId: 'turn-1',
  requestId: 'history-request-1',
  toolUseId: 'history-read-1',
  capability: 'computer_history',
  scope: { kind: 'capability' },
};

for (const [locale, requiredText] of [
  ['en', [/requested recorded activity/u, /conversation.s model/u, /does not enable recording or request OS permissions/u]],
  ['zh-CN', [/请求的已记录活动/u, /当前对话模型/u, /不会启用记录或申请系统权限/u]],
  ['zh-TW', [/請求的已記錄活動/u, /目前對話模型/u, /不會啟用記錄或申請系統權限/u]],
] as const) {
  test(`History approval describes data use, not recording consent (${locale})`, () => {
    const markup = renderToStaticMarkup(
      <LocaleProvider locale={locale}>
        <ClientCapabilityPrompt request={request} onRespond={() => undefined} />
      </LocaleProvider>,
    );
    const { document } = parseHTML(markup);
    const copy = getConversationCopy(locale).clientCapability;
    const section = document.querySelector('section');
    assert.ok(section);
    assert.equal(document.getElementById(section.getAttribute('aria-labelledby') ?? '')?.textContent, copy.title);
    for (const text of requiredText) assert.match(section.textContent ?? '', text);
    assert.equal(document.querySelectorAll('button').length, 2);
    assert.match(section.textContent ?? '', new RegExp(copy.sessionNotice, 'u'));
    assert.doesNotMatch(section.textContent ?? '', /desktop_mcp|ComputerHistoryReadEvents|Mac/u);
  });
}

test('History prompt rejects a mismatched scope rather than displaying broader consent', () => {
  assert.throws(
    () => renderToStaticMarkup(
      <LocaleProvider locale="en">
        <ClientCapabilityPrompt
          request={{ ...request, scope: { kind: 'mcp_tool', serverId: 'history', toolName: 'read' } }}
          onRespond={() => undefined}
        />
      </LocaleProvider>,
    ),
    /invalid scope/u,
  );
});

test('History uses the existing allow/deny lifecycle and suppresses duplicate submissions', async () => {
  const original = {
    document: globalThis.document,
    window: globalThis.window,
    requestAnimationFrame: globalThis.requestAnimationFrame,
    cancelAnimationFrame: globalThis.cancelAnimationFrame,
    IS_REACT_ACT_ENVIRONMENT: (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT,
  };
  const { document, window } = parseHTML('<div id="root"></div>');
  Object.assign(globalThis, {
    document, window, IS_REACT_ACT_ENVIRONMENT: true,
    requestAnimationFrame: () => 1,
    cancelAnimationFrame: () => undefined,
  });
  const container = document.querySelector('#root');
  assert.ok(container);
  const root = createRoot(container);
  const responses: { requestId: string; decision: 'allow' | 'deny' }[] = [];
  let resolveResponse!: () => void;
  const response = new Promise<void>((resolve) => { resolveResponse = resolve; });
  const render = async (next: ClientCapabilityRequestEvent) => {
    await act(() => root.render(
      <LocaleProvider locale="en">
        <ClientCapabilityPrompt request={next} onRespond={(value) => {
          responses.push(value);
          return response;
        }} />
      </LocaleProvider>,
    ));
  };
  const click = (button: Element) => button.dispatchEvent(new window.Event('click', { bubbles: true }));
  try {
    await render(request);
    const buttons = container.querySelectorAll('button');
    assert.equal(buttons[0]?.textContent, 'Reject');
    assert.equal(buttons[1]?.textContent, 'Allow for this task');
    await act(() => { click(buttons[1]!); click(buttons[1]!); });
    assert.deepEqual(responses, [{ requestId: request.requestId, decision: 'allow' }]);
    assert.equal([...container.querySelectorAll('button')].every((button) => button.disabled), true);
    await act(async () => { resolveResponse(); });
    await render({ ...request, requestId: 'history-request-2' });
    await act(async () => { click(container.querySelectorAll('button')[0]!); });
    assert.deepEqual(responses, [
      { requestId: request.requestId, decision: 'allow' },
      { requestId: 'history-request-2', decision: 'deny' },
    ]);
  } finally {
    await act(() => root.unmount());
    Object.assign(globalThis, original);
  }
});
