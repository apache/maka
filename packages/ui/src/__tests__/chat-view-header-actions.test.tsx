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
import type { SessionSummary } from '@maka/core/session';
import { parseHTML } from 'linkedom';
import { ChatSurfaceLayout } from '../chat-surface-layout.js';
import { ChatView } from '../chat-view.js';
import { MakaClientSlotCore, MakaClientSlotProvider } from '../client-plugin-slots.js';
import { LocaleProvider } from '../locale-context.js';
import { renderTranscriptMarkup } from './transcript-test-dom.js';

test('ChatView renders registered header actions in its own session scope', async () => {
  const core = new MakaClientSlotCore();
  core.register({ name: 'conversation.header.actions', id: 'session-action' }, ({ sessionId, sessionName }) => (
    <button type="button">{sessionName}: {sessionId}</button>
  ));
  const activeSession = {
    id: 'session-1', name: 'Session', status: 'running', labels: [],
  } as unknown as SessionSummary;

  const markup = await renderTranscriptMarkup(
    <LocaleProvider locale="en">
      <MakaClientSlotProvider core={core}>
        <ChatSurfaceLayout composer={null}>
          <ChatView messages={[]} activeSession={activeSession} scrollBehavior="auto" onNew={() => undefined} />
        </ChatSurfaceLayout>
      </MakaClientSlotProvider>
    </LocaleProvider>,
  );
  const { document } = parseHTML(markup);
  const action = document.querySelector('[data-maka-client-slot="conversation.header.actions"] button');
  assert.ok(action, 'the registered header action is visible without an outer session scope');
  assert.equal(action.textContent, 'Session: session-1');
});
