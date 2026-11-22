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

import { cleanup, Clipboard, effect, signal, Text, View } from 'nsh';
import { Button, ContextMenu, Input, MenuItem } from 'nsh/base';
import type { AgentRoomMessage } from '../../../../packages/plugin-sdk/src/index.js';
import { HistoryAttachments } from './Attachments';
import { Icon } from './Icon';
import type { ImagePreview } from './ImageThumbnail';
import { MarkdownBody } from './MarkdownBody';
import { RoomDeliveryStrip } from './RoomPanels';
import {
  defaultDoubleClickReaction,
  quickReactionChoices,
  recordRecentReaction,
  RoomQuickReactBar,
  RoomReactionStrip,
} from './RoomReactions';
import { tr } from './locale';
import { roomAuthorSession, roomAvatarColor, roomAvatarInitial } from './roomMessage';
import { createJumpHighlightValue, runJumpHighlight, useLiveMessageStyle } from './roomMotion';
import {
  C,
  captionTextStyle,
  controlFocusStyle,
  controlStyle,
  floatingStyle,
  inputTextStyle,
  textTooltip,
} from './ui';

export function RoomDayDivider(props: { label: string }) {
  return (
    <View style={{ alignItems: 'center', paddingVertical: 8 }}>
      <Text style={{ ...captionTextStyle, color: C.muted }}>{props.label}</Text>
    </View>
  );
}

