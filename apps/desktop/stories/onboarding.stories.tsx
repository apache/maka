import { type ReactNode } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import type { LlmConnection, OnboardingState, ProviderType, SettingsSection } from '@maka/core';
import { OnboardingHero } from '../src/renderer/OnboardingHero';

const meta = {
  title: 'Product/Onboarding',
  parameters: {
    layout: 'fullscreen',
  },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

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

function DetailPane(props: { children: ReactNode }) {
  return (
    <div
      data-maka-e2e-fixture="true"
      style={{
        background: 'var(--surface-canvas)',
        height: '100%',
        minHeight: 560,
      }}
    >
      <div
        className="maka-panel maka-panel-detail maka-floating-panel agents-content-area agents-parchment-paper-surface"
        style={{ height: '100%', overflow: 'auto' }}
      >
        <div style={{ margin: '0 auto', maxWidth: 720, padding: '48px 32px' }}>
          {props.children}
        </div>
      </div>
    </div>
  );
}

function heroProps(state: OnboardingState) {
  return {
    state,
    onOpenSettings: (_section?: SettingsSection) => undefined,
    onAddProvider: () => undefined,
    onBrowseProviders: () => undefined,
    connections,
    onRefreshConnections: async () => undefined,
    onSkip: () => undefined,
  };
}

export const NeedsConnection: Story = {
  render: () => (
    <DetailPane>
      <OnboardingHero {...heroProps({ kind: 'needs_connection' })} />
    </DetailPane>
  ),
};

export const NeedsDefaultConnection: Story = {
  render: () => (
    <DetailPane>
      <OnboardingHero {...heroProps({ kind: 'needs_default_connection' })} />
    </DetailPane>
  ),
};

export const NeedsConnectionCredentials: Story = {
  render: () => (
    <DetailPane>
      <OnboardingHero
        {...heroProps({ kind: 'needs_connection_credentials', connectionSlug: 'zai-live' })}
      />
    </DetailPane>
  ),
};

export const NeedsDefaultModel: Story = {
  render: () => (
    <DetailPane>
      <OnboardingHero
        {...heroProps({ kind: 'needs_default_model', connectionSlug: 'zai-live' })}
      />
    </DetailPane>
  ),
};

export const BlockedAllUnhealthy: Story = {
  render: () => (
    <DetailPane>
      <OnboardingHero
        {...heroProps({ kind: 'blocked', reason: 'all_connections_unhealthy' })}
      />
    </DetailPane>
  ),
};
