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
import { createDefaultSettings, mergeSettings } from '@maka/core/settings';
import { createComputerUseStatusItem } from '../computer-use/status-item.js';
import { createDesktopLocaleAuthority } from '../desktop-locale-authority.js';

type MenuTemplate = Array<{ label?: string }>;

test('rebuilds an active Computer Use menu when its resolved locale changes', () => {
  const locale = createDesktopLocaleAuthority({
    readSettings: async () => createDefaultSettings(),
    preferredSystemLanguages: () => ['en-US'],
  });
  const menus: MenuTemplate[] = [];
  const item = createComputerUseStatusItem({
    loadImage: () => ({}) as never,
    createTray: () => ({
      setIgnoreDoubleClickEvents: () => undefined,
      setContextMenu: (menu: unknown) => {
        menus.push((menu as { template: MenuTemplate }).template);
      },
      destroy: () => undefined,
    }) as never,
    buildMenu: (template) => ({ template }) as never,
    resolveLocale: () => locale.current(),
    subscribeLocaleChanges: (listener) => locale.subscribe(listener),
  });

  item.noteSessionActive('session-1');
  item.noteSessionApp('session-1', 'Safari');
  assert.deepEqual(menus.at(-1)?.map((row) => row.label), ['Stop Using Safari']);

  locale.observe(mergeSettings(createDefaultSettings(), {
    personalization: { uiLocale: 'zh' },
  }));
  assert.deepEqual(menus.at(-1)?.map((row) => row.label), ['停止操作 Safari']);

  item.destroy();
  locale.observe(mergeSettings(createDefaultSettings(), {
    personalization: { uiLocale: 'en' },
  }));
  assert.deepEqual(menus.at(-1)?.map((row) => row.label), ['停止操作 Safari']);
});
