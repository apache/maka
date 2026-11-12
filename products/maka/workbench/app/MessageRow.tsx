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
import { cleanup, computed, inputAction, signal, Text, View } from 'nsh';
import type { JSX, Signal } from 'nsh';
import { platform } from 'nsh';
import { ContextMenu, MenuItem, TextView } from 'nsh/base';
import { createMessageMenu, type MessageMenu } from './messageMenu';
import type { MessageSenders } from './messageSenders';
import { Icon } from './Icon';
import { hasTextPrefix, messageBytes, messageKey, senderSession, type Row } from './history';
import type { MessageOrigin } from '../../../../packages/plugin-sdk/src/index.js';
import { MarkdownBody } from './MarkdownBody';
import { SourceText } from './SourceText';
import { SkillMessage } from './SkillMessage';
import {
  C,
  bodyTextStyle,
  captionTextStyle,
  controlDisabledStyle,
  controlStyle,
  secondaryTextStyle,
  Disclosure,
  disclosureContentInset,
  disclosureTitleStyle,
  IconButton,
  floatingStyle,
  menuRowHoverStyle,
  menuRowStyle,
} from './ui';
import { HistoryAttachments } from './Attachments';
import type { ToolActivity } from './toolActivity';
import { ToolCard } from './ToolCard';
import { MessageQuotes } from './MessageQuotes';
import { MessageCopy, readOriginal, type OriginalMessage } from './MessageCopy';
import type { ImagePreview } from './ImageThumbnail';
import type { InlineEdit } from './MessageEdit';
import { LoadingIndicator } from './Loading';
import { useHost } from './host';
import { createText, errorText } from './text';

/** What names a message the Host generated in place of its text; null for the user's own. */
export function originLabel(origin: MessageOrigin | null | undefined): string | null {
  return origin?.kind === 'goal'
    ? tr('Pursuing Goal: {objective}', { objective: origin.objective })
    : null;
}

function senderLabel(sessionId: string, senders?: MessageSenders): string {
  const title = senders?.session(sessionId)?.title.trim();
  return title && title !== sessionId ? tr('From {title}', { title }) : tr('Agent conversation');
}

function SenderLink(props: { sessionId(): string; senders?: MessageSenders }) {
  const source = () => props.senders?.session(props.sessionId());
  const label = () => senderLabel(props.sessionId(), props.senders);
  const canOpen = () => !!source() && !!props.senders?.openBeside;
  const open = (sessionId: string) => {
    if (canOpen() && sessionId === props.sessionId()) props.senders?.openBeside?.(sessionId);
  };
  return (
    <IconButton
      label={tr('Open source conversation beside this one')}
      tooltip={label()}
      icon="split"
      disabled={!canOpen()}
      onPress={inputAction(open, props.sessionId())}
    />
  );
}

function FullAgentMessage(props: { original: OriginalMessage; sourceId: string }) {
  const host = useHost();
  const body = signal<string | null>(null);
  const failure = createText();
  let alive = true;
  cleanup(() => {
    alive = false;
  });
  void readOriginal(host, props.original, () => alive).then(
    (text) => {
      if (alive) body.set(text);
    },
    (reason) => {
      if (alive) failure.set(errorText(reason));
    },
  );
  return (
    <If
      when={body() !== null || !!failure()}
      else={<LoadingIndicator label={tr('Reading details…')} color={C.muted} />}
    >
      <Text
        style={{
          ...secondaryTextStyle,
          color: failure() ? C.danger : C.text,
          userSelect: 'text',
        }}
        textSource={failure() ? undefined : { id: props.sourceId, offset: 0 }}
      >
        {failure() || body()}
      </Text>
    </If>
  );
}

