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
 * The rail's new-task hint, which is where #3876 was reported from: the row
 * read `⌘ N` on Windows, where the key that creates a task is Ctrl N.
 *
 * Rendered through the real provider rather than calling the formatter again,
 * because the hint reaches this row through four components that know nothing
 * about the host OS — the context is the part worth covering.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { HostPlatformProvider } from '../host-platform-context.js';
import { LocaleProvider } from '../locale-context.js';
import { SessionSidebarNav } from '../session-sidebar-nav.js';

function renderRailHint(platform?: string): string | null {
  const markup = renderToStaticMarkup(
    <LocaleProvider locale="en">
      <HostPlatformProvider platform={platform}>
        <SessionSidebarNav
          selection={{ section: 'sessions' }}
          onSelect={() => undefined}
          onNew={() => undefined}
        />
      </HostPlatformProvider>
    </LocaleProvider>,
  );
  const match = /class="maka-nav-kbd"[^>]*>([^<]*)</.exec(markup);
  return match?.[1] ?? null;
}

test('the new-task hint names the key this platform actually uses', () => {
  assert.equal(renderRailHint('darwin'), '⌘ N');
  assert.equal(renderRailHint('win32'), 'Ctrl N');
  assert.equal(renderRailHint('linux'), 'Ctrl N');
});

test('the hint renders before the main process has named the platform', () => {
  // `app.info()` is async, and a row that renders nothing until it answers
  // would move the label when the hint appeared. Undefined resolves through
  // `navigator`, which under `renderToStaticMarkup` is not Apple.
  assert.equal(renderRailHint(undefined), 'Ctrl N');
});
