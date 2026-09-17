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
import { act, createElement } from 'react';
import { parseHTML } from 'linkedom';
import type { UiLocale } from '@maka/core/ui-locale';
import { buildCommandList } from '../../renderer/command-palette-commands.js';
import { getSettingsNavigationCopy } from '../../renderer/locales/settings-navigation-copy.js';
import { getShellCopy } from '../../renderer/locales/shell-copy.js';
import { SETTINGS_NAV } from '../../renderer/settings/settings-nav.js';

for (const locale of ['en', 'zh-CN', 'zh-TW'] as const) {
  for (const scope of ['settings', 'aliases'] as const) {
    test(`${locale} palette searches ${scope} through the production search source`, async () => {
      const previous = Object.getOwnPropertyDescriptors(globalThis);
      const { document, window } = parseHTML(
        '<!doctype html><html><body><div id="root"></div></body></html>',
      );
      document.oninput = null;
      window.scrollTo = () => {};
      window.getComputedStyle = () =>
        ({
          direction: 'ltr',
          writingMode: 'horizontal-tb',
          getPropertyValue: () => '',
        }) as unknown as CSSStyleDeclaration;
      Object.assign(window.HTMLElement.prototype, {
        showModal(this: HTMLElement) {
          this.setAttribute('open', '');
        },
        close(this: HTMLElement) {
          this.removeAttribute('open');
        },
        scrollIntoView() {},
      });
      const globals = {
        document,
        window,
        HTMLElement: window.HTMLElement,
        matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
        requestAnimationFrame: () => 1,
        cancelAnimationFrame() {},
        CSS: { supports: () => false, escape: (value: string) => value },
        IS_REACT_ACT_ENVIRONMENT: true,
      };
      Object.assign(globalThis, globals);
      const { createRoot } = await import('react-dom/client');
      const { LocaleProvider } = await import('@maka/ui');
      const { CommandPalette, OverlaysRoot, OverlaysServicesProvider } = await import(
        '../../renderer/features/overlays/index.js'
      );
      const { createFakeOverlaysServices } = await import(
        '../../renderer/features/overlays/testing.js'
      );
      const noop = () => {};
      const commands = buildCommandList({
        locale,
        activeSessionId: 'session-1',
        themePref: 'auto',
        connections: [],
        defaultSlug: null,
        onNewChat: noop,
        onOpenSideChat: noop,
        onOpenSettings: noop,
        onOpenSettingsSection: noop,
        onOpenShortcuts: noop,
        onSetTheme: noop,
        onSelectModule: noop,
      });
      const root = createRoot(document.getElementById('root')!);
      let overlays: import('../../renderer/features/overlays/testing.js').OverlaysShellProjection;
      const search = async (query: string, label?: string) => {
        await act(async () => {
          const input = document.querySelector<HTMLInputElement>('input')!;
          Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(
            input,
            query,
          );
          input.dispatchEvent(new window.Event('input', { bubbles: true }));
        });
        const labels = [...document.querySelectorAll('.maka-palette-label')].map(
          (node) => node.textContent,
        );
        if (label === undefined) {
          assert.deepEqual(labels, []);
          return;
        }
        assert.ok(
          labels.includes(label),
          `${locale}: ${JSON.stringify(query)} must find ${JSON.stringify(label)}, got ${JSON.stringify(labels)}`,
        );
      };
      try {
        await act(async () => {
          root.render(
            createElement(LocaleProvider, {
              locale,
              children: createElement(OverlaysServicesProvider, {
                services: createFakeOverlaysServices(),
                children: createElement(OverlaysRoot, {
                  children: (projection) => {
                    overlays = projection;
                    return createElement(CommandPalette, { commands });
                  },
                }),
              }),
            }),
          );
        });
        await act(async () => {
          overlays.commands.openPalette();
        });
        const sections = getSettingsNavigationCopy(locale).sections;
        const palette = getShellCopy(locale).commandPalette;
        if (scope === 'settings') {
          for (const { id } of SETTINGS_NAV) {
            const label = sections[id].label;
            await search(label, palette.settingsCommand(label));
          }
          await search('bot-chat', palette.settingsCommand(sections['bot-chat'].label));
          if (locale === 'zh-TW')
            await search('設定', palette.settingsCommand(sections.general.label));
        }
        const aliases: Record<UiLocale, readonly string[]> = {
          en: ['side', 'btw'],
          'zh-CN': ['侧聊', '追问'],
          'zh-TW': ['側聊', '追問', '侧聊', 'btw'],
        };
        if (scope === 'aliases') {
          for (const alias of aliases[locale])
            await search(alias, palette.commands['action:side-chat'].label);
          await search(
            locale === 'zh-TW' ? '偏好' : locale === 'zh-CN' ? '设置' : 'preferences',
            palette.commands['action:open-settings'].label,
          );
          await search(
            locale === 'zh-TW' ? '會話' : locale === 'zh-CN' ? '会话' : 'chats',
            palette.commands['nav:sessions'].label,
          );
        }
        await search('no-such-command-5377');
      } finally {
        await act(async () => {
          root.unmount();
        });
        for (const key of Object.keys(globals)) {
          const descriptor = previous[key];
          if (descriptor) Object.defineProperty(globalThis, key, descriptor);
          else Reflect.deleteProperty(globalThis, key);
        }
      }
    });
  }
}