export type MessageViewState = {
  expanded: Signal<boolean>;
  sourceMode: Signal<boolean>;
  /** An edit open in place of a user message. */
  edit?: Signal<InlineEdit | null>;
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
  senders,
  userScroll,
  onExpand,
  ownerKey,
  toolMaxHeight,
  toolProgress,
  onToolReading,
  inspectTool,
  finalActions,
  editMessage,
  messageEditor,
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
  senders?: MessageSenders;
  userScroll(): void;
  onExpand?(key: string): void;
  ownerKey?: () => string;
  toolMaxHeight: () => number;
  toolProgress?(id: string): ToolActivity['phase'] | null;
  onToolReading?(key: string): void;
  inspectTool?(key: string): void;
  finalActions?(row: () => Row, ownerKey: () => string, menu?: MessageMenu): JSX.Element;
  /** An action on a user message, beside its copy button. */
  editMessage?(row: () => Row, ownerKey: () => string, menu?: MessageMenu): JSX.Element;
  /** What takes a user message's place while `viewState.edit` holds an edit of it. */
  messageEditor?(row: () => Row, ownerKey: () => string): JSX.Element;
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
        // Host-generated execution prompts retain their full model input;
        // the conversation names the user-approved work.
        const note = () => (row().role === 'user' ? originLabel(row().origin) : null);
        if (note()) return <NoteDivider label={note()!} />;
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
        const actionRow = () => platform.idiom === 'terminal' || row().finalOutput || sourceMode();
        const sourceId = () => `${sessionId}/${rowKey(row())}`;
        const sender = () => (row().role === 'user' ? senderSession(row().origin) : null);
        if (sender()) {
          const title = () => senderLabel(sender()!, senders);
          const preview = computed(() => {
            if (expanded()) return '';
            const value = row();
            if (value.fragments && value.fragments[0]?.offset !== 0) return '';
            const start = /\S[\s\S]{0,239}/u.exec(value.text)?.[0];
            return start
              ? TextView.plainText(TextView.parse(start, { streaming: true }))
                  .replace(/\s+/g, ' ')
                  .trim()
              : '';
          });
          const original = computed<OriginalMessage | null>(() => {
            if (!expanded()) return null;
            const value = row();
            if (
              value.field !== 'body' ||
              !value.position ||
              value.totalBytes === undefined ||
              (hasTextPrefix(value) && messageBytes(value.text) === value.totalBytes)
            )
              return null;
            return {
              sessionId,
              key: rowKey(value),
              role: 'user',
              position: value.position,
              through: value.metadataThrough ?? through(),
            };
          });
          return (
            <View style={{ width: '100%', minWidth: 0 }}>
              <Disclosure
                label={preview() ? `${title()} · ${preview()}` : title()}
                tooltip={title()}
                icon="split"
                open={expanded()}
                terminalInset={controlStyle.paddingHorizontal}
                onPress={inputAction(setExpanded, {
                  sessionId,
                  key: rowKey(row()),
                  value: !expanded(),
                })}
                trailing={
                  <If when={expanded()}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                      <SenderLink sessionId={() => sender()!} senders={senders} />
                      <MessageCopy
                        row={row}
                        ownerKey={() => rowKey(row())}
                        sessionId={sessionId}
                        through={through}
                      />
                    </View>
                  </If>
                }
              >
                <View
                  style={{
                    flex: 1,
                    minWidth: 0,
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: 6,
                  }}
                >
                  <Text
                    style={[
                      {
                        ...captionTextStyle,
                        minWidth: 0,
                        maxWidth: preview() ? '48%' : undefined,
                        flexShrink: 1,
                        color: expanded() ? C.text : C.secondary,
                      },
                      { numberOfLines: 1, textOverflow: 'ellipsis' },
                    ]}
                  >
                    {title()}
                  </Text>
                  <If when={preview()}>
                    <Text
                      style={[
                        { ...captionTextStyle, minWidth: 0, flexShrink: 1, color: C.muted },
                        { numberOfLines: 1, textOverflow: 'ellipsis' },
                      ]}
                    >
                      {`·  ${preview()}`}
                    </Text>
                  </If>
                  <If when={platform.idiom !== 'terminal'}>
                    <Icon name={expanded() ? 'down' : 'right'} size={12} color={C.muted} />
                  </If>
                </View>
              </Disclosure>
              <If when={expanded()}>
                <View
                  style={{
                    paddingLeft: disclosureContentInset(24),
                    paddingVertical: 4,
                    gap: 8,
                  }}
                >
                  <If
                    when={original()}
                    else={
                      <Text style={{ ...secondaryTextStyle, color: C.text, userSelect: 'text' }}>
                        <SourceText row={row} sourceId={sourceId()} />
                      </Text>
                    }
                  >
                    <FullAgentMessage original={original()!} sourceId={sourceId()} />
                  </If>
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
              </If>
            </View>
          );
        }
        const text = computed(() => row().text);
        const thinking = () => row().field === 'thinking' || row().role === 'thinking';
        const firstLine = computed(() => (thinking() ? /\S[^\r\n]*/.exec(text()) : null));
        const preview = computed(() =>
          TextView.plainText(TextView.parse(firstLine()?.[0] ?? '', { streaming: true }))
            .replace(/\s+/g, ' ')
            .trim(),
        );
        // Thinking that is only a bold title has nothing more to show; any other
        // single line may be longer than its one-line preview.
        const detailed = () => {
          const line = firstLine();
          if (!line) return false;
          if (/\S/.test(text().slice(line.index + line[0].length))) return true;
          return !/^\*\*[^*]+\*\*$/.test(line[0].trim());
        };
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
        // On the desktop a message's actions show while the pointer is on it or
        // the keyboard focus is in them; its context menu has the same commands.
        const menu = platform.idiom === 'terminal' || compact() ? undefined : createMessageMenu();
        const revealed = menu && 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100';
        const toggleSource = () =>
          inputAction(setSourceMode, { sessionId, key: rowKey(row()), value: !sourceMode() });
        const message = (
          <View
            class={menu && 'group'}
            style={{ paddingVertical: user() ? 16 : 0, gap: 0, width: '100%' }}
          >
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
                          class={revealed}
                          style={{
                            flexDirection: 'row',
                            flexWrap: 'wrap',
                            width: '100%',
                            minWidth: 0,
                            justifyContent: 'flex-start',
                            alignItems: 'center',
                            gap: 8,
                            // The first glyph starts where the message does.
                            marginLeft: platform.idiom === 'terminal' ? 0 : -8,
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
                                  menu={menu}
                                />
                              }
                            >
                              {finalActions?.(row, () => rowKey(row()), menu)}
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
                            onPress={toggleSource()}
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
                          tooltip={summary()}
                          icon="thinking"
                          foldable={detailed()}
                          open={expanded() && detailed()}
                          onPress={inputAction(setExpanded, {
                            sessionId,
                            key: rowKey(row()),
                            value: !expanded(),
                          })}
                          trailing={
                            <If when={expanded() && detailed()}>
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
                          <If when={platform.idiom === 'terminal'}>
                            <Icon name="thinking" color={C.muted} />
                          </If>
                          <Text
                            style={[
                              { ...disclosureTitleStyle, color: C.secondary },
                              { numberOfLines: 1, textOverflow: 'ellipsis' },
                            ]}
                          >
                            {preview()}
                          </Text>
                        </Disclosure>
                        <If when={expanded() && detailed()}>
                          <View
                            style={{
                              paddingLeft: disclosureContentInset(24),
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
                      progress={() => toolProgress?.(row().tool?.toolUseId ?? '') ?? null}
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
                      senders={senders}
                      userScroll={userScroll}
                      expand={setExpanded}
                      showOriginal={setSourceMode}
                      inspect={inspectTool}
                    />
                  </If>
                </If>
              }
            >
              <If
                when={!!messageEditor && (viewState?.edit?.() ?? null) !== null}
                else={
                  <>
                    <View
                      style={{
                        alignSelf: 'flex-end',
                        maxWidth: '78%',
                        paddingHorizontal: 16,
                        paddingVertical: 16,
                        borderRadius: 20,
                        backgroundColor: C.card,
                        gap: 8,
                      }}
                    >
                      <MessageQuotes quotes={() => row().quotes ?? []} />
                      <SkillMessage row={row} sourceId={sourceId()} />
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
                      class={revealed}
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
                        marginRight: platform.idiom === 'terminal' ? 0 : -8,
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
                        menu={menu}
                      />
                      {editMessage?.(row, () => rowKey(row()), menu)}
                    </View>
                  </>
                }
              >
                {messageEditor?.(row, () => rowKey(row()))}
              </If>
            </If>
          </View>
        );
        if (!menu) return message;
        const Item = (props: { label: string; disabled?: boolean; select(): void }) => (
          <MenuItem
            accessibilityLabel={props.label}
            disabled={props.disabled}
            onSelect={props.select}
            style={{ ...menuRowStyle(), minWidth: 160 }}
            hoverStyle={menuRowHoverStyle()}
            focusStyle={menuRowHoverStyle()}
            disabledStyle={controlDisabledStyle}
          >
            <Text style={{ ...captionTextStyle, color: C.text }}>{props.label}</Text>
          </MenuItem>
        );
        return (
          <ContextMenu offset={4} margin={8} popupStyle={floatingStyle()} trigger={message}>
            <Each
              of={menu.commands().filter((command) => command.action() !== null)}
              key={(command) => command.kind}
            >
              {(command) => (
                <Item
                  label={command().label()}
                  disabled={command().busy()}
                  select={command().action()!}
                />
              )}
            </Each>
            <If when={!user()}>
              <Item
                label={sourceMode() ? tr('Show formatted message') : tr('Show message source')}
                select={toggleSource()}
              />
            </If>
          </ContextMenu>
        );
      }}
    </Each>
  );
}
