import { type ReactNode } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import type { LlmConnection, OnboardingState, ProviderType, SettingsSection } from '@maka/core';
import { OnboardingHero } from '../src/renderer/OnboardingHero';

// Fidelity convention (#1433): every story below names the real app path
// that reaches it. See apps/desktop/stories/FIDELITY.md.

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

/**
 * The hero's real frame, not an approximation of it.
 *
 * #1433: this used to end in `maxWidth: 720; padding: 48px 32px`, which is
 * nothing the app renders. The hero actually lands in ChatView's empty slot
 * (`chat-view.tsx` → `.maka-chatContent`) wrapped in
 * `.maka-onboarding-surface` (`chat-message-surface.tsx`), and that class owns
 * the hero's height, padding and alignment (`onboarding.css`). A story that
 * substitutes its own wrapper measures its own scaffolding — which is exactly
 * how #1433 produced a 135px offset and a centring bug that neither reproduced
 * in the built app. The chain below is the app's, class for class.
 */
function DetailPane(props: { children: ReactNode }) {
  return (
    <div
      data-maka-e2e-fixture="true"
      className="mainColumn"
      data-home-surface="true"
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
        <div className="maka-chatContent">
          <div className="maka-onboarding-surface">{props.children}</div>
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
