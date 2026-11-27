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

import {
  Clipboard,
  computed,
  effect,
  openUrl,
  Scroll,
  signal,
  Text,
  token,
  View,
  type ViewRef,
} from 'nsh';
import { Button, ContextMenu, TextView } from 'nsh/base';
import type { AgentHistoryChunk } from '../../bridge';
import { tr } from '../../locale';
import {
  isCompleteHistoryRow,
  quoteLimit,
  trimHostWhitespace,
  type DraftLink,
  type DraftQuote,
  type HistoryRow,
} from '../../state/chat';
import { showToast } from '../../state/hostPool';
import { hapticSelection } from '../../state/preferences';
import { type } from '../../theme/tokens';
import { ActionButton, Icon } from '../../ui';

function isQuotable(row: HistoryRow) {
  return !row.first.sourceCitation && Boolean(trimHostWhitespace(row.text));
}

export function MessageBody(props: {
  row: HistoryRow;
  limitReached: boolean;
  onQuote: (row: HistoryRow, text: string) => boolean;
  onAskSide?: (row: HistoryRow, text?: string) => boolean;
}) {
  const selection = signal<{ body: string; text: string } | null>(null);
  const selectedExcerpt = () => {
    const selected = selection();
    return selected?.body === props.row.text && isQuotable(props.row) ? selected.text : '';
  };
  let area: ViewRef | undefined;
  effect(() => {
    const selected = selection();
    if (selected && selected.body !== props.row.text) {
      // Native selection offsets are in rendered text, not history bytes.
      // A changed body (including a prepended prefix) needs a fresh selection.
      selection.set(null);
      area?.clearSelection();
    }
  });
  const sourceId = () =>
    props.row.first.offset > 0 || props.row.last.offset > 0 ? props.row.key : undefined;
  const quoteSelection = () => {
    const text = selectedExcerpt();
    if (text && !props.limitReached && props.onQuote(props.row, text)) {
      selection.set(null);
      area?.clearSelection();
    }
  };

  const askSide = () => {
    if (props.onAskSide?.(props.row, selectedExcerpt() || undefined)) {
      selection.set(null);
      area?.clearSelection();
    }
  };

  return (
    <View>
      <View
        ref={(ref) => (area = ref)}
        selectable
        onSelectionChange={({ text }) => {
          const excerpt = trimHostWhitespace(text);
          selection.set(excerpt ? { body: props.row.text, text: excerpt } : null);
        }}
        selectionMenu={
          isQuotable(props.row)
            ? [
                {
                  label: tr('Add to quotes'),
                  symbol: 'quote.bubble',
                  disabled: props.limitReached,
                  onSelect: quoteSelection,
                },
                ...(props.onAskSide
                  ? [
                      {
                        label: tr('Ask Side Question'),
                        symbol: 'arrow.turn.down.right',
                        onSelect: askSide,
                      },
                    ]
                  : []),
              ]
            : []
        }
      >
        <If
          when={props.row.first.role === 'user'}
          else={
            <TextView
              markdown={props.row.text}
              sourceId={sourceId()}
              sourceOffset={props.row.first.offset}
              classes={{ codeBlockHeader: 'px-3 text-foreground' }}
              codeBlockActions={[{ id: 'copy', label: tr('Copy') }]}
              styles={{
                paragraph: { color: token('foreground'), fontSize: 16, lineHeight: 24 },
              }}
              onLinkPress={({ url }) => void openUrl(url)}
            />
          }
        >
          <Text
            textSource={
              sourceId() ? { id: props.row.key, offset: props.row.first.offset } : undefined
            }
            style={{ ...type.body, color: token('foreground') }}
          >
            {props.row.text}
          </Text>
        </If>
      </View>
      <If when={selectedExcerpt()}>
        <Button
          accessibilityLabel={tr('Add to quotes')}
          disabled={props.limitReached}
          onPress={quoteSelection}
          class="active:opacity-60 disabled:opacity-45"
          style={{
            alignSelf: 'flex-start',
            minHeight: 44,
            minWidth: 44,
            flexDirection: 'row',
            alignItems: 'center',
            gap: 6,
          }}
        >
          <Icon name="quote" color={token('muted-foreground')} size={16} />
          <Text style={{ ...type.footnote, color: token('foreground') }}>
            {tr('Add to quotes')}
          </Text>
        </Button>
      </If>
    </View>
  );
}

