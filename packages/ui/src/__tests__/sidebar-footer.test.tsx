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

/**
 * The rail footer carries exactly two things: the Settings entry, and the
 * update reminder when the updater has something for the user to decide.
 * Build identity lives on the About page, not here.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { LocaleProvider } from '../locale-context.js';
import { SessionRailProvider, type SessionRailChrome } from '../session-rail-context.js';
import { SessionSidebarFooter } from '../session-sidebar-nav.js';

function renderFooter(
  updateReminder?: { state: 'downloaded' | 'error'; latestVersion: string },
): string {
  const chrome: SessionRailChrome = {
    collapsed: false,
    onCollapsedChange: () => undefined,
    width: 260,
    onWidthChange: () => undefined,
    minWidth: 180,
    maxWidth: 480,
    viewMode: 'conversation',
    selection: { section: 'sessions' },
    onSelect: () => undefined,
    onNew: () => undefined,
    onOpenSettings: () => undefined,
    onOpenUpdate: () => undefined,
    updateReminder,
  };
  return renderToStaticMarkup(
    <LocaleProvider locale="en">
      <SessionRailProvider data={{ sessions: [], groupVariant: 'conversation', onSelectSession: () => undefined }} chrome={chrome}>
        <SessionSidebarFooter />
      </SessionRailProvider>
    </LocaleProvider>,
  );
}

test('the settings row always renders', () => {
  const markup = renderFooter();
  assert.ok(markup.includes('Settings'), 'the footer carries the settings entry');
  assert.equal(markup.includes('maka-sidebar-update-button'), false, 'no reminder, no update button');
});

test('a downloaded update renders its action button', () => {
  const markup = renderFooter({ state: 'downloaded', latestVersion: '0.1.12' });
  assert.ok(markup.includes('maka-sidebar-update-button'));
});

test('a failed update renders its action button', () => {
  const markup = renderFooter({ state: 'error', latestVersion: '0.1.12' });
  assert.ok(markup.includes('maka-sidebar-update-button'));
});
