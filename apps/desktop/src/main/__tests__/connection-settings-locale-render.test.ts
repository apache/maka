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
import type { ProjectedLlmConnection, ProviderType } from '@maka/core/llm-connections';
import type { PeerMeshQueryResult } from '@maka/runtime-host/protocol';
import type { RuntimeHostPeerConnectionPath } from '@maka/runtime-host/client';
import type { DesktopRuntimeHostProfileSnapshot } from '../../preload/bridge-contract.js';
import type { ConnectionsBridge } from '../../renderer/features/connection-settings/index.js';
import type { RuntimeHostManagementServices } from '../../renderer/features/runtime-host-management/index.js';

// Keep renderer implementations and their asset imports out of the main compilation graph.
interface RenderModules {
  ProvidersPanel: ComponentType<{
    bridge: ConnectionsBridge;
    initialConnectionSlug?: string;
  }>;
  ConnectionDetail: ComponentType<{
    bridge: ConnectionsBridge;
    connection: ProjectedLlmConnection;
    isDefault: boolean;
    onChanged(): Promise<void>;
    onDeleted(): Promise<void>;
  }>;
  RuntimeHostSettingsTarget: ComponentType<{
    host?: { profileId: string; hostId: string };
    generation?: string;
    children: ReactNode;
  }>;
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
        "export { ProvidersPanel } from './settings/providers-panel';",
        "export { ConnectionDetail } from './settings/provider-connection-detail';",
        "export { RuntimeHostSettingsTarget } from './settings/runtime-host-settings-target';",
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
        bridge, providerType: 'custom', existingSlugs: ['taken'],
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

test('custom connection creation updates and clears the request URL preview while typing', async () => {
  const harness = installRenderer();
  await harness.render('en', createElement(components.AddProviderForm, {
    bridge: connectionDetailBridge({}),
    providerType: 'custom', existingSlugs: [],
    onCancel: unexpectedCall, onCreated: unexpectedCall,
  }));
  const input = harness.document.querySelector<HTMLInputElement>('.providerEndpointField input');
  assert.ok(input, 'missing service URL input');
  for (const [draft, expected] of [
    ['https://relay.example/proxy/chat/completions', 'https://relay.example/proxy/chat/completions'],
    ['https://relay.example/team', 'https://relay.example/team/chat/completions'],
    ['https://', null],
    ['', null],
  ] as const) {
    await act(async () => {
      input.value = draft;
      const key = Object.keys(input).find((candidate) => candidate.startsWith('__reactProps$'));
      assert.ok(key, 'missing React input props');
      const props = (input as unknown as Record<string, unknown>)[key] as {
        onChange(event: { target: HTMLInputElement; defaultPrevented: boolean }): void;
      };
      props.onChange({ target: input, defaultPrevented: false });
    });
    const preview = harness.document.querySelector('.providerRequestUrlPreview');
    if (expected) {
      assert.ok(preview);
      assert.ok(preview.textContent.endsWith(expected));
      assert.equal(input.getAttribute('aria-description'), preview.textContent);
    } else {
      assert.equal(preview, null);
      assert.equal(input.getAttribute('aria-description'), null);
    }
  }
});

test('endpoint editing previews the default model protocol override', async () => {
  const harness = installRenderer();
  const base = relayConnection();
  const connection: ProjectedLlmConnection = {
    ...base,
    defaultApiProtocol: 'openai-chat',
    modelOverrides: { [base.defaultModel]: { apiProtocol: 'openai-responses' } },
  };
  await harness.render('en', createElement(components.RuntimeHostSettingsTarget, {
    host: { profileId: 'local', hostId: 'host-local' },
    children: createElement(components.ConnectionDetail, {
      bridge: connectionDetailBridge({ hasSecret: async () => true }),
      connection,
      isDefault: true,
      onChanged: async () => {},
      onDeleted: async () => {},
    }),
  }));
  const edit = [...harness.document.querySelectorAll<HTMLButtonElement>('button')].find(
    (button) => button.getAttribute('aria-label') === 'Edit: Service URL',
  );
  assert.ok(edit, 'missing service URL edit action');
  await act(async () => edit.click());
  const preview = harness.document.querySelector('.providerRequestUrlPreview');
  assert.ok(preview);
  assert.ok(preview.textContent.endsWith('https://relay.example/v1/responses'));
  assert.equal(
    harness.document.querySelector('.providerEndpointField input')?.getAttribute('aria-description'),
    preview.textContent,
  );
});

test('legacy credential endpoint editing shows one preview and retains its accessible description', async () => {
  const harness = installRenderer();
  const connection: ProjectedLlmConnection = {
    ...relayConnection(),
    baseUrl: 'https://relay.example/v1?token=legacy-secret',
  };
  await harness.render('en', createElement(components.RuntimeHostSettingsTarget, {
    host: { profileId: 'local', hostId: 'host-local' },
    children: createElement(components.ConnectionDetail, {
      bridge: connectionDetailBridge({ hasSecret: async () => true }),
      connection,
      isDefault: true,
      onChanged: async () => {},
      onDeleted: async () => {},
    }),
  }));
  const edit = harness.document.querySelector<HTMLButtonElement>('button[aria-label="Edit: Service URL"]');
  assert.ok(edit);
  await act(async () => edit.click());
  const input = harness.document.querySelector<HTMLInputElement>('.providerEndpointField input');
  assert.ok(input);
  assert.equal(input.type, 'password');
  assert.equal(harness.document.querySelector('.providerRequestUrlPreview'), null);
  await act(async () => {
    input.value = 'https://relay.example/v1';
    const key = Object.keys(input).find((candidate) => candidate.startsWith('__reactProps$'));
    assert.ok(key);
    const props = (input as unknown as Record<string, unknown>)[key] as {
      onChange(event: { target: HTMLInputElement; defaultPrevented: boolean }): void;
    };
    props.onChange({ target: input, defaultPrevented: false });
  });
  const previews = harness.document.querySelectorAll('.providerRequestUrlPreview');
  assert.equal(previews.length, 1);
  const preview = previews[0]!;
  assert.ok(preview.textContent.endsWith('https://relay.example/v1/responses'));
  const descriptions = describedElements(input);
  assert.ok(descriptions.some((element) => element.textContent.includes(preview.textContent)));
  assert.ok(descriptions.some((element) =>
    element.querySelector('.maka-visually-hidden')?.textContent.trim() === preview.textContent,
  ), 'the accessible copy of the URL must not render a second visible preview');
});

test('credential probing does not flash a page-level loading warning', async () => {
  const harness = installRenderer();
  const credential = deferred<boolean>();
  const bridge = connectionDetailBridge({ hasSecret: () => credential.promise });
  const detail = createElement(components.ConnectionDetail, {
    bridge,
    connection: relayConnection(),
    isDefault: true,
    onChanged: async () => {},
    onDeleted: async () => {},
  });

  await harness.render('zh-CN', createElement(components.RuntimeHostSettingsTarget, {
    host: { profileId: 'local', hostId: 'host-local' },
    children: detail,
  }));

  assert.equal(
    harness.document.body.textContent.includes(
      '正在读取模型凭据状态，读取完成前暂不测试连接或刷新模型。',
    ),
    false,
    'an ordinary in-flight credential read must not insert a transient warning banner',
  );

  await act(async () => {
    credential.resolve(true);
    await credential.promise;
  });
});

test('model rows retain named parameter actions without mounting a tooltip layer per row', async () => {
  const harness = installRenderer();
  const base = relayConnection();
  const models = Array.from({ length: 32 }, (_, index) => ({
    id: `fixture/model-${index + 1}`,
    displayName: `Fixture model ${index + 1}`,
  }));
  const connection: ProjectedLlmConnection = {
    ...base,
    defaultModel: models[0]!.id,
    enabledModelIds: [models[0]!.id],
    models,
    catalogEntries: models.map((model, index) => ({
      ...base.catalogEntries[0]!,
      ...model,
      isDefault: index === 0,
    })),
  };
  await harness.render('zh-CN', createElement(components.RuntimeHostSettingsTarget, {
    host: { profileId: 'local', hostId: 'host-local' },
    children: createElement(components.ConnectionDetail, {
      bridge: connectionDetailBridge({ hasSecret: async () => false }),
      connection,
      isDefault: true,
      onChanged: async () => {},
      onDeleted: async () => {},
    }),
  }));

  const actions = [...harness.document.querySelectorAll<HTMLButtonElement>('span[title="配置参数"] > button')];
  assert.equal(actions.length, models.length);
  for (const [index, action] of actions.entries()) {
    assert.equal(action.getAttribute('aria-label'), `配置模型参数：${models[index]!.displayName}`);
    assert.equal(action.hasAttribute('aria-describedby'), false);
  }
});

test('credential read failures still render the persistent warning', async () => {
  const harness = installRenderer();
  const credential = deferred<boolean>();
  const bridge = connectionDetailBridge({ hasSecret: () => credential.promise });
  const detail = createElement(components.ConnectionDetail, {
    bridge,
    connection: relayConnection(),
    isDefault: true,
    onChanged: async () => {},
    onDeleted: async () => {},
  });

  await harness.render('zh-CN', createElement(components.RuntimeHostSettingsTarget, {
    host: { profileId: 'local', hostId: 'host-local' },
    children: detail,
  }));
  await act(async () => {
    credential.reject(new Error('credential store unavailable'));
    try {
      await credential.promise;
    } catch {
      // The component owns this rejection and turns it into an error state.
    }
  });

  assert.ok(harness.document.body.textContent.includes(
    '模型凭据状态暂时没刷新成功，已避免把未知状态显示成未登录或未配置。',
  ));
});

function unexpectedCall(): never {
  assert.fail('unexpected service call');
}

function deferred<T>() {
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

test('setting a default with one enabled model commits directly', async () => {
  const harness = installRenderer();
  const connection = { ...relayConnection(), defaultModel: '' };
  const calls: unknown[] = [];
  const bridge = connectionDetailBridge({
    hasSecret: async () => true,
    getSnapshot: async () => ({ connections: [connection], defaultConnection: 'relay-a', chatModelChoices: [] }),
    setDefault: async (identity, modelId) => { calls.push([identity, modelId]); },
  });
  await harness.render('zh-CN', providersPanel(bridge, connection.slug));
  await clickText(harness.document, '设为默认');
  assert.deepEqual(calls, [[{ connectionId: connection.connectionId, slug: connection.slug }, connection.enabledModelIds![0]]]);
  assert.equal(harness.document.querySelectorAll('dialog[open]').length, 0);
});

test('a connection with no enabled models asks for a choice and cancel writes nothing', async () => {
  const harness = installRenderer();
  const connection = { ...relayConnection(), defaultModel: '', enabledModelIds: [] };
  const bridge = connectionDetailBridge({
    hasSecret: async () => true,
    getSnapshot: async () => ({ connections: [connection], defaultConnection: 'relay-a', chatModelChoices: [] }),
  });
  await harness.render('zh-CN', providersPanel(bridge, connection.slug));
  await clickText(harness.document, '设为默认');
  const dialog = harness.document.querySelector('dialog[open]');
  assert.ok(dialog);
  assert.match(dialog.textContent!, /这个连接尚未启用模型/);
  const confirm = [...dialog.querySelectorAll('button')].find(button => button.textContent === '设为默认');
  assert.ok(confirm?.disabled);
  await clickText(dialog, '取消');
  assert.equal(harness.document.querySelectorAll('dialog[open]').length, 0);
});

test('choosing an unenabled default keeps the dialog on failure and updates the badge only on success', async () => {
  const harness = installRenderer();
  let connection = { ...relayConnection(), defaultModel: '', enabledModelIds: [] as string[] };
  let defaultConnection = 'relay-a';
  const calls: unknown[] = [];
  const bridge = connectionDetailBridge({
    hasSecret: async () => true,
    getSnapshot: async () => ({ connections: [connection], defaultConnection, chatModelChoices: [] }),
    setDefault: async (identity, modelId) => {
      calls.push([identity, modelId]);
      if (calls.length === 1) throw new Error('DEFAULT_CONNECTION_CHANGED');
      connection = { ...connection, defaultModel: modelId!, enabledModelIds: [modelId!] };
      defaultConnection = connection.slug;
    },
  });
  await harness.render('zh-CN', providersPanel(bridge, connection.slug));
  await clickText(harness.document, '设为默认');
  const selector = harness.document.querySelector<HTMLButtonElement>('dialog[open] [role="combobox"]');
  assert.ok(selector);
  await act(async () => selector.click());
  const option = [...harness.document.querySelectorAll<HTMLElement>('[role="option"]')].find(element => element.textContent?.includes('gpt-5.6-sol-joybuilder'));
  assert.ok(option);
  await act(async () => option.click());
  await clickText(harness.document.querySelector('dialog[open]')!, '启用并设为默认');
  assert.equal(defaultConnection, 'relay-a');
  assert.match(harness.document.querySelector('dialog[open]')!.textContent!, /连接配置已更新/);
  await clickText(harness.document.querySelector('dialog[open]')!, '启用并设为默认');
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1], [{ connectionId: connection.connectionId, slug: connection.slug }, 'gpt-5.6-sol-joybuilder']);
  assert.equal(defaultConnection, connection.slug);
  assert.equal(harness.document.querySelectorAll('dialog[open]').length, 0);
  assert.equal(harness.document.querySelector('.settingsActionSlotBadge')?.textContent, '默认');
});