const replyActionStyle = {
  width: 44,
  height: 44,
  justifyContent: 'center',
  alignItems: 'center',
} as const;

export function ReplyActions(props: {
  bodies: readonly HistoryRow[];
  folded: boolean;
  knownIncomplete: boolean;
  loadBodies?: () => Promise<HistoryRow[] | undefined>;
  limitReached: boolean;
  onQuote: (row: HistoryRow, text: string, combined?: readonly HistoryRow[]) => boolean;
  onAskSide?: () => void;
}) {
  const sources = computed(() => props.bodies.filter(isQuotable));
  const canQuote = () =>
    sources().length > 0 &&
    !props.limitReached &&
    !props.knownIncomplete &&
    (props.loadBodies !== undefined || (!props.folded && props.bodies.every(isCompleteHistoryRow)));
  const actOnReply = async (action: 'copy' | 'quote') => {
    if (action === 'quote' && !canQuote()) return;
    const visible = props.bodies;
    const load = props.loadBodies;
    try {
      if (action === 'copy') {
        let full: HistoryRow[] | undefined;
        try {
          full = await load?.();
        } catch (cause) {
          console.warn('Could not load the whole reply for Copy', cause);
        }
        hapticSelection();
        await Clipboard.writeText((full ?? visible).map((row) => row.text).join('\n\n'));
        showToast(tr('Copied'));
      } else {
        const rows = (load ? await load() : visible)?.filter(isQuotable);
        if (!rows?.length) {
          showToast(tr('Could not load conversation history.'));
          return;
        }
        props.onQuote(
          rows[0],
          rows.map((row) => row.text).join('\n\n'),
          rows.length > 1 ? rows : undefined,
        );
      }
    } catch (cause) {
      showToast(cause instanceof Error ? cause.message : String(cause));
    }
  };
  const actions = (
    <View style={{ flexDirection: 'row' }}>
      <Button
        accessibilityLabel={tr('Copy reply')}
        class="active:opacity-60"
        style={replyActionStyle}
        onPress={() => void actOnReply('copy')}
      >
        <Icon name="copy" color={token('muted-foreground')} size={16} />
      </Button>
      <If when={sources().length}>
        <Button
          accessibilityLabel={tr('Quote')}
          disabled={!canQuote()}
          class="active:opacity-60 disabled:opacity-45"
          style={replyActionStyle}
          onPress={() => void actOnReply('quote')}
        >
          <Icon name="quote" color={token('muted-foreground')} size={16} />
        </Button>
      </If>
    </View>
  );
  return (
    <If when={props.onAskSide} else={actions}>
      {/* Keep UIKit's context recognizer off the selectable text. */}
      <ContextMenu
        trigger={actions}
        items={[
          { id: 'copy', label: tr('Copy reply'), icon: 'doc.on.doc' },
          ...(sources().length
            ? [
                {
                  id: 'quote',
                  label: tr('Add to quotes'),
                  icon: 'quote.bubble',
                  disabled: !canQuote(),
                },
              ]
            : []),
          { id: 'ask-side', label: tr('Ask Side Question'), icon: 'arrow.turn.down.right' },
        ]}
        onSelect={({ id }) => {
          if (id === 'ask-side') props.onAskSide?.();
          else if (id === 'quote' || id === 'copy') void actOnReply(id);
        }}
      />
    </If>
  );
}

export function HistoryQuotes(props: { quotes: NonNullable<AgentHistoryChunk['quotes']> }) {
  return (
    <Each of={props.quotes}>
      {(entry) => (
        <View
          style={{
            paddingLeft: 8,
            paddingVertical: 2,
            gap: 2,
            borderLeftWidth: 3,
            borderLeftColor: token('muted-foreground'),
          }}
        >
          <Text
            style={{
              ...type.caption,
              fontWeight: '600',
              color: token('foreground'),
              numberOfLines: 1,
              textOverflow: 'ellipsis',
            }}
          >
            {entry().label || tr('Quote')}
          </Text>
          <Text
            style={{
              ...type.footnote,
              color: token('foreground'),
              numberOfLines: 3,
              textOverflow: 'ellipsis',
            }}
          >
            {entry().text + (entry().truncated ? '…' : '')}
          </Text>
        </View>
      )}
    </Each>
  );
}

