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
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import type {
  BrowserWindow,
  BrowserWindowConstructorOptions,
  MessageBoxReturnValue,
} from 'electron';
import { parseHTML } from 'linkedom';
import {
  type BrowserMessageBoxRuntime,
  buildBrowserMessageBoxHtml,
  centeredBounds,
  isBrowserMessageBoxPresentationActive,
  parseBrowserMessageBoxResponse,
  showBrowserMessageBoxWithRuntime,
} from '../browser-message-box.js';

test('falls back natively and never attaches to an inaccessible parent', async () => {
  const options = { message: 'Recover Maka' };
  const nativeResult = { response: 0, checkboxChecked: false };
  const parentState = { visible: false, minimized: false, destroyed: false };
  const parent = {
    isVisible: () => parentState.visible,
    isMinimized: () => parentState.minimized,
    isDestroyed: () => parentState.destroyed,
    getBounds: () => ({ x: 100, y: 100, width: 900, height: 700 }),
  } as BrowserWindow;
  const nativeParents: Array<BrowserWindow | undefined> = [];
  const runtimeBase = {
    shouldUseDarkColors: false,
    resolveWorkArea: () => ({ x: 0, y: 0, width: 1_200, height: 800 }),
    showNative: async (
      _options: typeof options,
      actualParent: BrowserWindow | undefined,
    ): Promise<MessageBoxReturnValue> => {
      nativeParents.push(actualParent);
      return nativeResult;
    },
    onBrowserError: () => assert.fail('native presentation must not report a browser error'),
  };

  parentState.visible = true;
  const failure = new Error('renderer failed');
  const failedWindow = fakeBrowserWindow({ loadError: failure });
  let reported: unknown;
  assert.equal(
    await showBrowserMessageBoxWithRuntime(options, parent, { locale: 'en' }, {
      ...runtimeBase,
      createWindow: (windowOptions) => {
        assert.equal(windowOptions.parent, parent);
        assert.equal(windowOptions.modal, true);
        parentState.minimized = true;
        failedWindow.options = windowOptions;
        return failedWindow.window;
      },
      onBrowserError: (error) => {
        reported = error;
      },
    }),
    nativeResult,
  );
  assert.equal(reported, failure);
  assert.deepEqual(nativeParents, [undefined]);
  assert.equal(failedWindow.destroyed(), true);
});

test('drives the BrowserWindow lifecycle through a safe response URL', async () => {
  const parent = {
    isVisible: () => true,
    isMinimized: () => true,
    isDestroyed: () => false,
  } as BrowserWindow;
  const presented = fakeBrowserWindow();
  let createdOptions: BrowserWindowConstructorOptions | undefined;

  const presentation = showBrowserMessageBoxWithRuntime(
    { message: 'Recover Maka', buttons: ['Recover', 'Cancel'], cancelId: 1 },
    parent,
    { locale: 'en', dark: true },
    {
      shouldUseDarkColors: false,
      createWindow: (options) => {
        createdOptions = options;
        return presented.window;
      },
      resolveWorkArea: (actualParent) => {
        assert.equal(actualParent, undefined);
        return { x: 0, y: 0, width: 1_200, height: 800 };
      },
      showNative: async () => assert.fail('successful browser presentation must not fall back'),
      onBrowserError: () => assert.fail('successful browser presentation must not report error'),
    },
  );
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(isBrowserMessageBoxPresentationActive(), true);
  assert.equal(createdOptions?.parent, undefined);
  assert.equal(createdOptions?.modal, undefined);
  assert.equal(presented.shown(), true);
  assert.equal(presented.focused(), true);
  assert.match(presented.loadedUrl(), /^data:text\/html/u);
  assert.equal(presented.deniesWindowOpen(), true);

  let prevented = false;
  presented.webContents.emit(
    'will-navigate',
    {
      preventDefault: () => {
        prevented = true;
      },
    },
    'maka-dialog://response/0',
  );
  assert.deepEqual(await presentation, { response: 0, checkboxChecked: false });
  assert.equal(prevented, true);
  assert.equal(presented.destroyed(), true);
  assert.equal(isBrowserMessageBoxPresentationActive(), false);
});

