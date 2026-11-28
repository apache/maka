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

import { cleanup, Clipboard, effect, platform, signal, Text, View } from 'nsh';
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
import {
  formatRoomPreviewText,
  roomAuthorSession,
  roomAvatarColor,
  roomAvatarInitial,
  roomTextNeedsMarkdown,
} from './roomMessage';
import { createJumpHighlightValue, runJumpHighlight, useLiveMessageStyle } from './roomMotion';
import {
  C,
  captionTextStyle,
  controlFocusStyle,
  controlStyle,
  floatingStyle,
  inputTextStyle,
  menuRowHoverStyle,
  menuRowStyle,
  radius,
  raisedShadow,
  readingTextStyle,
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
  onBurstDone?(emoji: string): void;
  onRowLayout?(messageId: string, y: number): void;
  onError?(reason: unknown): void;
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
  const editComposing = signal(false);
  const highlight = createJumpHighlightValue();
  const enterStyle = useLiveMessageStyle(props.isLive());
  let lastHighlightTick = 0;
  let cancelHighlight: (() => void) | null = null;

  effect(() => {
    const tick = props.highlightTick();
    if (props.isHighlighted() && tick > 0 && tick !== lastHighlightTick) {
      lastHighlightTick = tick;
      cancelHighlight?.();
      cancelHighlight = runJumpHighlight(highlight);
    }
  });

  cleanup(() => {
    cancelHighlight?.();
    cancelHighlight = null;
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
          borderRadius: radius(4),
          alignSelf: 'stretch',
        }}
        hoverStyle={{ backgroundColor: C.surface }}
      >
        <Text style={[{ ...captionTextStyle, color: C.secondary }, { numberOfLines: 1 }]}>
          {formatRoomPreviewText(props.repliedMessage()?.content.text ?? '') ||
            tr('View replied message')}
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
        <View style={{ gap: 8, minWidth: 260 }}>
          <Input
            autoFocus
            multiline
            submitBehavior="submit"
            accessibilityLabel={tr('Edit message')}
            value={props.editDraft()}
            onChange={({ value }) => props.setEditDraft(value)}
            onCompositionChange={(event) => editComposing.set(event.composing)}
            onSubmit={({ text }) => {
              if (editComposing()) return;
              props.setEditDraft(text);
              props.onSaveEdit();
            }}
            style={{
              ...inputTextStyle,
              color: C.text,
              backgroundColor: C.raised,
              borderRadius: radius(8),
              padding: 10,
              minHeight: 36,
              maxHeight: 220,
            }}
          />
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <Button
              accessibilityLabel={tr('Save')}
              onPress={props.onSaveEdit}
              style={{ ...controlStyle(), backgroundColor: C.surface }}
            >
              <Text style={{ ...captionTextStyle, color: C.accentText }}>{tr('Save')}</Text>
            </Button>
            <Button
              accessibilityLabel={tr('Cancel')}
              onPress={props.onCancelEdit}
              style={controlStyle()}
            >
              <Text style={{ ...captionTextStyle, color: C.secondary }}>{tr('Cancel')}</Text>
            </Button>
          </View>
        </View>
      </If>
      <If when={!isDeleted() && !props.isEditing() && Boolean(props.message().content.text)}>
        {/* Keep selectable scoped to prose so outer double-click quick-react still fires,
            while binding ContextMenu directly to the selectable trigger so right-click opens
            the Room menu instead of the default selectable-text menu. */}
        <ContextMenu
          offset={4}
          margin={8}
          popupStyle={floatingStyle()}
          trigger={
            <View selectable>
              <If
                when={isHuman() && !roomTextNeedsMarkdown(props.message().content.text)}
                else={
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
                }
              >
                <Text style={{ ...readingTextStyle(), color: C.text }}>
                  {props.message().content.text}
                </Text>
              </If>
            </View>
          }
        >
          {contextMenuContent()}
        </ContextMenu>
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
                accessibilityLabel={emoji()}
                onSelect={() => {
                  recordRecentReaction(emoji());
                  props.onReact(props.message().id, emoji());
                }}
                style={{
                  width: 28,
                  height: 28,
                  borderRadius: radius(6),
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
                hoverStyle={{ backgroundColor: C.surface }}
                focusStyle={{ backgroundColor: C.surface }}
              >
                <Text style={{ fontSize: 15 }}>{emoji()}</Text>
              </MenuItem>
            )}
          </Each>
        </View>
      </If>
      <MenuItem
        accessibilityLabel={tr('Reply to message')}
        onSelect={() => props.onReply(props.message())}
        style={{ ...menuRowStyle(), minWidth: 168 }}
        hoverStyle={menuRowHoverStyle()}
        focusStyle={menuRowHoverStyle()}
      >
        <Text style={{ ...captionTextStyle, color: C.text }}>{tr('Reply to message')}</Text>
      </MenuItem>
      <If when={!isDeleted()}>
        <MenuItem
          accessibilityLabel={props.message().pinned ? tr('Unpin message') : tr('Pin message')}
          onSelect={() => props.onTogglePin(props.message().id, !props.message().pinned)}
          style={{ ...menuRowStyle(), minWidth: 168 }}
          hoverStyle={menuRowHoverStyle()}
          focusStyle={menuRowHoverStyle()}
        >
          <Text style={{ ...captionTextStyle, color: C.text }}>
            {props.message().pinned ? tr('Unpin message') : tr('Pin message')}
          </Text>
        </MenuItem>
        <If when={Boolean(props.message().content.text)}>
          <MenuItem
            accessibilityLabel={tr('Copy message')}
            onSelect={() =>
              void Clipboard.writeText(props.message().content.text).catch((reason) =>
                props.onError?.(reason),
              )
            }
            style={{ ...menuRowStyle(), minWidth: 168 }}
            hoverStyle={menuRowHoverStyle()}
            focusStyle={menuRowHoverStyle()}
          >
            <Text style={{ ...captionTextStyle, color: C.text }}>{tr('Copy message')}</Text>
          </MenuItem>
        </If>
        <MenuItem
          accessibilityLabel={tr('Edit message')}
          onSelect={() => props.onStartEdit(props.message())}
          style={{ ...menuRowStyle(), minWidth: 168 }}
          hoverStyle={menuRowHoverStyle()}
          focusStyle={menuRowHoverStyle()}
        >
          <Text style={{ ...captionTextStyle, color: C.text }}>{tr('Edit message')}</Text>
        </MenuItem>
        <MenuItem
          accessibilityLabel={tr('Delete message')}
          onSelect={() => props.onDelete(props.message().id)}
          style={{ ...menuRowStyle(), minWidth: 168 }}
          hoverStyle={menuRowHoverStyle()}
          focusStyle={menuRowHoverStyle()}
        >
          <Text style={{ ...captionTextStyle, color: C.danger }}>{tr('Delete message')}</Text>
        </MenuItem>
      </If>
    </>
  );

  const humanCardNeedsFixedWidth = () =>
    !isDeleted() && (props.isEditing() || roomTextNeedsMarkdown(props.message().content.text));

  return (
    <View
      onLayout={({ bounds }) => props.onRowLayout?.(props.message().id, bounds.origin.y)}
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
              borderRadius: radius(12),
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
                          class={
                            platform.idiom === 'terminal'
                              ? undefined
                              : 'opacity-0 group-hover:opacity-100'
                          }
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
                              color: isInspected() ? C.accentText : C.text,
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
                          <Icon name="pin" size={11} color={C.accentText} />
                        </If>
                      </View>
                    </If>

                    {replyQuoteBlock()}
                    {bodySection()}

                    <If when={!isDeleted()}>
                      <RoomReactionStrip
                        reactions={() => props.message().reactions ?? []}
                        burstFor={props.burstFor}
                        onBurstDone={props.onBurstDone}
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
                    width: '100%',
                    flexDirection: 'row',
                    alignItems: 'flex-end',
                    justifyContent: 'flex-end',
                    gap: 8,
                  }}
                >
                  <View
                    class={
                      platform.idiom === 'terminal'
                        ? undefined
                        : 'opacity-0 group-hover:opacity-100'
                    }
                    style={{
                      flexDirection: 'row',
                      alignItems: 'center',
                      gap: 4,
                      paddingBottom: 4,
                      flexShrink: 0,
                    }}
                  >
                    <If when={props.message().pinned}>
                      <Icon name="pin" size={11} color={C.accentText} />
                    </If>
                    <If when={Boolean(props.message().editedAt) && !isDeleted()}>
                      <Text style={{ fontSize: 10.5, color: C.muted }}>{tr('Edited')}</Text>
                    </If>
                    <Text style={{ fontSize: 10.5, color: C.muted }}>{props.timeLabel}</Text>
                  </View>
                  <View
                    style={{
                      width: humanCardNeedsFixedWidth() ? '78%' : undefined,
                      maxWidth: '78%',
                      paddingHorizontal: 15,
                      paddingVertical: 10,
                      borderRadius: radius(18),
                      borderTopRightRadius: props.isContinuation() ? radius(8) : radius(18),
                      backgroundColor: isDeleted() ? C.surface : C.card,
                      gap: 6,
                      ...raisedShadow(),
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
                    onBurstDone={props.onBurstDone}
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
