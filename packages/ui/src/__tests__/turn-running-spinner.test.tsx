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
    partialOutputRetained: false,
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
  return document.querySelector('.maka-turn-processing .astryx-spinner') !== null;
}

test('hands the spinner to the turn status after the tool settles', () => {
  assert.equal(statusHasSpinner(['running']), false);
  assert.equal(statusHasSpinner(['completed']), true);
});

test('keeps the turn spinner when a collapsed group hides the running tool', () => {
  assert.equal(statusHasSpinner(['running', 'completed']), true);
});
