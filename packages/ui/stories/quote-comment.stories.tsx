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

import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor } from 'storybook/test';
import { useState, type ComponentProps } from 'react';
import type { QuoteRef } from '@maka/core/events';
import type { SessionSummary, StoredMessage } from '@maka/core/session';
import { ChatSurfaceLayout, ChatView, Composer } from '../src/components.js';
import type { ChatModelChoice } from '../src/chat-model-helpers.js';

// Fidelity convention (#1433): every story below names the real app path
// that reaches it. See apps/desktop/stories/FIDELITY.md.

const meta = {
  title: 'Product/Quote annotations',
  parameters: { layout: 'fullscreen' },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;
type ComposerProps = ComponentProps<typeof Composer>;
type ChatViewProps = ComponentProps<typeof ChatView>;

const NOW = Date.UTC(2026, 6, 1, 9, 30, 0);

const modelChoices: ChatModelChoice[] = [
  { connectionId: 'connection-anthropic-main', connectionSlug: 'anthropic-main', providerType: 'anthropic', providerLabel: 'Anthropic', model: 'claude-sonnet-4-5', label: 'Claude Sonnet 4.5', isDefault: true, thinkingLevels: [] },
];

function noop() {
  return undefined;
}

function session(o: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: 's',
    name: '引用注释',
    isFlagged: false,
    isArchived: false,
    labels: [],
    hasUnread: false,
    lastMessageAt: NOW,
    lastMessagePreview: '第 6 次被 Vercel 的免费层限流拦截。',
    status: 'active',
    backend: 'ai-sdk',
    llmConnectionId: 'connection-anthropic-main',
    llmConnectionSlug: 'anthropic-main',
    connectionLocked: false,
    model: 'claude-sonnet-4-5',
    permissionMode: 'ask',
    ...o,
  };
}

const ANNOTATED_QUOTE: QuoteRef = {
  text: '接口已跑通，前 5 次判断成功；第 6 次被 Vercel 的免费层限流拦截，记录显示未送到 Jev。程序已停止，没有自动重试。',
  label: 'Assistant',
  comment: '按 debug 技能核对限流规则，再判断是否能降速继续。',
  sourceTurnId: 'turn-3',
};

// A second staged quote with no label, which is what quoting out of the
// transcript produces: the chip is then named by its own excerpt, so two staged
// quotes never read as the same control.
const BARE_QUOTE: QuoteRef = {
  text: '我会按 debug 技能核对限流规则，再判断是否能降速继续。',
  sourceTurnId: 'turn-4',
};

const baseComposer: ComposerProps = {
  draftKey: 'storybook-quote-annotations',
  onSend: noop,
  onStop: noop,
  modelLabel: 'Claude Sonnet 4.5',
  activeSession: session(),
  activeModel: 'claude-sonnet-4-5',
  activeModelLabel: 'Claude Sonnet 4.5',
  modelChoices,
  permissionMode: 'ask',
  onPermissionModeChange: noop,
  onPickAttachments: noop,
  onAttachFilePaths: noop,
};

const baseChat: ChatViewProps = {
  messages: [],
  scrollBehavior: 'smooth',
  activeSession: session(),
  activeConnectionLabel: 'Anthropic',
  activeModel: 'claude-sonnet-4-5',
  activeModelLabel: 'Claude Sonnet 4.5',
  modelChoices,
  userLabel: '你',
  onNew: noop,
  onPromptSuggestion: noop,
};

function userMessage(id: string, turnId: string, text: string, quotes: QuoteRef[]): StoredMessage {
  return { type: 'user', id, turnId, ts: NOW, text, quotes };
}

function Frame({ children, width = 960 }: { children: React.ReactNode; width?: number }) {
  return (
    <div
      style={{
        width,
        maxWidth: 'calc(100vw - 48px)',
        margin: '0 auto',
        background: 'var(--background)',
        display: 'flex',
        minHeight: 360,
      }}
    >
      {children}
    </div>
  );
}

/** The composer's staged quotes are host state, so the story holds them the
 *  way AppShell does: editing a note writes back to the staged quote. */
function AnnotatingComposer(props: { draftKey: string }) {
  const [quotes, setQuotes] = useState<QuoteRef[]>([ANNOTATED_QUOTE, BARE_QUOTE]);
  return (
    <Composer
      {...baseComposer}
      draftKey={props.draftKey}
      pendingQuotes={quotes}
      onRemoveQuote={(index) => setQuotes((current) => current.filter((_, i) => i !== index))}
      onEditQuoteComment={(index, comment) =>
        setQuotes((current) =>
          current.map((quote, i) => (i === index ? { ...quote, comment } : quote)),
        )
      }
    />
  );
}

// Real path: select text in a transcript answer → the floating 引用 action → write a
// note in the panel that opens under the selection → the staged quote chip in the
// composer drawer.
export const ComposerStagedQuoteWithNote: Story = {
  render: () => (
    <Frame>
      <div style={{ padding: '0 24px 24px', width: '100%' }}>
        <AnnotatingComposer draftKey="composer-quote-notes" />
      </div>
    </Frame>
  ),
};

// Real path: the same gesture one step earlier — the annotation panel is open over the
// selection, waiting for the note. Clicking the staged chip reopens it over the drawer.
export const AnnotationPanelOpen: Story = {
  render: () => (
    <Frame>
      <div style={{ padding: '0 24px 24px', width: '100%' }}>
        <AnnotatingComposer draftKey="composer-quote-panel" />
      </div>
    </Frame>
  ),
  play: async () => {
    await waitFor(() => expect(document.querySelector('.maka-composer-quote-token')).toBeTruthy());
    const token = document.querySelector('.maka-composer-quote-token');
    expect(token).toBeTruthy();
    await userEvent.click(token as HTMLElement);
    // The panel's content stays mounted while closed, so the assertion is
    // about the one that is actually on screen.
    await waitFor(() =>
      expect(
        [...document.querySelectorAll('.maka-quote-comment-panel')].filter((panel) =>
          panel.checkVisibility(),
        ),
      ).toHaveLength(1),
    );
  },
};

// Real path: send a message carrying an annotated quote → the chip on the sent turn,
// whose hover/focus read names the excerpt and the note.
export const SentQuoteWithNote: Story = {
  render: () => (
    <Frame>
      <ChatSurfaceLayout composer={null}>
        <ChatView
          {...baseChat}
          messages={[
            userMessage(
              'u-quote',
              't-quote',
              '我会按 debug 技能核对限流规则，再判断是否能降速继续。',
              [ANNOTATED_QUOTE, BARE_QUOTE],
            ),
          ]}
        />
      </ChatSurfaceLayout>
    </Frame>
  ),
  play: async () => {
    // The transcript mounts its turns a beat after the surface does.
    await waitFor(() => expect(document.querySelector('.maka-quote-chip')).toBeTruthy());
    const chip = document.querySelector('.maka-quote-chip');
    expect(chip).toBeTruthy();
    await userEvent.hover(chip as HTMLElement);
    await waitFor(() =>
      expect(
        [...document.querySelectorAll('.maka-quote-hover-card')].filter((card) =>
          card.checkVisibility(),
        ),
      ).toHaveLength(1),
    );
  },
};
