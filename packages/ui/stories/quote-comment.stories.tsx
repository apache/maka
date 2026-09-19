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
import { useRef, useState, type ComponentProps } from 'react';
import type { QuoteRef } from '@maka/core/events';
import type { SessionSummary, StoredMessage } from '@maka/core/session';
import {
  ChatSurfaceLayout,
  ChatView,
  Composer,
  type ChatViewHandle,
} from '../src/components.js';
import { findQuoteTextRange } from '../src/selection-quote-target.js';
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

const ASSISTANT_REPLY = ANNOTATED_QUOTE.text;

function applyComment(quotes: QuoteRef[], index: number, comment: string): QuoteRef[] {
  return quotes.map((quote, i) => {
    if (i !== index) return quote;
    const { comment: _drop, ...rest } = quote;
    return comment ? { ...rest, comment } : rest;
  });
}

const REPLY_TURN: StoredMessage = {
  type: 'assistant',
  id: 'a-3',
  turnId: 'turn-3',
  ts: NOW,
  text: ASSISTANT_REPLY,
  modelId: 'claude-sonnet-4-5',
};

/** The loop the app wires: select → annotate → stage → reopen the note over
 *  the excerpt itself. Quotes live in story state the way AppShell holds them. */
function TranscriptQuoteLoop(props: {
  initialQuotes?: QuoteRef[];
  messages?: ChatViewProps['messages'];
}) {
  const chatViewRef = useRef<ChatViewHandle>(null);
  const [quotes, setQuotes] = useState<QuoteRef[]>(props.initialQuotes ?? []);
  return (
    <ChatSurfaceLayout
      composer={
        <Composer
          {...baseComposer}
          pendingQuotes={quotes}
          onRemoveQuote={(index) => setQuotes((current) => current.filter((_, i) => i !== index))}
          onEditQuoteComment={(index, comment) => setQuotes((current) => applyComment(current, index, comment))}
          onAnnotateQuote={(index) => {
            const quote = quotes[index];
            return (
              quote !== undefined &&
              (chatViewRef.current?.openQuoteAnnotation({
                index,
                text: quote.text,
                turnId: quote.sourceTurnId,
                comment: quote.comment,
              }) ?? false)
            );
          }}
        />
      }
    >
      <ChatView
        {...baseChat}
        handleRef={chatViewRef}
        pendingQuotes={quotes}
        messages={props.messages ?? [REPLY_TURN]}
        onQuoteSelection={(selection) =>
          setQuotes((current) => [
            ...current,
            {
              text: selection.text,
              sourceTurnId: selection.turnId,
              ...(selection.comment ? { comment: selection.comment } : {}),
            },
          ])
        }
        onQuoteAnnotationSubmit={(index, comment) =>
          setQuotes((current) => applyComment(current, index, comment))
        }
      />
    </ChatSurfaceLayout>
  );
}

/** Selects the excerpt once the turn's DOM has stopped being replaced — the
 *  virtualizer's first-measure churn and prop-driven re-renders both swap the
 *  turn's nodes out, and a range over replaced nodes collapses on sight. The
 *  range is built and added inside the same poll as the stability check, so a
 *  render committed in the hand-off is caught by the selection itself going
 *  empty rather than surfacing later as a missing action bar. */
async function selectExcerpt(turnId: string, needle: string): Promise<void> {
  await waitFor(
    async () => {
      const firstTurn = document.querySelector(`[data-turn-id="${turnId}"]`);
      const first = firstTurn ? findQuoteTextRange(firstTurn as HTMLElement, needle) : null;
      await new Promise((resolve) => setTimeout(resolve, 500));
      const secondTurn = document.querySelector(`[data-turn-id="${turnId}"]`);
      const second = secondTurn ? findQuoteTextRange(secondTurn as HTMLElement, needle) : null;
      expect(
        firstTurn !== null &&
          firstTurn === secondTurn &&
          first !== null &&
          second !== null &&
          first.startContainer === second.startContainer &&
          first.endContainer === second.endContainer,
      ).toBe(true);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(second as Range);
      expect((selection?.toString().length ?? 0) > 0).toBe(true);
    },
    { timeout: 8000 },
  );
}

