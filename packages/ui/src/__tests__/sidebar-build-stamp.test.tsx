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
 * The rail footer answers "which build is this?" — the question the About
 * page already answers two clicks away, which is why it was worth putting
 * where the user already looks.
 *
 * Both halves are asserted. A dev build and a release build render different
 * strings, and the stamp keeps its place when the update button appears: the
 * button is an action and takes the edge, the stamp is a label and must not
 * move under it.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { LocaleProvider } from '../locale-context.js';
import { SessionSidebarFooter, type SidebarBuildStamp } from '../session-sidebar-nav.js';

function renderFooter(
  buildStamp?: SidebarBuildStamp,
  updateReminder?: { state: 'downloaded' | 'error'; latestVersion: string },
): string {
  return renderToStaticMarkup(
    <LocaleProvider locale="en">
      <SessionSidebarFooter
        buildStamp={buildStamp}
        updateReminder={updateReminder}
        onOpenSettings={() => undefined}
        onOpenUpdate={() => undefined}
      />
    </LocaleProvider>,
  );
}

function stampText(markup: string): string | null {
  const match = /class="maka-sidebar-build-stamp"[^>]*>([^<]*)</.exec(markup);
  return match?.[1] ?? null;
}

test('a release build shows the version alone', () => {
  // `build-info.ts` returns `commit: null` once packaged — there is no `.git`
  // to read — so the version is the whole identity a release can offer.
  assert.equal(stampText(renderFooter({ version: '0.1.11', commit: null })), 'v0.1.11');
});

test('a dev build appends the short commit, which is what distinguishes two of them', () => {
  assert.equal(
    stampText(renderFooter({ version: '0.1.11', commit: '4d223d05beea1bfa' })),
    'v0.1.11 · 4d223d0',
  );
});

test('no stamp renders before the build info resolves', () => {
  // The value arrives over async IPC. Rendering a placeholder would put a
  // wrong version on screen for the time it takes to be replaced.
  assert.equal(stampText(renderFooter(undefined)), null);
});

test('the update button takes the edge and the stamp keeps its place', () => {
  const markup = renderFooter({ version: '0.1.11', commit: null }, {
    state: 'downloaded',
    latestVersion: '0.1.12',
  });
  const stampAt = markup.indexOf('maka-sidebar-build-stamp');
  const buttonAt = markup.indexOf('maka-sidebar-update-button');
  assert.ok(stampAt > 0, 'the stamp renders alongside an update reminder');
  assert.ok(buttonAt > 0, 'the update button still renders');
  // Order in the flex row is order in the markup: settings, stamp, button.
  assert.ok(stampAt < buttonAt, 'the stamp precedes the update button');
});
