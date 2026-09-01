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
  assert.match(markup, /用时 4 分钟 33 秒/);
  assert.match(markup, /读取 1 个文件/);
  assert.match(markup, /package name 是 maka/);

  const { document } = parseHTML(markup);
  const workLogHeader = document.querySelector(
    '.maka-work-log > .astryx-collapsible-trigger',
  );
  const processingHeader = document.querySelector(
    '.maka-processing-block > .astryx-collapsible-trigger',
  );
  const workLogContent = document.querySelector('.maka-work-log-content');
  const finalAnswer = [...document.querySelectorAll('.maka-chat-message-bubble-assistant')]
    .find((element) => element.textContent.includes('package name 是 maka'));
  assert.ok(workLogHeader);
  assert.ok(processingHeader);
  assert.ok(workLogContent);
  assert.ok(finalAnswer);
  assert.equal(workLogHeader.getAttribute('aria-expanded'), 'false');
  assert.equal(processingHeader.getAttribute('aria-expanded'), 'false');
  assert.equal(workLogContent.textContent.includes('package name 是 maka'), false);
  assert.equal(workLogContent.contains(finalAnswer), false);
});

test('keeps live work expanded, then collapses it once when the final answer appears', async () => {
  const { container, root } = domRoot();

  await renderTurn(root, fixtureTurn(workTimeline(false)), true);
  const processingHeader = container.querySelector(
    '.maka-processing-block > .astryx-collapsible-trigger',
  );
  assert.ok(processingHeader);
  assert.equal(
    container.querySelector('.maka-work-log > .astryx-collapsible-trigger'),
    null,
  );
  assert.equal(processingHeader.getAttribute('aria-expanded'), 'true');

  await renderTurn(root, {
    ...fixtureTurn(workTimeline(true, false)),
    status: 'completed',
  }, false);
  const workLogHeader = container.querySelector(
    '.maka-work-log > .astryx-collapsible-trigger',
  );
  const settledProcessingHeader = container.querySelector(
    '.maka-processing-block > .astryx-collapsible-trigger',
  );
  assert.ok(workLogHeader);
  assert.ok(settledProcessingHeader);
  assert.equal(workLogHeader.getAttribute('aria-expanded'), 'false');
  assert.equal(settledProcessingHeader.getAttribute('aria-expanded'), 'false');

  await act(() => workLogHeader.dispatchEvent(new window.Event('click', { bubbles: true })));
  assert.equal(workLogHeader.getAttribute('aria-expanded'), 'true');

  await renderTurn(root, {
    ...fixtureTurn([
      ...workTimeline(false),
      {
        kind: 'text',
        text: 'package name 是 maka，验证完成。',
        messageId: 'final-1',
        live: false,
      },
    ]),
    status: 'completed',
  }, false);
  assert.equal(
    workLogHeader.getAttribute('aria-expanded'),
    'true',
    'later final-answer deltas do not override a manual reopen',
  );
});

test('keeps a steered segment expanded while its tool is still running', async () => {
  const { container, root } = domRoot();
  const runningRead: ToolActivityItem = {
    toolUseId: 'read-running',
    toolName: 'Read',
    activityKind: 'read',
    status: 'running',
    args: {},
  };
  const turn = fixtureTurn([
    {
      kind: 'text',
      text: '正在读取项目文件。',
      messageId: 'commentary-running',
    },
    { kind: 'tools', items: [runningRead] },
    {
      kind: 'user',
      messageId: 'steer-1',
      message: { id: 'steer-1', role: 'user', text: '顺便检查测试。', ts: 3 },
    },
  ]);

  await renderTurn(root, turn, true);

  assert.equal(
    container.querySelector('.maka-work-log > .astryx-collapsible-trigger'),
    null,
  );
  assert.equal(
    container
      .querySelector('.maka-processing-block > .astryx-collapsible-trigger')
      ?.getAttribute('aria-expanded'),
    'true',
  );
  assert.equal(container.textContent.includes('正在读取项目文件。'), true);
});