/** The floating 引用 action above the settled selection. */
async function quoteActionButton(): Promise<HTMLElement> {
  // The hook holds the bar back until the selection has been quiet for its
  // full settle window, so this wait needs room well beyond a plain render.
  return waitFor(
    () => {
      const button = [...document.querySelectorAll<HTMLElement>('.maka-quote-actions button')].find(
        (candidate) => candidate.textContent === '引用',
      );
      expect(button).toBeTruthy();
      return button as HTMLElement;
    },
    { timeout: 5000 },
  );
}

function panelButton(panel: HTMLElement, label: string): HTMLElement {
  const button = [...panel.querySelectorAll('button')].find(
    (candidate) => candidate.textContent === label,
  );
  expect(button).toBeTruthy();
  return button as HTMLElement;
}

function typeNote(panel: HTMLElement, note: string) {
  const field = panel.querySelector('[contenteditable="true"]');
  expect(field).toBeTruthy();
  // The layer's mousedown preventDefault keeps userEvent's focus-driven
  // typing from reaching the field; drive the editable's input directly.
  field!.textContent = note;
  field!.dispatchEvent(new InputEvent('input', { bubbles: true }));
}

/** Ordinals pinned at their excerpts' ends: every staged quote keeps one, and
 *  the note being written borrows the next slot's number. `total` is the count
 *  of pins that should be on the transcript, so a pin quietly dropping is as
 *  much a failure as a wrong label. */
async function expectOrdinal(label: string, total: number) {
  const badges = await waitFor(() => {
    const all = [...document.querySelectorAll<HTMLElement>('.maka-quote-ordinal')].filter(
      (candidate) => candidate.checkVisibility(),
    );
    expect(all.length).toBe(total);
    return all;
  });
  const badge = badges.find((candidate) => candidate.textContent?.trim() === label);
  expect(badge).toBeTruthy();
  // A pin belongs at its own excerpt's end: it must sit where one of the
  // painted ranges — the note in flight or a staged quote's — finishes.
  const ends: { x: number; y: number }[] = [];
  for (const name of ['maka-quote-annotate', 'maka-quote-staged'] as const) {
    const highlight = CSS.highlights?.get(name);
    for (const range of highlight ? [...highlight] : []) {
      const rects = (range as Range).getClientRects();
      const last = rects[rects.length - 1];
      if (last) ends.push({ x: last.right, y: last.top + last.height / 2 });
    }
  }
  const box = (badge as HTMLElement).getBoundingClientRect();
  const center = { x: box.left + box.width / 2, y: box.top + box.height / 2 };
  expect(
    ends.some((end) => Math.abs(center.x - end.x) < 24 && Math.abs(center.y - end.y) < 16),
  ).toBe(true);
}

