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

import { tr } from './locale';
import { CompactionDivider, NoteDivider } from './CompactionDivider';
import { computed, inputAction, signal, Text, View } from 'nsh';
import type { JSX, Signal } from 'nsh';
import { platform } from 'nsh';
import { messageKey, type Row } from './history';
import type { MessageOrigin } from '../../../../packages/plugin-sdk/src/index.js';
import { MarkdownBody } from './MarkdownBody';
import { SourceText } from './SourceText';
import {
  C,
  bodyTextStyle,
  secondaryTextStyle,
  Disclosure,
  disclosureTitleStyle,
  IconButton,
} from './ui';
import { HistoryAttachments } from './Attachments';
import { ToolCard } from './ToolCard';
import { MessageCopy } from './MessageCopy';
import type { ImagePreview } from './ImageThumbnail';

/** What names a message the Host generated in place of its text; null for the user's own. */
export function originLabel(origin: MessageOrigin | null | undefined): string | null {
  return origin?.kind === 'plan' ? tr('Executing plan: {title}', { title: origin.title }) : null;
}

export type MessageViewState = {
  expanded: Signal<boolean>;
  sourceMode: Signal<boolean>;
};
type MessageRowToggle = {
  sessionId: string;
  key: string;
  value: boolean;
};

export function MessageRow({
  item,
  repeats,
  sessionId,
  through,
  viewState,
  previewImage,
  openLink,
  userScroll,
  onExpand,
  ownerKey,
  toolMaxHeight,
  onToolReading,
  finalActions,
  editMessage,
  failureActions,
}: {
  item: () => Row;
  /** How many identical failures this row stands for. */
  repeats?: () => number;
  sessionId: string;
  through: () => number;
  viewState?: MessageViewState;
  previewImage(image: ImagePreview): void;
  openLink(target: string, restoreFocus: () => boolean): Promise<void>;
  userScroll(): void;
  onExpand?(key: string): void;
  ownerKey?: () => string;
  toolMaxHeight: () => number;
  onToolReading?(key: string): void;
  finalActions?(row: () => Row, ownerKey: () => string): JSX.Element;
  /** An action on a user message, beside its copy button. */
  editMessage?(row: () => Row, ownerKey: () => string): JSX.Element;
  /** An action beside a failure notice. */
  failureActions?(row: () => Row): JSX.Element;
}) {
  const rowKey = (row: Row) => ownerKey?.() ?? messageKey(row);
  return (
    <Each of={[item()]} key={rowKey}>
      {(row) => {
        if (row().role === 'compaction')
          return (
            <CompactionDivider state="completed" durationMs={() => row().compaction!.durationMs} />
          );
        // The Host wrote this message to start an approved Plan; the model keeps
        // the full request, and the conversation names the Plan it ran.
        const note = row().role === 'user' ? originLabel(row().origin) : null;
        if (note) return <NoteDivider label={note} />;
        // A failure is a notice about the run, not an answer: one quiet line, with
        // no source view since its source is the same text.
        if (row().role === 'failure')
          return (
            <View style={{ gap: 4, paddingVertical: 4 }}>
              <Text style={[{ ...secondaryTextStyle, color: C.warning }, { userSelect: 'text' }]}>
                {row().text}
                {(repeats?.() ?? 1) > 1
                  ? ` · ${tr('Failed {count} times', { count: repeats!() })}`
                  : ''}
              </Text>
              {failureActions?.(row)}
            </View>
          );
        const expanded = viewState?.expanded ?? signal(false),
          sourceMode = viewState?.sourceMode ?? signal(false);
        const ownsRow = (action: MessageRowToggle) => {
          return action.sessionId === sessionId && action.key === rowKey(row());
        };
        const setSourceMode = (action: MessageRowToggle) => {
          if (ownsRow(action)) sourceMode.set(action.value);
        };
        const setExpanded = (action: MessageRowToggle) => {
          if (!ownsRow(action)) return;
          expanded.set(action.value);
          if (action.value) onExpand?.(action.key);
        };
        // On the desktop the replies between tool calls carry no actions, so
        // only the final reply (or one already showing its source) has a row.
        const actionRow = () => platform.isTerminal || row().finalOutput || sourceMode();
        const sourceId = () => `${sessionId}/${row().messageId}/${row().field}`;
        const text = computed(() => row().text);
        const preview = computed(() => /\S[^\r\n]*/.exec(text())?.[0].trim() ?? '');
        const thinking = () => row().field === 'thinking' || row().role === 'thinking';
        const isTool = () =>
          row().tool != null || row().role === 'tool_call' || row().role === 'tool_result';
        const compact = () => thinking() || isTool();
        const user = () => row().role === 'user';
        const summary = () => `${tr('Thinking')}${preview() ? ` · ${preview()}` : ''}`;
        const timestamp = () => {
          const value = (row() as Row & { timestamp?: number }).timestamp;
          if (typeof value !== 'number') return '';
          const date = new Date(value);
          return Number.isNaN(date.getTime())
            ? ''
            : `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
        };
        return (
          <View style={{ paddingVertical: user() ? 16 : 0, gap: 0, width: '100%' }}>
            <If
              when={user()}
              else={
                <If
                  when={compact()}
                  else={
                    <View style={{ gap: 8 }}>
                      <If
                        when={sourceMode()}
                        else={
                          <If
                            when={row().role === 'assistant' && row().field === 'body'}
                            else={
                              <Text
                                style={[
                                  { color: C.text, ...bodyTextStyle },
                                  { userSelect: 'text' },
                                ]}
                              >
                                <SourceText row={row} sourceId={sourceId()} />
                              </Text>
                            }
                          >
                            <MarkdownBody
                              sessionId={sessionId}
                              row={row}
                              sourceId={sourceId()}
                              openLink={openLink}
                              userScroll={userScroll}
                            />
                          </If>
                        }
                      >
                        <Text style={[{ color: C.text, ...bodyTextStyle }, { userSelect: 'text' }]}>
                          <SourceText row={row} sourceId={sourceId()} />
                        </Text>
                      </If>
                      <If when={actionRow()}>
                        <View
                          style={{
                            flexDirection: 'row',
                            flexWrap: 'wrap',
                            width: '100%',
                            minWidth: 0,
                            justifyContent: 'flex-start',
                            alignItems: 'center',
                            gap: 8,
                            // The first glyph starts where the message does.
                            marginLeft: platform.isTerminal ? 0 : -8,
                          }}
                        >
                          <If
                            when={
                              row().finalOutput &&
                              row().role === 'assistant' &&
                              row().field === 'body' &&
                              row().position
                            }
                          >
                            <If
                              when={finalActions}
                              else={
                                <MessageCopy
                                  row={row}
                                  ownerKey={() => rowKey(row())}
                                  sessionId={sessionId}
                                  through={through}
                                />
                              }
                            >
                              {finalActions?.(row, () => rowKey(row()))}
                            </If>
                          </If>
                          <IconButton
                            label={
                              sourceMode()
                                ? tr('Show formatted message')
                                : tr('Show message source')
                            }
                            icon={sourceMode() ? 'file' : 'markdown'}
                            selected={sourceMode()}
                            onPress={inputAction(setSourceMode, {
                              sessionId,
                              key: rowKey(row()),
                              value: !sourceMode(),
                            })}
                          />
                        </View>
                      </If>
                    </View>
                  }
                >
                  <If
                    when={isTool()}
                    else={
                      <View>
                        <Disclosure
                          label={summary()}
                          open={expanded()}
                          onPress={inputAction(setExpanded, {
                            sessionId,
                            key: rowKey(row()),
                            value: !expanded(),
                          })}
                          trailing={
                            <If when={expanded()}>
                              <IconButton
                                label={
                                  sourceMode()
                                    ? tr('Show formatted thinking')
                                    : tr('Show thinking source')
                                }
                                icon={sourceMode() ? 'file' : 'markdown'}
                                selected={sourceMode()}
                                onPress={inputAction(setSourceMode, {
                                  sessionId,
                                  key: rowKey(row()),
                                  value: !sourceMode(),
                                })}
                              />
                            </If>
                          }
                        >
                          <Text
                            style={[
                              { ...disclosureTitleStyle, color: C.muted },
                              { numberOfLines: 1, textOverflow: 'ellipsis' },
                            ]}
                          >
                            {summary()}
                          </Text>
                        </Disclosure>
                        <If when={expanded()}>
                          <View
                            style={{
                              paddingLeft: platform.isTerminal ? 24 : 32,
                              paddingVertical: 4,
                            }}
                          >
                            <If
                              when={sourceMode()}
                              else={
                                <MarkdownBody
                                  sessionId={sessionId}
                                  row={row}
                                  sourceId={sourceId()}
                                  openLink={openLink}
                                  userScroll={userScroll}
                                  compact
                                />
                              }
                            >
                              <Text
                                style={[
                                  { ...secondaryTextStyle, color: C.muted },
                                  { userSelect: 'text' },
                                ]}
                              >
                                <SourceText row={row} sourceId={sourceId()} />
                              </Text>
                            </If>
                          </View>
                        </If>
                      </View>
                    }
                  >
                    <ToolCard
                      row={row}
                      sessionId={sessionId}
                      through={through}
                      ownerKey={() => rowKey(row())}
                      expanded={() => expanded() ?? false}
                      original={() => sourceMode() ?? false}
                      maxHeight={toolMaxHeight}
                      reading={() => {
                        if (expanded()) onToolReading?.(rowKey(row()));
                      }}
                      previewImage={previewImage}
                      userScroll={userScroll}
                      expand={setExpanded}
                      showOriginal={setSourceMode}
                    />
                  </If>
                </If>
              }
            >
              <View
                style={{
                  alignSelf: 'flex-end',
                  maxWidth: '78%',
                  paddingHorizontal: 16,
                  paddingVertical: 16,
                  borderRadius: 20,
                  backgroundColor: C.surface,
                }}
              >
                <Text style={[{ color: C.text, ...bodyTextStyle }, { userSelect: 'text' }]}>
                  <SourceText row={row} sourceId={sourceId()} />
                </Text>
                <If when={(row().attachments?.length ?? 0) > 0}>
                  <HistoryAttachments
                    userScroll={userScroll}
                    sessionId={sessionId}
                    through={row().metadataThrough ?? through()}
                    position={row().position}
                    attachments={row().attachments!}
                    preview={previewImage}
                  />
                </If>
              </View>
              <View
                style={{
                  alignSelf: 'flex-end',
                  width: '78%',
                  minWidth: 0,
                  flexDirection: 'row',
                  flexWrap: 'wrap',
                  alignItems: 'center',
                  justifyContent: 'flex-end',
                  gap: 8,
                  paddingTop: 4,
                  // The last glyph ends where the bubble does.
                  marginRight: platform.isTerminal ? 0 : -8,
                }}
              >
                <If when={timestamp()}>
                  <Text style={{ color: C.muted, fontSize: 12, lineHeight: 16 }}>
                    {timestamp()}
                  </Text>
                </If>
                <MessageCopy
                  row={row}
                  ownerKey={() => rowKey(row())}
                  sessionId={sessionId}
                  through={through}
                />
                {editMessage?.(row, () => rowKey(row()))}
              </View>
            </If>
          </View>
        );
      }}
    </Each>
  );
}