test('fetching choices in the default dialog preserves the selection and offers every discovered model', async () => {
  const harness = installRenderer();
  let connection: ProjectedLlmConnection = { ...relayConnection(), defaultModel: '', enabledModelIds: [], models: [], catalogEntries: [] };
  const bridge = connectionDetailBridge({
    hasSecret: async () => true,
    getSnapshot: async () => ({ connections: [connection], defaultConnection: 'relay-a', chatModelChoices: [] }),
    fetchModels: async (identity, options) => {
      assert.deepEqual(identity, { connectionId: connection.connectionId, slug: connection.slug });
      assert.deepEqual(options, { preserveSelection: true });
      connection = { ...connection, models: [{ id: 'discovered-first' }, { id: 'discovered-second' }],
        catalogEntries: ['discovered-first', 'discovered-second'].map(id => ({ ...relayConnection().catalogEntries[0]!, id, isDefault: false })),
      };
      return { models: connection.models!, source: 'fetched' };
    },
  });
  await harness.render('zh-CN', providersPanel(bridge, connection.slug));
  await clickText(harness.document, '设为默认');
  await clickText(harness.document.querySelector('dialog[open]')!, '获取模型');
  const selector = harness.document.querySelector<HTMLButtonElement>('dialog[open] [role="combobox"]');
  assert.ok(selector);
  await act(async () => selector.click());
  const offered = [...harness.document.querySelectorAll('[role="option"]')].map(option => option.textContent);
  assert.ok(offered.includes('discovered-first'));
  assert.ok(offered.includes('discovered-second'));
  await clickText(harness.document.querySelector('dialog[open]')!, '取消');
  assert.deepEqual(connection.enabledModelIds, []);
});

