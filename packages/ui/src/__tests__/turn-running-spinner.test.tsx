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
import { renderToStaticMarkup } from 'react-dom/server';
import { parseHTML } from 'linkedom';
import { TurnView } from '../chat-turn.js';
import { LocaleProvider } from '../locale-context.js';
import type { TurnViewModel } from '../materialize.js';

function statusHasSpinner(toolStatuses: readonly ('running' | 'completed')[]): boolean {
  const tools = toolStatuses.map((status, index) => ({
    toolUseId: `tool-${index + 1}`,
    toolName: 'Bash',
    status,
    args: {},
  } as const));
  const turn: TurnViewModel = {
    turnId: 'turn-1',
    status: 'running',
    tools,
    notes: [],
    startedAt: 1,
    timeline: [{ kind: 'tools', items: tools }],
  };
  const markup = renderToStaticMarkup(
    <LocaleProvider locale="en">
      <TurnView turn={turn} liveStreaming={{ runningStatus: true }} />
    </LocaleProvider>,
  );
  const { document } = parseHTML(markup);
  assert.equal(document.querySelectorAll('.maka-turn-processing').length, 1);
  assert.ok(document.querySelector('.maka-processing-summary .maka-turn-processing'));
  assert.equal(document.querySelector('.maka-turn-footer .maka-turn-processing'), null);
  assert.doesNotMatch(markup, /Waiting for model output/);
  return document.querySelector('.maka-turn-processing .astryx-spinner') !== null;
}

function runningStatusText(locale: 'en' | 'zh-CN'): string {
  const turn: TurnViewModel = {
    turnId: 'turn-1',
    status: 'running',
    tools: [],
    notes: [],
    startedAt: 1,
    timeline: [],
  };
  const markup = renderToStaticMarkup(
    <LocaleProvider locale={locale}>
      <TurnView turn={turn} liveStreaming={{ runningStatus: true }} />
    </LocaleProvider>,
  );
  return parseHTML(markup).document.querySelector('.maka-turn-processing')?.textContent ?? '';
}

test('keeps the process header spinner-free across tool settlement and grouping', () => {
  assert.equal(statusHasSpinner(['running']), false);
  assert.equal(statusHasSpinner(['completed']), false);
  assert.equal(statusHasSpinner(['running', 'completed']), false);
});

test('keeps a working cue before any process content arrives', () => {
  assert.equal(runningStatusText('zh-CN'), '正在琢磨…');
  assert.equal(runningStatusText('en'), 'Pondering…');
});

test('user input and provider retry suppress playful process activity', () => {
  const turn: TurnViewModel = {
    turnId: 'turn-1', status: 'running', tools: [], notes: [], startedAt: 1,
    timeline: [{ kind: 'thinking', text: 'reasoning', messageId: 'thought' }],
  };
  for (const runningStatus of [false, true]) {
    const markup = renderToStaticMarkup(
      <LocaleProvider locale="en">
        <TurnView turn={turn} liveStreaming={{ runningStatus, ...(runningStatus ? {
          providerRetry: { receivedAtMs: 1, event: {
            id: 'retry', type: 'provider_retry', turnId: 'turn-1', ts: 1,
            phase: 'scheduled', reason: 'network', attempt: 1, maxAttempts: 3,
            delayMs: 1000,
          } },
        } : {}) }} />
      </LocaleProvider>,
    );
    const { document } = parseHTML(markup);
    // The playful cue is suppressed either way; the status row states what is
    // actually happening instead — a wait for retry, or an idle in-progress.
    assert.equal(document.querySelector('.maka-turn-processing'), null);
    assert.equal(
      document.querySelector('.maka-processing-summary')?.textContent,
      runningStatus ? 'Waiting to retry (1/3)' : 'Working…',
    );
    assert.equal(document.querySelectorAll('.maka-turn-provider-retry').length, runningStatus ? 1 : 0);
  }
});

test('only the latest assistant segment owns live activity after a user instruction', () => {
  const tool = { toolUseId: 'read', toolName: 'Read', status: 'completed' as const, args: {} };
  const instruction = { id: 'steer', role: 'user' as const, text: 'Also check the keyboard', ts: 2 };
  const turn: TurnViewModel = {
    turnId: 'turn-1', status: 'running', tools: [tool], notes: [], startedAt: 1,
    timeline: [
      { kind: 'tools', items: [tool] },
      { kind: 'user', messageId: instruction.id, message: instruction },
      { kind: 'thinking', text: 'checking keyboard behavior', messageId: 'thought' },
    ],
  };
  const { document } = parseHTML(renderToStaticMarkup(
    <LocaleProvider locale="en"><TurnView turn={turn} liveStreaming={{ runningStatus: true }} /></LocaleProvider>,
  ));
  const summaries = document.querySelectorAll('.maka-processing-summary');
  assert.equal(summaries.length, 2);
  assert.equal(summaries[0]?.textContent, 'Execution process');
  assert.equal(summaries[1]?.textContent, 'Pondering…');
  assert.equal(document.querySelectorAll('.maka-turn-processing').length, 1);
  assert.equal(document.querySelector('.maka-turn-footer .maka-turn-processing'), null);
  const settled = parseHTML(renderToStaticMarkup(
    <LocaleProvider locale="en"><TurnView turn={{ ...turn, status: 'completed', durationMs: 213_000 }} /></LocaleProvider>,
  )).document;
  const settledSummaries = settled.querySelectorAll('.maka-processing-summary');
  assert.equal(settledSummaries[0]?.textContent, 'Execution process');
  // The turn's last disclosure carries the status row as its summary: the
  // outcome word and the duration in one place.
  assert.equal(settledSummaries[1]?.textContent, 'Done · Worked for 3m 33s');
  assert.equal(
    settled.querySelector('.maka-turn-statusbar')?.getAttribute('data-turn-status'),
    'completed',
  );
});

test('shows the outcome in the status row and model facts in the footer for a reply without process entries', () => {
  const turn: TurnViewModel = {
    turnId: 'turn-1', status: 'completed', modelId: 'fixture-model', tools: [], notes: [], startedAt: 1,
    durationMs: 213_000,
    timeline: [{ kind: 'text', messageId: 'answer', text: 'the answer' }],
  };
  const { document } = parseHTML(renderToStaticMarkup(
    <LocaleProvider locale="en">
      <TurnView turn={turn} footerActions={[{ id: 'copy', label: 'Copy', enabled: true }]} />
    </LocaleProvider>,
  ));
  // No work log: the status row stands alone at the top of the answer rather
  // than heading an empty disclosure.
  assert.equal(document.querySelector('.maka-processing-sequence'), null);
  const statusbar = document.querySelector('.maka-turn-statusbar');
  assert.ok(statusbar);
  assert.equal(statusbar.getAttribute('data-turn-status'), 'completed');
  // Localized duration (the same wording the copy owns), not the compact
  // `3m 33s` the live counter uses.
  assert.equal(statusbar.textContent, 'Done · Worked for 3m 33s');
  // The footer keeps only the reference facts: the model name, no state.
  const footer = document.querySelector('.maka-turn-footer');
  assert.match(footer?.textContent ?? '', /fixture-model/);
  assert.doesNotMatch(footer?.textContent ?? '', /Done|Worked for/);
  // This turn carries only the placeholder start (the fixture's `startedAt: 1`),
  // so no finish time is rendered rather than dating it to 1970.
  assert.equal(footer?.querySelector('time'), null);
});
