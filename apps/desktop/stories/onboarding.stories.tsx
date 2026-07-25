import { type ReactNode } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import type { LlmConnection, OnboardingState, ProviderType, SettingsSection } from '@maka/core';
import { OnboardingHero } from '../src/renderer/OnboardingHero';

// FIDELITY CONVENTION (#1433) — every story in this file must map to an app
// state a real user can reach, with that path noted above the story. Stories
// are treated as ground truth for what the product looks like, so one that
// composes an unreachable state makes every visual comparison built on it
// wrong. If the app changes and a story no longer matches a reachable state,
// fix the story or delete it — do not keep both "the app" and "the story
// version" of a surface alive. Where a story deliberately puts several states
// side by side for review, say so: the arrangement is a scaffold, each panel
// is the reachable state.

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

// Real path: first launch with no sessions — the hero fills the chat surface's empty
// area (chat-message-surface.tsx) while onboarding is unfinished, gated in
// app-shell.tsx. This is the fresh-install state: no model connection exists at all.
export const NeedsConnection: Story = {
  render: () => (
    <DetailPane>
      <OnboardingHero {...heroProps({ kind: 'needs_connection' })} />
    </DetailPane>
  ),
};

// Real path: same hero, with at least one ready connection but no default picked — e.g.
// after deleting the connection that used to be the default.
export const NeedsDefaultConnection: Story = {
  render: () => (
    <DetailPane>
      <OnboardingHero {...heroProps({ kind: 'needs_default_connection' })} />
    </DetailPane>
  ),
};

// Real path: same hero, when the default connection exists but its API key is missing or
// was rejected.
export const NeedsConnectionCredentials: Story = {
  render: () => (
    <DetailPane>
      <OnboardingHero
        {...heroProps({ kind: 'needs_connection_credentials', connectionSlug: 'zai-live' })}
      />
    </DetailPane>
  ),
};

// Real path: same hero, when the default connection is usable but no default model has
// been chosen.
export const NeedsDefaultModel: Story = {
  render: () => (
    <DetailPane>
      <OnboardingHero
        {...heroProps({ kind: 'needs_default_model', connectionSlug: 'zai-live' })}
      />
    </DetailPane>
  ),
};

// Real path: same hero, when connections exist but every one of them fails its health
// probe — no per-connection fix applies, so the hero offers no single next step.
export const BlockedAllUnhealthy: Story = {
  render: () => (
    <DetailPane>
      <OnboardingHero
        {...heroProps({ kind: 'blocked', reason: 'all_connections_unhealthy' })}
      />
    </DetailPane>
  ),
};
