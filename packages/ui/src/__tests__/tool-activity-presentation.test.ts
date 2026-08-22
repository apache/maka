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
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup as renderReactToStaticMarkup } from 'react-dom/server';
import { ToolCallDetail } from '../tool-activity.js';
import type { ToolActivityItem } from '../materialize.js';
import { LocaleProvider } from '../locale-context.js';

function renderToStaticMarkup(node: ReactNode, locale: 'zh' | 'en' = 'zh'): string {
  return renderReactToStaticMarkup(createElement(LocaleProvider, {
    locale,
    children: node,
  }));
}

describe('tool activity presentation', () => {
  it('contains a malformed persisted terminal result instead of crashing the renderer', () => {
    const malformed = {
      kind: 'terminal',
      cwd: '/tmp/maka',
      cmd: 'npm test',
      status: 'failed',
      exitCode: 1,
    } as unknown as NonNullable<ToolActivityItem['result']>;
    const markup = renderToStaticMarkup(createElement(ToolCallDetail, {
      item: {
        toolUseId: 'tool-malformed-terminal',
        toolName: 'Bash',
        status: 'errored',
        args: { command: 'npm test' },
        result: malformed,
      } satisfies ToolActivityItem,
    }));

    assert.match(markup, /npm test/);
    assert.match(markup, /终端输出不可用/);
    assert.doesNotMatch(markup, /失败 · 退出码|退出码 1/);
  });

  it('redacts secrets in sensitive values and property names', () => {
    const cases: Array<Record<string, unknown>> = [
      { password: 'correct-horse', token: 'short-secret' },
      { 'api_key=sk-1234567890abcdefghi': true },
      { 'Authorization: Bearer SENTINEL_TOKEN': true },
      { 'private key: gamma delta': true },
      { 'access token: alpha beta': true },
    ];
    for (const args of cases) {
      const markup = renderToStaticMarkup(createElement(ToolCallDetail, {
        item: {
          toolUseId: 'tool-secret',
          toolName: 'CustomInspect',
          status: 'running',
          args,
          result: { kind: 'json', value: { ok: true } },
        } satisfies ToolActivityItem,
      }));
      assert.doesNotMatch(
        markup,
        /correct-horse|short-secret|sk-1234567890abcdefghi|SENTINEL_TOKEN|gamma|delta|alpha|beta/,
      );
      assert.match(markup, /redacted/i);
    }
  });

  it('keeps pre-handoff live output when shell_run lands with empty streams', () => {
    const markup = renderToStaticMarkup(createElement(ToolCallDetail, {
      item: {
        toolUseId: 'tool-shell-run-empty',
        toolName: 'Bash',
        activityKind: 'command',
        status: 'running',
        args: { command: 'npm test' },
        outputChunks: [
          { seq: 1, stream: 'stdout', text: 'starting-live-output\n', redacted: true, createdAt: 1 },
        ],
        outputTruncated: true,
        result: {
          kind: 'shell_run',
          ref: 'maka://runtime/background-tasks/bg-empty',
          mode: 'pipes',
          status: 'running',
          cwd: '/repo',
          cmd: 'npm test',
          startedAt: 1,
          updatedAt: 2,
          revision: 1,
        },
      } satisfies ToolActivityItem,
    }));

    assert.match(markup, /starting-live-output/);
    assert.match(markup, /已脱敏/);
    assert.match(markup, /输出已截断/);
    assert.doesNotMatch(markup, /尚无输出/);
    const panels = markup.match(/data-slot="tool-output"/g) ?? [];
    assert.equal(panels.length, 1);
  });

  it('keeps redacted/truncated meta when live chunks are empty bodies', () => {
    const markup = renderToStaticMarkup(createElement(ToolCallDetail, {
      item: {
        toolUseId: 'tool-shell-run-empty-meta',
        toolName: 'Bash',
        activityKind: 'command',
        status: 'running',
        args: { command: 'npm test' },
        outputChunks: [
          { seq: 1, stream: 'stdout', text: '', redacted: true, createdAt: 1 },
        ],
        outputTruncated: true,
        result: {
          kind: 'shell_run',
          ref: 'maka://runtime/background-tasks/bg-meta',
          mode: 'pipes',
          status: 'running',
          cwd: '/repo',
          cmd: 'npm test',
          startedAt: 1,
          updatedAt: 2,
          revision: 1,
        },
      } satisfies ToolActivityItem,
    }));

    assert.match(markup, /已脱敏/);
    assert.match(markup, /输出已截断/);
    const panels = markup.match(/data-slot="tool-output"/g) ?? [];
    assert.equal(panels.length, 1);
  });

  it('keeps provider call ids out of output action names', () => {
    const render = (toolUseId: string) =>
      renderToStaticMarkup(createElement(ToolCallDetail, {
        item: {
          toolUseId,
          toolName: 'Bash',
          status: 'running',
          args: { command: 'npm test' },
          outputChunks: [
            { seq: 1, stream: 'stdout', text: 'running\n', redacted: false, createdAt: 1 },
          ],
        } satisfies ToolActivityItem,
      }));
    const firstId = 'provider-call-first-12345678';
    const secondId = 'provider-call-second-12345678';

    assert.doesNotMatch(render(firstId), new RegExp(firstId));
    assert.doesNotMatch(render(secondId), new RegExp(secondId));
    assert.match(render(firstId), /Bash/);
  });

  it('disambiguates code copy actions by their tool call', () => {
    const details = createElement('div', null,
      createElement(ToolCallDetail, {
        item: {
          toolUseId: 'tool-alpha',
          toolName: 'AlphaTool',
          status: 'completed',
          args: {},
          result: { kind: 'json', value: { ok: true } },
        } satisfies ToolActivityItem,
      }),
      createElement(ToolCallDetail, {
        item: {
          toolUseId: 'tool-beta',
          toolName: 'BetaTool',
          status: 'completed',
          args: {},
          result: { kind: 'json', value: { ok: true } },
        } satisfies ToolActivityItem,
      }),
    );
    const zhMarkup = renderToStaticMarkup(details);
    const enMarkup = renderToStaticMarkup(details, 'en');

    assert.match(zhMarkup, /aria-label="复制：AlphaTool"/);
    assert.match(zhMarkup, /aria-label="复制：BetaTool"/);
    assert.match(enMarkup, /aria-label="Copy: AlphaTool"/);
    assert.match(enMarkup, /aria-label="Copy: BetaTool"/);
  });
});
