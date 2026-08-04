import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { MenuItemConstructorOptions } from 'electron';
import {
  buildApplicationMenuTemplate,
  type ApplicationMenuCommand,
  type ApplicationMenuDeps,
} from '../application-menu.js';

function deps(overrides: Partial<ApplicationMenuDeps> = {}): ApplicationMenuDeps {
  return {
    platform: 'darwin',
    isPackaged: true,
    dispatch: () => {},
    ...overrides,
  };
}

type FlatItem = MenuItemConstructorOptions & { parentLabel?: string };

function flatten(template: ReturnType<typeof buildApplicationMenuTemplate>): FlatItem[] {
  const items: FlatItem[] = [];
  for (const item of template ?? []) {
    items.push(item);
    for (const sub of (item.submenu as MenuItemConstructorOptions[] | undefined) ?? []) {
      items.push({ ...sub, parentLabel: item.label });
    }
  }
  return items;
}

function invoke(item: FlatItem): void {
  item.click?.(undefined as never, undefined as never, undefined as never);
}

describe('application menu template', () => {
  it('returns null off macOS so Windows/Linux shell chrome is untouched', () => {
    assert.equal(buildApplicationMenuTemplate(deps({ platform: 'win32' })), null);
    assert.equal(buildApplicationMenuTemplate(deps({ platform: 'linux' })), null);
  });

  it('exposes New Task and Settings with the standard accelerators in a packaged build', () => {
    const items = flatten(buildApplicationMenuTemplate(deps()));
    const newTask = items.find((item) => item.accelerator === 'CmdOrCtrl+N');
    const settings = items.find((item) => item.accelerator === 'Command+,');
    assert.equal(newTask?.label, 'New Task');
    assert.equal(newTask?.parentLabel, 'File');
    assert.equal(settings?.label, 'Settings…');
    assert.equal(settings?.parentLabel, 'Maka');
  });

  it('keeps Reload and DevTools out of production menus', () => {
    const items = flatten(buildApplicationMenuTemplate(deps()));
    assert.equal(items.some((item) => item.role === 'reload'), false);
    assert.equal(items.some((item) => item.role === 'forceReload'), false);
    assert.equal(items.some((item) => item.role === 'toggleDevTools'), false);
    assert.equal(items.some((item) => item.role === 'quit'), true);
  });

  it('adds Reload and DevTools in development', () => {
    const items = flatten(buildApplicationMenuTemplate(deps({ isPackaged: false })));
    assert.equal(items.some((item) => item.role === 'reload'), true);
    assert.equal(items.some((item) => item.role === 'forceReload'), true);
    assert.equal(items.some((item) => item.role === 'toggleDevTools'), true);
  });

  it('keeps the standard Edit and Window roles for native behavior', () => {
    const items = flatten(buildApplicationMenuTemplate(deps()));
    assert.equal(items.some((item) => item.role === 'editMenu'), true);
    assert.equal(items.some((item) => item.role === 'windowMenu'), true);
    assert.equal(items.some((item) => item.role === 'close'), true);
    assert.equal(items.some((item) => item.role === 'hide'), true);
    assert.equal(items.some((item) => item.role === 'help'), true);
  });
});

describe('menu command dispatch', () => {
  it('routes each command through dispatch exactly once', () => {
    const dispatched: ApplicationMenuCommand[] = [];
    const items = flatten(
      buildApplicationMenuTemplate(deps({ dispatch: (command) => dispatched.push(command) })),
    );
    const newTask = items.find((item) => item.accelerator === 'CmdOrCtrl+N');
    const settings = items.find((item) => item.accelerator === 'Command+,');
    const help = items.find((item) => item.label === 'Keyboard Shortcuts');
    invoke(newTask!);
    invoke(settings!);
    invoke(help!);
    assert.deepEqual(dispatched, ['newTask', 'openSettings', 'openHelp']);
  });
});