async function visiblePanel(): Promise<HTMLElement> {
  return waitFor(() => {
    const panel = [...document.querySelectorAll<HTMLElement>('.maka-quote-comment-panel')].find(
      (candidate) => candidate.checkVisibility(),
    );
    expect(panel).toBeTruthy();
    return panel as HTMLElement;
  });
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

// Real path, the fallback: the staged quote outlives its source — the turn has
// left the transcript (rewritten history, virtualized out, a different session)
// — so clicking the token cannot anchor an editor at the excerpt and degrades
// to the popover beside the token.
const ORPHAN_QUOTE: QuoteRef = { ...ANNOTATED_QUOTE, sourceTurnId: 'turn-removed' };

export const ComposerTokenFallback: Story = {
  render: () => (
    <Frame>
      <div style={{ padding: '0 24px', width: '100%', display: 'flex' }}>
        <TranscriptQuoteLoop initialQuotes={[ORPHAN_QUOTE]} />
      </div>
    </Frame>
  ),
  play: async () => {
    const token = await waitFor(() => {
      const el = document.querySelector('.maka-composer-quote-token');
      expect(el).toBeTruthy();
      return el as HTMLElement;
    });
    await userEvent.click(token);
    const panel = await visiblePanel();
    // Degraded, not anchored: the visible panel lives in the composer's
    // popover, not the transcript's annotation layer over the excerpt.
    expect(panel.closest('.maka-quote-annotation-layer')).toBeNull();
    expect(
      panel.querySelector('[contenteditable="true"]')?.textContent,
    ).toBe('按 debug 技能核对限流规则，再判断是否能降速继续。');
  },
};

// Real path, end to end: select text in the transcript → 引用 → write the note in
// the panel under the selection → the staged token → clicking the token reopens
// the note over the excerpt itself, not beside the composer.
export const TranscriptQuoteGesture: Story = {
  render: () => (
    <Frame>
      <div style={{ padding: '0 24px', width: '100%', display: 'flex' }}>
        <TranscriptQuoteLoop />
      </div>
    </Frame>
  ),
  play: async () => {
    // The selection is the only source of truth — restoring a real Range over
    // the excerpt is what a user's drag produces.
    await selectExcerpt('turn-3', ASSISTANT_REPLY);
    await userEvent.click(await quoteActionButton());
    const panel = await visiblePanel();
    typeNote(panel, '按 debug 技能核对限流规则，再判断是否能降速继续。');
    await userEvent.click(panelButton(panel, '引用'));
    const token = await waitFor(() => {
      const el = document.querySelector('.maka-composer-quote-token');
      expect(el).toBeTruthy();
      return el as HTMLElement;
    });
    // Submitting keeps the mark: the staged excerpt stays highlighted with
    // its ordinal pinned at the end, so the transcript still shows what was
    // quoted.
    await expectOrdinal('1', 1);
    // The token's editor anchors back at the excerpt, with the note prefilled.
    await userEvent.click(token);
    const reopened = await visiblePanel();
    expect(
      reopened.querySelector('[contenteditable="true"]')?.textContent,
    ).toBe('按 debug 技能核对限流规则，再判断是否能降速继续。');
  },
};

const SECOND_REPLY =
  '第二轮我会按 debug 技能核对限流规则，再判断是否能降速继续，并补一轮端到端验证。';
const SECOND_TURN: StoredMessage = {
  type: 'assistant',
  id: 'a-4',
  turnId: 'turn-4',
  ts: NOW,
  text: SECOND_REPLY,
  modelId: 'claude-sonnet-4-5',
};

// Real path, several annotations at once: each fresh note is numbered with
// the slot it will take, and each staged token's editor reopens at its own
// excerpt carrying that quote's own ordinal — the marker sits on the text,
// not on the card.
export const TranscriptTwoAnnotations: Story = {
  render: () => (
    <Frame>
      <div style={{ padding: '0 24px', width: '100%', display: 'flex' }}>
        <TranscriptQuoteLoop messages={[REPLY_TURN, SECOND_TURN]} />
      </div>
    </Frame>
  ),
  play: async () => {
    // First annotation on the earlier reply takes the first free slot.
    await selectExcerpt('turn-3', '第 6 次被 Vercel 的免费层限流拦截');
    await userEvent.click(await quoteActionButton());
    const firstPanel = await visiblePanel();
    await expectOrdinal('1', 1);
    typeNote(firstPanel, '限流这段先核');
    await userEvent.click(panelButton(firstPanel, '引用'));
    // Staging the first token re-renders the transcript (pendingQuotes); the
    // submitted excerpt keeps its highlight and pin instead of losing the
    // mark with the panel. Select the next excerpt only once that churn has
    // landed, or the new range collapses on the text nodes it replaces.
    await waitFor(() =>
      expect(document.querySelectorAll('.maka-composer-quote-token').length).toBe(1),
    );
    await expectOrdinal('1', 1);

    // The second annotation is numbered by what is already staged, and the
    // first pin stays put while it is written.
    await selectExcerpt('turn-4', '核对限流规则，再判断是否能降速继续');
    await userEvent.click(await quoteActionButton());
    const secondPanel = await visiblePanel();
    await expectOrdinal('2', 2);
    await userEvent.click(panelButton(secondPanel, '引用'));

    // Both staged; each excerpt keeps its own pin and each token's editor
    // anchors back at its own excerpt, so which staged quote it is never
    // ambiguous.
    await waitFor(() => {
      const all = document.querySelectorAll<HTMLElement>('.maka-composer-quote-token');
      expect(all.length).toBe(2);
    });
    await expectOrdinal('1', 2);
    await expectOrdinal('2', 2);
    const tokens = [...document.querySelectorAll<HTMLElement>('.maka-composer-quote-token')];
    await userEvent.click(tokens[0]);
    const firstEdit = await visiblePanel();
    await expectOrdinal('1', 2);
    expect(firstEdit.closest('.maka-quote-annotation-layer')).toBeTruthy();
    expect(firstEdit.querySelector('[contenteditable="true"]')?.textContent).toBe('限流这段先核');
    await userEvent.click(panelButton(firstEdit, '取消'));
    await userEvent.click(tokens[1]);
    const secondEdit = await visiblePanel();
    await expectOrdinal('2', 2);
    expect(secondEdit.closest('.maka-quote-annotation-layer')).toBeTruthy();
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
