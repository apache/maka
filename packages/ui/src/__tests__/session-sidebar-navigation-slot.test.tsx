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
import { renderToStaticMarkup } from 'react-dom/server';
import {
  MakaClientSlotCore,
  MakaClientSlotProvider,
} from '../client-plugin-slots.js';
import { LocaleProvider } from '../locale-context.js';
import { SessionRailProvider, type SessionRailChrome } from '../session-rail-context.js';
import { SessionSidebarNav } from '../session-sidebar-nav.js';

test('sidebar navigation plugins render between New Task and WorkHub', () => {
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
    workHubEntry: { active: false, label: 'WorkHub', onSelect: () => undefined },
  };
  const slots = new MakaClientSlotCore();
  slots.register(
    { name: 'sidebar.navigation', id: 'fixture-long-task' },
    ({ collapsed }) => <span data-collapsed={collapsed}>PLUGIN NAV</span>,
  );

  const markup = renderToStaticMarkup(
    <LocaleProvider locale="en">
      <SessionRailProvider
        data={{ sessions: [], groupVariant: 'conversation', onSelectSession: () => undefined }}
        chrome={chrome}
      >
        <MakaClientSlotProvider core={slots}>
          <SessionSidebarNav />
        </MakaClientSlotProvider>
      </SessionRailProvider>
    </LocaleProvider>,
  );

  const newTask = markup.indexOf('New task');
  const pluginItem = markup.indexOf('PLUGIN NAV');
  const workHub = markup.indexOf('WorkHub');
  assert.ok(newTask >= 0 && pluginItem > newTask && workHub > pluginItem, markup);
  assert.match(markup, /data-collapsed="false"/u);
});
