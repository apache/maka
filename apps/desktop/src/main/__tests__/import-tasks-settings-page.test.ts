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
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { AstryxLocaleProvider, LocaleProvider, ToastProvider } from '@maka/ui';
import type { DesktopRuntimeHostRef } from '../../preload/bridge-contract.js';
import type { DesktopExternalSessionCatalogItem } from '../../preload/external-session-catalog.js';
import type { ExternalSessionImportIpcResult } from '../../preload/external-session-import-result.js';
import {
  SessionBundleServicesProvider,
  SessionBundleTasks,
} from '../../renderer/features/session-bundle/index.js';
import { createSessionCatalogController } from '../../renderer/application/contracts/session-catalog/session-catalog-state.js';
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

  it('scopes catalog reads and import to the selected Runtime Host', async () => {
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

  it('shows an actionable banner and does not re-read the catalog when no model is usable', async () => {
    const harness = await renderPage({
      catalog: catalog(externalSession()),
      importResult: { ok: false, reason: 'no_model' },
    });

    const importButton = buttonWithText(harness.container, 'Import');
    assert.ok(importButton);
    await act(async () => {
      importButton.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    assert.match(harness.container.textContent, /No usable model connection/);
    // A clean model failure is not a maybe-landed task: no extra catalog read, and
    // none of the unknown-outcome copy.
    assert.doesNotMatch(harness.container.textContent, /Check the import result/);
    assert.deepEqual(harness.hostCalls(), [
      { operation: 'listSources', host: TEST_RUNTIME_HOST },
      { operation: 'list', host: TEST_RUNTIME_HOST },
      { operation: 'import', host: TEST_RUNTIME_HOST },
    ]);

    await act(async () => harness.root.unmount());
  });

  it('shows a source-unreadable banner when the conversation cannot be converted', async () => {
    const harness = await renderPage({
      catalog: catalog(externalSession()),
      importResult: { ok: false, reason: 'source_unreadable' },
    });

    const importButton = buttonWithText(harness.container, 'Import');
    assert.ok(importButton);
    await act(async () => {
      importButton.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    assert.match(harness.container.textContent, /could not be read or converted/);

    await act(async () => harness.root.unmount());
  });

  for (const [locale, label, expected] of [
    ['en', 'Import', /single record size allows at most 67,108,864 bytes/],
    ['zh-CN', '导入', /单条记录大小最多 67,108,864 字节/],
    ['zh-TW', '匯入', /單筆記錄大小最多 67,108,864 位元組/],
  ] as const) {
    it(`shows the exact source limit without generic retry advice in ${locale}`, async () => {
      const harness = await renderPage({
        locale,
        catalog: catalog(externalSession()),
        importResult: {
          ok: false,
          reason: 'source_limit_exceeded',
          limit: { kind: 'record_bytes', max: 67_108_864 },
        },
      });
      const button = buttonWithText(harness.container, label);
      assert.ok(button);
      await act(async () => button.click());
      assert.match(harness.container.textContent, expected);
      assert.doesNotMatch(harness.container.textContent, /Check the source and try again|请检查来源后重试|請檢查來源後重試|Check the import result/);
      assert.equal(harness.listCalls(), 1);
      await act(async () => harness.root.unmount());
    });
  }

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
      locale: 'zh-CN',
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

  it('does not claim another client task after an unknown import outcome', async () => {
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
    assert.match(harness.container.textContent, /Check the import result/);
    assert.doesNotMatch(harness.container.textContent, /The imported task is available now/);
    // Catalog history may include a task from this or another client, but the
    // page never attributes it to this unanswered request or navigates to it.
    assert.deepEqual(opened, []);

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
    | Extract<ExternalSessionImportIpcResult, { ok: false }>
    | Promise<Extract<ExternalSessionImportIpcResult, { ok: false }>>;
  /**
   * Per-source answers for a batch: `ok` lands, `unknown` is the Host not
   * answering, `throw` is a rejection. Keyed by source session id, because a
   * batch is exactly the case where the ids must not share one answer.
   */
  importBySource?: Record<string, 'ok' | 'unknown' | 'throw' | 'no_model' | 'source_unreadable'>;
  onOpenImported?: (sessionId: string) => void;
  offersBundleSource?: boolean;
  locale?: 'en' | 'zh-CN' | 'zh-TW';
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
        if (perSource === 'no_model' || perSource === 'source_unreadable') {
          return { ok: false, reason: perSource };
        }
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
      ...(options.offersBundleSource === undefined
        ? {}
        : { offersBundleSource: options.offersBundleSource }),
    };
    const bare = createElement(ImportTasksSettingsPage, pageProps);
    // Composed the way the settings surface composes it. The page's bundle
    // source renders a panel the feature provides, so a page rendered on its
    // own is a composition production never has.
    const page = createElement(SessionBundleTasks, {
      isLocalTarget: options.offersBundleSource === true,
      catalog: createSessionCatalogController(),
      renderSection: ({ children }: { children: ReactNode }) =>
        createElement('div', null, children),
      children: bare,
    });
    const targeted = createElement(RuntimeHostSettingsTarget, {
      host: TEST_RUNTIME_HOST,
      children: page,
    });
    // The page asks for a confirmation before exporting a subtree, and a
    // confirmation is a toast. The app has always provided one; the harness did
    // not, which made every case fail on the provider rather than the case.
    const withServices = createElement(SessionBundleServicesProvider, {
      services: {
        exportBundle: async () => ({ ok: false, reason: 'canceled' }) as const,
        importBundle: async () => ({ ok: false, reason: 'canceled' }) as const,
      },
      children: targeted,
    });
    const withToasts = createElement(ToastProvider, { children: withServices });
    const localized = createElement(AstryxLocaleProvider, { children: withToasts });
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

  it('select all and batch submission exclude a source the Host is already importing', async () => {
    const harness = await renderPage({
      catalog: {
        sessions: [
          externalSession({
            id: 'running',
            importState: { importedCount: 0, importedSessionIds: [], isImporting: true },
          }),
          externalSession({ id: 'available' }),
        ],
        nextCursor: null,
      },
      importBySource: { available: 'ok' },
    });
    const { container, importedIds } = harness;

    await tick(masterBox(container), true);
    assert.deepEqual(rows(container).map((box) => box.checked), [false, true]);
    assert.match(container.textContent ?? '', /1 \/ 1 selected/);

    const run = buttonWithText(container, 'Import selected');
    assert.ok(run);
    await act(async () => run.click());
    assert.deepEqual(importedIds(), ['available']);

    await act(async () => harness.root.unmount());
  });

  it('does not carry a selected source id into another adapter', async () => {
    const { container } = await renderPage({
      adapterIds: ['codex', 'claude-code'],
      bySource: {
        codex: [catalog(externalSession({ id: 'shared', name: 'Codex shared' }))],
        'claude-code': [catalog(externalSession({ id: 'shared', name: 'Claude shared' }))],
      },
    });

    await tick(rows(container)[0]!, true);
    assert.equal(buttonWithText(container, 'Import selected')?.disabled, false);
    await act(async () => {
      segment(container, 'claude-code')?.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    assert.match(container.textContent ?? '', /Claude shared/);
    assert.equal(rows(container)[0]?.checked, false);
    assert.equal(buttonWithText(container, 'Import selected')?.disabled, true);
  });

  it('does not let a completed batch refresh overwrite a newer source selection', async () => {
    let finishImport:
      | ((result: { ok: false; reason: 'commit_outcome_unknown' }) => void)
      | undefined;
    const pendingImport = new Promise<{ ok: false; reason: 'commit_outcome_unknown' }>((resolve) => {
      finishImport = resolve;
    });
    const { container } = await renderPage({
      adapterIds: ['codex', 'claude-code'],
      bySource: {
        codex: [
          catalog(externalSession({ id: 'codex', name: 'Codex conversation' })),
          catalog(externalSession({ id: 'codex', name: 'Stale Codex refresh' })),
        ],
        'claude-code': [catalog(externalSession({ id: 'claude', name: 'Claude conversation' }))],
      },
      importResult: pendingImport,
    });

    await tick(rows(container)[0]!, true);
    const run = buttonWithText(container, 'Import selected');
    assert.ok(run);
    await act(async () => {
      run.click();
      await Promise.resolve();
      segment(container, 'claude-code')?.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.match(container.textContent ?? '', /Claude conversation/);

    await act(async () => {
      finishImport?.({ ok: false, reason: 'commit_outcome_unknown' });
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.match(container.textContent ?? '', /Claude conversation/);
    assert.doesNotMatch(container.textContent ?? '', /Stale Codex refresh/);
  });

  it('imports the marked rows one at a time and counts each outcome once', async () => {
    // Sequential on purpose: a progress count is only true when one thing is
    // happening, and the summary must preserve the catalog order the user chose.
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
    // A catalog read cannot attribute a later task to this unanswered request.
    // Unknown is not a definite failure even though the user may choose a new import.
    const quiet = externalSession({ id: 'quiet' });
    const { container } = await renderPage({
      catalogs: [{ sessions: [quiet], nextCursor: null }],
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
    // It surfaces through a per-request warning without changing eligibility.
    assert.match(text, /unconfirmed|Unconfirmed|outcome/i);
    assert.equal(rows(container)[0]?.disabled, false);
  });

  it('allows a source to be submitted again after an unknown outcome', async () => {
    const uncertain = externalSession({ id: 'uncertain', name: 'Uncertain' });
    const { container, importedIds } = await renderPage({
      catalogs: [{ sessions: [uncertain], nextCursor: null }],
      importBySource: { uncertain: 'unknown' },
    });

    const firstRun = buttonWithText(container, 'Import');
    assert.ok(firstRun);
    await act(async () => {
      firstRun.click();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    assert.deepEqual(importedIds(), ['uncertain']);
    const retry = buttonWithText(container, 'Import');
    assert.ok(retry);
    assert.equal(retry.disabled, false);

    await act(async () => {
      retry.click();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.deepEqual(importedIds(), ['uncertain', 'uncertain']);
  });

  it('keeps source limit details in the batch summary after the catalog refresh', async () => {
    const harness = await renderPage({
      catalog: catalog(externalSession({ name: 'Oversized conversation' })),
      importResult: {
        ok: false,
        reason: 'source_limit_exceeded',
        limit: { kind: 'records', max: 1_000_000 },
      },
    });
    await tick(masterBox(harness.container), true);
    const run = buttonWithText(harness.container, 'Import selected');
    assert.ok(run);
    await act(async () => run.click());
    assert.equal(harness.listCalls(), 2);
    const text = harness.container.textContent ?? '';
    assert.match(text, /No conversation was imported/);
    assert.match(text, /1 more could not be imported/);
    assert.match(text, /Oversized conversation: .*record count allows at most 1,000,000/);
    assert.doesNotMatch(text, /Check the import result|Check the source and try again/);
    await act(async () => harness.root.unmount());
  });

  it('counts code-classified batch failures as failed, not unconfirmed, and raises the model banner', async () => {
    // Before the fix, no_model / source_unreadable were swept into the
    // maybe-landed "unconfirmed" bucket alongside commit_outcome_unknown: no
    // actionable banner, and the summary could read as success. They are
    // definite failures; no_model additionally raises its actionable banner.
    const { container } = await renderPage({
      catalog: {
        sessions: [
          externalSession({ id: 'blocked', name: 'Blocked' }),
          externalSession({ id: 'unreadable', name: 'Unreadable' }),
        ],
        nextCursor: null,
      },
      importBySource: { blocked: 'no_model', unreadable: 'source_unreadable' },
    });

    await tick(masterBox(container), true);
    const run = buttonWithText(container, 'Import selected');
    assert.ok(run);
    await act(async () => {
      run.click();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    const text = container.textContent ?? '';
    // Both are definite failures: the summary counts them, none imported.
    assert.match(text, /No conversation was imported/);
    assert.match(text, /2 more could not be imported/);
    // Not the maybe-landed path: no unconfirmed banner is offered.
    assert.doesNotMatch(text, /Check the import result/);
    // The one globally-actionable reason surfaces its banner.
    assert.match(text, /No usable model connection/);
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

describe('ImportTasksSettingsPage bundle source', () => {
  it('does not offer the bundle source where the feature is not mounted', async () => {
    // An adapter is present so the switch renders at all; the question is
    // whether the bundle joins it. Beside a Remote target it must not: the
    // panel needs services this page does not have, and picking the source
    // there would name a Local action on a Remote-scoped page.
    const harness = await renderPage({ adapterIds: ['codex'], offersBundleSource: false });
    assert.match(harness.container.textContent, /Codex/);
    assert.doesNotMatch(harness.container.textContent, /Maka session file/);
    await act(async () => harness.root.unmount());
  });

  it('offers it where the feature is mounted', async () => {
    const harness = await renderPage({ adapterIds: ['codex'], offersBundleSource: true });
    assert.match(harness.container.textContent, /Maka session file/);
    await act(async () => harness.root.unmount());
  });

  it('says so when neither an agent nor the bundle source is available', async () => {
    // Beside a Remote target with no agent installed there is nothing to pick,
    // nothing to filter and nothing to list. Empty controls would be worse than
    // the sentence that says why.
    const harness = await renderPage({ adapterIds: [], offersBundleSource: false });
    assert.match(harness.container.textContent, /No supported Agent detected/);
    await act(async () => harness.root.unmount());
  });
});