test('multiple enabled models require a choice, and an empty catalog offers model setup', async () => {
  const harness = installRenderer();
  let connection: ProjectedLlmConnection = { ...relayConnection(), defaultModel: '',
    enabledModelIds: ['first', 'second'],
    catalogEntries: ['first', 'second'].map(id => ({ ...relayConnection().catalogEntries[0]!, id, isDefault: false })),
  };
  const bridge = connectionDetailBridge({
    hasSecret: async () => true,
    getSnapshot: async () => ({ connections: [connection], defaultConnection: 'relay-a', chatModelChoices: [] }),
    fetchModels: async () => {
      connection = { ...relayConnection(), defaultModel: '', enabledModelIds: [] };
      return { models: connection.models!, source: 'fetched' };
    },
  });
  await harness.render('zh-CN', providersPanel(bridge, connection.slug));
  await clickText(harness.document, '设为默认');
  assert.match(harness.document.querySelector('dialog[open]')!.textContent!, /选择这个连接用于新任务/);
  await clickText(harness.document.querySelector('dialog[open]')!, '取消');
  connection = { ...connection, connectionId: 'empty-relay', slug: 'empty-relay', models: [], catalogEntries: [], enabledModelIds: [] };
  // A new panel instance reads the empty connection instead of reusing the old route.
  await harness.render('zh-CN', providersPanel(bridge, connection.slug, 'empty'));
  await clickText(harness.document, '设为默认');
  assert.match(harness.document.querySelector('dialog[open]')!.textContent!, /请先获取或手动添加模型/);
  await clickText(harness.document.querySelector('dialog[open]')!, '手动添加模型');
  assert.match(harness.document.querySelector('dialog[open]')!.textContent!, /模型 ID/);
});

