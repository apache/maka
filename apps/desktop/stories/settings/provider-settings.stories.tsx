import { useEffect, useRef, type ReactNode } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { ToastProvider } from '@maka/ui';
import type {
  ConnectionTestResult,
  LlmConnection,
  ModelDiscoveryResult,
  ProviderType,
} from '@maka/core';
import { ProvidersPanel, type ConnectionsBridge } from '../../src/renderer/settings/ProvidersPanel';

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
type AutoOpenTarget = 'detail' | 'add' | 'oauth' | 'xai-device';

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
    async list() {
      if (input.loading) return new Promise<LlmConnection[]>(() => undefined);
      if (input.failLoad) throw new Error('模型连接服务暂时不可用');
      return connections;
    },
    async getDefault() {
      if (input.loading) return new Promise<string | null>(() => undefined);
      return defaultSlug;
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
    claudeSubscription: {
      getAccountState: async () => ({
        runtimeState: 'authenticated',
        profile: { email: 'claude@example.com' },
      }),
      isExperimentalEnabled: async () => true,
      getAuthUrl: async () => ({ authRequestId: 'storybook-claude', stateHint: 'storybook' }),
      openAuthUrl: async () => ({ ok: true }),
      completeAuthorization: async () => ({ ok: true }),
      cancelAuthorization: async () => ({ ok: true }),
      logout: async () => ({ ok: true }),
      refreshQuota: async () => ({ ok: true }),
    },
    openAiCodex: browserSubscriptionFixture({
      runtimeState: 'authenticated',
      email: 'codex@example.com',
      plan: 'Plus',
    }),
    githubCopilotSubscription: browserSubscriptionFixture({
      runtimeState: 'not_logged_in',
    }),
    xaiOAuth: xaiDeviceSubscriptionFixture(),
    cursorSubscription: browserSubscriptionFixture({
      runtimeState: 'not_logged_in',
    }),
    antigravitySubscription: browserSubscriptionFixture({
      runtimeState: 'storage_failed',
      errorMessage: '需要 Google client_id 后才能完成登录。',
    }),
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
          <div className="settingsPageContent" style={{ overflow: 'auto' }}>
            <div className="settingsPageContentInner">
              <div className="settingsStructuredPage settingsModelsPage">
                <ProvidersPanel bridge={props.bridge} />
              </div>
            </div>
          </div>
        </section>
      </div>
    </ToastProvider>
  );
}

function clickAutoOpenTarget(root: HTMLElement, target: AutoOpenTarget): boolean {
  if (target === 'detail') {
    const detailButton = root.querySelector<HTMLButtonElement>('button[aria-label*="模型连接：Z.AI Live"]');
    detailButton?.click();
    return Boolean(detailButton);
  }
  if (target === 'oauth') {
    const oauthTab = root.querySelector<HTMLButtonElement>('button[data-catalog-tab="oauth"]');
    oauthTab?.click();
    return Boolean(oauthTab);
  }
  if (target === 'xai-device') {
    const dialog = document.querySelector<HTMLElement>(
      '[aria-labelledby="provider-connection-dialog-xai-oauth"]',
    );
    if (dialog) {
      const code = dialog.querySelector('code');
      if (code?.textContent?.trim() === 'ABCD-EFGH') return true;
      const loginButton = Array.from(dialog.querySelectorAll<HTMLButtonElement>('button'))
        .find((button) => button.textContent?.includes('SuperGrok / X Premium'));
      if (loginButton && !loginButton.disabled) loginButton.click();
      return false;
    }
    const xaiCard = root.querySelector<HTMLButtonElement>('button[data-card-id="xai"]');
    if (xaiCard) {
      xaiCard.click();
      return false;
    }
    root.querySelector<HTMLButtonElement>('button[data-catalog-tab="oauth"]')?.click();
    return false;
  }

  const addButton = Array.from(root.querySelectorAll<HTMLButtonElement>('button'))
    .find((button) => button.textContent?.trim() === '自定义');
  addButton?.click();
  return Boolean(addButton);
}

function ProviderStory(props: {
  bridge: ConnectionsBridge;
  autoOpen?: AutoOpenTarget;
}): ReactNode {
  return <ProviderStoryFrame bridge={props.bridge} autoOpen={props.autoOpen} />;
}

// Real path: 设置 → 模型, while the connection list is still loading.
export const Loading: Story = {
  render: () => <ProviderStory bridge={createBridge({ loading: true })} />,
};

// Real path: same page when the connection list fails to load.
export const LoadError: Story = {
  render: () => <ProviderStory bridge={createBridge({ failLoad: true })} />,
};

// Real path: same page on a fresh install, with no connection configured yet.
export const Empty: Story = {
  render: () => <ProviderStory bridge={createBridge({ connections: [], defaultSlug: null })} />,
};

// Real path: same page with several healthy connections and one of them set as default.
export const ConfiguredProviders: Story = {
  render: () => <ProviderStory bridge={createBridge({ connections: configuredConnections, defaultSlug: 'zai-live' })} />,
};

// Real path: same page when connections need attention — missing credentials, a failed
// probe, or an expired OAuth session.
export const ProblemConnections: Story = {
  render: () => <ProviderStory bridge={createBridge({ connections: problemConnections, defaultSlug: 'zai-live' })} />,
};

// Real path: 设置 → 模型 → click a connection → its detail panel.
export const SelectedDetail: Story = {
  render: () => (
    <ProviderStory
      bridge={createBridge({ connections: configuredConnections, defaultSlug: 'zai-live' })}
      autoOpen="detail"
    />
  ),
};

// Real path: 设置 → 模型 → 添加 → the provider catalog and the add form.
export const AddProvider: Story = {
  render: () => (
    <ProviderStory
      bridge={createBridge({ connections: configuredConnections, defaultSlug: 'zai-live' })}
      autoOpen="add"
    />
  ),
};

// Real path: 设置 → 模型 → the OAuth subscription cards, shown here in their needs-attention
// state.
export const OAuthCards: Story = {
  render: () => (
    <ProviderStory
      bridge={createBridge({ connections: problemConnections, defaultSlug: 'zai-live' })}
      autoOpen="oauth"
    />
  ),
};

// Real path: 设置 → 模型 → 账号 → xAI Grok → 登录, while the RFC 8628
// device flow waits for the user to enter the displayed code in the browser.
export const XaiDeviceAuthorization: Story = {
  render: () => (
    <ProviderStory
      bridge={createBridge({ connections: configuredConnections, defaultSlug: 'zai-live' })}
      autoOpen="xai-device"
    />
  ),
};
