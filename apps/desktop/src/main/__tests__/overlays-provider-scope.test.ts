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
import { afterEach, describe, test } from 'node:test';
import { act, createElement } from 'react';
import { cleanupFakeDom, installReactRenderer } from './fake-dom.js';
import {
  createFakeOverlaysServices,
  OverlaysConsumer,
  OverlaysRoot,
  OverlaysServicesProvider,
  type OverlaysShellProjection,
} from '../../renderer/features/overlays/testing.js';

let frameRenders = 0;
let layerRenders = 0;
let latest: OverlaysShellProjection | undefined;
let latestLayer: OverlaysShellProjection | undefined;

function ShellFrame(props: { readonly overlays: OverlaysShellProjection }) {
  frameRenders += 1;
  latest = props.overlays;
  return null;
}

function OverlayLayerProbe() {
  return createElement(OverlaysConsumer, {
    children: (overlays) => {
      layerRenders += 1;
      latestLayer = overlays;
      return null;
    },
  });
}

function renderRoot(
  root: ReturnType<typeof installReactRenderer>['root'],
  services = createFakeOverlaysServices(),
) {
  root.render(
    createElement(
      OverlaysServicesProvider,
      { services },
      createElement(OverlaysRoot, {
        children: (overlays) =>
          createElement(
            'div',
            null,
            createElement(ShellFrame, { overlays }),
            createElement(OverlayLayerProbe),
          ),
      }),
    ),
  );
}

afterEach(() => {
  frameRenders = 0;
  layerRenders = 0;
  latest = undefined;
  latestLayer = undefined;
  cleanupFakeDom();
});