test('maps close to cancel and falls back after each BrowserWindow presentation failure', async () => {
  const closed = fakeBrowserWindow();
  const closeResult = showBrowserMessageBoxWithRuntime(
    { message: 'Recover Maka', buttons: ['Recover', 'Cancel'], cancelId: 1 },
    undefined,
    { locale: 'en' },
    runtimeForWindow(closed),
  );
  closed.window.emit('closed');
  assert.equal(isBrowserMessageBoxPresentationActive(), true);
  assert.deepEqual(await closeResult, { response: 1, checkboxChecked: false });
  assert.equal(closed.destroyed(), true);

  for (const scenario of ['unresponsive', 'renderer-gone', 'timeout'] as const) {
    const presented = fakeBrowserWindow({ pendingLoad: scenario === 'timeout' });
    const errors: unknown[] = [];
    const nativeResult = { response: 0, checkboxChecked: false };
    const result = showBrowserMessageBoxWithRuntime(
      { message: 'Recover Maka' },
      undefined,
      { locale: 'en' },
      runtimeForWindow(presented, {
        presentationTimeoutMs: scenario === 'timeout' ? 1 : undefined,
        onBrowserError: (error) => errors.push(error),
        nativeResult,
      }),
    );
    if (scenario === 'unresponsive') presented.window.emit('unresponsive');
    if (scenario === 'renderer-gone') {
      presented.webContents.emit('render-process-gone', {}, { reason: 'crashed' });
    }

    assert.equal(await result, nativeResult);
    assert.equal(errors.length, 1, scenario);
    assert.equal(presented.destroyed(), true, scenario);
    assert.equal(isBrowserMessageBoxPresentationActive(), false, scenario);
  }
});

test('accepts only an in-range response URL produced by the dialog', () => {
  assert.equal(parseBrowserMessageBoxResponse('maka-dialog://response/1', 3), 1);
  for (const value of [
    'https://response/1',
    'maka-dialog://other/1',
    'maka-dialog://user@response/1',
    'maka-dialog://response:123/1',
    'maka-dialog://response/01',
    'maka-dialog://response/1?',
    'maka-dialog://response/1#',
    'maka-dialog://response/1?again=true',
    'maka-dialog://response/3',
    'not a url',
  ]) {
    assert.equal(parseBrowserMessageBoxResponse(value, 3), undefined, value);
  }
});

test('centers against the parent while keeping the whole dialog on-screen', () => {
  assert.deepEqual(
    centeredBounds(
      { x: 900, y: 700, width: 200, height: 100 },
      { x: 0, y: 0, width: 1_000, height: 800 },
      520,
      300,
    ),
    { x: 480, y: 500, width: 520, height: 300 },
  );
  assert.deepEqual(
    centeredBounds(undefined, { x: -1_000, y: 40, width: 800, height: 600 }, 400, 280),
    { x: -800, y: 200, width: 400, height: 280 },
  );
});

test('renders escaped content with Maka dialog tokens and safe action ordering', () => {
  const html = buildBrowserMessageBoxHtml(
    {
      type: 'warning',
      title: '<img src=x onerror=alert(1)>',
      message: 'Maka & Runtime Host · /Users/示例',
      detail: '</div><script>globalThis.pwned = true</script>',
      buttons: ['Replace <Host>', 'Cancel', 'Copy & Diagnostics'],
      defaultId: 0,
      cancelId: 1,
    },
    { dark: true, locale: 'en', palette: 'nord' },
  );

  assert.match(html, /<html lang="en"/u);
  assert.match(html, /aria-label="Close"/u);
  assert.match(html, /data-theme="dark"/u);
  assert.match(html, /data-maka-theme="nord"/u);
  assert.match(html, /--surface-overlay:/u);
  assert.match(html, /--accent-solid:/u);
  assert.match(html, /--space-4:/u);
  assert.match(html, /color: var\(--maka-brand\)/u);
  assert.doesNotMatch(html, /--control-overlay-hover:/u);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/u);
  assert.match(html, /Maka &amp; Runtime Host/u);
  assert.match(html, /&lt;\/div&gt;&lt;script&gt;globalThis\.pwned = true&lt;\/script&gt;/u);
  assert.match(html, /Replace &lt;Host&gt;/u);
  assert.doesNotMatch(html, /<img src=x/u);
  assert.doesNotMatch(html, /<script>globalThis\.pwned/u);

  const cancelPosition = html.indexOf('>Cancel</button>');
  const copyPosition = html.indexOf('>Copy &amp; Diagnostics</button>');
  const actionPosition = html.indexOf('>Replace &lt;Host&gt;</button>');
  assert.ok(cancelPosition >= 0 && cancelPosition < copyPosition);
  assert.ok(copyPosition < actionPosition);
  assert.match(html, /data-response="0" autofocus/u);
  assert.match(html, /default-src 'none'/u);
});

