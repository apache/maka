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
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { parseHTML } from 'linkedom';
import { TurnView } from '../chat-turn.js';
import { LocaleProvider } from '../locale-context.js';
import type { ToolActivityItem, TurnViewModel } from '../materialize.js';

const originalGlobals = {
  cancelAnimationFrame: globalThis.cancelAnimationFrame,
  document: globalThis.document,
  matchMedia: globalThis.matchMedia,
  requestAnimationFrame: globalThis.requestAnimationFrame,
  window: globalThis.window,
};
const originalActEnvironment = (globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
}).IS_REACT_ACT_ENVIRONMENT;
const mountedRoots: ReturnType<typeof createRoot>[] = [];

afterEach(async () => {
  for (const root of mountedRoots.splice(0)) await act(() => root.unmount());
  Object.assign(globalThis, {
    ...originalGlobals,
    IS_REACT_ACT_ENVIRONMENT: originalActEnvironment,
  });
});

function domRoot() {
  const { document, window } = parseHTML('<div id="root"></div>');
  Object.assign(globalThis, {
    cancelAnimationFrame() {},
    document,
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    requestAnimationFrame: () => 1,
    window,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  window.matchMedia = globalThis.matchMedia;
  const container = document.querySelector('#root');
  assert.ok(container);
  const root = createRoot(container);
  mountedRoots.push(root);
  return { container, root };
}

function renderTurn(
  root: ReturnType<typeof createRoot>,
  turn: TurnViewModel,
  live: boolean,
): Promise<void> {
  return act(() => {
    root.render(
      <LocaleProvider locale="zh">
        <TurnView turn={turn} liveStreaming={live ? {} : undefined} />
      </LocaleProvider>,
    );
  }) as unknown as Promise<void>;
}

function fixtureTurn(timeline: TurnViewModel['timeline']): TurnViewModel {
  return {
    turnId: 'turn-1',
    status: 'running',
    partialOutputRetained: false,
    tools: timeline.flatMap((item) => item.kind === 'tools' ? item.items : []),
    notes: [],
    timeline,
    startedAt: 1,
  };
}

function workTimeline(
  includeFinalAnswer: boolean,
  finalAnswerLive = true,
): TurnViewModel['timeline'] {
  const read: ToolActivityItem = {
    toolUseId: 'read-1',
    toolName: 'Read',
    activityKind: 'read',
    status: 'completed',
    args: {},
  };
  return [
    {
      kind: 'text',
      text: '准备检查 package.json 的 name 字段。',
      messageId: 'commentary-1',
      phase: 'commentary',
    },
    {
      kind: 'thinking',
      text: 'reasoning',
      messageId: 'thinking-1',
    },
    { kind: 'tools', items: [read] },
    ...(includeFinalAnswer
      ? [{
          kind: 'text' as const,
          text: 'package name 是 maka。',
          messageId: 'final-1',
          phase: 'final_answer' as const,
          live: finalAnswerLive,
        }]
      : []),
  ];
}

test('folds completed reasoning and tool activity into one collapsed work log', () => {
  const turn = {
    ...fixtureTurn(workTimeline(true, false)),
    status: 'completed' as const,
    durationMs: 273_000,
  };

  const markup = renderToStaticMarkup(
    createElement(LocaleProvider, {
      locale: 'zh',
      children: createElement(TurnView, { turn }),
    }),
  );

  assert.match(markup, /准备检查 package\.json 的 name 字段/);
  assert.match(markup, /data-processing="block"/);
  assert.match(markup, /class="maka-work-log-header" aria-expanded="false"/);
  assert.match(markup, /class="maka-work-log-content" hidden=""/);
  assert.match(markup, /aria-expanded="false"/);
  assert.match(markup, /用时 4 分钟 33 秒/);
  assert.match(markup, /读取 1 个文件/);
  assert.match(markup, /class="maka-processing-sequence" hidden=""/);
  assert.match(markup, /package name 是 maka/);

  const { document } = parseHTML(markup);
  const workLogContent = document.querySelector('.maka-work-log-content');
  const finalAnswer = [...document.querySelectorAll('.maka-chat-message-bubble-assistant')]
    .find((element) => element.textContent.includes('package name 是 maka'));
  assert.ok(workLogContent);
  assert.ok(finalAnswer);
  assert.equal(workLogContent.textContent.includes('package name 是 maka'), false);
  assert.equal(workLogContent.contains(finalAnswer), false);
});

test('keeps live work expanded, then collapses it once when the final answer appears', async () => {
  const { container, root } = domRoot();

  await renderTurn(root, fixtureTurn(workTimeline(false)), true);
  const processingHeader = container.querySelector('.maka-processing-header');
  assert.ok(processingHeader);
  assert.equal(container.querySelector('.maka-work-log-header'), null);
  assert.equal(processingHeader.getAttribute('aria-expanded'), 'true');
  assert.equal(container.querySelector('.maka-processing-sequence')?.hasAttribute('hidden'), false);

  await renderTurn(root, fixtureTurn(workTimeline(true)), true);
  const workLogHeader = container.querySelector('.maka-work-log-header');
  assert.ok(workLogHeader);
  assert.equal(workLogHeader.getAttribute('aria-expanded'), 'false');
  assert.equal(container.querySelector('.maka-work-log-content')?.hasAttribute('hidden'), true);
  assert.equal(processingHeader.getAttribute('aria-expanded'), 'false');

  await act(() => workLogHeader.dispatchEvent(new window.Event('click', { bubbles: true })));
  assert.equal(workLogHeader.getAttribute('aria-expanded'), 'true');

  await renderTurn(root, fixtureTurn([
    ...workTimeline(false),
    {
      kind: 'text',
      text: 'package name 是 maka，验证完成。',
      messageId: 'final-1',
      phase: 'final_answer',
      live: true,
    },
  ]), true);
  assert.equal(
    workLogHeader.getAttribute('aria-expanded'),
    'true',
    'later final-answer deltas do not override a manual reopen',
  );
});

test('does not create a work log for a direct final answer', () => {
  const turn = {
    ...fixtureTurn([
      {
        kind: 'text' as const,
        text: '直接答案。',
        messageId: 'final-1',
        phase: 'final_answer' as const,
      },
    ]),
    status: 'completed' as const,
  };

  const markup = renderToStaticMarkup(
    createElement(LocaleProvider, {
      locale: 'zh',
      children: createElement(TurnView, { turn }),
    }),
  );

  assert.doesNotMatch(markup, /data-work-log="true"/);
  assert.match(markup, /直接答案/);
});

test('collapses commentary-only failed work while leaving the failure outcome outside', () => {
  const turn = {
    ...fixtureTurn(workTimeline(false)),
    status: 'failed' as const,
  };
  const markup = renderToStaticMarkup(
    createElement(LocaleProvider, {
      locale: 'zh',
      children: createElement(TurnView, {
        turn,
        failedReasonLabel: '模型请求失败',
      }),
    }),
  );

  const { document } = parseHTML(markup);
  const workLogContent = document.querySelector('.maka-work-log-content');
  assert.ok(workLogContent);
  assert.equal(workLogContent.hasAttribute('hidden'), true);
  assert.equal(workLogContent.textContent.includes('准备检查 package.json'), true);
  assert.equal(workLogContent.textContent.includes('模型请求失败'), false);
  assert.match(markup, /模型请求失败/);
});
