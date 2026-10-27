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

import { textTooltip } from './ui';
import { tr } from './locale';
import { CompactionDivider } from './CompactionDivider';
import { computed, inputAction, signal, Text, View } from 'nsh';
import type { JSX } from 'nsh';
import { Button } from 'nsh/base';
import { platform } from 'nsh';
import { messageKey, type Row } from './history';
import { MarkdownBody } from './MarkdownBody';
import { SourceText } from './SourceText';
import { C, bodyTextStyle, secondaryTextStyle, controlStyle } from './ui';
import { Icon } from './Icon';
import { HistoryAttachments } from './Attachments';
import { ToolCard } from './ToolCard';
import { MessageCopy } from './MessageCopy';
import type { ImagePreview } from './ImageThumbnail';

export type MessageViewState = {
  expanded: ReturnType<typeof signal<boolean>>;
  sourceMode: ReturnType<typeof signal<boolean>>;
};
type MessageRowToggle = {
  sessionId: string;
  key: string;
  value: boolean;
};

export function MessageRow({
  item,
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
}: {
  item: () => Row;
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
}) {
  const rowKey = (row: Row) => ownerKey?.() ?? messageKey(row);
  return (
    <Each of={[item()]} key={rowKey}>
      {(row) => {
        if (row().role === 'compaction')
          return (
            <CompactionDivider state="completed" durationMs={() => row().compaction!.durationMs} />
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
                      <View
                        style={{
                          flexDirection: 'row',
                          flexWrap: 'wrap',
                          width: '100%',
                          minWidth: 0,
                          justifyContent: 'flex-start',
                          alignItems: 'center',
                          gap: 8,
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
                        <Button
                          accessibilityLabel={
                            sourceMode() ? tr('Show formatted message') : tr('Show message source')
                          }
                          tooltip={textTooltip(() =>
                            sourceMode() ? tr('Show formatted message') : tr('Show message source'),
                          )}
                          selected={sourceMode()}
                          onPress={inputAction(setSourceMode, {
                            sessionId,
                            key: rowKey(row()),
                            value: !sourceMode(),
                          })}
                          style={{
                            ...controlStyle,
                            width: 32,
                            paddingHorizontal: 8,
                            alignItems: 'center',
                          }}
                          hoverStyle={{ backgroundColor: C.surface }}
                          focusStyle={{ backgroundColor: C.raised }}
                        >
                          <Icon name={sourceMode() ? 'file' : 'code'} color={C.muted} />
                        </Button>
                      </View>
                    </View>
                  }
                >
                  <If
                    when={isTool()}
                    else={
                      <View>
                        <View style={{ flexDirection: 'row', alignItems: 'center', minWidth: 0 }}>
                          <Button
                            accessibilityLabel={summary()}
                            selected={expanded()}
                            onPress={inputAction(setExpanded, {
                              sessionId,
                              key: rowKey(row()),
                              value: !expanded(),
                            })}
                            style={{
                              ...controlStyle,
                              flex: 1,
                              minWidth: 0,
                              paddingHorizontal: 0,
                              flexDirection: 'row',
                              alignItems: 'center',
                              gap: 8,
                            }}
                            hoverStyle={{ backgroundColor: C.raised }}
                            focusStyle={{ backgroundColor: C.line }}
                          >
                            <Icon name={expanded() ? 'down' : 'right'} color={C.secondary} />
                            <Text
                              style={[
                                { flex: 1, color: C.muted, fontSize: 13, lineHeight: 16 },
                                { numberOfLines: 1, textOverflow: 'ellipsis' },
                              ]}
                            >
                              {summary()}
                            </Text>
                          </Button>
                          <If when={expanded()}>
                            <Button
                              accessibilityLabel={
                                sourceMode()
                                  ? tr('Show formatted thinking')
                                  : tr('Show thinking source')
                              }
                              tooltip={textTooltip(() =>
                                sourceMode()
                                  ? tr('Show formatted thinking')
                                  : tr('Show thinking source'),
                              )}
                              selected={sourceMode()}
                              onPress={inputAction(setSourceMode, {
                                sessionId,
                                key: rowKey(row()),
                                value: !sourceMode(),
                              })}
                              style={{
                                ...controlStyle,
                                width: 32,
                                paddingHorizontal: 8,
                                alignItems: 'center',
                              }}
                              hoverStyle={{ backgroundColor: C.raised }}
                              focusStyle={{ backgroundColor: C.line }}
                            >
                              <Icon name={sourceMode() ? 'file' : 'code'} color={C.muted} />
                            </Button>
                          </If>
                        </View>
                        <If when={expanded()}>
                          <View
                            style={{
                              paddingLeft: platform.isTerminal ? 24 : 22,
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
              </View>
            </If>
          </View>
        );
      }}
    </Each>
  );
}