test('routes button and keyboard decisions through the rendered interaction bridge', () => {
  const html = buildBrowserMessageBoxHtml(
    {
      message: 'Recover Maka',
      buttons: ['Recover', 'Cancel'],
      defaultId: 0,
      cancelId: 1,
    },
    { dark: false, locale: 'en' },
  );
  const { document, window } = parseHTML(html);
  const script = document.querySelector('script')?.textContent;
  assert.ok(script);
  const navigations: string[] = [];
  runInNewContext(script, {
    window: { location: { assign: (url: string) => navigations.push(url) } },
    document,
    Element: window.Element,
    HTMLButtonElement: window.HTMLButtonElement,
  });
  const dispatchKey = (key: string): void => {
    const event = new window.Event('keydown', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'key', { value: key });
    document.body.dispatchEvent(event);
  };

  document
    .querySelector('[data-response="0"]')
    ?.dispatchEvent(new window.Event('click', { bubbles: true, cancelable: true }));
  dispatchKey('Escape');
  dispatchKey('Enter');

  assert.deepEqual(navigations, [
    'maka-dialog://response/0',
    'maka-dialog://response/1',
    'maka-dialog://response/0',
  ]);
});

interface FakeBrowserWindow {
  readonly window: BrowserWindow;
  readonly webContents: EventEmitter;
  options?: BrowserWindowConstructorOptions;
  loadedUrl(): string;
  shown(): boolean;
  focused(): boolean;
  destroyed(): boolean;
  deniesWindowOpen(): boolean;
}

function fakeBrowserWindow(input: {
  readonly loadError?: Error;
  readonly pendingLoad?: boolean;
} = {}): FakeBrowserWindow {
  let loadedUrl = '';
  let shown = false;
  let focused = false;
  let destroyed = false;
  let deniesWindowOpen = false;
  const webContents = Object.assign(new EventEmitter(), {
    setWindowOpenHandler(handler: () => { action: string }) {
      deniesWindowOpen = handler().action === 'deny';
    },
    async executeJavaScript(script: string): Promise<number | undefined> {
      return script.includes('scrollHeight') ? 340 : undefined;
    },
  });
  const window = Object.assign(new EventEmitter(), {
    webContents,
    setMenuBarVisibility() {},
    loadURL(url: string): Promise<void> {
      loadedUrl = url;
      if (input.loadError) return Promise.reject(input.loadError);
      if (input.pendingLoad) return new Promise<void>(() => undefined);
      return Promise.resolve();
    },
    isDestroyed: () => destroyed,
    destroy: () => {
      destroyed = true;
    },
    setBounds() {},
    show: () => {
      shown = true;
    },
    focus: () => {
      focused = true;
    },
  }) as unknown as BrowserWindow;
  return {
    window,
    webContents,
    loadedUrl: () => loadedUrl,
    shown: () => shown,
    focused: () => focused,
    destroyed: () => destroyed,
    deniesWindowOpen: () => deniesWindowOpen,
  };
}

function runtimeForWindow(
  presented: FakeBrowserWindow,
  options: {
    readonly presentationTimeoutMs?: number;
    readonly onBrowserError?: (error: unknown) => void;
    readonly nativeResult?: MessageBoxReturnValue;
  } = {},
): BrowserMessageBoxRuntime {
  return {
    shouldUseDarkColors: false,
    createWindow: (windowOptions) => {
      presented.options = windowOptions;
      return presented.window;
    },
    resolveWorkArea: () => ({ x: 0, y: 0, width: 1_200, height: 800 }),
    showNative: async () =>
      options.nativeResult ?? assert.fail('successful browser presentation must not fall back'),
    onBrowserError:
      options.onBrowserError ??
      (() => assert.fail('successful browser presentation must not report an error')),
    ...(options.presentationTimeoutMs === undefined
      ? {}
      : { presentationTimeoutMs: options.presentationTimeoutMs }),
  };
}
