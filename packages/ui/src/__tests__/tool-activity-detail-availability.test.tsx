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
import { describe, it } from 'node:test';
import { act, createElement, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { parseHTML } from 'linkedom';
import { UI_LOCALES, type UiLocale } from '@maka/core/ui-locale';
import type { ToolResultContent } from '@maka/core/events';
import { ToolTrow } from '../tool-activity.js';
import type { ToolActivityItem } from '../materialize.js';
import { LocaleProvider } from '../locale-context.js';
import {
  MakaClientSessionScope,
  MakaClientSlotCore,
  MakaClientSlotProvider,
} from '../client-plugin-slots.js';
import { getToolActivityCopy } from '../tool-activity/copy.js';
import { ToolResultPreview } from '../tool-activity/tool-result-preview.js';

const baseItem: ToolActivityItem = {
  toolUseId: 'detail-test',
  toolName: 'CustomTool',
  status: 'completed',
  args: undefined,
};

function renderWithLocale(children: ReactNode, locale: UiLocale = 'en'): string {
  return renderToStaticMarkup(createElement(LocaleProvider, { locale, children }));
}

function toolRow(root: ParentNode): Element {
  const row = root.querySelector('[data-slot="chat-tool-call-row"]');
  assert.ok(row, 'the actual Astryx call row is rendered');
  return row;
}

// Astryx renders this path only for the row's detail chevron.
const CHEVRON = 'path[d="M6 9l6 6 6-6"]';
function assertExpandable(root: ParentNode, expected: boolean): void {
  const row = toolRow(root);
  assert.equal(row.getAttribute('role'), expected ? 'button' : null);
  assert.equal(row.getAttribute('tabindex'), expected ? '0' : null);
  assert.equal(row.hasAttribute('aria-expanded'), expected);
  assert.equal(row.querySelector(CHEVRON) !== null, expected, 'row detail chevron');
}

function assertRow(changes: Partial<ToolActivityItem>, expected: boolean, locale: UiLocale = 'en'): string {
  const markup = renderWithLocale(createElement(ToolTrow, { items: [{ ...baseItem, ...changes }] }), locale);
  assertExpandable(parseHTML(markup).document, expected);
  return markup;
}

function quietResult(content: string): ToolResultContent {
  return { kind: 'json', value: { content } };
}

function summaryResult(summarized: string): ToolResultContent {
  return { kind: 'summary', summarized, original: 'hidden original', reason: 'too_large' };
}

const archivedResult: Extract<ToolResultContent, { kind: 'archived_tool_result' }> = {
  kind: 'archived_tool_result',
  status: 'not_loaded',
  runtimeEventId: 'event-1',
  toolCallId: 'detail-test',
  toolName: 'CustomTool',
  originalEstimatedTokens: 800,
  originalBytes: 3200,
  rewriteVersion: 1,
  reason: 'tool_result_pruned',
};

describe('tool row detail availability', () => {
  it('omits activation and chevrons for empty bodies and permission-denied output', () => {
    for (const status of ['completed', 'running'] as const) assertRow({ status }, false);
    assertRow({
      status: 'errored',
      args: { path: '/private/data' },
      result: { kind: 'text', text: 'User denied permission request' },
    }, false);
    assertRow({ result: { kind: 'text', text: '  \n\t ' } }, false);
    assertRow({ result: summaryResult('   ') }, false);
  });

  it('compares untitled invocation text using trim, redaction and the row cap', () => {
    for (const command of [
      '  git status  \n',
      'curl -H "Authorization: Bearer secret-token-value" https://example.com',
    ]) {
      const markup = assertRow({ toolName: 'Bash', args: { command } }, false);
      assert.doesNotMatch(markup, /secret-token-value/);
    }
    // The row shows only the first 119 characters; the tail is readable only
    // inside the detail panel, so a capped invocation stays expandable.
    assertRow({ toolName: 'Bash', args: { command: `echo ${'x'.repeat(300)}` } }, true);
    assertRow({ args: { command: 'git status' }, intent: 'Inspect working tree' }, true);
    assertRow({ args: { command: 'echo first\necho second' } }, true);
  });

  it('keeps titled or distinct quiet JSON expandable and uses the full intent formatter', () => {
    assertRow({ args: { command: 'git status' }, result: quietResult('git status') }, true);
    assertRow({ result: quietResult('first\nsecond') }, true);

    const intent = `${'x'.repeat(130)} expected`;
    const markup = assertRow({
      intent, result: quietResult(`${'x'.repeat(130)} actual output`),
    }, true);
    assert.ok(markup.includes(intent), 'the target retains its suffix beyond 120 characters');
    assertRow({ intent, result: quietResult(`  ${intent}  `) }, false);
    // Same rule at the 240-character intent cap: a body longer than the
    // displayed target keeps its tail only inside the detail panel.
    assertRow({
      intent: `Inspect   ${'x'.repeat(250)}`, result: quietResult(`Inspect ${'x'.repeat(250)}`),
    }, true);
  });

  it('keeps args-only details when the target omits information', () => {
    assertRow({ args: {}, intent: '(empty)' }, false);
    assertRow({ args: ['first', 'second'], intent: 'first' }, true);
    assertRow({ args: ['x'.repeat(300)], intent: 'x'.repeat(300) }, true);
  });

  it('omits image and archived placeholder details and localizes archive stats', () => {
    assertRow({ result: {
      kind: 'image', mimeType: 'image/png', ref: { kind: 'workspace_file', relativePath: 'image.png' },
    } }, false);
    for (const locale of UI_LOCALES) {
      for (const status of ['not_loaded', 'missing', 'corrupt'] as const) {
        const markup = assertRow({ result: { ...archivedResult, status } }, false, locale);
        assert.ok(markup.includes(getToolActivityCopy(locale).result.archivedStatus[status]));
        assert.doesNotMatch(markup, /\[archived_tool_result\]/);
      }
    }
    // An archived result on an interrupted call keeps its outcome word.
    const interrupted = assertRow({ status: 'interrupted', result: archivedResult }, false);
    const copy = getToolActivityCopy('en');
    assert.ok(
      interrupted.includes(`${copy.status.interrupted} · ${copy.result.archivedStatus.not_loaded}`),
    );
  });

  it('preserves text, diff, terminal, shell and web search activation', () => {
    const output = { mode: 'pipes', stdout: 'output', stderr: '', stdoutTruncated: false, stderrTruncated: false, redacted: false } as const;
    const results: ToolResultContent[] = [
      { kind: 'text', text: 'actual output' },
      { kind: 'file_diff', paths: ['a.ts'], diff: '@@ -1 +1 @@\n-old\n+new' },
      {
        kind: 'terminal', cmd: 'npm test', cwd: '/repo', status: 'completed', exitCode: 0,
        output,
      },
      {
        kind: 'shell_run', cmd: 'npm test', cwd: '/repo', status: 'completed', mode: 'pipes',
        ref: 'maka://runtime/background-tasks/test', startedAt: 1, updatedAt: 2, revision: 1, output,
      },
      { kind: 'web_search', provider: 'tavily', query: 'Maka', rows: [] },
    ];
    for (const result of results) assertRow({ result }, true);
  });

  it('keeps sandbox and bypass decorations expandable even without a body', () => {
    const results: ToolResultContent[] = [
      { kind: 'text', text: 'User denied permission request', sandboxDenial: { likely: true, backend: 'macos-seatbelt' } },
      { kind: 'text', text: 'requires bypass', sandboxFailure: { reason: 'requires_bypass', source: 'client_capability' } },
    ];
    for (const result of results) assertRow({ result, status: 'errored' }, true);
  });

  it('ignores session-scoped detail plugin keys outside a session scope', () => {
    const core = new MakaClientSlotCore();
    core.register({ name: 'conversation.tool.detail', key: 'CustomTool' }, () => null);
    const unscoped = renderWithLocale(createElement(
      MakaClientSlotProvider, { core },
      createElement(ToolTrow, { items: [{ ...baseItem }] }),
    ));
    assertExpandable(parseHTML(unscoped).document, false);
    const scoped = renderWithLocale(createElement(
      MakaClientSlotProvider, { core },
      createElement(
        MakaClientSessionScope, { sessionId: 'session-1' },
        createElement(ToolTrow, { items: [{ ...baseItem }] }),
      ),
    ));
    assertExpandable(parseHTML(scoped).document, true);
  });

  it('renders summary code with text redaction, localization and actual line truncation', () => {
    const text = `summary body\nAuthorization: Bearer secret-token-value\nUser denied permission request\n${Array.from({ length: 510 }, (_, i) => `line ${i}`).join('\n')}`;
    for (const locale of UI_LOCALES) {
      const renderCode = (content: ToolResultContent) => {
        const markup = renderWithLocale(createElement(ToolResultPreview, { content }), locale);
        const code = parseHTML(markup).document.querySelector('code');
        assert.ok(code, 'the result uses a code block');
        return code.textContent;
      };
      const summary = renderCode(summaryResult(text));
      assert.equal(summary, renderCode({ kind: 'text', text }));
      assert.match(summary, /summary body/);
      const copy = getToolActivityCopy(locale);
      assert.ok(summary.includes(copy.permissionDenied));
      assert.ok(summary.includes(copy.result.hiddenLines(13)));
      assert.doesNotMatch(summary, /secret-token-value|hidden original|\[summary\]|line 509/);
    }
  });
});

it('updates the same row for live output and keyed plugin registration, disposal and abdication', async () => {
  const original = {
    document: globalThis.document, window: globalThis.window,
    Element: globalThis.Element, HTMLElement: globalThis.HTMLElement, Node: globalThis.Node,
    matchMedia: globalThis.matchMedia,
    requestAnimationFrame: globalThis.requestAnimationFrame,
    cancelAnimationFrame: globalThis.cancelAnimationFrame,
    IS_REACT_ACT_ENVIRONMENT: (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT,
  };
  const { document, window } = parseHTML('<div id="root"></div>');
  window.getComputedStyle = () => ({ getPropertyValue: () => '' }) as unknown as CSSStyleDeclaration;
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) as unknown as MediaQueryList;
  Object.assign(globalThis, {
    document, window, Element: window.Element, HTMLElement: window.HTMLElement, Node: window.Node,
    matchMedia: window.matchMedia, requestAnimationFrame: () => 1, cancelAnimationFrame() {},
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const container = document.querySelector('#root');
  assert.ok(container);
  const root = createRoot(container);
  const core = new MakaClientSlotCore();
  const render = (changes: Partial<ToolActivityItem>) => act(async () => root.render(
    <LocaleProvider locale="en">
      <MakaClientSlotProvider core={core}>
        <MakaClientSessionScope sessionId="session-1">
          <ToolTrow items={[{ ...baseItem, ...changes }]} />
        </MakaClientSessionScope>
      </MakaClientSlotProvider>
    </LocaleProvider>,
  ));
  try {
    await render({ status: 'running' });
    assertExpandable(container, false);
    await render({ status: 'running', outputChunks: [
      { seq: 1, stream: 'stdout', text: 'live output', redacted: false, createdAt: 1 },
    ] });
    assertExpandable(container, true);
    await act(async () => { toolRow(container).dispatchEvent(new window.Event('click', { bubbles: true })); });
    assert.match(container.textContent, /live output/);
    await render({ status: 'completed', result: summaryResult('visible summary') });
    assert.match(container.textContent, /visible summary/);
    assert.doesNotMatch(container.textContent, /hidden original|\[summary\]/);
    await render({});
    assertExpandable(container, false);
    await act(async () => { core.register({ name: 'conversation.tool.detail', key: 'OtherTool' }, () => <p>other plugin</p>); });
    assertExpandable(container, false);
    let dispose!: () => void;
    await act(async () => { dispose = core.register({ name: 'conversation.tool.detail', key: 'CustomTool' }, () => <p>matching plugin</p>); });
    assertExpandable(container, true);
    // Detail state is retained by Astryx; matching output appears as soon as
    // this already-open row gets a contribution.
    assert.match(container.textContent, /matching plugin/);
    assert.doesNotMatch(container.textContent, /other plugin/);
    await act(async () => dispose());
    assertExpandable(container, false);
    await act(async () => { core.register({ name: 'conversation.tool.detail', key: 'CustomTool' }, () => <p>active plugin</p>); });
    assertExpandable(container, true);
    const entry = core.activeEntries('conversation.tool.detail').find((candidate) => candidate.options.key === 'CustomTool');
    assert.ok(entry);
    await act(async () => core.abdicate('conversation.tool.detail', entry));
    assertExpandable(container, false);
  } finally {
    await act(() => root.unmount());
    Object.assign(globalThis, original);
  }
});