export function DraftQuoteStrip(props: {
  quotes: readonly DraftQuote[];
  links: readonly DraftLink[];
  disabled?: boolean;
  onClearQuotes: () => void;
  onRemoveQuote: (id: number) => void;
  onRemoveLink: (id: string) => void;
  mainActions?: { ask: () => void; send: () => void; canSend: boolean };
}) {
  const chips = computed(() => [...props.quotes, ...props.links]);
  return (
    <View style={{ paddingBottom: 8 }}>
      <If when={props.quotes.length}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <Text style={{ ...type.footnote, color: token('muted-foreground'), flex: 1 }}>
            {props.quotes.length >= quoteLimit
              ? tr('Quote limit reached ({count})', { count: quoteLimit })
              : tr('{count, plural, one {# quote} other {# quotes}}', {
                  count: props.quotes.length,
                })}
          </Text>
          <Button
            accessibilityLabel={tr('Clear all quotes')}
            disabled={props.disabled}
            onPress={props.onClearQuotes}
            class="active:opacity-60 disabled:opacity-45"
            style={{ minHeight: 44, minWidth: 44, justifyContent: 'center', alignItems: 'center' }}
          >
            <Text style={{ ...type.footnote, color: token('primary') }}>
              {tr('Clear all quotes')}
            </Text>
          </Button>
        </View>
      </If>
      <Scroll
        horizontal
        scrollbar={false}
        keyboardShouldPersistTaps="handled"
        style={{ height: 44, flexGrow: 0 }}
      >
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <Each of={chips()} key={(entry) => entry.id}>
            {(entry) => {
              const quote = () => {
                const item = entry();
                return 'reference' in item ? item.reference : undefined;
              };
              const link = () => {
                const item = entry();
                return 'title' in item ? item.title : undefined;
              };
              return (
                <View
                  style={{
                    width: 168,
                    height: 44,
                    paddingLeft: 8,
                    borderRadius: 8,
                    backgroundColor: token('inline-card'),
                    borderWidth: 1,
                    borderColor: token('border'),
                    flexShrink: 0,
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: 4,
                  }}
                >
                  <If
                    when={quote()}
                    else={
                      <View style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                        <Icon name="link" color={token('muted-foreground')} size={14} />
                        <Text
                          style={{
                            ...type.footnote,
                            color: token('foreground'),
                            flex: 1,
                            numberOfLines: 1,
                            textOverflow: 'ellipsis',
                          }}
                        >
                          {link()}
                        </Text>
                      </View>
                    }
                  >
                    {(reference) => (
                      <View style={{ flex: 1, gap: 2 }}>
                        <Text
                          style={{
                            ...type.caption,
                            fontWeight: '600',
                            color: token('muted-foreground'),
                            numberOfLines: 1,
                            textOverflow: 'ellipsis',
                          }}
                        >
                          {reference().label || tr('Quote')}
                        </Text>
                        <Text
                          style={{ ...type.footnote, color: token('foreground'), numberOfLines: 1 }}
                        >
                          {reference().text}
                        </Text>
                      </View>
                    )}
                  </If>
                  <Button
                    accessibilityLabel={
                      quote()
                        ? tr('Remove quote: {text}', { text: quote()!.text.slice(0, 80) })
                        : tr('Remove conversation link: {title}', { title: link()! })
                    }
                    disabled={props.disabled}
                    onPress={() => {
                      const item = entry();
                      if ('reference' in item) props.onRemoveQuote(item.id);
                      else props.onRemoveLink(item.id);
                    }}
                    class="active:opacity-60 disabled:opacity-45"
                    style={{
                      width: 44,
                      height: 44,
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                  >
                    <Icon name="close" size={14} color={token('muted-foreground')} />
                  </Button>
                </View>
              );
            }}
          </Each>
        </View>
      </Scroll>
      <If when={props.mainActions}>
        {(actions) => (
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', marginTop: 4, gap: 4 }}>
            <ActionButton
              title={tr('Send to Main Chat')}
              variant="quiet"
              compact
              minHeight={44}
              disabled={!actions().canSend}
              onPress={() => actions().send()}
            />
            <ActionButton
              title={tr('Ask Side Question')}
              variant="secondary"
              compact
              minHeight={44}
              onPress={() => actions().ask()}
            />
          </View>
        )}
      </If>
    </View>
  );
}
