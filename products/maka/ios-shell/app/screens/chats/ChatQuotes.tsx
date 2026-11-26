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

import { Clipboard, computed, openUrl, Scroll, signal, Text, token, View, type ViewRef } from 'nsh';
import { Button, TextView } from 'nsh/base';
import type { AgentHistoryChunk } from '../../bridge';
import { tr } from '../../locale';
import {
  clearDraftQuotes,
  isCompleteHistoryRow,
  quoteLimit,
  removeDraftQuote,
  trimHostWhitespace,
  type DraftQuote,
  type HistoryRow,
} from '../../state/chat';
import { showToast } from '../../state/hostPool';
import { hapticSelection } from '../../state/preferences';
import { type } from '../../theme/tokens';
import { Icon } from '../../ui';

function isQuotable(row: HistoryRow) {
  return !row.first.sourceCitation && Boolean(trimHostWhitespace(row.text));
}

export function MessageBody(props: {
  row: HistoryRow;
  limitReached: boolean;
  onQuote: (row: HistoryRow, text: string) => boolean;
}) {
  const selection = signal<{ body: string; text: string } | null>(null);
  const selectedExcerpt = () => {
    const selected = selection();
    return selected?.body === props.row.text && isQuotable(props.row) ? selected.text : '';
  };
  let area: ViewRef | undefined;
  const quoteSelection = () => {
    const text = selectedExcerpt();
    if (text && !props.limitReached && props.onQuote(props.row, text)) {
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
              ]
            : []
        }
      >
        <If
          when={props.row.first.role === 'user'}
          else={
            <TextView
              markdown={props.row.text}
              classes={{ codeBlockHeader: 'px-3 text-foreground' }}
              codeBlockActions={[{ id: 'copy', label: tr('Copy') }]}
              styles={{
                paragraph: { color: token('foreground'), fontSize: 16, lineHeight: 24 },
              }}
              onLinkPress={({ url }) => void openUrl(url)}
            />
          }
        >
          <Text style={{ ...type.body, color: token('foreground') }}>{props.row.text}</Text>
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
  limitReached: boolean;
  onQuote: (row: HistoryRow, text: string, combined: boolean) => boolean;
}) {
  const sources = computed(() => props.bodies.filter(isQuotable));
  return (
    <View style={{ flexDirection: 'row' }}>
      <Button
        accessibilityLabel={tr('Copy reply')}
        class="active:opacity-60"
        style={replyActionStyle}
        onPress={() => {
          hapticSelection();
          void Clipboard.writeText(props.bodies.map((row) => row.text).join('\n\n'));
          showToast(tr('Copied'));
        }}
      >
        <Icon name="copy" color={token('muted-foreground')} size={16} />
      </Button>
      <If when={sources().length}>
        <Button
          accessibilityLabel={tr('Quote')}
          disabled={props.limitReached || !sources().every(isCompleteHistoryRow)}
          class="active:opacity-60 disabled:opacity-45"
          style={replyActionStyle}
          onPress={() => {
            const rows = sources();
            props.onQuote(rows[0], rows.map((row) => row.text).join('\n\n'), rows.length > 1);
          }}
        >
          <Icon name="quote" color={token('muted-foreground')} size={16} />
        </Button>
      </If>
    </View>
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
  rootId: string;
  sessionId: string;
  quotes: readonly DraftQuote[];
}) {
  return (
    <View style={{ paddingBottom: 8 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Text style={{ ...type.footnote, color: token('muted-foreground'), flex: 1 }}>
          {props.quotes.length >= quoteLimit
            ? tr('Quote limit reached ({count})', { count: quoteLimit })
            : tr('{count, plural, one {# quote} other {# quotes}}', { count: props.quotes.length })}
        </Text>
        <View
          role="button"
          accessibilityLabel={tr('Clear all quotes')}
          onPress={() => clearDraftQuotes(props.rootId, props.sessionId)}
          class="active:opacity-60"
          style={{ minHeight: 44, minWidth: 44, justifyContent: 'center', alignItems: 'center' }}
        >
          <Text style={{ ...type.footnote, color: token('primary') }}>
            {tr('Clear all quotes')}
          </Text>
        </View>
      </View>
      <Scroll
        horizontal
        scrollbar={false}
        keyboardShouldPersistTaps="handled"
        style={{ height: 44, flexGrow: 0 }}
      >
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <Each of={props.quotes} key={(entry) => entry.id}>
            {(entry) => (
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
                }}
              >
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
                    {entry().reference.label || tr('Quote')}
                  </Text>
                  <Text style={{ ...type.footnote, color: token('foreground'), numberOfLines: 1 }}>
                    {entry().reference.text}
                  </Text>
                </View>
                <View
                  role="button"
                  accessibilityLabel={tr('Remove quote: {text}', {
                    text: entry().reference.text.slice(0, 80),
                  })}
                  onPress={() => removeDraftQuote(props.rootId, props.sessionId, entry().id)}
                  class="active:opacity-60"
                  style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}
                >
                  <Icon name="close" size={14} color={token('muted-foreground')} />
                </View>
              </View>
            )}
          </Each>
        </View>
      </Scroll>
    </View>
  );
}