export function RoomMessageRow(props: {
  sessionId: string;
  through(): number;
  message(): AgentRoomMessage;
  isFirst(): boolean;
  isContinuation(): boolean;
  showDateDivider(): boolean;
  dayLabel: string;
  timeLabel: string;
  isLive(): boolean;
  isHighlighted(): boolean;
  highlightTick(): number;
  isEditing(): boolean;
  editDraft(): string;
  setEditDraft(value: string): void;
  inspecting(): string | null;
  repliedMessage(): AgentRoomMessage | undefined;
  name(id: string): string;
  burstFor(emoji: string): number;
  onReply(message: AgentRoomMessage): void;
  onJump(messageId: string): void;
  onReact(messageId: string, emoji: string): void;
  onTogglePin(messageId: string, pinned: boolean): void;
  onStartEdit(message: AgentRoomMessage): void;
  onSaveEdit(): void;
  onCancelEdit(): void;
  onDelete(messageId: string): void;
  onOpenAgent(id: string): void;
  onOpenLink(target: string, restoreFocus: () => boolean): Promise<void>;
  onPreviewImage(image: ImagePreview): void;
  onUserScroll(): void;
}) {
  const pickerOpen = signal(false);
  const highlight = createJumpHighlightValue();
  const enterStyle = useLiveMessageStyle(props.isLive());
  let lastHighlightTick = 0;

  effect(() => {
    const tick = props.highlightTick();
    if (props.isHighlighted() && tick > 0 && tick !== lastHighlightTick) {
      lastHighlightTick = tick;
      void runJumpHighlight(highlight);
    }
  });

  cleanup(() => {
    highlight.stop();
  });

  const isHuman = () => props.message().author.kind === 'human';
  const isDeleted = () => Boolean(props.message().deletedAt);
  const authorId = () => roomAuthorSession(props.message());
  const isInspected = () => Boolean(authorId() && props.inspecting() === authorId());

  const handleDoubleClick = (event: { clickCount?: number }) => {
    if (event.clickCount !== 2 || isDeleted() || props.isEditing()) return;
    const emoji = defaultDoubleClickReaction();
    recordRecentReaction(emoji);
    props.onReact(props.message().id, emoji);
  };

  const replyQuoteBlock = () => (
    <If when={Boolean(props.message().replyTo)}>
      <Button
        accessibilityLabel={tr('View replied message')}
        onPress={() => props.onJump(props.message().replyTo!)}
        style={{
          borderLeftWidth: 2,
          borderLeftColor: isHuman() ? C.accent + '88' : C.line,
          paddingLeft: 8,
          paddingVertical: 2,
          borderRadius: 4,
          alignSelf: 'stretch',
        }}
        hoverStyle={{ backgroundColor: C.surface }}
      >
        <Text style={[{ ...captionTextStyle, color: C.secondary }, { numberOfLines: 1 }]}>
          {props.repliedMessage()?.content.text || tr('View replied message')}
        </Text>
      </Button>
    </If>
  );

  const bodySection = () => (
    <>
      <If when={isDeleted()}>
        <Text style={{ ...captionTextStyle, color: C.muted }}>{tr('Message deleted')}</Text>
      </If>
      <If when={!isDeleted() && props.isEditing()}>
        <View style={{ gap: 8, minWidth: 240 }}>
          <Input
            autoFocus
            accessibilityLabel={tr('Edit message')}
            value={props.editDraft()}
            onChange={({ value }) => props.setEditDraft(value)}
            onSubmit={() => props.onSaveEdit()}
            style={{
              ...inputTextStyle,
              color: C.text,
              backgroundColor: C.raised,
              borderRadius: 8,
              padding: 10,
            }}
          />
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <Button
              accessibilityLabel={tr('Save')}
              onPress={props.onSaveEdit}
              style={{ ...controlStyle, backgroundColor: C.surface }}
            >
              <Text style={{ ...captionTextStyle, color: C.accent }}>{tr('Save')}</Text>
            </Button>
            <Button
              accessibilityLabel={tr('Cancel')}
              onPress={props.onCancelEdit}
              style={controlStyle}
            >
              <Text style={{ ...captionTextStyle, color: C.secondary }}>{tr('Cancel')}</Text>
            </Button>
          </View>
        </View>
      </If>
      <If when={!isDeleted() && !props.isEditing() && Boolean(props.message().content.text)}>
        {/* Scope selectable strictly to the text body so double-click on the frame triggers quick react */}
        <View selectable>
          <MarkdownBody
            selectable={false}
            row={() => ({
              key: props.message().id + ':' + String(props.message().editedAt ?? 0),
              messageId: props.message().id,
              field: 'body',
              role: isHuman() ? 'user' : 'assistant',
              text: props.message().content.text,
              prefix: true,
              closedAt: props.message().at,
            })}
            sourceId={props.message().id}
            sessionId={props.sessionId}
            openLink={props.onOpenLink}
            userScroll={props.onUserScroll}
          />
        </View>
      </If>
      <If when={!isDeleted() && props.message().content.attachments.length > 0}>
        <HistoryAttachments
          sessionId={props.sessionId}
          through={props.through()}
          roomMessageId={props.message().id}
          attachments={props.message().content.attachments}
          preview={props.onPreviewImage}
          userScroll={props.onUserScroll}
        />
      </If>
    </>
  );

  const contextMenuContent = () => (
    <>
      <If when={!isDeleted()}>
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: 2,
            paddingHorizontal: 6,
            paddingVertical: 4,
            borderBottomWidth: 1,
            borderBottomColor: C.line,
            marginBottom: 4,
          }}
        >
          <Each of={quickReactionChoices()} key={(emoji) => emoji}>
            {(emoji) => (
              <MenuItem
                onSelect={() => {
                  recordRecentReaction(emoji());
                  props.onReact(props.message().id, emoji());
                }}
              >
                <Text style={{ fontSize: 15 }}>{emoji()}</Text>
              </MenuItem>
            )}
          </Each>
        </View>
      </If>
      <MenuItem onSelect={() => props.onReply(props.message())}>
        <Text style={{ color: C.text }}>{tr('Reply to message')}</Text>
      </MenuItem>
      <If when={!isDeleted()}>
        <MenuItem onSelect={() => props.onTogglePin(props.message().id, !props.message().pinned)}>
          <Text style={{ color: C.text }}>
            {props.message().pinned ? tr('Unpin message') : tr('Pin message')}
          </Text>
        </MenuItem>
        <MenuItem onSelect={() => void Clipboard.writeText(props.message().content.text)}>
          <Text style={{ color: C.text }}>{tr('Copy message')}</Text>
        </MenuItem>
        <MenuItem onSelect={() => props.onStartEdit(props.message())}>
          <Text style={{ color: C.text }}>{tr('Edit message')}</Text>
        </MenuItem>
        <MenuItem onSelect={() => props.onDelete(props.message().id)}>
          <Text style={{ color: C.danger }}>{tr('Delete message')}</Text>
        </MenuItem>
      </If>
    </>
  );

  return (
    <View
      style={[
        {
          marginTop: props.isFirst()
            ? 0
            : props.showDateDivider()
              ? 10
              : props.isContinuation()
                ? 3
                : 16,
        },
        enterStyle,
      ]}
    >
      <If when={props.showDateDivider()}>
        <RoomDayDivider label={props.dayLabel} />
      </If>

      <ContextMenu
        offset={4}
        margin={8}
        popupStyle={floatingStyle()}
        trigger={
          <View
            class="group"
            onPress={handleDoubleClick}
            style={{
              position: 'relative',
              borderRadius: 12,
              paddingVertical: props.isContinuation() ? 2 : 5,
              paddingHorizontal: 8,
              backgroundColor: highlight.interpolate({
                inputRange: [0, 1],
                outputRange: [C.accent + '00', C.accent + '1A'],
              }),
            }}
          >
            {/* Breathing 2px left accent bar during jump highlight */}
            <View
              accessibilityElementsHidden
              style={{
                position: 'absolute',
                left: 0,
                top: 4,
                bottom: 4,
                width: 2,
                borderRadius: 1,
                backgroundColor: C.accent,
                opacity: highlight,
                pointerEvents: 'none',
              }}
            />

            <If when={!isDeleted() && !props.isEditing()}>
              <RoomQuickReactBar
                pickerOpen={pickerOpen}
                setPickerOpen={(v) => pickerOpen.set(v)}
                onReact={(emoji) => props.onReact(props.message().id, emoji)}
                onReply={() => props.onReply(props.message())}
                align="right"
              />
            </If>

            <If
              when={isHuman()}
              else={
                /* Agent voice: left-aligned avatar + full-width Markdown */
                <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 10 }}>
                  <If
                    when={!props.isContinuation()}
                    else={
                      <View
                        style={{
                          width: 30,
                          paddingTop: 3,
                          alignItems: 'flex-end',
                        }}
                      >
                        <Text
                          class="opacity-0 group-hover:opacity-100"
                          style={{ fontSize: 10, color: C.muted }}
                        >
                          {props.timeLabel}
                        </Text>
                      </View>
                    }
                  >
                    <Button
                      accessibilityLabel={props.name(authorId()!)}
                      tooltip={textTooltip(() => props.name(authorId()!))}
                      onPress={() => authorId() && props.onOpenAgent(authorId()!)}
                      style={{
                        width: 30,
                        height: 30,
                        borderRadius: 15,
                        backgroundColor: roomAvatarColor(authorId()!),
                        borderWidth: isInspected() ? 2 : 0,
                        borderColor: isInspected() ? C.accent : 'transparent',
                        alignItems: 'center',
                        justifyContent: 'center',
                        marginTop: 1,
                      }}
                      hoverStyle={{ opacity: 0.9 }}
                      focusStyle={controlFocusStyle()}
                    >
                      <Text style={{ fontSize: 12, fontWeight: '600', color: '#FFFFFF' }}>
                        {roomAvatarInitial(props.name(authorId()!))}
                      </Text>
                    </Button>
                  </If>

                  <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
                    <If when={!props.isContinuation()}>
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 7 }}>
                        <Button
                          accessibilityLabel={props.name(authorId()!)}
                          onPress={() => authorId() && props.onOpenAgent(authorId()!)}
                          hoverStyle={{ opacity: 0.8 }}
                        >
                          <Text
                            style={{
                              fontSize: 13,
                              fontWeight: '600',
                              color: isInspected() ? C.accent : C.text,
                            }}
                          >
                            {props.name(authorId()!)}
                          </Text>
                        </Button>
                        <Text style={{ fontSize: 11, color: C.muted }}>{props.timeLabel}</Text>
                        <If when={Boolean(props.message().editedAt) && !isDeleted()}>
                          <Text style={{ fontSize: 11, color: C.muted }}>{tr('Edited')}</Text>
                        </If>
                        <If when={props.message().pinned}>
                          <Icon name="pin" size={11} color={C.accent} />
                        </If>
                      </View>
                    </If>

                    {replyQuoteBlock()}
                    {bodySection()}

                    <If when={!isDeleted()}>
                      <RoomReactionStrip
                        reactions={() => props.message().reactions ?? []}
                        burstFor={props.burstFor}
                        name={props.name}
                        align="left"
                        onToggle={(emoji) => props.onReact(props.message().id, emoji)}
                        onOpenAgent={props.onOpenAgent}
                      />
                    </If>

                    <RoomDeliveryStrip
                      states={props.message().deliveryStates ?? []}
                      name={props.name}
                      align="left"
                      onOpenAgent={props.onOpenAgent}
                    />
                  </View>
                </View>
              }
            >
              {/* Human voice: right-aligned calm card (no self-avatar or self-nametag) */}
              <View style={{ alignItems: 'flex-end', gap: 3 }}>
                <View
                  style={{
                    flexDirection: 'row',
                    alignItems: 'flex-end',
                    justifyContent: 'flex-end',
                    gap: 8,
                    maxWidth: '84%',
                  }}
                >
                  <View
                    class="opacity-0 group-hover:opacity-100"
                    style={{
                      flexDirection: 'row',
                      alignItems: 'center',
                      gap: 4,
                      paddingBottom: 4,
                    }}
                  >
                    <If when={props.message().pinned}>
                      <Icon name="pin" size={11} color={C.accent} />
                    </If>
                    <If when={Boolean(props.message().editedAt) && !isDeleted()}>
                      <Text style={{ fontSize: 10.5, color: C.muted }}>{tr('Edited')}</Text>
                    </If>
                    <Text style={{ fontSize: 10.5, color: C.muted }}>{props.timeLabel}</Text>
                  </View>
                  <View
                    style={{
                      maxWidth: '100%',
                      paddingHorizontal: 15,
                      paddingVertical: 10,
                      borderRadius: 18,
                      borderTopRightRadius: props.isContinuation() ? 8 : 18,
                      backgroundColor: isDeleted() ? C.surface : C.card,
                      gap: 6,
                    }}
                  >
                    {replyQuoteBlock()}
                    {bodySection()}
                  </View>
                </View>

                <If when={!isDeleted()}>
                  <RoomReactionStrip
                    reactions={() => props.message().reactions ?? []}
                    burstFor={props.burstFor}
                    name={props.name}
                    align="right"
                    onToggle={(emoji) => props.onReact(props.message().id, emoji)}
                    onOpenAgent={props.onOpenAgent}
                  />
                </If>

                <RoomDeliveryStrip
                  states={props.message().deliveryStates ?? []}
                  name={props.name}
                  align="right"
                  onOpenAgent={props.onOpenAgent}
                />
              </View>
            </If>
          </View>
        }
      >
        {contextMenuContent()}
      </ContextMenu>
    </View>
  );
}
