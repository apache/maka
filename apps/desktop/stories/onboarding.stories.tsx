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

import { type ComponentProps, type ReactNode } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import type { LlmConnection, ProviderType } from '@maka/core/llm-connections';
import type { OnboardingState } from '@maka/core/onboarding';
import type { SettingsSection } from '@maka/core/settings';
import { ChatSurfaceLayout, ChatView } from '@maka/ui';
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
              <ChatView messages={[]} scrollBehavior="smooth" onNew={() => undefined} emptyOverride={emptyOverride} />
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
};

// Real path: a configured connection exists but its credential is unavailable.
export const NeedsCredentials: Story = {
  render: () => (
    <DetailPane>
      <OnboardingHero
        {...heroProps({ kind: 'needs_connection_credentials', connectionSlug: 'zai-live' })}
      />
    </DetailPane>
  ),
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
