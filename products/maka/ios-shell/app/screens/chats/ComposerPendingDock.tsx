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
  createMotion,
  effect,
  LayoutAnimation,
  reduceMotion,
  Scroll,
  signal,
  Text,
  token,
  View,
  type JSX,
} from 'nsh';
import { Button, ContextMenu, Input } from 'nsh/base';
import { tr } from '../../locale';
import {
  sendPreview,
  trimHostWhitespace,
  type createConversationController,
} from '../../state/chat';
import { showToast } from '../../state/hostPool';
import { hapticSelection } from '../../state/preferences';
import { motion, spacing, type } from '../../theme/tokens';
import { glassSurfaceStyle, Icon } from '../../ui';

type Controller = ReturnType<typeof createConversationController>;
type QueuedMessage = NonNullable<Awaited<ReturnType<Controller['readQueuedMessage']>>>;
type Editing = { messageId: string; base: QueuedMessage; text: string; latest?: QueuedMessage };

const actions = { flexDirection: 'row', flexWrap: 'wrap', gap: 4 } as const;
const preview = { ...type.footnote, numberOfLines: 1, textOverflow: 'ellipsis' } as const;

function DockAction(props: {
  label: string;
  onPress: () => void;
  accessibilityLabel?: string;
  disabled?: boolean;
  destructive?: boolean;
}) {
  return (
    <Button
      accessibilityLabel={props.accessibilityLabel ?? props.label}
      disabled={props.disabled}
      onPress={props.onPress}
      class="active:opacity-60 disabled:opacity-40"
      style={{
        minHeight: 44,
        minWidth: 44,
        paddingHorizontal: 8,
        justifyContent: 'center',
        alignItems: 'center',
      }}
    >
      <Text
        style={{
          ...type.subheadlineMedium,
          color: token(props.destructive ? 'destructive' : 'glass-accent'),
        }}
      >
        {props.label}
      </Text>
    </Button>
  );
}

export function QueueSendMenu(props: {
  trigger: JSX.Element;
  onQueue?: () => void;
  disabled: boolean;
}) {
  return (
    <If when={props.onQueue !== undefined} else={props.trigger}>
      <ContextMenu
        trigger={props.trigger}
        items={[
          { id: 'queue', label: tr('Add to queue'), icon: 'text.append', disabled: props.disabled },
        ]}
        onSelect={() => {
          if (!props.disabled) props.onQueue?.();
        }}
      />
    </If>
  );
}

function SteeringPill(props: { text: string; sending?: boolean; queued?: boolean }) {
  const fade = reduceMotion()
    ? undefined
    : createMotion({ enter: 'fadeIn', duration: motion.fast });
  return (
    <View
      style={{
        ...glassSurfaceStyle(18),
        ...fade?.style,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        paddingHorizontal: 12,
        paddingVertical: 6,
      }}
    >
      <View
        style={{
          width: 6,
          height: 6,
          borderRadius: 3,
          backgroundColor: token('primary'),
          animationName: props.sending && !reduceMotion() ? 'pulse' : 'none',
          animationDuration: motion.skeletonPulse,
          animationTimingFunction: 'ease-in-out',
          animationIterationCount: 'infinite',
          animationFrameRate: 24,
        }}
      />
      <View style={{ flex: 1 }}>
        <Text style={{ ...preview, color: token('glass-muted') }}>
          {props.sending
            ? tr('Sending…')
            : props.queued
              ? tr('Waiting for queue…')
              : tr('Steer · Waiting for next step')}
        </Text>
        <Text style={{ ...preview, color: token('glass-foreground') }}>{props.text}</Text>
      </View>
    </View>
  );
}

