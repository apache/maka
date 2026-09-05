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
import { mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { after, afterEach, before, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { parseHTML } from 'linkedom';
import { act, createElement, type ComponentType, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { AstryxLocaleProvider, LocaleProvider, ToastProvider } from '@maka/ui';
import type { UiLocale } from '@maka/core/ui-locale';
import type { ProviderType } from '@maka/core/llm-connections';
import type { PeerMeshQueryResult } from '@maka/runtime-host/protocol';
import type { RuntimeHostPeerConnectionPath } from '@maka/runtime-host/client';
import type { DesktopRuntimeHostProfileSnapshot } from '../../preload/bridge-contract.js';
import type { ConnectionsBridge } from '../../renderer/features/connection-settings/index.js';
import type { RuntimeHostManagementServices } from '../../renderer/features/runtime-host-management/index.js';

// Keep renderer implementations and their asset imports out of the main compilation graph.
interface RenderModules {
  AddProviderForm: ComponentType<{
    bridge: ConnectionsBridge;
    providerType: ProviderType;
    existingSlugs: string[];
    onCancel(): void;
    onCreated(slug: string, modelDiscoveryError?: unknown): Promise<void>;
  }>;
  RuntimeHostProfilesSection: ComponentType<{
    onRemoteHostAdded(profileId: string): void;
  }>;
  RuntimeHostManagementServicesProvider: ComponentType<{
    services: RuntimeHostManagementServices;
    children?: ReactNode;
  }>;
  RuntimeHostPeerMeshDialog: ComponentType<{
    target: Parameters<RuntimeHostManagementServices['peerMesh']['execute']>[0];
    targetName: string;
    onClose(): void;
  }>;
}

let components: RenderModules;
let bundleDirectory: string;
let mountedRoot: Root | undefined;
const originalGlobals = {
  document: globalThis.document,
  window: globalThis.window,
  HTMLElement: globalThis.HTMLElement,
  HTMLIFrameElement: globalThis.HTMLIFrameElement,
  Node: globalThis.Node,
  Event: globalThis.Event,
  CSS: globalThis.CSS,
  matchMedia: globalThis.matchMedia,
  getComputedStyle: globalThis.getComputedStyle,
  requestAnimationFrame: globalThis.requestAnimationFrame,
  cancelAnimationFrame: globalThis.cancelAnimationFrame,
  IS_REACT_ACT_ENVIRONMENT: (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT,
};

before(async () => {
  const repoRoot = resolve(import.meta.dirname, '../../../../..');
  bundleDirectory = await mkdtemp(resolve(repoRoot, 'apps/desktop/dist/main/__tests__/connection-locale-'));
  const outfile = resolve(bundleDirectory, 'components.mjs');
  // Like password-input.test.ts, bundle extensionless renderer imports without replacing components.
  await build({
    stdin: {
      contents: [
        "export { AddProviderForm } from './settings/provider-add-form';",
        "export { RuntimeHostProfilesSection } from './settings/runtime-host-profiles-section';",
        "export { RuntimeHostManagementServicesProvider, RuntimeHostPeerMeshDialog } from './features/runtime-host-management/index';",
      ].join('\n'),
      resolveDir: resolve(repoRoot, 'apps/desktop/src/renderer'),
    },
    outfile,
    bundle: true,
    packages: 'external',
    loader: { '.svg': 'dataurl' },
    platform: 'node',
    format: 'esm',
    jsx: 'automatic',
    target: 'node20',
    logLevel: 'silent',
  });
  components = await import(pathToFileURL(outfile).href) as RenderModules;
});

afterEach(async () => {
  try {
    if (mountedRoot) await act(() => mountedRoot?.unmount());
  } finally {
    mountedRoot = undefined;
    Object.assign(globalThis, originalGlobals);
  }
});

after(async () => {
  if (bundleDirectory) await rm(bundleDirectory, { recursive: true, force: true });
});

const localeCases = [
  {
    locale: 'zh-CN', direct: '直连', transit: '成员转发', save: '保存供应商',
    slugErrors: {
      required: '请填写连接标识',
      format: '连接标识只能包含小写字母、数字和连字符',
      too_long: '连接标识不能超过 64 个字符',
      duplicate: '连接标识已存在',
    },
  },
  {
    locale: 'zh-TW', direct: '直接連線', transit: '成員轉送', save: '儲存供應商',
    slugErrors: {
      required: '請填寫連線標識',
      format: '連線標識只能包含小寫字母、數字和連字號',
      too_long: '連線標識不能超過 64 個字元',
      duplicate: '連線標識已存在',
    },
  },
  {
    locale: 'en', direct: 'Direct', transit: 'Member transit', save: 'Save provider',
    slugErrors: {
      required: 'Enter a connection identifier',
      format: 'Connection identifiers use lowercase letters, digits, and hyphens',
      too_long: 'Connection identifiers are at most 64 characters',
      duplicate: 'Connection identifier already exists',
    },
  },
] as const;

for (const copy of localeCases) {
  test(`${copy.locale}: peer path badges describe the route, while tooltips retain the protocol`, async () => {
    const harness = installRenderer();
    const paths: RuntimeHostPeerConnectionPath[] = [
      { kind: 'direct', transport: 'webrtc' },
      { kind: 'direct', transport: 'quic' },
      { kind: 'direct', transport: 'tcp' },
      { kind: 'transit', relayPeerId: 'relay-peer' },
    ];
    const snapshot: DesktopRuntimeHostProfileSnapshot = {
      defaultProfileId: 'local',
      entries: [{
        profile: { kind: 'local', id: 'local', name: 'Local' },
        enabled: true, isDefault: true, readiness: 'ready',
      }, ...paths.map<DesktopRuntimeHostProfileSnapshot['entries'][number]>((peerPath, index) => ({
        profile: {
          kind: 'remote', id: `remote-${index}`, name: `Remote ${index}`, rootId: 'root',
          transport: {
            kind: 'libp2p-direct',
            reachability: {
              lease: {
                version: 1, peerId: `peer-${index}`, revision: 1,
                issuedAt: 1, expiresAt: 300001, directRoutes: [], coordinationRoutes: [],
              },
              publicKey: 'test-public-key', signature: 'test-signature',
            },
          },
        },
        enabled: true, isDefault: false, readiness: 'ready', peerPath,
      }))],
    };
    Object.assign(window, {
      maka: {
        runtimeHostProfiles: {
          getSnapshot: async () => snapshot,
          subscribeChanges: () => () => {},
        },
        localRuntimeHostRemoteAccess: { getSnapshot: async () => ({ state: 'off' }) },
        runtimeHostManagement: { subscribeProgress: () => () => {} },
      },
    });
    await harness.render(copy.locale, createElement(components.RuntimeHostProfilesSection, {
      onRemoteHostAdded: unexpectedCall,
    }));

    const details = [
      `${copy.direct} · WebRTC`, `${copy.direct} · QUIC`, `${copy.direct} · TCP`,
      `${copy.transit} · relay-peer`,
    ];
    for (const [index, detail] of details.entries()) {
      const row = [...harness.document.querySelectorAll('li')].find(
        (element) => element.textContent.includes(`Remote ${index}`),
      );
      assert.ok(row, `missing Remote ${index}`);
      const trigger = [...row.querySelectorAll('span[aria-describedby]')].find(
        (element) => describedElements(element).some(
          (description) => description.getAttribute('role') === 'tooltip' && description.textContent === detail,
        ),
      );
      assert.ok(trigger, `missing rendered tooltip: ${detail}`);
      assert.equal(trigger.textContent, index === 3 ? copy.transit : copy.direct);
    }
  });

  for (const [reason, slug] of Object.entries({
    required: '', format: 'Not A Slug', too_long: 'a'.repeat(65), duplicate: 'taken',
  })) {
    test(`${copy.locale}: AddProviderForm renders the ${reason} slug error`, async () => {
      const harness = installRenderer();
      const calls: string[] = [];
      const bridge = {
        create: async () => { calls.push('create'); throw new Error('unexpected create'); },
        fetchModels: async () => { calls.push('fetchModels'); throw new Error('unexpected discovery'); },
      } as unknown as ConnectionsBridge;
      await harness.render(copy.locale, createElement(components.AddProviderForm, {
        bridge, providerType: 'openai-compatible', existingSlugs: ['taken'],
        onCancel: unexpectedCall, onCreated: unexpectedCall,
      }));
      const input = harness.document.querySelector<HTMLInputElement>('input[placeholder="my-provider"]');
      assert.ok(input, 'missing connection identifier input');
      await act(async () => {
        input.value = slug;
        const key = Object.keys(input).find((candidate) => candidate.startsWith('__reactProps$'));
        assert.ok(key, 'missing React input props');
        const props = (input as unknown as Record<string, unknown>)[key] as {
          onChange(event: { target: HTMLInputElement; defaultPrevented: boolean }): void;
        };
        props.onChange({ target: input, defaultPrevented: false });
      });
      const submit = [...harness.document.querySelectorAll('button')].find(
        (button) => button.textContent === copy.save,
      );
      assert.ok(submit, 'missing save button');
      await act(async () => submit.click());

      assert.equal(input.getAttribute('aria-invalid'), 'true');
      assert.deepEqual(describedElements(input).map((element) => element.textContent), [
        copy.slugErrors[reason as keyof typeof copy.slugErrors],
      ]);
      assert.deepEqual(calls, [], 'invalid identifiers must not reach the provider bridge');
    });
  }
}

test('zh-TW: expanded Peer Mesh members render localized route states', async () => {
  const harness = installRenderer();
  const states = ['local', 'connecting', 'reachable', 'reconnecting', 'needs_repair'] as const;
  const snapshot: PeerMeshQueryResult = {
    available: true, localPeerId: 'peer-local',
    meshes: [{
      meshId: 'mesh-1', displayName: 'Test Mesh', role: 'authority',
      authorityPeerId: 'peer-local', revision: 1, closed: false, pendingInvitationCount: 0,
      members: states.map((state) => ({ peerId: `peer-${state}`, state, endpointKind: 'host' })),
    }],
  };
  const services = managementServices();
  services.peerMesh.execute = async (_target, action) => {
    assert.equal(action, 'status');
    return snapshot;
  };
  await harness.render('zh-TW', createElement(components.RuntimeHostPeerMeshDialog, {
    target: { kind: 'local_host' }, targetName: 'Local Host', onClose: unexpectedCall,
  }), services);
  const disclosure = harness.document.querySelector<HTMLButtonElement>('.settingsPeerMeshCardDisclosure');
  assert.ok(disclosure, 'missing mesh disclosure');
  await act(async () => disclosure.click());

  const expected = [
    '本機 Runtime Host · 管理者', '正在連線', '可連線', '正在恢復連線', '需要新邀請碼修復',
  ];
  const members = [...harness.document.querySelectorAll('.settingsPeerMeshMember')];
  assert.equal(members.length, states.length);
  for (const [index, member] of members.entries()) {
    const heading = member.querySelector('.settingsPeerMeshMemberHeading');
    assert.ok(heading);
    assert.equal(heading.nextElementSibling?.textContent, expected[index], states[index]);
  }
});

function unexpectedCall(): never {
  assert.fail('unexpected service call');
}

function managementServices(): RuntimeHostManagementServices {
  return {
    supportsWsl: false,
    profilePairing: { retry: unexpectedCall, discard: unexpectedCall },
    connectionCodes: {
      create: unexpectedCall, importCode: unexpectedCall,
      readClipboardText: unexpectedCall, writeClipboardText: unexpectedCall,
    },
    resources: { query: unexpectedCall, schedule: unexpectedCall },
    peerMesh: {
      execute: unexpectedCall, cancel: unexpectedCall,
      getConnectivityPolicy: unexpectedCall, setConnectivityPolicy: unexpectedCall,
      getDirectPeer: unexpectedCall, configureDirectPeer: unexpectedCall, copyText: unexpectedCall,
      createOperationId: () => 'status-operation', schedule: () => () => {},
    },
  };
}

function describedElements(element: Element): Element[] {
  return (element.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean).map((id) => {
    const description = element.ownerDocument.getElementById(id);
    assert.ok(description, `missing description: ${id}`);
    return description;
  });
}

function installRenderer() {
  const { document, window } = parseHTML('<html><body><div id="root"></div></body></html>');
  const matchMedia = (media: string) => ({
    matches: false, media, onchange: null,
    addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {},
    dispatchEvent: () => false,
  });
  const getComputedStyle = () => ({
    direction: 'ltr', writingMode: 'horizontal-tb', getPropertyValue: () => '',
  }) as unknown as CSSStyleDeclaration;
  Object.assign(window, { matchMedia, getComputedStyle, scrollTo() {} });
  Object.assign(window.HTMLElement.prototype, {
    showModal(this: HTMLElement) { this.setAttribute('open', ''); },
    close(this: HTMLElement) { this.removeAttribute('open'); },
  });
  Object.assign(globalThis, {
    document, window, matchMedia, getComputedStyle,
    HTMLElement: window.HTMLElement,
    HTMLIFrameElement: window.HTMLIFrameElement ?? class HTMLIFrameElement {},
    Event: window.Event, Node: window.Node, CSS: { escape: (value: string) => value },
    requestAnimationFrame: () => 0, cancelAnimationFrame: () => {},
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const container = document.getElementById('root');
  assert.ok(container);
  const root = createRoot(container);
  mountedRoot = root;
  return {
    document,
    async render(locale: UiLocale, children: ReactNode, services = managementServices()) {
      await act(async () => root.render(createElement(LocaleProvider, {
        locale,
        children: createElement(AstryxLocaleProvider, {
          children: createElement(ToastProvider, {
            children: createElement(components.RuntimeHostManagementServicesProvider, { services, children }),
          }),
        }),
      })));
    },
  };
}
