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
