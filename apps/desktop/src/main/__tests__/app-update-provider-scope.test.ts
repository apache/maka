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
import { act, createElement, Fragment } from 'react';
import {
  LocaleProvider,
  ToastProvider,
  useSidebarUpdateProjection,
  type SidebarUpdateProjection,
} from '@maka/ui';
import { cleanupFakeDom, installReactRenderer } from './fake-dom.js';
import {
  AppUpdateAboutProjectionConsumer,
  AppUpdateProvider,
  AppUpdateServicesProvider,
  createFakeAppUpdateServices,
  type AppUpdateAboutProjection,
  type AppUpdateInstallResult,
  type AppUpdateServices,
  type AppUpdateStatus,
} from '../../renderer/features/app-update/testing.js';

let shellRenders = 0;
let unrelatedRenders = 0;
let sidebarRenders = 0;
let aboutRenders = 0;
let latestSidebar: SidebarUpdateProjection | undefined;
let latestAbout: AppUpdateAboutProjection | undefined;

function UnrelatedProbe() {
  unrelatedRenders += 1;
  return null;
}

function SidebarProbe() {
  sidebarRenders += 1;
  latestSidebar = useSidebarUpdateProjection();
  return null;
}

function AboutProbe() {
  return createElement(AppUpdateAboutProjectionConsumer, {
    children: (projection) => {
      aboutRenders += 1;
      latestAbout = projection;
      return null;
    },
  });
}

function ShellProbe(props: { readonly aboutOpen: boolean }) {
  shellRenders += 1;
  return createElement(
    Fragment,
    null,
    createElement(UnrelatedProbe),
    createElement(SidebarProbe),
    props.aboutOpen ? createElement(AboutProbe) : null,
  );
}

function renderProvider(
  root: ReturnType<typeof installReactRenderer>['root'],
  services: AppUpdateServices,
  aboutOpen: boolean,
) {
  root.render(createElement(LocaleProvider, {
    locale: 'en',
    children: createElement(
      ToastProvider,
      null,
      createElement(
        AppUpdateServicesProvider,
        { services },
        createElement(
          AppUpdateProvider,
          null,
          createElement(ShellProbe, { aboutOpen }),
        ),
      ),
    ),
  }));
}

function downloading(percent: number): AppUpdateStatus {
  return {
    state: 'downloading',
    currentVersion: '1.0.0',
    latestVersion: '1.1.0',
    progress: { percent },
  };
}

afterEach(() => {
  shellRenders = 0;
  unrelatedRenders = 0;
  sidebarRenders = 0;
  aboutRenders = 0;
  latestSidebar = undefined;
  latestAbout = undefined;
  cleanupFakeDom();
});

describe('AppUpdateProvider render scope', () => {
  test('routes progress only to an open About reader and reminders only to the footer', async () => {
    const { root } = installReactRenderer();
    let emit: ((status: AppUpdateStatus) => void) | undefined;
    const defaults = createFakeAppUpdateServices();
    const services = createFakeAppUpdateServices({
      appUpdate: {
        ...defaults.appUpdate,
        updateStatus: async () => ({ state: 'idle', currentVersion: '1.0.0' }),
        subscribeUpdateStatus: (handler) => {
          emit = handler;
          return () => undefined;
        },
      },
    });

    await act(async () => renderProvider(root, services, true));
    const initial = {
      shell: shellRenders,
      unrelated: unrelatedRenders,
      sidebar: sidebarRenders,
      about: aboutRenders,
    };

    await act(async () => emit?.(downloading(10)));
    assert.equal(shellRenders, initial.shell);
    assert.equal(unrelatedRenders, initial.unrelated);
    assert.equal(sidebarRenders, initial.sidebar);
    assert.equal(aboutRenders, initial.about + 1);
    assert.equal(latestAbout?.status?.state, 'downloading');

    const afterFirstProgress = aboutRenders;
    await act(async () => emit?.(downloading(20)));
    assert.equal(shellRenders, initial.shell);
    assert.equal(unrelatedRenders, initial.unrelated);
    assert.equal(sidebarRenders, initial.sidebar);
    assert.equal(aboutRenders, afterFirstProgress + 1);

    await act(async () => emit?.({
      state: 'downloaded',
      currentVersion: '1.0.0',
      latestVersion: '1.1.0',
    }));
    assert.equal(shellRenders, initial.shell);
    assert.equal(unrelatedRenders, initial.unrelated);
    assert.equal(sidebarRenders, initial.sidebar + 1);
    assert.equal(aboutRenders, afterFirstProgress + 2);
    assert.deepEqual(latestSidebar?.reminder, {
      state: 'downloaded',
      latestVersion: '1.1.0',
    });

    const afterDownloaded = {
      sidebarRenders,
      aboutRenders,
      projection: latestSidebar,
    };
    await act(async () => emit?.({
      state: 'downloaded',
      currentVersion: '1.0.0',
      latestVersion: '1.1.0',
    }));
    assert.equal(sidebarRenders, afterDownloaded.sidebarRenders);
    assert.equal(aboutRenders, afterDownloaded.aboutRenders + 1);
    assert.equal(latestSidebar, afterDownloaded.projection);

    await act(async () => root.unmount());
  });

  test('has no reader work for progress while About is closed', async () => {
    const { root } = installReactRenderer();
    let emit: ((status: AppUpdateStatus) => void) | undefined;
    const defaults = createFakeAppUpdateServices();
    const services = createFakeAppUpdateServices({
      appUpdate: {
        ...defaults.appUpdate,
        updateStatus: async () => ({ state: 'idle', currentVersion: '1.0.0' }),
        subscribeUpdateStatus: (handler) => {
          emit = handler;
          return () => undefined;
        },
      },
    });

    await act(async () => renderProvider(root, services, false));
    const before = [shellRenders, unrelatedRenders, sidebarRenders, aboutRenders];
    await act(async () => emit?.(downloading(73)));
    assert.deepEqual(
      [shellRenders, unrelatedRenders, sidebarRenders, aboutRenders],
      before,
    );
    await act(async () => root.unmount());
  });

  test('deduplicates concurrent install requests at the persistent provider owner', async () => {
    const { root } = installReactRenderer();
    let emit: ((status: AppUpdateStatus) => void) | undefined;
    let resolveInstall!: (result: AppUpdateInstallResult) => void;
    const installResult = new Promise<AppUpdateInstallResult>((resolve) => {
      resolveInstall = resolve;
    });
    let installCount = 0;
    const defaults = createFakeAppUpdateServices();
    const services = createFakeAppUpdateServices({
      appUpdate: {
        ...defaults.appUpdate,
        updateStatus: async () => ({ state: 'idle', currentVersion: '1.0.0' }),
        installUpdate: () => {
          installCount += 1;
          return installResult;
        },
        subscribeUpdateStatus: (handler) => {
          emit = handler;
          return () => undefined;
        },
      },
    });

    await act(async () => renderProvider(root, services, false));
    await act(async () => emit?.({
      state: 'downloaded',
      currentVersion: '1.0.0',
      latestVersion: '1.1.0',
    }));
    await act(async () => {
      latestSidebar?.onOpenUpdate?.();
      latestSidebar?.onOpenUpdate?.();
    });
    assert.equal(installCount, 1);

    await act(async () => {
      resolveInstall({ ok: true });
      await installResult;
      await Promise.resolve();
    });
    await act(async () => root.unmount());
  });
});