export function ComposerPendingDock(props: {
  ctrl: Controller;
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  running: boolean;
  generation?: number;
  focusComposer: () => void;
}) {
  const ctrl = props.ctrl;
  const editing = signal<Editing | null>(null);
  const composing = signal(false);
  const editorNotice = () => {
    const edit = editing();
    return (
      ctrl.queueError() ??
      (edit && stale(edit) ? tr('The queue changed. Your edit is kept.') : null)
    );
  };
  const rowPresent = (id: string) => ctrl.queuedMessages().some((row) => row.messageId === id);
  const sameVersion = (message: QueuedMessage) =>
    message.generation === props.generation && message.revision === ctrl.queue()?.revision;
  const stale = (edit: Editing) => !sameVersion(edit.base) || !rowPresent(edit.messageId);
  const startEdit = async (messageId: string) => {
    const base = await ctrl.readQueuedMessage(messageId);
    if (base) editing.set({ messageId, base, text: base.message });
  };
  const reviewLatest = async () => {
    const edit = editing();
    if (!edit) return;
    const latest = await ctrl.readQueuedMessage(edit.messageId);
    if (latest) editing.update((draft) => draft && { ...draft, latest });
  };
  const acceptLatest = () => {
    const edit = editing();
    if (!edit?.latest || !sameVersion(edit.latest)) return;
    editing.set({ ...edit, base: edit.latest, latest: undefined });
    ctrl.clearQueueError();
  };
  const closeEditor = () => {
    composing.set(false);
    editing.set(null);
    ctrl.clearQueueError();
  };
  const save = async () => {
    const edit = editing();
    if (!edit || composing() || stale(edit)) return;
    if (await ctrl.updateQueuedMessage(edit.messageId, edit.base.revision, edit.text))
      closeEditor();
  };
  const copyEdit = async () => {
    const edit = editing();
    if (!edit) return;
    try {
      await Clipboard.writeText(edit.text);
      showToast(tr('Copied'));
    } catch (cause) {
      console.warn('Could not copy queued message edit', cause);
      showToast(tr('Could not copy the edit.'));
    }
  };
  const toggle = () => {
    hapticSelection();
    if (!reduceMotion())
      LayoutAnimation.configureNext(LayoutAnimation.create(motion.normal, 'easeInEaseOut'));
    if (props.expanded) composing.set(false);
    props.onExpandedChange(!props.expanded);
  };
  let pillCount = 0;
  effect(() => {
    const next =
      ctrl.steeringMessages().length +
      ctrl.pendingSends().filter((send) => !('detail' in send)).length;
    if (next < pillCount && !reduceMotion())
      LayoutAnimation.configureNext(
        LayoutAnimation.create(motion.fast, 'easeInEaseOut', 'opacity'),
      );
    pillCount = next;
  });

  return (
    <If
      when={
        ctrl.pendingSends().length ||
        ctrl.steeringMessages().length ||
        ctrl.queuedMessages().length ||
        editing() ||
        ctrl.queueError()
      }
    >
      <View style={{ paddingHorizontal: spacing.pageX, paddingBottom: 6, gap: 6 }}>
        <If when={ctrl.pendingSends().length || ctrl.steeringMessages().length}>
          <Scroll
            style={{ maxHeight: 152 }}
            contentStyle={{ gap: 5 }}
            keyboardShouldPersistTaps="handled"
          >
            <Each of={ctrl.pendingSends()} key={(send) => send.id}>
              {(send) => {
                const failure = () => {
                  const item = send();
                  return 'detail' in item ? item : null;
                };
                return (
                  <If
                    when={failure()}
                    else={
                      <SteeringPill
                        text={sendPreview(send().draft)}
                        sending={send().state === 'sending'}
                        queued={send().delivery === 'queue'}
                      />
                    }
                  >
                    {(failed) => (
                      <View
                        style={{
                          ...glassSurfaceStyle(18),
                          paddingHorizontal: 12,
                          paddingTop: 8,
                          paddingBottom: 3,
                          gap: 2,
                        }}
                      >
                        <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 7 }}>
                          <Icon
                            name="warning"
                            size={16}
                            color={token(send().state === 'unknown' ? 'warning' : 'destructive')}
                          />
                          <View style={{ flex: 1, gap: 2 }}>
                            <Text style={{ ...preview, color: token('glass-foreground') }}>
                              {sendPreview(send().draft)}
                            </Text>
                            <Text style={{ ...type.footnote, color: token('glass-muted') }}>
                              {failed().detail}
                            </Text>
                          </View>
                        </View>
                        <View style={actions}>
                          <DockAction
                            label={tr('Edit')}
                            disabled={ctrl.sending()}
                            onPress={() => {
                              if (ctrl.editPendingSend(send().id)) props.focusComposer();
                            }}
                          />
                          <If when={send().state === 'failed'}>
                            <DockAction
                              label={tr('Retry')}
                              disabled={ctrl.sending() || props.generation === undefined}
                              onPress={() => void ctrl.retryPendingSend(send().id)}
                            />
                          </If>
                          <DockAction
                            label={tr('Dismiss')}
                            onPress={() => ctrl.dismissPendingSend(send().id)}
                          />
                        </View>
                      </View>
                    )}
                  </If>
                );
              }}
            </Each>
            <Each of={ctrl.steeringMessages()} key={(entry) => entry.messageId}>
              {(entry) => <SteeringPill text={entry().preview} />}
            </Each>
          </Scroll>
        </If>

        <If when={ctrl.queuedMessages().length || editing() || ctrl.queueError()}>
          <View style={{ ...glassSurfaceStyle(18), maxHeight: 220, overflow: 'hidden' }}>
            <View
              role="button"
              accessibilityLabel={tr('Queued Messages ({count})', {
                count: ctrl.queuedMessages().length,
              })}
              accessibilityState={{ expanded: props.expanded }}
              onPress={toggle}
              class="active:opacity-70"
              style={{
                minHeight: 44,
                paddingHorizontal: 12,
                flexDirection: 'row',
                alignItems: 'center',
                gap: 8,
                flexShrink: 0,
              }}
            >
              <Icon name="queue" color={token('muted-foreground')} size={16} />
              <Text style={{ ...type.caption, color: token('glass-foreground') }}>
                {tr('{count} queued', { count: ctrl.queuedMessages().length })}
              </Text>
              <Text style={{ ...preview, flex: 1, color: token('glass-muted') }}>
                {props.expanded ? '' : ctrl.queuedMessages()[0]?.preview}
              </Text>
              <View style={{ transform: [{ rotate: props.expanded ? '180deg' : '0deg' }] }}>
                <Icon name="chevronDown" color={token('muted-foreground')} size={14} />
              </View>
            </View>

            <If when={props.expanded}>
              <Scroll
                style={{ maxHeight: 175, flexShrink: 1 }}
                contentStyle={{ paddingHorizontal: 12, paddingBottom: 6 }}
                keyboardShouldPersistTaps="handled"
              >
                <If when={editorNotice()}>
                  {(detail) => (
                    <Text
                      style={{ ...type.footnote, color: token('destructive'), marginBottom: 4 }}
                    >
                      {detail()}
                    </Text>
                  )}
                </If>
                <If
                  when={editing()}
                  else={
                    <Each of={ctrl.queuedMessages()} key={(entry) => entry.messageId}>
                      {(entry) => (
                        <View
                          style={{
                            borderTopWidth: spacing.hairline,
                            borderColor: token('glass-border'),
                            paddingTop: 6,
                          }}
                        >
                          <Text style={{ ...preview, color: token('glass-foreground') }}>
                            {entry().preview || tr('Queued turn')}
                          </Text>
                          <View style={actions}>
                            <DockAction
                              label={tr('Steer now')}
                              disabled={!props.running || ctrl.queueBusy()}
                              onPress={() => void ctrl.promoteQueuedMessage(entry().messageId)}
                            />
                            <DockAction
                              label={tr('Edit')}
                              accessibilityLabel={tr('Edit queued message')}
                              disabled={ctrl.queueBusy()}
                              onPress={() => void startEdit(entry().messageId)}
                            />
                            <DockAction
                              label={tr('Remove')}
                              accessibilityLabel={tr('Remove queued message')}
                              disabled={ctrl.queueBusy()}
                              destructive
                              onPress={() => void ctrl.cancelQueuedMessage(entry().messageId)}
                            />
                          </View>
                        </View>
                      )}
                    </Each>
                  }
                >
                  {(edit) => (
                    <View style={{ gap: 4 }}>
                      <Input
                        testID="queue-message-editor"
                        multiline
                        accessibilityLabel={tr('Edit queued message')}
                        value={edit().text}
                        disabled={ctrl.queueBusy()}
                        onCompositionChange={({ composing: active }) => composing.set(active)}
                        onChange={({ value }) =>
                          editing.update((current) => current && { ...current, text: value })
                        }
                        style={{
                          ...type.body,
                          minHeight: 44,
                          maxHeight: 88,
                          padding: 8,
                          color: token('foreground'),
                          backgroundColor: token('surface'),
                          borderRadius: spacing.controlRadius,
                        }}
                      />
                      <If when={edit().latest && sameVersion(edit().latest!)}>
                        <Text style={{ ...type.caption, color: token('glass-muted') }}>
                          {tr('Current queued message')}
                        </Text>
                        <Text style={{ ...type.footnote, color: token('glass-foreground') }}>
                          {edit().latest?.message}
                        </Text>
                      </If>
                      <View style={actions}>
                        <If
                          when={stale(edit())}
                          else={
                            <DockAction
                              label={tr('Save')}
                              disabled={
                                ctrl.queueBusy() ||
                                composing() ||
                                !(
                                  trimHostWhitespace(edit().text) ||
                                  edit().base.hasAttachments ||
                                  edit().base.quotes.length
                                )
                              }
                              onPress={() => void save()}
                            />
                          }
                        >
                          <If
                            when={edit().latest && sameVersion(edit().latest!)}
                            else={
                              <If when={rowPresent(edit().messageId)}>
                                <DockAction
                                  label={tr('Review latest')}
                                  disabled={ctrl.queueBusy()}
                                  onPress={() => void reviewLatest()}
                                />
                              </If>
                            }
                          >
                            <DockAction label={tr('Keep my edit')} onPress={acceptLatest} />
                          </If>
                        </If>
                        <DockAction label={tr('Copy edit')} onPress={() => void copyEdit()} />
                        <DockAction
                          label={tr('Cancel')}
                          disabled={ctrl.queueBusy()}
                          onPress={closeEditor}
                        />
                      </View>
                    </View>
                  )}
                </If>
                <If when={!editing() && !ctrl.queuedMessages().length && ctrl.queueError()}>
                  <DockAction label={tr('Dismiss')} onPress={ctrl.clearQueueError} />
                </If>
              </Scroll>
            </If>
          </View>
        </If>
      </View>
    </If>
  );
}
