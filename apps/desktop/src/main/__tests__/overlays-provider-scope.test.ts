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

  test('records the search scroll target and marks it handled once', async () => {
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
    const rendersBeforeStaleNonce = frameRenders;
    await act(async () => commands.consumeSearchScrollTarget(2));
    assert.equal(frameRenders, rendersBeforeStaleNonce);
    await act(async () => commands.consumeSearchScrollTarget(3));
    assert.equal(latest?.selectors.searchScrollTarget?.handled, true);
    await act(async () => root.unmount());
  });

  test('routes the thread search to the mounted service', async () => {
    const { root } = installReactRenderer();
    const queries: string[] = [];
    const services = createFakeOverlaysServices({
      search: {
        thread: async (request) => {
          queries.push(request.query);
          return [];
        },
      },
    });
    await act(async () => renderRoot(root, services));
    await latest!.commands.searchThread({ query: 'deploy' } as Parameters<
      OverlaysShellProjection['commands']['searchThread']
    >[0]);
    assert.deepEqual(queries, ['deploy']);
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