test('shows the turn duration only on the final assistant segment', () => {
  const turn = {
    ...fixtureTurn([
      {
        kind: 'text' as const,
        text: '先检查第一部分。',
        messageId: 'commentary-1',
      },
      {
        kind: 'text' as const,
        text: '第一部分完成。',
        messageId: 'final-1',
      },
      {
        kind: 'user' as const,
        messageId: 'steer-1',
        message: { id: 'steer-1', role: 'user' as const, text: '继续检查。', ts: 3 },
      },
      {
        kind: 'text' as const,
        text: '正在检查第二部分。',
        messageId: 'commentary-2',
      },
      {
        kind: 'text' as const,
        text: '第二部分完成。',
        messageId: 'final-2',
      },
    ]),
    status: 'completed' as const,
    durationMs: 10_000,
  };

  const markup = renderToStaticMarkup(
    createElement(LocaleProvider, {
      locale: 'zh',
      children: createElement(TurnView, { turn }),
    }),
  );

  assert.equal(markup.match(/用时 10 秒/g)?.length, 1);
  assert.match(markup, />工作记录</);
});

test('does not create a work log for a direct final answer', () => {
  const turn = {
    ...fixtureTurn([
      {
        kind: 'text' as const,
        text: '直接答案。',
        messageId: 'final-1',
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

test('keeps the last completed text outside earlier imported progress', () => {
  const turn = {
    ...fixtureTurn([
      {
        kind: 'text' as const,
        text: '正在检查导入的旧会话。',
        messageId: 'commentary-1',
      },
      {
        kind: 'text' as const,
        text: '旧版最终答案。',
        messageId: 'legacy-final',
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
  const { document } = parseHTML(markup);
  const workLogContent = document.querySelector('.maka-work-log-content');
  const finalAnswer = [...document.querySelectorAll('.maka-chat-message-bubble-assistant')]
    .find((element) => element.textContent.includes('旧版最终答案'));
  assert.ok(workLogContent);
  assert.ok(finalAnswer);
  assert.equal(workLogContent.textContent.includes('正在检查导入的旧会话'), true);
  assert.equal(workLogContent.textContent.includes('旧版最终答案'), false);
  assert.equal(workLogContent.contains(finalAnswer), false);
});

test('uses the last text as the final reply when a completed turn ends after tool activity', () => {
  const turn = {
    ...fixtureTurn([
      {
        kind: 'text' as const,
        text: '先检查一下。',
        messageId: 'legacy-progress',
      },
      {
        kind: 'tools' as const,
        items: [
          {
            toolUseId: 'read-after-text',
            toolName: 'Read',
            activityKind: 'read',
            status: 'completed',
            args: {},
          },
        ],
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
  const { document } = parseHTML(markup);
  const workLogContent = document.querySelector('.maka-work-log-content');
  const finalAnswer = [...document.querySelectorAll('.maka-chat-message-bubble-assistant')]
    .find((element) => element.textContent.includes('先检查一下。'));
  assert.ok(workLogContent);
  assert.ok(finalAnswer);
  assert.equal(workLogContent.textContent.includes('先检查一下。'), false);
  assert.equal(workLogContent.contains(finalAnswer), false);
  assert.equal(workLogContent.textContent.includes('读取 1 个文件'), true);
});

for (const status of ['failed', 'aborted'] as const) {
  test(`collapses all retained work for a ${status} turn with no final answer`, () => {
    const turn = {
      ...fixtureTurn(workTimeline(false)),
      status,
    };
    const markup = renderToStaticMarkup(
      createElement(LocaleProvider, {
        locale: 'zh',
        children: createElement(TurnView, {
          turn,
          failedReasonLabel: status === 'failed' ? '模型请求失败' : undefined,
        }),
      }),
    );

    const { document } = parseHTML(markup);
    const workLogHeader = document.querySelector(
      '.maka-work-log > .astryx-collapsible-trigger',
    );
    const workLogContent = document.querySelector('.maka-work-log-content');
    assert.ok(workLogHeader);
    assert.ok(workLogContent);
    assert.equal(workLogHeader.getAttribute('aria-expanded'), 'false');
    assert.equal(workLogContent.textContent.includes('准备检查 package.json'), true);
    assert.equal(
      [...document.querySelectorAll('.maka-chat-message-bubble-assistant')]
        .some((element) => !workLogContent.contains(element)),
      false,
    );
    if (status === 'failed') {
      assert.equal(workLogContent.textContent.includes('模型请求失败'), false);
      assert.match(markup, /模型请求失败/);
    }
  });
}
