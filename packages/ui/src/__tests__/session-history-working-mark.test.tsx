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
import test from 'node:test';
import { parseHTML } from 'linkedom';
import { renderToStaticMarkup } from 'react-dom/server';
import type { SessionSummary } from '@maka/core/session';
import { LocaleProvider } from '../locale-context.js';
import { SessionHistoryList } from '../session-history-list.js';
import { SessionRailProvider, type SessionRailData } from '../session-rail-context.js';

function Rail(props: Partial<SessionRailData> & { sessions: readonly SessionSummary[] }) {
  const data: SessionRailData = {
    groupVariant: 'conversation',
    onSelectSession: () => undefined,
    ...props,
  };
  return (
    <LocaleProvider locale="en">
      <SessionRailProvider data={data}>
        <SessionHistoryList />
      </SessionRailProvider>
    </LocaleProvider>
  );
}

const session: SessionSummary = {
  id: 'session-1',
  name: 'Release notes',
  isFlagged: false,
  isArchived: false,
  labels: [],
  hasUnread: false,
  status: 'active',
  backend: 'ai-sdk',
  llmConnectionSlug: 'test-connection',
  connectionLocked: true,
  model: 'test-model',
  permissionMode: 'ask',
};

test('the responding row’s signal carries the working mark', () => {
  const dom = parseHTML(
    renderToStaticMarkup(
      <Rail sessions={[{ ...session, status: 'running', runningTurnIds: ['turn-1'] }]} />,
    ),
  );
  assert.equal(
    dom.document.querySelector('.maka-session-row-signal')?.getAttribute('data-working'),
    'true',
  );
});

test('a persisted running row keeps the working mark without live turns', () => {
  const dom = parseHTML(
    renderToStaticMarkup(<Rail sessions={[{ ...session, status: 'running' }]} />),
  );
  assert.equal(
    dom.document.querySelector('.maka-session-row-signal')?.getAttribute('data-working'),
    'true',
  );
});

test('a settled row carries no working mark', () => {
  const dom = parseHTML(renderToStaticMarkup(<Rail sessions={[session]} />));
  const signal = dom.document.querySelector('.maka-session-row-signal');
  assert.ok(signal, 'the signal gutter always renders');
  assert.equal(signal.getAttribute('data-working'), null);
});
