import { type ComponentProps, type ReactNode } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import type { LlmConnection, OnboardingState, ProviderType, SettingsSection } from '@maka/core';
import { ChatSurfaceLayout, ChatView } from '@maka/ui';
import { expect, fn, userEvent, within } from 'storybook/test';
import { OnboardingHero } from '../src/renderer/onboarding-hero';

const meta = {
  title: 'Product/Onboarding',
  parameters: { layout: 'fullscreen' },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

const MAKA_WINDOW_FLOOR_VIEWPORT = {
  makaWindowFloor: {
    name: 'Maka window floor',
    styles: { width: '480px', height: '900px' },
    type: 'desktop' as const,
  },
};

function makeConnection(input: {
  slug: string;
  name: string;
  providerType: ProviderType;
}): LlmConnection {
  return {
    slug: input.slug,
    name: input.name,
    providerType: input.providerType,
    defaultModel: 'glm-4.7',
    enabled: true,
    modelsFetchedAt: Date.now() - 60_000,
    lastTestAt: new Date(Date.now() - 60_000).toISOString(),
    createdAt: Date.now() - 6 * 24 * 60 * 60 * 1000,
    updatedAt: Date.now() - 60_000,
  };
}

const connections: LlmConnection[] = [
  makeConnection({ slug: 'zai-live', name: 'Z.AI Live', providerType: 'zai-coding-plan' }),
  makeConnection({ slug: 'openai-review', name: 'OpenAI Review', providerType: 'openai' }),
];

/**
 * Everything from `<main>` inward is the real ChatView empty-state path. The
 * three wrappers outside it mirror the app shell because app-shell.tsx itself
 * cannot be mounted as a story without its main-process orchestration.
 */
function DetailPane(props: { children?: ReactNode }) {
  const emptyOverride = props.children === undefined
    ? undefined
    : <div className="maka-onboarding-surface">{props.children}</div>;
  return (
    <div
      className="app maka-shell-astryx agents-layout-body"
      data-sidebar-state="expanded"
      style={{ background: 'var(--surface-canvas)', height: '100%', minHeight: 560 }}
    >
      <div
        className="maka-panel maka-panel-detail agents-parchment-paper-surface"
        data-agents-view="im_hub"
      >
        <div className="maka-detail-with-artifacts">
          <div className="mainColumn" data-home-surface="true">
            <ChatSurfaceLayout composer={null}>
              <ChatView messages={[]} onNew={() => undefined} emptyOverride={emptyOverride} />
            </ChatSurfaceLayout>
          </div>
        </div>
      </div>
    </div>
  );
}

function heroProps(
  state: OnboardingState,
  overrides: Partial<ComponentProps<typeof OnboardingHero>> = {},
): ComponentProps<typeof OnboardingHero> {
  return {
    state,
    onOpenSettings: (_section?: SettingsSection) => undefined,
    onOpenConnectionDetail: (_connectionSlug: string) => undefined,
    onAddProvider: () => undefined,
    onBrowseProviders: () => undefined,
    connections,
    onRefreshConnections: async () => undefined,
    onSkip: () => undefined,
    ...overrides,
  };
}

// Real path: a fresh workspace has no model connection and no sessions.
export const NeedsConnection: Story = {
  render: () => (
    <DetailPane>
      <OnboardingHero {...heroProps({ kind: 'needs_connection' })} />
    </DetailPane>
  ),
  play: async ({ canvasElement }) => {
    const providerRow = canvasElement.querySelector<HTMLElement>('.maka-onboarding-provider-row');
    await expect(providerRow).not.toBeNull();
    const style = getComputedStyle(providerRow as HTMLElement);
    await expect(style.paddingTop).toBe('8px');
    await expect(style.paddingRight).toBe('8px');
    await expect(canvasElement.querySelectorAll('[data-maka-contract="onboarding-card"]')).toHaveLength(1);

    const chatLayout = canvasElement.querySelector<HTMLElement>('[data-chat-scroll-container="true"]');
    const composerDock = chatLayout?.lastElementChild;
    await expect(composerDock).toBeInstanceOf(HTMLElement);
    await expect(getComputedStyle(composerDock as HTMLElement).display).toBe('none');
  },
};

const openConnectionDetail = fn();

// Real path: a configured connection exists but its credential is unavailable.
export const NeedsCredentials: Story = {
  render: () => (
    <DetailPane>
      <OnboardingHero
        {...heroProps(
          { kind: 'needs_connection_credentials', connectionSlug: 'zai-live' },
          { onOpenConnectionDetail: openConnectionDetail },
        )}
      />
    </DetailPane>
  ),
  play: async ({ canvasElement }) => {
    openConnectionDetail.mockClear();
    await userEvent.click(within(canvasElement).getByRole('button', { name: '配置连接凭据' }));
    await expect(openConnectionDetail).toHaveBeenCalledWith('zai-live');
  },
};

// Real path: the snapshot references a connection before the renderer list catches up.
export const NeedsCredentialsUnknownSlug: Story = {
  render: () => (
    <DetailPane>
      <OnboardingHero
        {...heroProps(
          { kind: 'needs_connection_credentials', connectionSlug: 'ghost-connection' },
          { connections: [] },
        )}
      />
    </DetailPane>
  ),
};

// Real path: credentials work but the connection has no chat-capable enabled model.
export const NeedsModel: Story = {
  render: () => (
    <DetailPane>
      <OnboardingHero
        {...heroProps({ kind: 'needs_model', connectionSlug: 'zai-live' })}
      />
    </DetailPane>
  ),
};

// Real path: every configured connection fails readiness checks.
export const Blocked: Story = {
  render: () => (
    <DetailPane>
      <OnboardingHero
        {...heroProps({ kind: 'blocked', reason: 'all_connections_unhealthy' })}
      />
    </DetailPane>
  ),
};

// Real path: a configured workspace with no sessions gets the ordinary empty chat.
export const ReadyEmpty: Story = {
  render: () => <DetailPane />,
};

// Real path: the desktop window is at its 480px width floor during first run.
export const NarrowWindow: Story = {
  parameters: { viewport: { options: MAKA_WINDOW_FLOOR_VIEWPORT } },
  globals: { viewport: { value: 'makaWindowFloor', isRotated: false } },
  render: () => (
    <DetailPane>
      <OnboardingHero {...heroProps({ kind: 'needs_connection' })} />
    </DetailPane>
  ),
};
