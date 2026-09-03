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

describe('ImportTasksSettingsPage source switching', () => {
  const LOADING = /Reading external conversations/;

  it('shows the reading spinner the first time a source is opened', async () => {
    let settle: ((r: CatalogResult) => void) | undefined;
    const pending = new Promise<CatalogResult>((resolve) => {
      settle = resolve;
    });
    const harness = await renderPage({
      adapterIds: ['codex', 'claude-code'],
      bySource: {
        codex: [catalog(externalSession({ id: 's-codex', name: 'Codex conv' }))],
        'claude-code': [pending],
      },
    });

    assert.match(harness.container.textContent, /Codex conv/, 'codex loads on mount');
    assert.doesNotMatch(harness.container.textContent, LOADING, 'no spinner once codex is loaded');

    const cc = segment(harness.container, 'claude-code');
    assert.ok(cc, 'claude-code segment renders');
    await act(async () => {
      cc.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    // First visit to claude-code: nothing cached, so the blank + spinner shows.
    assert.match(harness.container.textContent, LOADING, 'first-time load shows the spinner');
    assert.doesNotMatch(harness.container.textContent, /Codex conv/, 'codex rows are cleared');

    await act(async () => {
      settle?.(catalog(externalSession({ id: 's-cc', name: 'CC conv' })));
      await Promise.resolve();
      await Promise.resolve();
    });

    assert.match(harness.container.textContent, /CC conv/, 'claude-code rows arrive');
    assert.doesNotMatch(harness.container.textContent, LOADING, 'spinner clears when loaded');

    await act(async () => harness.root.unmount());
  });

  it('shows a previously-loaded source instantly with no spinner, then refreshes in place', async () => {
    let settleRevisit: ((r: CatalogResult) => void) | undefined;
    const revisitRefresh = new Promise<CatalogResult>((resolve) => {
      settleRevisit = resolve;
    });
    const harness = await renderPage({
      adapterIds: ['codex', 'claude-code'],
      bySource: {
        // [initial load, background refresh on revisit]
        codex: [catalog(externalSession({ id: 's-codex', name: 'Codex conv' })), revisitRefresh],
        'claude-code': [catalog(externalSession({ id: 's-cc', name: 'CC conv' }))],
      },
    });

    assert.match(harness.container.textContent, /Codex conv/);

    await act(async () => {
      segment(harness.container, 'claude-code')!.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.match(harness.container.textContent, /CC conv/, 'claude-code loaded');

    // Revisit codex: cached rows appear immediately with no blanking spinner
    // (the background refresh is still pending here).
    await act(async () => {
      segment(harness.container, 'codex')!.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.match(harness.container.textContent, /Codex conv/, 'cached codex rows shown instantly');
    assert.doesNotMatch(harness.container.textContent, LOADING, 'no spinner on revisit');

    await act(async () => {
      settleRevisit?.(catalog(externalSession({ id: 's-codex', name: 'Codex conv refreshed' })));
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.match(harness.container.textContent, /Codex conv refreshed/, 'background refresh lands');
    assert.doesNotMatch(harness.container.textContent, LOADING, 'still no spinner after refresh');

    await act(async () => harness.root.unmount());
  });

  it('does not let a stale background refresh overwrite a newer source selection', async () => {
    let settleStaleCodexRefresh: ((r: CatalogResult) => void) | undefined;
    const staleCodexRefresh = new Promise<CatalogResult>((resolve) => {
      settleStaleCodexRefresh = resolve;
    });
    const harness = await renderPage({
      adapterIds: ['codex', 'claude-code'],
      bySource: {
        codex: [catalog(externalSession({ id: 's-codex', name: 'Codex conv' })), staleCodexRefresh],
        'claude-code': [
          catalog(externalSession({ id: 's-cc', name: 'CC conv' })),
          catalog(externalSession({ id: 's-cc', name: 'CC conv' })),
        ],
      },
    });

    await act(async () => {
      segment(harness.container, 'claude-code')!.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.match(harness.container.textContent, /CC conv/);

    // Revisit codex (cache hit → background refresh left pending)...
    await act(async () => {
      segment(harness.container, 'codex')!.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    // ...then switch straight back to claude-code before that refresh resolves.
    await act(async () => {
      segment(harness.container, 'claude-code')!.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.match(harness.container.textContent, /CC conv/, 'claude-code is the current source');

    await act(async () => {
      settleStaleCodexRefresh?.(
        catalog(externalSession({ id: 's-codex', name: 'Stale codex conv' })),
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    assert.match(harness.container.textContent, /CC conv/, 'claude-code rows remain');
    assert.doesNotMatch(
      harness.container.textContent,
      /Stale codex conv/,
      'the superseded codex refresh never lands under claude-code',
    );

    await act(async () => harness.root.unmount());
  });

  it('drops an in-flight import poll after switching source, with no stuck spinner', async (context) => {
    context.mock.timers.enable({ apis: ['setTimeout'] });
    let settleStalePoll: ((r: CatalogResult) => void) | undefined;
    const stalePoll = new Promise<CatalogResult>((resolve) => {
      settleStalePoll = resolve;
    });
    const importing = externalSession({
      id: 's-codex',
      name: 'Codex conv',
      importState: { importedCount: 0, importedSessionIds: [], isImporting: true },
    });
    const harness = await renderPage({
      adapterIds: ['codex', 'claude-code'],
      bySource: {
        // [initial load with an import in flight, background poll read left pending]
        codex: [{ sessions: [importing], nextCursor: null }, stalePoll],
        'claude-code': [catalog(externalSession({ id: 's-cc', name: 'CC conv' }))],
      },
    });
    assert.match(harness.container.textContent, /Codex conv/);

    // The importing row schedules a poll; fire it so refreshLoadedCatalog is in
    // flight against the pending read.
    await act(async () => {
      context.mock.timers.runAll();
      await Promise.resolve();
      await Promise.resolve();
    });

    // Switch to claude-code while the codex poll is still in flight.
    await act(async () => {
      segment(harness.container, 'claude-code')!.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.match(harness.container.textContent, /CC conv/, 'claude-code loaded');
    assert.doesNotMatch(harness.container.textContent, LOADING, 'no stuck reading spinner');

    // The stale codex poll resolves last — it must not overwrite claude-code.
    await act(async () => {
      settleStalePoll?.({
        sessions: [externalSession({ id: 's-codex', name: 'Codex conv refreshed' })],
        nextCursor: null,
      });
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.match(harness.container.textContent, /CC conv/, 'still showing claude-code');
    assert.doesNotMatch(
      harness.container.textContent,
      /Codex conv refreshed/,
      'stale poll result is dropped',
    );
    assert.doesNotMatch(harness.container.textContent, LOADING, 'still no spinner');

    await act(async () => harness.root.unmount());
  });

  it('clears the reading spinner when a pending search returns to a cached term', async (context) => {
    context.mock.timers.enable({ apis: ['setTimeout'] });
    // The uncached search never resolves, so its spinner generation stays in
    // flight; the return-to-'' refresh never resolves either, so only the
    // cache-hit path — not a completed refresh — can retire the spinner.
    const pendingSearch = new Promise<CatalogResult>(() => {});
    const refreshPending = new Promise<CatalogResult>(() => {});
    const harness = await renderPage({
      // [initial '' load, uncached 'zzz' search, background refresh on return to '']
      catalogs: [
        catalog(externalSession({ id: 's-codex', name: 'Codex conv' })),
        pendingSearch,
        refreshPending,
      ],
    });
    assert.match(harness.container.textContent, /Codex conv/, 'initial load shows rows');

    // Type an uncached term (the source and archived controls disable during a
    // load, but the search box does not, so this is the reachable way to leave a
    // request pending). It blanks to the spinner and never resolves.
    await act(async () => {
      setSearchInput(harness.container, 'zzz');
      await Promise.resolve();
    });
    // Fire the 250ms debounce only after the effect above has registered it.
    await act(async () => {
      context.mock.timers.runAll();
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.match(harness.container.textContent, LOADING, 'uncached search shows the spinner');

    // Return the search to the already-loaded empty term. The cached rows must
    // come back with no spinner even though the older 'zzz' load is still
    // pending and this hit's own refresh has not landed — the cache hit has to
    // clear the stranded loading state itself.
    await act(async () => {
      setSearchInput(harness.container, '');
      await Promise.resolve();
    });
    await act(async () => {
      context.mock.timers.runAll();
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.match(harness.container.textContent, /Codex conv/, 'cached rows shown instantly');
    assert.doesNotMatch(
      harness.container.textContent,
      LOADING,
      'the stranded search spinner is cleared on the cache hit',
    );

    await act(async () => harness.root.unmount());
  });

  it('clears a pending Load More lock when switching back to a cached source', async () => {
    // Both revisit refreshes and the Load More append are left pending, so the
    // only thing that can release the Load More lock is the cache-hit reset.
    const codexRefreshPending = new Promise<CatalogResult>(() => {});
    const codexLoadMorePending = new Promise<CatalogResult>(() => {});
    const claudeCodeRefreshPending = new Promise<CatalogResult>(() => {});
    const harness = await renderPage({
      adapterIds: ['codex', 'claude-code'],
      bySource: {
        // [initial load (paged), revisit refresh, Load More append]
        codex: [
          { sessions: [externalSession({ id: 's-codex', name: 'Codex conv' })], nextCursor: 'c1' },
          codexRefreshPending,
          codexLoadMorePending,
        ],
        // [initial load (paged), revisit refresh]
        'claude-code': [
          { sessions: [externalSession({ id: 's-cc', name: 'CC conv' })], nextCursor: 'cc1' },
          claudeCodeRefreshPending,
        ],
      },
    });

    // Load claude-code so it is cached with its own paged Load More.
    await act(async () => {
      segment(harness.container, 'claude-code')!.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.match(harness.container.textContent, /CC conv/, 'claude-code loaded');

    // Revisit codex (cache hit; background refresh left pending), then start a
    // Load More whose append never resolves so `loadingMore` stays set.
    await act(async () => {
      segment(harness.container, 'codex')!.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    const codexLoadMore = buttonWithText(harness.container, 'Load more');
    assert.ok(codexLoadMore, 'codex Load More renders');
    await act(async () => {
      codexLoadMore.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    const busyLoadMore = Array.from(
      harness.container.querySelectorAll<HTMLButtonElement>('button'),
    ).find((button) => button.textContent?.includes('Loading…'));
    assert.ok(busyLoadMore, 'Load More shows the pending label while the append is in flight');

    // Switch back to the cached claude-code before that append resolves. Its
    // Load More must not inherit the stranded lock from codex's pending append.
    await act(async () => {
      segment(harness.container, 'claude-code')!.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.match(harness.container.textContent, /CC conv/, 'cached claude-code rows shown');
    const cachedLoadMore = buttonWithText(harness.container, 'Load more');
    assert.ok(cachedLoadMore, "claude-code's Load More is released, not stuck on 'Loading…'");
    assert.equal(cachedLoadMore.hasAttribute('disabled'), false, 'Load More is enabled again');

    await act(async () => harness.root.unmount());
  });

  it('keeps every loaded page when a revisited multi-page source refreshes', async () => {
    const harness = await renderPage({
      adapterIds: ['codex', 'claude-code'],
      bySource: {
        // [page 1, page 2 via Load More, refresh page 1, refresh page 2]
        codex: [
          {
            sessions: [externalSession({ id: 's-codex-1', name: 'Codex page one' })],
            nextCursor: 'codex-cursor-1',
          },
          { sessions: [externalSession({ id: 's-codex-2', name: 'Codex page two' })], nextCursor: null },
          {
            sessions: [externalSession({ id: 's-codex-1', name: 'Codex page one' })],
            nextCursor: 'codex-cursor-1',
          },
          { sessions: [externalSession({ id: 's-codex-2', name: 'Codex page two' })], nextCursor: null },
        ],
        'claude-code': [catalog(externalSession({ id: 's-cc', name: 'CC conv' }))],
      },
    });

    // Page in the second page of codex via Load More.
    const loadMore = buttonWithText(harness.container, 'Load more');
    assert.ok(loadMore, 'codex has a second page to load');
    await act(async () => {
      loadMore.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.match(harness.container.textContent, /Codex page one/);
    assert.match(harness.container.textContent, /Codex page two/, 'both pages are loaded');

    // Switch away to claude-code, then back to codex.
    await act(async () => {
      segment(harness.container, 'claude-code')!.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.match(harness.container.textContent, /CC conv/);

    await act(async () => {
      segment(harness.container, 'codex')!.click();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    // The cache hit shows both pages instantly; the background refresh must
    // re-read the *whole* loaded window rather than shrink the list back to the
    // first page.
    assert.match(harness.container.textContent, /Codex page one/, 'first page kept');
    assert.match(
      harness.container.textContent,
      /Codex page two/,
      'the second page survives the background refresh',
    );
    // codex page 1 + Load More + refresh page 1 + refresh page 2, plus the one
    // claude-code load = 5. A first-page-only refresh would stop at 4.
    assert.equal(harness.listCalls(), 5, 'the revisit refresh re-read every loaded page');

    await act(async () => harness.root.unmount());
  });

  it('does not start a second catalog read when revisiting a still-importing source', async (context) => {
    context.mock.timers.enable({ apis: ['setTimeout'] });
    const importing = externalSession({
      id: 's-codex',
      name: 'Codex conv',
      importState: { importedCount: 0, importedSessionIds: [], isImporting: true },
    });
    const harness = await renderPage({
      adapterIds: ['codex', 'claude-code'],
      bySource: {
        codex: [{ sessions: [importing], nextCursor: null }],
        'claude-code': [catalog(externalSession({ id: 's-cc', name: 'CC conv' }))],
      },
    });
    assert.match(harness.container.textContent, /Codex conv/);
    assert.equal(harness.listCalls(), 1, 'codex loaded once on mount');

    // Load claude-code (now cached), then return to the still-importing codex.
    await act(async () => {
      segment(harness.container, 'claude-code')!.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.equal(harness.listCalls(), 2, 'claude-code loaded');

    await act(async () => {
      segment(harness.container, 'codex')!.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    // The cache hit shows the importing rows again, but must NOT kick off its own
    // background readCatalogWindow: the 1s import poll is the single refresher for
    // an importing selection, and a second concurrent read shares the same request
    // generation and can land a stale pre-import page on top of a newer poll
    // result (the timer is deliberately left un-fired here).
    assert.match(harness.container.textContent, /Codex conv/, 'cached codex rows shown');
    assert.equal(
      harness.listCalls(),
      2,
      'revisiting an importing source starts no second catalog read',
    );

    await act(async () => harness.root.unmount());
  });

  it('updates the cache for a recovered import even after switching away', async () => {
    let settleImport: ((r: { ok: false; reason: 'commit_outcome_unknown' }) => void) | undefined;
    const importResult = new Promise<{ ok: false; reason: 'commit_outcome_unknown' }>((resolve) => {
      settleImport = resolve;
    });
    const codexRecovered = externalSession({
      id: 's-codex',
      name: 'Codex conv',
      importState: { importedCount: 1, importedSessionIds: ['codex-task'], isImporting: false },
    });
    // The revisit's background refresh never resolves, so the returned view is the
    // cache alone — proving the cache itself holds the recovered state.
    const codexRevisitPending = new Promise<CatalogResult>(() => {});
    const harness = await renderPage({
      adapterIds: ['codex', 'claude-code'],
      bySource: {
        // [mount, recovery readCatalogWindow, revisit background refresh]
        codex: [
          { sessions: [externalSession({ id: 's-codex', name: 'Codex conv' })], nextCursor: null },
          { sessions: [codexRecovered], nextCursor: null },
          codexRevisitPending,
        ],
        'claude-code': [catalog(externalSession({ id: 's-cc', name: 'CC conv' }))],
      },
      importResult,
    });

    // Start an import on codex, then switch to claude-code before the (unknown)
    // outcome resolves.
    const importButton = harness.container.querySelector<HTMLButtonElement>(
      'button[aria-label="Import Codex conv"]',
    );
    assert.ok(importButton);
    await act(async () => importButton.click());

    await act(async () => {
      segment(harness.container, 'claude-code')!.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.match(harness.container.textContent, /CC conv/);

    // The import comes back unknown; recovery confirms it landed while codex is not
    // the current selection.
    await act(async () => {
      settleImport?.({ ok: false, reason: 'commit_outcome_unknown' });
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.match(harness.container.textContent, /The imported task is available now/);
    assert.match(harness.container.textContent, /CC conv/, 'the current view is untouched by recovery');

    // Returning to codex must show the recovered "imported" state straight from
    // the cache — not the stale pre-import row that would invite a duplicate
    // import — even though the background refresh has not landed.
    await act(async () => {
      segment(harness.container, 'codex')!.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.match(harness.container.textContent, /Codex conv/);
    assert.match(
      harness.container.textContent,
      /Imported once/,
      'the cache reflects the recovered import on return',
    );

    await act(async () => harness.root.unmount());
  });

  it('publishes a recovered import to the current view after leaving and returning to its source', async () => {
    let settleImport: ((r: { ok: false; reason: 'commit_outcome_unknown' }) => void) | undefined;
    const importResult = new Promise<{ ok: false; reason: 'commit_outcome_unknown' }>((resolve) => {
      settleImport = resolve;
    });
    const codexRecovered = externalSession({
      id: 's-codex',
      name: 'Codex conv',
      importState: { importedCount: 1, importedSessionIds: ['codex-task'], isImporting: false },
    });
    // The revisit's own background refresh never resolves, so recovery is the only
    // thing that can update the screen — proving recovery publishes rather than
    // leaving the view to wait on a slow refresh.
    const codexRevisitPending = new Promise<CatalogResult>(() => {});
    const harness = await renderPage({
      adapterIds: ['codex', 'claude-code'],
      bySource: {
        // [mount, revisit background refresh (pending), recovery readCatalogWindow]
        codex: [
          { sessions: [externalSession({ id: 's-codex', name: 'Codex conv' })], nextCursor: null },
          codexRevisitPending,
          { sessions: [codexRecovered], nextCursor: null },
        ],
        'claude-code': [catalog(externalSession({ id: 's-cc', name: 'CC conv' }))],
      },
      importResult,
    });

    const importButton = harness.container.querySelector<HTMLButtonElement>(
      'button[aria-label="Import Codex conv"]',
    );
    assert.ok(importButton);
    await act(async () => importButton.click());

    // Switch to claude-code, then back to codex — all before the import resolves.
    await act(async () => {
      segment(harness.container, 'claude-code')!.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      segment(harness.container, 'codex')!.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.match(harness.container.textContent, /Codex conv/, 'back on codex, pre-import rows shown');
    assert.doesNotMatch(harness.container.textContent, /Imported once/, 'not recovered yet');

    // Recovery lands. codex is the current selection again, but at a *newer*
    // generation than when the import started, so a generation check would refuse
    // to publish. Matching the selection tuple, recovery must still reach the
    // screen — not just the cache — even though the revisit refresh is pending.
    await act(async () => {
      settleImport?.({ ok: false, reason: 'commit_outcome_unknown' });
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.match(harness.container.textContent, /The imported task is available now/);
    assert.match(
      harness.container.textContent,
      /Imported once/,
      'recovery publishes to the returned-to view, not only the cache',
    );

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
  // Multi-source tests: `listSources` reports these, and `list` draws per-source
  // queues from `bySource` (keyed by adapterId) instead of the flat `catalogs`.
  adapterIds?: string[];
  bySource?: Record<string, Array<CatalogResult | Error | Promise<CatalogResult>>>;
  importResult?:
    | { ok: false; reason: 'commit_outcome_unknown' }
    | Promise<{ ok: false; reason: 'commit_outcome_unknown' }>;
  /**
   * Per-source answers for a batch: `ok` lands, `unknown` is the Host not
   * answering, `throw` is a rejection. Keyed by source session id, because a
   * batch is exactly the case where the ids must not share one answer.
   */
  importBySource?: Record<string, 'ok' | 'unknown' | 'throw'>;
  onOpenImported?: (sessionId: string) => void;
  locale?: 'en' | 'zh';
}): Promise<{
  container: HTMLElement;
  root: Root;
  listCalls(): number;
  listInputs(): Array<{ includeArchived: boolean }>;
  hostCalls(): Array<{ operation: 'listSources' | 'list' | 'import'; host?: DesktopRuntimeHostRef }>;
  /** Source ids handed to `import`, in the order the batch walked them. */
  importedIds(): string[];
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
  const importedIds: string[] = [];
  const listInputs: Array<{ includeArchived: boolean }> = [];
  const hostCalls: Array<{
    operation: 'listSources' | 'list' | 'import';
    host?: DesktopRuntimeHostRef;
  }> = [];
  const catalogs = options.catalogs ?? [options.catalog ?? { sessions: [], nextCursor: null }];
  const sourceCounts: Record<string, number> = {};
  (window as unknown as { maka: unknown }).maka = {
    externalSessions: {
      listSources: async (host?: DesktopRuntimeHostRef) => {
        hostCalls.push({ operation: 'listSources', host });
        return { adapterIds: options.adapterIds ?? ['codex'] };
      },
      list: async (
        input: { includeArchived?: boolean; adapterId: string },
        host?: DesktopRuntimeHostRef,
      ) => {
        hostCalls.push({ operation: 'list', host });
        listInputs.push({ includeArchived: input.includeArchived === true });
        listCalls++;
        if (options.bySource) {
          const queue = options.bySource[input.adapterId] ?? [{ sessions: [], nextCursor: null }];
          const index = Math.min(sourceCounts[input.adapterId] ?? 0, queue.length - 1);
          sourceCounts[input.adapterId] = (sourceCounts[input.adapterId] ?? 0) + 1;
          const perSource = queue[index];
          if (perSource instanceof Error) throw perSource;
          return perSource;
        }
        const result = catalogs[Math.min(listCalls - 1, catalogs.length - 1)];
        if (result instanceof Error) throw result;
        return result;
      },
      import: async (input: unknown, host?: DesktopRuntimeHostRef) => {
        hostCalls.push({ operation: 'import', host });
        const sourceSessionId = (input as { sourceSessionId?: string }).sourceSessionId ?? '';
        importedIds.push(sourceSessionId);
        const perSource = options.importBySource?.[sourceSessionId];
        if (perSource === 'throw') throw new Error(`import-failed:${sourceSessionId}`);
        if (perSource === 'unknown') return { ok: false, reason: 'commit_outcome_unknown' };
        if (perSource === 'ok') {
          return { ok: true, session: { id: `imported-${sourceSessionId}` } };
        }
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
    importedIds: () => importedIds,
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

// Drives the search TextInput the way goal-dialog.test does: set the value and
// invoke the React onChange the renderer wired to it, so `searchDraft` updates
// without a real input event. The caller fires the debounce timer afterward.
function setSearchInput(container: HTMLElement, value: string): void {
  const input = Array.from(container.querySelectorAll<HTMLInputElement>('input')).find(
    (element) => element.type !== 'checkbox' && element.type !== 'radio',
  );
  assert.ok(input, 'search input renders');
  input.value = value;
  const propsKey = Object.keys(input).find((key) => key.startsWith('__reactProps$'));
  assert.ok(propsKey, 'missing React props on the search input');
  const props = (input as unknown as Record<string, unknown>)[propsKey] as {
    onChange?: (event: { target: HTMLInputElement; defaultPrevented: boolean }) => void;
  };
  assert.ok(props.onChange, 'missing search change handler');
  props.onChange({ target: input, defaultPrevented: false });
}

function segment(container: HTMLElement, value: string): HTMLButtonElement | undefined {
  return Array.from(
    container.querySelectorAll<HTMLButtonElement>('button[role="radio"]'),
  ).find((button) => button.getAttribute('data-value') === value);
}

/**
 * Selecting several conversations and importing them in one go.
 *
 * The page is a directory you pick from, so the checkboxes are always there —
 * there is no mode to enter. What these cases pin is the accounting: a batch
 * that reports one number for four different outcomes is worse than no batch.
 */
describe('ImportTasksSettingsPage batch import', () => {
  function rows(container: HTMLElement): HTMLInputElement[] {
    return Array.from(container.querySelectorAll<HTMLInputElement>('li input[type="checkbox"]'));
  }

  function masterBox(container: HTMLElement): HTMLInputElement {
    const box = container.querySelector<HTMLInputElement>(
      '.maka-import-selection-bar input[type="checkbox"]',
    );
    assert.ok(box, 'master checkbox renders');
    return box;
  }

  async function tick(box: HTMLInputElement, checked: boolean): Promise<void> {
    // React's checkbox onChange is driven by the native click, and its value
    // tracker swallows a programmatic `.checked` write without one.
    await act(async () => {
      box.checked = checked;
      box.dispatchEvent(new (globalThis.window as unknown as { Event: typeof Event }).Event('click', {
        bubbles: true,
        cancelable: true,
      }));
      await Promise.resolve();
    });
  }

  it('the master box marks and unmarks exactly the rows on screen', async () => {
    const { container } = await renderPage({
      catalog: {
        sessions: [
          externalSession({ id: 'a', name: 'A' }),
          externalSession({ id: 'b', name: 'B' }),
        ],
        nextCursor: null,
      },
    });

    assert.equal(rows(container).length, 2);
    await tick(masterBox(container), true);
    assert.deepEqual(rows(container).map((box) => box.checked), [true, true]);
    assert.match(container.textContent ?? '', /2 \/ 2 selected/);

    await tick(masterBox(container), false);
    assert.deepEqual(rows(container).map((box) => box.checked), [false, false]);
    assert.match(container.textContent ?? '', /0 \/ 2 selected/);
  });

  it('the master box reads indeterminate for a partial selection', async () => {
    // The usual state during a selection, and the one a checked/unchecked pair
    // cannot express.
    const { container } = await renderPage({
      catalog: {
        sessions: [externalSession({ id: 'a' }), externalSession({ id: 'b' })],
        nextCursor: null,
      },
    });

    await tick(rows(container)[0]!, true);
    assert.equal(masterBox(container).indeterminate, true);
    await tick(rows(container)[1]!, true);
    assert.equal(masterBox(container).indeterminate, false);
    assert.equal(masterBox(container).checked, true);
  });

  it('imports the marked rows one at a time and counts each outcome once', async () => {
    // Sequential on purpose: recovery re-reads the catalog window an attempt
    // came from, so overlapping attempts would race that read, and a progress
    // count is only true when one thing is happening.
    const { container, importedIds } = await renderPage({
      catalog: {
        sessions: [
          externalSession({ id: 'fresh', name: 'Fresh' }),
          externalSession({
            id: 'again',
            name: 'Again',
            importState: { importedCount: 1, importedSessionIds: ['prior'], isImporting: false },
          }),
          externalSession({ id: 'broken', name: 'Broken' }),
        ],
        nextCursor: null,
      },
      importBySource: { fresh: 'ok', again: 'ok', broken: 'throw' },
    });

    await tick(masterBox(container), true);
    const run = buttonWithText(container, 'Import selected');
    assert.ok(run, 'the batch button renders');
    await act(async () => {
      run.click();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    assert.deepEqual(importedIds(), ['fresh', 'again', 'broken']);
    const text = container.textContent ?? '';
    // Two imported, and the summary says one of them now exists twice —
    // re-importing is how a conversation is refreshed, but a user who marked
    // three and reads "imported 2" deserves to know which kind they were.
    assert.match(text, /Imported 2 conversations/);
    assert.match(text, /1 of them had been imported before/);
    // One rejection does not become the batch's answer for the rows after it.
    assert.match(text, /1 more could not be imported/);
  });

  it('a Host that does not answer is not counted as a failure', async () => {
    // Only a catalog read settles whether an unanswered conversion landed.
    // Calling it a failure is what invites the retry that makes a second copy.
    const { container } = await renderPage({
      catalog: { sessions: [externalSession({ id: 'quiet' })], nextCursor: null },
      importBySource: { quiet: 'unknown' },
    });

    await tick(masterBox(container), true);
    const run = buttonWithText(container, 'Import selected');
    assert.ok(run);
    await act(async () => {
      run.click();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    const text = container.textContent ?? '';
    assert.match(text, /No conversation was imported/);
    assert.doesNotMatch(text, /could not be imported/);
    // It surfaces through the unconfirmed banner, which owns the retry.
    assert.match(text, /unconfirmed|Unconfirmed|outcome/i);
  });

  it('spins only the conversion in flight, not every queued row', async () => {
    // A spinner claims something is happening now. Marking every selected row
    // would put one on rows the batch has not reached, and on rows it already
    // finished.
    let releaseFirst: ((value: { ok: false; reason: 'commit_outcome_unknown' }) => void) | undefined;
    const { container } = await renderPage({
      catalog: {
        sessions: [externalSession({ id: 'a', name: 'A' }), externalSession({ id: 'b', name: 'B' })],
        nextCursor: null,
      },
      // The first conversion parks until released, so the assertion lands while
      // exactly one row is converting and the other is queued.
      importResult: new Promise((resolve) => {
        releaseFirst = resolve;
      }),
    });

    await tick(masterBox(container), true);
    const run = buttonWithText(container, 'Import selected');
    assert.ok(run);
    await act(async () => {
      run.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    const spinning = Array.from(container.querySelectorAll('li')).map((row) =>
      row.textContent?.includes('Importing') === true || !!row.querySelector('[aria-busy="true"]'),
    );
    assert.equal(spinning.filter(Boolean).length, 1, 'exactly one row reads as converting');

    await act(async () => {
      releaseFirst?.({ ok: false, reason: 'commit_outcome_unknown' });
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
  });

  it('the batch button stays out of reach until something is marked', async () => {
    const { container } = await renderPage({
      catalog: { sessions: [externalSession({ id: 'a' })], nextCursor: null },
    });

    const run = buttonWithText(container, 'Import selected');
    assert.ok(run);
    assert.equal(run.disabled, true);
    await tick(rows(container)[0]!, true);
    assert.equal(buttonWithText(container, 'Import selected')?.disabled, false);
  });
});
