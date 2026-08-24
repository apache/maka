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

import { useEffect, useRef, type ReactNode } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { Layout, LayoutContent, LayoutHeader } from '@astryxdesign/core';
import { ToastProvider } from '@maka/ui';
import type {
  ConnectionTestResult,
  LlmConnection,
  ModelDiscoveryResult,
  ProviderType,
} from '@maka/core/llm-connections';
import { buildChatModelChoices } from '@maka/core/chat-model-choice';
import { ProvidersPanel, type ConnectionsBridge } from '../../src/renderer/settings/providers-panel';
import { RuntimeHostSettingsTarget } from '../../src/renderer/settings/runtime-host-settings-target';
import { SettingsPage } from '../../src/renderer/settings/settings-section';

const NOW = Date.parse('2026-07-01T08:00:00Z');

// Fidelity convention (#1433): every story below names the real app path
// that reaches it. See apps/desktop/stories/FIDELITY.md.

const meta = {
  title: 'Product/Settings/Providers',
  parameters: {
    layout: 'fullscreen',
  },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;
type AutoOpenTarget =
  | 'detail'
  | 'detail-static'
  | 'detail-relay'
  | 'add'
  | 'catalog'
  | 'oauth'
  | 'xai-device';

function makeConnection(input: {
  slug: string;
  name: string;
  providerType: ProviderType;
  baseUrl?: string;
  defaultModel?: string;
  enabled?: boolean;
  lastTestStatus?: LlmConnection['lastTestStatus'];
  lastTestMessage?: string;
  models?: LlmConnection['models'];
  modelSource?: LlmConnection['modelSource'];
}): LlmConnection {
  return {
    slug: input.slug,
    name: input.name,
    providerType: input.providerType,
    ...(input.baseUrl ? { baseUrl: input.baseUrl } : {}),
    defaultModel: input.defaultModel ?? 'glm-4.7',
    enabled: input.enabled ?? true,
    ...(input.models ? { models: input.models } : {}),
    ...(input.modelSource ? { modelSource: input.modelSource } : {}),
    modelsFetchedAt: NOW - 18 * 60 * 1000,
    ...(input.lastTestStatus ? { lastTestStatus: input.lastTestStatus } : {}),
    lastTestAt: new Date(NOW - 12 * 60 * 1000).toISOString(),
    ...(input.lastTestMessage ? { lastTestMessage: input.lastTestMessage } : {}),
    createdAt: NOW - 6 * 24 * 60 * 60 * 1000,
    updatedAt: NOW - 12 * 60 * 1000,
  };
}

const configuredConnections = [
  makeConnection({
    slug: 'zai-live',
    name: 'Z.AI Live',
    providerType: 'zai-coding-plan',
    defaultModel: 'glm-4.7',
    lastTestStatus: 'verified',
    models: [
      { id: 'glm-4.7', displayName: 'GLM 4.7' },
      { id: 'glm-4.6', displayName: 'GLM 4.6' },
    ],
    modelSource: 'fetched',
  }),
  makeConnection({
    slug: 'zai-bench',
    name: 'Z.AI Bench',
    providerType: 'zai-coding-plan',
    defaultModel: 'glm-4.6',
  }),
  makeConnection({
    slug: 'openai-review',
    name: 'OpenAI Review',
    providerType: 'openai',
    defaultModel: 'gpt-5',
    lastTestStatus: 'verified',
    models: [
      { id: 'gpt-5', displayName: 'GPT-5' },
      { id: 'gpt-4o', displayName: 'GPT-4o' },
    ],
    modelSource: 'fetched',
  }),
  makeConnection({
    slug: 'ollama-local',
    name: 'Ollama Local',
    providerType: 'ollama',
    defaultModel: 'qwen2.5-coder',
    lastTestStatus: 'verified',
  }),
];

// A provider whose key cannot call a model-list endpoint: refresh replays the
// array this build shipped, so 添加模型 replaces 更新模型目录 as the only way the
// catalog can grow. `deepseek-v4-pro-beta` is a model added that way — absent
// from `models`, declared in `relayModelProfiles` (#1584).
const staticCatalogConnections = [
  {
    ...makeConnection({
      slug: 'ark-plan',
      name: 'Ark Agent Plan',
      providerType: 'volcengine-agent-plan',
      defaultModel: 'doubao-seed-2.1-turbo',
      lastTestStatus: 'verified',
      models: [{ id: 'doubao-seed-2.1-turbo' }, { id: 'kimi-k2.6' }],
      modelSource: 'fetched',
    }),
    enabledModelIds: ['doubao-seed-2.1-turbo', 'deepseek-v4-pro-beta'],
    relayModelProfiles: { 'deepseek-v4-pro-beta': { contextWindow: 262_144 } },
  },
];

// A custom relay fronting one model family. Capability declarations are a
// relay-only surface — a built-in provider's thinking support comes from
// bundled metadata — and the family shares one `reasoning_effort` vocabulary,
// which is the case the bulk control exists for. `deepseek-r2` already
// declares two levels so the story shows partial coverage, not just the
// all-or-nothing ends.
const relayConnections = [
  {
    ...makeConnection({
      slug: 'relay-house',
      name: 'House Relay',
      providerType: 'openai-compatible',
      baseUrl: 'https://relay.example.com/v1',
      defaultModel: 'deepseek-r2',
      lastTestStatus: 'verified',
      models: [
        { id: 'deepseek-r2' },
        { id: 'deepseek-v4' },
        { id: 'qwen3-max-thinking' },
        { id: 'kimi-k2.6' },
      ],
      modelSource: 'fetched',
    }),
    enabledModelIds: ['deepseek-r2', 'deepseek-v4', 'qwen3-max-thinking', 'kimi-k2.6'],
    relayModelProfiles: { 'deepseek-r2': { thinkingLevels: ['low', 'high'] as const } },
  },
];

const problemConnections = [
  configuredConnections[0],
  makeConnection({
    slug: 'claude-subscription',
    name: 'Claude Code',
    providerType: 'claude-subscription',
    defaultModel: 'claude-sonnet-4-5-20250929',
    enabled: false,
    lastTestStatus: 'needs_reauth',
    lastTestMessage: '订阅账号需要重新登录。',
  }),
  makeConnection({
    slug: 'openai-rate-limit',
    name: 'OpenAI Rate Limited',
    providerType: 'openai',
    defaultModel: 'gpt-5',
    lastTestStatus: 'error',
    lastTestMessage: '上次验证触发 429 限流。',
  }),
];

function createBridge(input: {
  connections?: LlmConnection[];
  defaultSlug?: string | null;
  failLoad?: boolean;
  loading?: boolean;
}): ConnectionsBridge {
  let connections = [...(input.connections ?? [])];
  let defaultSlug: string | null = input.defaultSlug ?? connections[0]?.slug ?? null;

  return {
    async getSnapshot() {
      if (input.loading) return new Promise<never>(() => undefined);
      if (input.failLoad) throw new Error('模型连接服务暂时不可用');
      return {
        connections,
        defaultConnection: defaultSlug,
        chatModelChoices: buildChatModelChoices(connections),
      };
    },
    async setDefault(slug) {
      defaultSlug = slug;
    },
    async create(next) {
      const connection = makeConnection({
        slug: next.slug,
        name: next.name,
        providerType: next.providerType,
        baseUrl: next.baseUrl,
        defaultModel: next.defaultModel,
        lastTestStatus: 'verified',
      });
      connections = [...connections, connection];
      defaultSlug ??= connection.slug;
      return connection;
    },
    async update(slug, patch) {
      const current = connections.find((connection) => connection.slug === slug);
      if (!current) throw new Error('连接不存在');
      const updated: LlmConnection = {
        ...current,
        ...patch,
        // UpdateConnectionInput.relayModelProfiles is tri-state (null clears);
        // a stored connection never carries null — clear maps to absent.
        relayModelProfiles:
          patch.relayModelProfiles === undefined
            ? current.relayModelProfiles
            : (patch.relayModelProfiles ?? undefined),
        requestBodyOverlay:
          patch.requestBodyOverlay === undefined
            ? current.requestBodyOverlay
            : (patch.requestBodyOverlay ?? undefined),
        updatedAt: NOW,
      };
      connections = connections.map((connection) => connection.slug === slug ? updated : connection);
      return updated;
    },
    async delete(slug) {
      connections = connections.filter((connection) => connection.slug !== slug);
      if (defaultSlug === slug) defaultSlug = connections[0]?.slug ?? null;
    },
    async test(slug): Promise<ConnectionTestResult> {
      if (slug.includes('rate-limit')) {
        return {
          ok: false,
          statusCode: 429,
          errorClass: 'provider_unavailable',
          errorMessage: 'rate limit',
        };
      }
      return { ok: true, latencyMs: 328, modelTested: 'glm-4.7' };
    },
    async fetchModels(slug): Promise<ModelDiscoveryResult> {
      return {
        models: [
          { id: slug.includes('openai') ? 'gpt-5' : 'glm-4.7' },
          { id: slug.includes('openai') ? 'gpt-4o' : 'glm-4.6' },
        ],
        source: 'fetched',
        fetchedAt: NOW,
      };
    },
    async hasSecret() {
      return true;
    },
    async getRequestHeaders() {
      return { names: [] };
    },
    async setRequestHeaders(_slug, headers) {
      return { names: headers.map(({ name }) => name) };
    },
    subscribeEvents() {
      return () => undefined;
    },
  };
}

function installSubscriptionFixtures() {
  const target = window as unknown as {
    maka?: Record<string, unknown>;
  };
  target.maka = {
    ...(target.maka ?? {}),
    openAiCodex: browserSubscriptionFixture({
      runtimeState: 'authenticated',
      email: 'codex@example.com',
      plan: 'Plus',
    }),
    githubCopilotSubscription: browserSubscriptionFixture({
      runtimeState: 'not_logged_in',
    }),
    xaiOAuth: xaiDeviceSubscriptionFixture(),
  };
}

function xaiDeviceSubscriptionFixture() {
  return {
    getAccountState: async () => ({ provider: 'xai-oauth', runtimeState: 'authorizing' }),
    getAuthUrl: async () => ({ authRequestId: 'storybook-xai', stateHint: 'ABCD-EFGH' }),
    openAuthUrl: async () => ({ ok: true }),
    completeAuthorization: async () => new Promise<never>(() => undefined),
    cancelAuthorization: async () => ({ ok: true }),
    logout: async () => ({ ok: true }),
  };
}

function browserSubscriptionFixture(state: {
  runtimeState: string;
  email?: string;
  plan?: string;
  errorMessage?: string;
}) {
  return {
    getAccountState: async () => state,
    getAuthUrl: async () => ({ authRequestId: 'storybook-oauth', stateHint: 'storybook' }),
    openAuthUrl: async () => ({ ok: true }),
    completeAuthorization: async () => ({ ok: true }),
    cancelAuthorization: async () => ({ ok: true }),
    logout: async () => ({ ok: true }),
  };
}

function ProviderStoryFrame(props: {
  bridge: ConnectionsBridge;
  autoOpen?: AutoOpenTarget;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const clickedRef = useRef(false);

  useEffect(() => {
    installSubscriptionFixtures();
  }, []);

  useEffect(() => {
    const autoOpen = props.autoOpen;
    if (!autoOpen) return;
    clickedRef.current = false;
    const interval = window.setInterval(() => {
      if (clickedRef.current) return;
      const root = rootRef.current;
      if (!root) return;
      clickedRef.current = clickAutoOpenTarget(root, autoOpen);
      if (clickedRef.current) window.clearInterval(interval);
    }, 60);
    return () => window.clearInterval(interval);
  }, [props.autoOpen, props.bridge]);

  return (
    <ToastProvider>
      <div
        ref={rootRef}
        className="settingsSurface"
        data-modal="true"
        data-maka-e2e-fixture="true"
        style={{
          gridTemplateColumns: 'minmax(0, 1fr)',
          height: 700,
          margin: '0 auto',
          maxWidth: 1040,
          minHeight: 0,
          overflow: 'hidden',
          width: '100%',
        }}
      >
        <section className="settingsMainPane" data-agents-view="settings">
          {/* The same Layout settings-surface.tsx wraps every settings page in,
              contentWidth included — without it the story renders forms at the
              window's width and hides exactly the layout question a page-level
              form raises. */}
          <Layout
            height="auto"
            padding={0}
            contentWidth={920}
            header={(
              <LayoutHeader padding={6}>
                <div className="settingsPageHeader">
                  <div className="settingsPageHeaderTitleStack">
                    <h2>模型</h2>
                  </div>
                </div>
              </LayoutHeader>
            )}
            content={(
              <LayoutContent padding={6} isScrollable={false}>
                <SettingsPage className="settingsModelsPage">
                  <ProvidersPanel bridge={props.bridge} />
                </SettingsPage>
              </LayoutContent>
            )}
          />
        </section>
      </div>
    </ToastProvider>
  );
}

/** Every level is a page inside the story root now, so nothing is looked up on
 *  `document` — the story renders what the story frame contains. */
function catalogRoot(root: HTMLElement): HTMLElement | null {
  return root.querySelector<HTMLElement>('[data-maka-contract="provider-catalog"]');
}

/** Walk to the catalog level, returning it once it is on screen. */
function reachCatalog(root: HTMLElement): HTMLElement | null {
  const catalog = catalogRoot(root);
  if (catalog) return catalog;
  root.querySelector<HTMLButtonElement>('button[data-maka-contract="add-connection"]')?.click();
  return null;
}

function clickAutoOpenTarget(root: HTMLElement, target: AutoOpenTarget): boolean {
  if (target === 'detail' || target === 'detail-static' || target === 'detail-relay') {
    // ListItem's clickable surface is an invisible button inside the row, so
    // the row is located by its slug hook and the button taken from within it.
    const slug =
      target === 'detail' ? 'zai-live' : target === 'detail-static' ? 'ark-plan' : 'relay-house';
    const row = root.querySelector<HTMLElement>(`[data-connection-slug="${slug}"]`);
    const detailButton = row?.querySelector('button') ?? null;
    detailButton?.click();
    return Boolean(detailButton);
  }
  if (target === 'catalog' || target === 'oauth') {
    // Account sign-ins are rows in the catalog, not a tab on the page, so both
    // targets rest on the catalog level itself.
    return Boolean(reachCatalog(root));
  }
  if (target === 'xai-device') {
    const setup = root.querySelector<HTMLElement>('[data-maka-contract="provider-setup"]');
    if (!setup) {
      const catalog = reachCatalog(root);
      catalog?.querySelector<HTMLElement>('[data-card-id="xai"]')?.querySelector('button')?.click();
      return false;
    }
    const code = setup.querySelector('code');
    if (code?.textContent?.trim() === 'ABCD-EFGH') return true;
    const loginButton = Array.from(setup.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent?.includes('SuperGrok / X Premium'));
    if (loginButton && !loginButton.disabled) loginButton.click();
    return false;
  }

  // 'add': walk to the catalog, then into one provider's form.
  const catalog = reachCatalog(root);
  if (!catalog) return false;
  const providerRow = catalog.querySelector<HTMLElement>('[data-provider="deepseek"]')?.querySelector('button') ?? null;
  providerRow?.click();
  return Boolean(providerRow);
}

function ProviderStory(props: {
  bridge: ConnectionsBridge;
  autoOpen?: AutoOpenTarget;
}): ReactNode {
  return (
    <RuntimeHostSettingsTarget host={{ profileId: 'local', hostId: 'storybook-local-host' }}>
      <ProviderStoryFrame bridge={props.bridge} autoOpen={props.autoOpen} />
    </RuntimeHostSettingsTarget>
  );
}

// Real path: same page with several healthy connections and one of them set as default.
export const ConfiguredProviders: Story = {
  render: () => <ProviderStory bridge={createBridge({ connections: configuredConnections, defaultSlug: 'zai-live' })} />,
};

// Real path: same page when connections need attention — missing credentials, a failed
// probe, or an expired OAuth session.
export const ProblemConnections: Story = {
  render: () => <ProviderStory bridge={createBridge({ connections: problemConnections, defaultSlug: 'zai-live' })} />,
};

// Real path: 设置 → 模型 → click a connection row — the detail page it routes to.
export const ConnectionDetailPage: Story = {
  render: () => (
    <ProviderStory
      bridge={createBridge({ connections: configuredConnections, defaultSlug: 'zai-live' })}
      autoOpen="detail"
    />
  ),
};

// Real path: 设置 → 模型 → click a connection whose provider has no model-list
// endpoint — 添加模型 stands where 更新模型目录 would, and the capability section
// lists the models Maka's bundled metadata cannot describe.
export const StaticCatalogConnectionDetail: Story = {
  render: () => (
    <ProviderStory
      bridge={createBridge({ connections: staticCatalogConnections, defaultSlug: 'ark-plan' })}
      autoOpen="detail-static"
    />
  ),
};

// Real path: 设置 → 模型 → click a custom relay — the capability section with
// several enabled models, where 批量设置思考档位 sits above the per-model rows it
// writes into. Opening its menu shows each level's coverage across the table:
// `low` and `high` on 1 of 4, everything else on none.
export const RelayConnectionDetail: Story = {
  render: () => (
    <ProviderStory
      bridge={createBridge({ connections: relayConnections, defaultSlug: 'relay-house' })}
      autoOpen="detail-relay"
    />
  ),
  // Opens the batch menu and asserts that partial coverage reaches assistive
  // technology, not only the eye. The item carries its own `aria-label`, which
  // replaces the accessible name the visible description would otherwise have
  // joined — and the menu item does not wire `description` to
  // `aria-describedby`. Without an explicit description, "1/4 个模型" and
  // "全部未声明" both reach a screen reader as an unchecked box with the same
  // name, which is exactly the state the count exists to distinguish.
  play: async ({ canvasElement }) => {
    const body = within(canvasElement.ownerDocument.body);
    const trigger = await body.findByRole('button', { name: /批量设置思考档位/ });
    await userEvent.click(trigger);

    // `low` is declared by one of the four models; `minimal` by none.
    const partial = await body.findByRole('menuitemcheckbox', {
      name: '批量设置思考档位 low',
    });
    const none = await body.findByRole('menuitemcheckbox', {
      name: '批量设置思考档位 minimal',
    });

    // Both are unchecked — coverage is the only thing separating them.
    await expect(partial).toHaveAttribute('aria-checked', 'false');
    await expect(none).toHaveAttribute('aria-checked', 'false');
    await expect(partial).toHaveAttribute('aria-description', '1/4 个模型');
    await expect(none).toHaveAttribute('aria-description', '全部未声明');
  },
};

// Real path: 设置 → 模型 → 添加连接 — level two, the provider catalog.
export const AddConnectionCatalog: Story = {
  render: () => (
    <ProviderStory
      bridge={createBridge({ connections: configuredConnections, defaultSlug: 'zai-live' })}
      autoOpen="catalog"
    />
  ),
};

// Real path: 设置 → 模型 → 添加连接 → pick a provider — level three, its form.
export const AddProvider: Story = {
  render: () => (
    <ProviderStory
      bridge={createBridge({ connections: configuredConnections, defaultSlug: 'zai-live' })}
      autoOpen="add"
    />
  ),
};