describe('OverlaysRoot', () => {
  test('hands the shell frame closed overlays and stable commands', async () => {
    const { root } = installReactRenderer();
    await act(async () => renderRoot(root));
    assert.ok(latest);
    assert.equal(latest.selectors.anyModalOpen, false);
    assert.equal(latest.selectors.settings.open, false);
    assert.equal(latest.selectors.searchScrollTarget, null);
    assert.equal(latestLayer, latest);
    const commands = latest.commands;

    await act(async () => commands.openHelp());
    assert.equal(latest?.selectors.helpOpen, true);
    assert.equal(latest?.selectors.anyModalOpen, true);
    assert.equal(latest?.commands, commands);
    assert.equal(frameRenders, 2);
    assert.equal(layerRenders, 2);

    await act(async () => commands.closeHelp());
    assert.equal(latest?.selectors.anyModalOpen, false);
    await act(async () => commands.openPalette());
    assert.equal(latest?.selectors.paletteOpen, true);
    await act(async () => commands.closePalette());
    await act(async () => commands.openSearch());
    assert.equal(latest?.selectors.searchOpen, true);
    assert.equal(latest?.selectors.anyModalOpen, true);
    await act(async () => commands.closeSearch());
    assert.equal(latest?.selectors.anyModalOpen, false);
    assert.equal(latest?.commands, commands);
    await act(async () => root.unmount());
  });

  test('opens Settings through the persisted section and settles focus only when closed', async () => {
    const { root } = installReactRenderer();
    const persisted: string[] = [];
    let blurred = 0;
    const services = createFakeOverlaysServices({
      settingsSection: { persist: (section) => { persisted.push(section); } },
      focus: { blurActiveElement: () => { blurred += 1; } },
    });
    await act(async () => renderRoot(root, services));
    const commands = latest!.commands;

    await act(async () => commands.openSettingsSection('models'));
    assert.equal(latest?.selectors.settings.open, true);
    assert.deepEqual(latest?.selectors.settings.request, { section: 'models' });
    assert.deepEqual(persisted, ['models']);
    assert.equal(blurred, 1);

    await act(async () => commands.openProviderCatalog());
    assert.equal(latest?.selectors.settings.providerCatalogOpen, true);
    assert.deepEqual(persisted, ['models', 'models']);
    assert.equal(blurred, 1, 'an already open Settings does not move focus again');

    await act(async () => commands.closeSettings());
    assert.equal(latest?.selectors.settings.open, false);
    assert.equal(latest?.selectors.settings.providerCatalogOpen, false);

    await act(async () => commands.openProjectSettings('profile-2'));
    assert.deepEqual(latest?.selectors.settings.request, {
      section: 'projects',
      profileId: 'profile-2',
    });
    assert.equal(blurred, 2);

    await act(async () => commands.setSettingsProfileId('profile-2'));
    assert.equal(frameRenders, 5, 'an unchanged profile re-renders nothing');
    await act(async () => commands.setSettingsProfileId(undefined));
    assert.equal(latest?.selectors.settings.request.profileId, undefined);
    await act(async () => root.unmount());
  });

  test('opens History from provider sub-surfaces, persists it and only blurs on reopen', async () => {
    const { root } = installReactRenderer();
    const persisted: string[] = [];
    let blurred = 0;
    const services = createFakeOverlaysServices({
      settingsSection: { persist: (section) => { persisted.push(section); } },
      focus: { blurActiveElement: () => { blurred += 1; } },
    });
    await act(async () => renderRoot(root, services));
    const commands = latest!.commands;
    const entries = [
      {
        open: () => commands.openProviderCatalog(),
        surface: {
          providerCatalogOpen: true,
          connectionDetailSlug: undefined,
          createProviderType: undefined,
        },
      },
      {
        open: () => commands.openConnectionDetail('history-test-connection'),
        surface: {
          providerCatalogOpen: false,
          connectionDetailSlug: 'history-test-connection',
          createProviderType: undefined,
        },
      },
      {
        open: () => commands.openProviderCreate('openai'),
        surface: {
          providerCatalogOpen: false,
          connectionDetailSlug: undefined,
          createProviderType: 'openai',
        },
      },
    ];
    const history = {
      open: true,
      request: { section: 'computer-history' },
      providerCatalogOpen: false,
      connectionDetailSlug: undefined,
      createProviderType: undefined,
    };

    const expectedPersisted: string[] = [];
    for (const [index, entry] of entries.entries()) {
      await act(async () => entry.open());
      assert.deepEqual(latest!.selectors.settings, {
        open: true,
        request: { section: 'models' },
        ...entry.surface,
      });
      assert.equal(blurred, index * 2 + 1);
      expectedPersisted.push('models');
      assert.deepEqual(persisted, expectedPersisted);

      await act(async () => commands.openSettingsSection('computer-history'));
      assert.deepEqual(latest!.selectors.settings, history);
      expectedPersisted.push('computer-history');
      assert.deepEqual(persisted, expectedPersisted);
      assert.equal(blurred, index * 2 + 1, 'switching an open Settings to History keeps focus');
      assert.equal(latestLayer, latest, 'the overlay layer receives the History request');

      await act(async () => commands.closeSettings());
      assert.deepEqual(latest!.selectors.settings, { ...history, open: false });
      assert.equal(blurred, index * 2 + 1);
      await act(async () => commands.openSettings());
      assert.deepEqual(latest!.selectors.settings, history, 'plain reopen remembers History');
      assert.equal(blurred, index * 2 + 2);
      assert.deepEqual(
        persisted,
        expectedPersisted,
        'plain reopen does not overwrite the persisted section',
      );
      await act(async () => commands.closeSettings());
    }
    await act(async () => root.unmount());
  });

  test('records the search scroll target until the transcript clears it', async () => {
    const { root } = installReactRenderer();
    await act(async () => renderRoot(root));
    const commands = latest!.commands;

    await act(async () =>
      commands.setSearchScrollTarget({ sessionId: 's1', turnId: 't1', nonce: 3 }));
    assert.deepEqual(latest?.selectors.searchScrollTarget, {
      sessionId: 's1',
      turnId: 't1',
      nonce: 3,
    });
    await act(async () => commands.setSearchScrollTarget(null));
    assert.equal(latest?.selectors.searchScrollTarget, null);
    await act(async () => root.unmount());
  });

  test('routes search requests and cancellation to the mounted service with stable commands', async () => {
    const { root } = installReactRenderer();
    const queries: Array<[string, string | undefined]> = [];
    const cancelled: string[] = [];
    const services = createFakeOverlaysServices({
      search: {
        thread: async (request, requestId) => {
          queries.push([request.query, requestId]);
          return [];
        },
        cancelThread: async (requestId) => { cancelled.push(requestId); },
      },
    });
    await act(async () => renderRoot(root, services));
    const commands = latest!.commands;
    await commands.searchThread({ query: 'deploy' } as Parameters<
      OverlaysShellProjection['commands']['searchThread']
    >[0], 'search-1');
    await act(async () => commands.openSearch());
    await act(async () => commands.closeSearch());
    assert.equal(latest!.commands.searchThread, commands.searchThread);
    assert.equal(latest!.commands.cancelSearchThread, commands.cancelSearchThread);
    await commands.cancelSearchThread('search-1');
    assert.deepEqual(queries, [['deploy', 'search-1']]);
    assert.deepEqual(cancelled, ['search-1']);
    await act(async () => root.unmount());
  });

  test('throws for an overlay reader mounted outside OverlaysRoot', () => {
    const { root } = installReactRenderer();
    assert.throws(
      () => act(() => root.render(createElement(OverlayLayerProbe))),
      { message: 'OverlaysRoot is missing' },
    );
    assert.equal(layerRenders, 0);
  });
});
