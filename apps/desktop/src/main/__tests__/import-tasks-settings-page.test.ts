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

import { strict as assert } from 'node:assert';
import { afterEach, describe, it } from 'node:test';
import { parseHTML } from 'linkedom';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { AstryxLocaleProvider, LocaleProvider } from '@maka/ui';
import type { DesktopRuntimeHostRef } from '../../preload/bridge-contract.js';
import type { DesktopExternalSessionCatalogItem } from '../../preload/external-session-catalog.js';
import { ImportTasksSettingsPage } from '../../renderer/settings/import-tasks-settings-page.js';
import { RuntimeHostSettingsTarget } from '../../renderer/settings/runtime-host-settings-target.js';

type CatalogResult = {
  sessions: DesktopExternalSessionCatalogItem[];
  nextCursor: string | null;
};

const originalGlobals = {
  document: globalThis.document,
  window: globalThis.window,
  matchMedia: globalThis.matchMedia,
  HTMLElement: globalThis.HTMLElement,
  HTMLIFrameElement: globalThis.HTMLIFrameElement,
  getComputedStyle: globalThis.getComputedStyle,
  requestAnimationFrame: globalThis.requestAnimationFrame,
  cancelAnimationFrame: globalThis.cancelAnimationFrame,
  IS_REACT_ACT_ENVIRONMENT: (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT,
};

const TEST_RUNTIME_HOST = {
  profileId: 'test-profile',
  hostId: 'test-host',
} satisfies DesktopRuntimeHostRef;

afterEach(() => {
  Object.assign(globalThis, originalGlobals);
});

describe('ImportTasksSettingsPage durable import state', () => {
  it('renders imported history and an entry to the newest imported task after remount', async () => {
    const opened: string[] = [];
    const harness = await renderPage({
      catalog: {
        sessions: [
          externalSession({
            importState: {
              importedCount: 2,
              importedSessionIds: ['session-newest', 'session-older'],
              isImporting: false,
            },
          }),
        ],
        nextCursor: null,
      },
      onOpenImported: (sessionId) => opened.push(sessionId),
    });

    assert.match(harness.container.textContent, /Imported 2 times/);
    const openButton = buttonWithText(harness.container, 'Open latest imported task');
    assert.ok(openButton);
    await act(async () => openButton.click());
    assert.deepEqual(opened, ['session-newest']);

    await act(async () => harness.root.unmount());
  });

  it('scopes catalog reads, recovery, and import to the selected Runtime Host', async () => {
    const source = externalSession();
    const harness = await renderPage({
      catalogs: [catalog(source), catalog(source)],
      importResult: { ok: false, reason: 'commit_outcome_unknown' },
    });

    const importButton = buttonWithText(harness.container, 'Import');
    assert.ok(importButton);
    await act(async () => {
      importButton.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    assert.deepEqual(harness.hostCalls(), [
      { operation: 'listSources', host: TEST_RUNTIME_HOST },
      { operation: 'list', host: TEST_RUNTIME_HOST },
      { operation: 'import', host: TEST_RUNTIME_HOST },
      { operation: 'list', host: TEST_RUNTIME_HOST },
    ]);

    await act(async () => harness.root.unmount());
  });

  it('uses catalog in-flight state after remount to disable the source row', async () => {
    const harness = await renderPage({
      catalog: {
        sessions: [
          externalSession({
            importState: {
              importedCount: 1,
              importedSessionIds: ['session-existing'],
              isImporting: true,
            },
          }),
        ],
        nextCursor: null,
      },
    });

    const importing = harness.container.querySelector<HTMLButtonElement>(
      'button[aria-label="Importing Investigate a flaky test"]',
    );
    assert.ok(importing);
    assert.equal(importing.hasAttribute('disabled'), true);
    assert.equal(importing.getAttribute('aria-busy'), 'true');

    await act(async () => harness.root.unmount());
  });

  it('renders durable repeat-import state in Chinese', async () => {
    const harness = await renderPage({
      locale: 'zh',
      catalog: catalog(
        externalSession({
          importState: {
            importedCount: 3,
            importedSessionIds: ['session-zh'],
            isImporting: false,
          },
        }),
      ),
    });

    assert.match(harness.container.textContent, /已导入 3 次/);
    assert.ok(buttonWithText(harness.container, '打开最近导入的任务'));
    assert.ok(buttonWithText(harness.container, '再次导入'));

    await act(async () => harness.root.unmount());
  });

  it('polls catalog-owned in-flight state until the imported task becomes durable', async (context) => {
    context.mock.timers.enable({ apis: ['setTimeout'] });
    const importing = externalSession({
      importState: { importedCount: 0, importedSessionIds: [], isImporting: true },
    });
    const imported = externalSession({
      importState: {
        importedCount: 1,
        importedSessionIds: ['session-landed'],
        isImporting: false,
      },
    });
    const harness = await renderPage({ catalogs: [catalog(importing), catalog(imported)] });

    assert.equal(harness.listCalls(), 1);
    await act(async () => {
      context.mock.timers.runAll();
      await Promise.resolve();
      await Promise.resolve();
    });

    assert.equal(harness.listCalls(), 2);
    assert.match(harness.container.textContent, /Imported once/);
    assert.equal(harness.container.querySelector('button[aria-busy="true"]'), null);

    await act(async () => harness.root.unmount());
  });

  it('polls the whole loaded page window without dropping a later-page import', async (context) => {
    context.mock.timers.enable({ apis: ['setTimeout'] });
    const firstPage = externalSession({ id: 'source-first', name: 'First page source' });
    const secondPageImporting = externalSession({
      id: 'source-second',
      name: 'Second page source',
      importState: { importedCount: 0, importedSessionIds: [], isImporting: true },
    });
    const secondPageImported = externalSession({
      id: 'source-second',
      name: 'Second page source',
      importState: {
        importedCount: 1,
        importedSessionIds: ['second-page-task'],
        isImporting: false,
      },
    });
    const harness = await renderPage({
      catalogs: [
        { sessions: [firstPage], nextCursor: '1' },
        { sessions: [secondPageImporting], nextCursor: null },
        { sessions: [firstPage], nextCursor: '1' },
        { sessions: [secondPageImported], nextCursor: null },
      ],
    });

    const loadMore = buttonWithText(harness.container, 'Load more');
    assert.ok(loadMore);
    await act(async () => {
      loadMore.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.match(harness.container.textContent, /Second page source/);

    await act(async () => {
      context.mock.timers.runAll();
      await Promise.resolve();
      await Promise.resolve();
    });

    assert.equal(harness.listCalls(), 4);
    assert.match(harness.container.textContent, /First page source/);
    assert.match(harness.container.textContent, /Second page source/);
    assert.match(harness.container.textContent, /Imported once/);

    await act(async () => harness.root.unmount());
  });

  it('re-reads the catalog after an unknown outcome and exposes the task that landed', async () => {
    const initial = externalSession();
    const recovered = externalSession({
      importState: {
        importedCount: 1,
        importedSessionIds: ['session-recovered'],
        isImporting: false,
      },
    });
    const opened: string[] = [];
    const harness = await renderPage({
      catalogs: [catalog(initial), catalog(recovered)],
      importResult: { ok: false, reason: 'commit_outcome_unknown' },
      onOpenImported: (sessionId) => opened.push(sessionId),
    });

    const importButton = buttonWithText(harness.container, 'Import');
    assert.ok(importButton);
    await act(async () => {
      importButton.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    assert.equal(harness.listCalls(), 2);
    assert.match(harness.container.textContent, /The imported task is available now/);
    const openButton = buttonWithText(harness.container, 'Open latest imported task');
    assert.ok(openButton);
    await act(async () => openButton.click());
    assert.deepEqual(opened, ['session-recovered']);

    await act(async () => harness.root.unmount());
  });

  it('clears a recovered import banner when the catalog selection changes', async () => {
    const initial = externalSession({ name: 'Current source conversation' });
    const recovered = externalSession({
      name: 'Current source conversation',
      importState: {
        importedCount: 1,
        importedSessionIds: ['session-recovered-before-filter'],
        isImporting: false,
      },
    });
    const filtered = externalSession({
      id: 'archived-source',
      name: 'Archived catalog conversation',
      archived: true,
    });
    const harness = await renderPage({
      catalogs: [catalog(initial), catalog(recovered), catalog(filtered)],
      importResult: { ok: false, reason: 'commit_outcome_unknown' },
    });

    const importButton = buttonWithText(harness.container, 'Import');
    assert.ok(importButton);
    await act(async () => {
      importButton.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.match(harness.container.textContent, /The imported task is available now/);

    const archivedFilter = harness.container.querySelector<HTMLInputElement>(
      'input[type="checkbox"]',
    );
    assert.ok(archivedFilter);
    await act(async () => {
      archivedFilter.checked = true;
      archivedFilter.dispatchEvent(new window.Event('click', { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });

    assert.match(harness.container.textContent, /Archived catalog conversation/);
    assert.doesNotMatch(harness.container.textContent, /The imported task is available now/);

    await act(async () => harness.root.unmount());
  });

  it('preserves the loaded page window when unknown-outcome recovery finds its source early', async () => {
    const firstPage = externalSession({ id: 'source-first', name: 'First page source' });
    const secondPage = externalSession({ id: 'source-second', name: 'Second page source' });
    const recoveredFirstPage = externalSession({
      id: 'source-first',
      name: 'First page source',
      importState: {
        importedCount: 1,
        importedSessionIds: ['first-page-task'],
        isImporting: false,
      },
    });
    const harness = await renderPage({
      catalogs: [
        { sessions: [firstPage], nextCursor: '1' },
        { sessions: [secondPage], nextCursor: null },
        { sessions: [recoveredFirstPage], nextCursor: '1' },
        { sessions: [secondPage], nextCursor: null },
      ],
      importResult: { ok: false, reason: 'commit_outcome_unknown' },
    });

    const loadMore = buttonWithText(harness.container, 'Load more');
    assert.ok(loadMore);
    await act(async () => {
      loadMore.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.match(harness.container.textContent, /Second page source/);

    const importButton = Array.from(harness.container.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.getAttribute('aria-label') === 'Import First page source',
    );
    assert.ok(importButton);
    await act(async () => {
      importButton.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    assert.equal(harness.listCalls(), 4);
    assert.match(harness.container.textContent, /First page source/);
    assert.match(harness.container.textContent, /Second page source/);
    assert.match(harness.container.textContent, /The imported task is available now/);

    await act(async () => harness.root.unmount());
  });

  it('allows a safe retry when recovery finds no new imported task', async () => {
    const source = externalSession({
      importState: {
        importedCount: 1,
        importedSessionIds: ['session-existing'],
        isImporting: false,
      },
    });
    const harness = await renderPage({
      catalogs: [catalog(source), catalog(source)],
      importResult: { ok: false, reason: 'commit_outcome_unknown' },
    });

    const firstImport = buttonWithText(harness.container, 'Import again');
    assert.ok(firstImport);
    await act(async () => {
      firstImport.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    assert.equal(harness.listCalls(), 2);
    assert.match(harness.container.textContent, /No new task was recorded, so it is safe to retry/);
    const retry = buttonWithText(harness.container, 'Import again');
    assert.ok(retry);
    assert.equal(retry.hasAttribute('disabled'), false);

    await act(async () => harness.root.unmount());
  });

  it('keeps the import uncertain when recovery can no longer find the source row', async () => {
    const harness = await renderPage({
      catalogs: [catalog(externalSession()), { sessions: [], nextCursor: null }],
      importResult: { ok: false, reason: 'commit_outcome_unknown' },
    });

    const importButton = buttonWithText(harness.container, 'Import');
    assert.ok(importButton);
    await act(async () => {
      importButton.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    assert.match(harness.container.textContent, /Check the import result/);
    assert.doesNotMatch(harness.container.textContent, /safe to retry/);

    await act(async () => harness.root.unmount());
  });

  it('does not let an older catalog poll overwrite unknown-outcome recovery', async (context) => {
    context.mock.timers.enable({ apis: ['setTimeout'] });
    let settlePoll: ((result: CatalogResult) => void) | undefined;
    const pendingPoll = new Promise<CatalogResult>((resolve) => {
      settlePoll = resolve;
    });
    const target = externalSession({ id: 'target-source', name: 'Target source' });
    const otherImporting = externalSession({
      id: 'other-source',
      name: 'Other source',
      importState: { importedCount: 0, importedSessionIds: [], isImporting: true },
    });
    const recoveredTarget = externalSession({
      id: 'target-source',
      name: 'Target source',
      importState: {
        importedCount: 1,
        importedSessionIds: ['target-task'],
        isImporting: false,
      },
    });
    const harness = await renderPage({
      catalogs: [
        { sessions: [target, otherImporting], nextCursor: null },
        pendingPoll,
        { sessions: [recoveredTarget, otherImporting], nextCursor: null },
      ],
      importResult: { ok: false, reason: 'commit_outcome_unknown' },
    });

    await act(async () => {
      context.mock.timers.runAll();
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.equal(harness.listCalls(), 2);

    const importButton = harness.container.querySelector<HTMLButtonElement>(
      'button[aria-label="Import Target source"]',
    );
    assert.ok(importButton);
    await act(async () => {
      importButton.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.match(harness.container.textContent, /The imported task is available now/);

    await act(async () => {
      settlePoll?.({ sessions: [target, otherImporting], nextCursor: null });
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.match(harness.container.textContent, /Imported once/);

    await act(async () => harness.root.unmount());
  });

  it('clears loading-more state when recovery retires the pending page request', async () => {
    let settleLoadMore: ((result: CatalogResult) => void) | undefined;
    const pendingLoadMore = new Promise<CatalogResult>((resolve) => {
      settleLoadMore = resolve;
    });
    const source = externalSession({ name: 'Visible source' });
    const recovered = externalSession({
      name: 'Visible source',
      importState: {
        importedCount: 1,
        importedSessionIds: ['visible-task'],
        isImporting: false,
      },
    });
    const harness = await renderPage({
      catalogs: [
        { sessions: [source], nextCursor: '1' },
        pendingLoadMore,
        { sessions: [recovered], nextCursor: '1' },
      ],
      importResult: { ok: false, reason: 'commit_outcome_unknown' },
    });

    const loadMore = buttonWithText(harness.container, 'Load more');
    assert.ok(loadMore);
    await act(async () => loadMore.click());

    const importButton = harness.container.querySelector<HTMLButtonElement>(
      'button[aria-label="Import Visible source"]',
    );
    assert.ok(importButton);
    await act(async () => {
      importButton.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.match(harness.container.textContent, /The imported task is available now/);

    await act(async () => {
      settleLoadMore?.({ sessions: [], nextCursor: null });
      await Promise.resolve();
      await Promise.resolve();
    });
    const recoveredLoadMore = Array.from(
      harness.container.querySelectorAll<HTMLButtonElement>('button'),
    ).find((button) => button.textContent?.includes('Load more'));
    assert.ok(recoveredLoadMore);
    assert.equal(recoveredLoadMore.getAttribute('aria-busy'), null);
    assert.equal(recoveredLoadMore.hasAttribute('disabled'), false);

    await act(async () => harness.root.unmount());
  });

  it('retries a failed unknown-outcome catalog recovery instead of leaving a local lock', async () => {
    const initial = externalSession();
    const recovered = externalSession({
      importState: {
        importedCount: 1,
        importedSessionIds: ['session-after-read-retry'],
        isImporting: false,
      },
    });
    const harness = await renderPage({
      catalogs: [catalog(initial), new Error('catalog temporarily unavailable'), catalog(recovered)],
      importResult: { ok: false, reason: 'commit_outcome_unknown' },
    });

    const importButton = buttonWithText(harness.container, 'Import');
    assert.ok(importButton);
    await act(async () => {
      importButton.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.equal(harness.listCalls(), 2);
    assert.match(harness.container.textContent, /Check the import result/);

    const retryRead = buttonWithText(harness.container, 'Retry');
    assert.ok(retryRead);
    await act(async () => {
      retryRead.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    assert.equal(harness.listCalls(), 3);
    assert.doesNotMatch(harness.container.textContent, /Check the import result/);
    assert.match(harness.container.textContent, /The imported task is available now/);

    await act(async () => harness.root.unmount());
  });

  it('does not replace a newer filter catalog while recovering an older import attempt', async () => {
    let settleImport: ((result: { ok: false; reason: 'commit_outcome_unknown' }) => void) | undefined;
    const importResult = new Promise<{ ok: false; reason: 'commit_outcome_unknown' }>((resolve) => {
      settleImport = resolve;
    });
    const initial = externalSession({ name: 'Original source conversation' });
    const filtered = externalSession({ id: 'archived-source', name: 'Current filtered catalog' });
    const recovered = externalSession({
      name: 'Original source conversation',
      importState: {
        importedCount: 1,
        importedSessionIds: ['session-from-original-filter'],
        isImporting: false,
      },
    });
    const harness = await renderPage({
      catalogs: [catalog(initial), catalog(filtered), catalog(recovered)],
      importResult,
    });

    const importButton = buttonWithText(harness.container, 'Import');
    assert.ok(importButton);
    await act(async () => importButton.click());

    const archivedFilter = harness.container.querySelector<HTMLInputElement>('input[type="checkbox"]');
    assert.ok(archivedFilter);
    await act(async () => {
      archivedFilter.checked = true;
      archivedFilter.dispatchEvent(new window.Event('click', { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.equal(harness.listCalls(), 2);
    assert.match(harness.container.textContent, /Current filtered catalog/);

    await act(async () => {
      settleImport?.({ ok: false, reason: 'commit_outcome_unknown' });
      await Promise.resolve();
      await Promise.resolve();
    });

    assert.deepEqual(harness.listInputs().map((input) => input.includeArchived), [false, true, false]);
    assert.match(harness.container.textContent, /Current filtered catalog/);
    assert.match(harness.container.textContent, /The imported task is available now/);

    await act(async () => harness.root.unmount());
  });
});

function externalSession(
  overrides: Partial<DesktopExternalSessionCatalogItem> = {},
): DesktopExternalSessionCatalogItem {
  return {
    id: 'codex-source-1',
    name: 'Investigate a flaky test',
    cwd: '/workspace/maka-agent',
    updatedAt: Date.now(),
    importState: { importedCount: 0, importedSessionIds: [], isImporting: false },
    ...overrides,
  };
}

async function renderPage(options: {
  catalog?: CatalogResult;
  catalogs?: Array<CatalogResult | Error | Promise<CatalogResult>>;
  importResult?:
    | { ok: false; reason: 'commit_outcome_unknown' }
    | Promise<{ ok: false; reason: 'commit_outcome_unknown' }>;
  onOpenImported?: (sessionId: string) => void;
  locale?: 'en' | 'zh';
}): Promise<{
  container: HTMLElement;
  root: Root;
  listCalls(): number;
  listInputs(): Array<{ includeArchived: boolean }>;
  hostCalls(): Array<{ operation: 'listSources' | 'list' | 'import'; host?: DesktopRuntimeHostRef }>;
}> {
  const { document, window } = parseHTML('<div id="root"></div>');
  const matchMedia = (media: string) => ({
    matches: false,
    media,
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent: () => false,
  });
  Object.assign(window, { matchMedia });
  Object.assign(globalThis, {
    document,
    window,
    matchMedia,
    HTMLElement: window.HTMLElement,
    HTMLIFrameElement: window.HTMLIFrameElement ?? class HTMLIFrameElement {},
    // Astryx 0.4 Spinner resolves its inherited canvas color during render.
    getComputedStyle: (element: Element) => ({
      color: (element as HTMLElement).style?.color || 'currentColor',
    }) as CSSStyleDeclaration,
    requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(callback, 0),
    cancelAnimationFrame: (handle: number) => clearTimeout(handle),
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  let listCalls = 0;
  const listInputs: Array<{ includeArchived: boolean }> = [];
  const hostCalls: Array<{
    operation: 'listSources' | 'list' | 'import';
    host?: DesktopRuntimeHostRef;
  }> = [];
  const catalogs = options.catalogs ?? [options.catalog ?? { sessions: [], nextCursor: null }];
  (window as unknown as { maka: unknown }).maka = {
    externalSessions: {
      listSources: async (host?: DesktopRuntimeHostRef) => {
        hostCalls.push({ operation: 'listSources', host });
        return { adapterIds: ['codex'] };
      },
      list: async (input: { includeArchived?: boolean }, host?: DesktopRuntimeHostRef) => {
        hostCalls.push({ operation: 'list', host });
        listInputs.push({ includeArchived: input.includeArchived === true });
        const result = catalogs[Math.min(listCalls++, catalogs.length - 1)];
        if (result instanceof Error) throw result;
        return result;
      },
      import: async (_input: unknown, host?: DesktopRuntimeHostRef) => {
        hostCalls.push({ operation: 'import', host });
        return options.importResult ?? Promise.reject(new Error('import is not used by this test'));
      },
    },
  };

  const container = document.querySelector<HTMLElement>('#root');
  assert.ok(container);
  const root = createRoot(container);
  await act(async () => {
    const pageProps = {
      onImported: () => undefined,
      onOpenImported: options.onOpenImported ?? (() => undefined),
    };
    const page = createElement(ImportTasksSettingsPage, pageProps);
    const targeted = createElement(RuntimeHostSettingsTarget, {
      host: TEST_RUNTIME_HOST,
      children: page,
    });
    const localized = createElement(AstryxLocaleProvider, { children: targeted });
    root.render(
      createElement(LocaleProvider, { locale: options.locale ?? 'en', children: localized }),
    );
    await Promise.resolve();
    await Promise.resolve();
  });
  return {
    container,
    root,
    listCalls: () => listCalls,
    listInputs: () => listInputs,
    hostCalls: () => hostCalls,
  };
}

function catalog(session: DesktopExternalSessionCatalogItem): CatalogResult {
  return { sessions: [session], nextCursor: null };
}

function buttonWithText(container: HTMLElement, text: string): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
    (button) => button.textContent === text,
  );
}