function providersPanel(bridge: ConnectionsBridge, slug: string, key?: string) {
  return createElement(components.RuntimeHostSettingsTarget, {
    host: { profileId: 'local', hostId: 'host-local' },
    children: createElement(components.ProvidersPanel, { key, bridge, initialConnectionSlug: slug }),
  });
}

async function clickText(container: ParentNode, label: string) {
  const button = [...container.querySelectorAll('button')].find(button => button.textContent === label);
  assert.ok(button, `missing button: ${label}`);
  await act(async () => button.click());
}

function relayConnection(): ProjectedLlmConnection {
  const modelId = 'gpt-5.6-sol-joybuilder';
  return {
    connectionId: 'relay-connection',
    slug: 'custom-2',
    name: '自定义中转站（OpenAI Responses）',
    providerType: 'custom',
    defaultApiProtocol: 'openai-responses',
    baseUrl: 'https://relay.example/v1',
    defaultModel: modelId,
    enabledModelIds: [modelId],
    enabled: true,
    models: [{ id: modelId }],
    modelSource: 'fetched',
    createdAt: 1,
    updatedAt: 1,
    catalogEntries: [{
      id: modelId,
      canUseAsChatDefault: true,
      isDefault: true,
      supportsVision: false,
      thinkingLevels: [],
    }],
  };
}

function connectionDetailBridge(overrides: Partial<ConnectionsBridge>): ConnectionsBridge {
  return {
    oauth: {} as ConnectionsBridge['oauth'],
    getSnapshot: unexpectedCall,
    setDefault: unexpectedCall,
    create: unexpectedCall,
    update: unexpectedCall,
    delete: unexpectedCall,
    test: unexpectedCall,
    fetchModels: unexpectedCall,
    hasSecret: unexpectedCall,
    getRequestHeaders: async () => ({ names: [] }),
    setRequestHeaders: unexpectedCall,
    ...overrides,
  };
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
    handoff: {
      current: async () => null,
      subscribe: () => () => {},
      decide: unexpectedCall,
      copyText: unexpectedCall,
    },
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
    showModal(this: HTMLElement & { open: boolean }) { this.open = true; this.setAttribute('open', ''); },
    close(this: HTMLElement & { open: boolean }) { this.open = false; this.removeAttribute('open'); },
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
