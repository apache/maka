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
  assert.equal(document.querySelector('.maka-turn-footer-meta .maka-turn-processing'), null);
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
    assert.equal(document.querySelector('.maka-turn-processing'), null);
    assert.equal(document.querySelector('.maka-processing-summary')?.textContent, 'Execution process');
    assert.equal(document.querySelectorAll('.maka-turn-provider-retry').length, runningStatus ? 1 : 0);
  }
});

test('a provider queue suppresses the running cue and shows the queue position instead', () => {
  const turn: TurnViewModel = {
    turnId: 'turn-1', status: 'running', tools: [], notes: [], startedAt: 1,
    timeline: [{ kind: 'thinking', text: 'reasoning', messageId: 'thought' }],
  };
  const { document } = parseHTML(renderToStaticMarkup(
    <LocaleProvider locale="en">
      <TurnView turn={turn} liveStreaming={{ runningStatus: true, providerQueue: { position: 3 } }} />
    </LocaleProvider>,
  ));
  // Nothing arrives while the provider holds the request: the queue indicator
  // is the only processing cue, and the footer's running cue stays silent.
  // (Compared as counts and strings: inspecting a linkedom node on failure
  // never returns.)
  const cues = document.querySelectorAll('.maka-turn-processing');
  assert.equal(cues.length, 1);
  assert.equal(cues[0]?.getAttribute('aria-label'), 'Queued by Trae · Position 3');
  assert.equal(document.querySelectorAll('.maka-turn-footer-meta .maka-turn-processing').length, 0);
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
  assert.equal(document.querySelector('.maka-turn-footer-meta .maka-turn-processing'), null);
  const settled = parseHTML(renderToStaticMarkup(
    <LocaleProvider locale="en"><TurnView turn={{ ...turn, status: 'completed', durationMs: 213_000 }} /></LocaleProvider>,
  )).document;
  const settledSummaries = settled.querySelectorAll('.maka-processing-summary');
  assert.equal(settledSummaries[0]?.textContent, 'Execution process');
  assert.equal(settledSummaries[1]?.textContent, 'Worked for 3m 33s');
  assert.equal(settled.querySelector('.maka-turn-status-line')?.textContent, 'Done');
});

test('keeps elapsed and model metadata in the footer for a reply without process entries', () => {
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
  // The duration lives on the status line at the BOTTOM of the turn, where a
  // growing answer cannot push it out of view. The top summary states only what
  // the disclosure holds.
  assert.equal(document.querySelector('.maka-processing-summary')?.textContent?.trim(), 'Execution process');
  const statusLine = document.querySelector('.maka-turn-status-line')?.textContent ?? '';
  // Localized duration (the same wording the copy owns), not the compact
  // `3m 33s` the live counter uses.
  assert.match(statusLine, /Done · Worked for 3m 33s/);
  // This turn carries only the placeholder start (the fixture's `startedAt: 1`),
  // so no finish time is printed rather than dating it to 1970.
  assert.doesNotMatch(statusLine, /1970/);
  // The footer's meta row carries the turn's state AND the model facts on one
  // line, rather than the state taking a line of its own.
  assert.equal(
    document.querySelector('.maka-turn-footer-meta')?.textContent,
    'Done · Worked for 3m 33s · fixture-model',
  );
});
