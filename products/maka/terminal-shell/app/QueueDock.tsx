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

import { createText, errorText, message as uiMessage } from './text';
import { tr } from './locale';
import {
  cleanup,
  computed,
  effect,
  Input,
  inputAction,
  Scroll,
  signal,
  Text,
  View,
  List,
} from 'nsh';
import { Button } from 'nsh/base';
import { keymap } from 'nsh/keymap';
import { Clipboard } from 'nsh/clipboard';
import { platform, windowSize } from 'nsh/device';
import type {
  AgentQueue,
  AgentQueueAction,
  AgentQueueMessageResult,
  AgentQueueMutationResult,
} from '../../../../packages/plugin-sdk/src/index.js';
import { C, bodyTextStyle, captionTextStyle, controlStyle } from './ui';
import { Icon } from './Icon';

export type QueueSession = {
  sessionId: string;
  snapshot(): AgentQueue | null;
  running(): boolean;
  read(messageId: string, expectedRevision: number): Promise<AgentQueueMessageResult>;
  change(expectedRevision: number, edit: AgentQueueAction): Promise<AgentQueueMutationResult>;
};
type RowAction = {
  sessionId: string;
  revision: number;
  messageId: string;
  kind: 'edit' | 'retract' | 'promote';
};
type Editing = {
  messageId: string;
  revision: number;
  text: string;
  hasAttachments: boolean;
};
type Review = Extract<AgentQueueMessageResult, { kind: 'ready' }>;
const actionStyle = {
  ...controlStyle,
  width: 32,
  height: 32,
  paddingHorizontal: 8,
  alignItems: 'center',
  justifyContent: 'center',
  borderRadius: 16,
} as const;

// Queue content belongs to the existing Host watch. Only an uncommitted inline
// edit and the current action's receipt/observation fence are local to this view.
export function QueueDock(props: { session: QueueSession }) {
  const session = props.session;
  const items = computed(
    () => session.snapshot()?.entries.filter((row) => row.kind !== 'in_flight') ?? [],
  );
  const collapsed = signal(true);
  const editing = signal<Editing | null>(null);
  const review = signal<Review | null>(null);
  const busy = signal<{ through: number | null } | null>(null);
  const error = createText();
  const copied = signal<string | null>(null);
  let alive = true;
  cleanup(() => {
    alive = false;
  });
  effect(() => {
    const pending = busy();
    if (pending?.through != null && (session.snapshot()?.revision ?? -1) >= pending.through)
      busy.set(null);
    if (items().length === 0) collapsed.set(true);
  });
  const expanded = () =>
    items().length === 1 || !collapsed() || editing() !== null || busy() !== null;
  const entry = (messageId: string) => items().find((row) => row.messageId === messageId);
  const revision = () => session.snapshot()?.revision ?? -1;
  const report = (reason: unknown) => {
    if (alive) error.set(errorText(reason));
  };
  const changedMessage = () =>
    editing()
      ? uiMessage('The queue changed. Your edit is kept; review the current message.')
      : uiMessage('The queue changed. Select the current message again.');
  const missingMessage = () =>
    editing()
      ? uiMessage('This message is no longer queued. Your edit is kept.')
      : uiMessage('This message is no longer queued.');
  const change = async (
    expectedRevision: number,
    edit: Exclude<AgentQueueAction, { kind: 'reorder' }>,
  ) => {
    if (!alive || busy()) return false;
    if (expectedRevision !== revision()) {
      error.set(changedMessage());
      return false;
    }
    busy.set({ through: null });
    error.set('');
    try {
      const result = await session.change(expectedRevision, edit);
      if (!alive) return false;
      if (result.kind === 'committed') {
        // Keep the row action pending until the original watch observes this
        // receipt. A successful receipt never supplies a replacement queue.
        busy.set(revision() >= result.revision ? null : { through: result.revision });
        return true;
      }
      busy.set(null);
      error.set(
        result.kind === 'revision_conflict'
          ? changedMessage()
          : result.reason === 'execution_changed'
            ? uiMessage('This turn cannot accept this message right now. It remains queued.')
            : result.reason === 'not_running'
              ? uiMessage('No turn is running. This message remains queued.')
              : result.reason === 'missing' || result.reason === 'in_flight'
                ? missingMessage()
                : uiMessage('The Host did not accept this queue change.'),
      );
    } catch (reason) {
      if (alive) busy.set(null);
      report(reason);
    }
    return false;
  };
  const read = async (messageId: string, expectedRevision: number) => {
    if (!alive || busy()) return null;
    busy.set({ through: null });
    error.set('');
    try {
      const result = await session.read(messageId, expectedRevision);
      if (!alive) return null;
      if (result.kind === 'ready' && result.revision === revision() && entry(messageId))
        return result;
      error.set(
        result.kind === 'missing'
          ? missingMessage()
          : uiMessage('The queue changed. Select Edit or Review again for its current message.'),
      );
    } catch (reason) {
      report(reason);
    } finally {
      if (alive) busy.set(null);
    }
    return null;
  };
  const act = async (request: RowAction) => {
    if (!alive || request.sessionId !== session.sessionId || busy()) return;
    const row = entry(request.messageId);
    if (!row || request.revision !== revision()) {
      error.set(uiMessage('The queue changed before this action. Select the current row again.'));
      return;
    }
    if (request.kind === 'edit') {
      const result = await read(row.messageId, request.revision);
      if (result && alive) {
        review.set(null);
        editing.set({
          messageId: row.messageId,
          revision: result.revision,
          text: result.message,
          hasAttachments: result.hasAttachments,
        });
      }
    } else if (request.kind !== 'promote' || (row.kind === 'followup' && session.running())) {
      await change(request.revision, { kind: request.kind, messageId: row.messageId });
    }
  };
  const save = async () => {
    const edit = editing();
    if (!edit || (!edit.text.trim() && !edit.hasAttachments)) return;
    if (
      await change(edit.revision, { kind: 'update', messageId: edit.messageId, message: edit.text })
    ) {
      if (alive && editing()?.messageId === edit.messageId) {
        editing.set(null);
        review.set(null);
      }
    }
  };
  const cancel = () => {
    if (!busy()) {
      editing.set(null);
      review.set(null);
      error.set('');
    }
  };
  const reviewLatest = async () => {
    const edit = editing();
    if (!edit) return;
    const latest = await read(edit.messageId, revision());
    if (alive && latest && editing()?.messageId === edit.messageId) review.set(latest);
  };
  const resolveReview = (useLatest: boolean) => {
    const edit = editing();
    const latest = review();
    if (!edit || !latest || latest.revision !== revision()) {
      error.set(uiMessage('The queue changed again. Review its current message before saving.'));
      return;
    }
    editing.set({
      messageId: edit.messageId,
      revision: latest.revision,
      text: useLatest ? latest.message : edit.text,
      hasAttachments: latest.hasAttachments,
    });
    review.set(null);
    error.set('');
  };
  const copyEdit = async () => {
    const text = editing()?.text;
    if (text !== undefined) {
      try {
        await Clipboard.writeText(text);
        if (alive) copied.set(text);
      } catch (reason) {
        report(reason);
      }
    }
  };
  const rowHeight = platform.isTerminal ? 32 : 40;
  const readerHeight = () => Math.max(rowHeight, windowSize().height / 4);
  return (
    <If when={items().length > 0 || editing() !== null || error()}>
      <View
        style={{
          backgroundColor: C.surface,
          borderRadius: platform.isTerminal ? 0 : 12,
          marginTop: 8,
          overflow: 'hidden',
        }}
      >
        <If when={items().length > 1}>
          <Button
            accessibilityLabel={tr('Queued messages')}
            tooltip={tr('Messages waiting for a turn')}
            selected={expanded()}
            disabled={editing() !== null || busy() !== null}
            onPress={inputAction(() => collapsed.set(!collapsed()), null)}
            style={{ ...controlStyle, flexDirection: 'row', alignItems: 'center', gap: 8 }}
            hoverStyle={{ backgroundColor: C.raised }}
            focusStyle={{ backgroundColor: C.line }}
          >
            <Icon name="queue" color={C.muted} />
            <Text style={{ ...captionTextStyle, color: C.secondary, flex: 1 }}>
              {tr('{count} queued messages', { count: items().length })}
            </Text>
            <Icon name={expanded() ? 'down' : 'right'} color={C.muted} />
          </Button>
        </If>
        <If when={expanded() && editing() === null}>
          <List
            accessibilityLabel={tr('Message queue')}
            each={items()}
            keyExtractor={(row) => row.messageId}
            estimatedItemSize={rowHeight}
            style={{ height: Math.min(items().length * rowHeight, readerHeight()), flexGrow: 0 }}
          >
            {(row) => {
              const number = () =>
                items().findIndex((item) => item.messageId === row().messageId) + 1;
              const request = (kind: RowAction['kind']): RowAction => ({
                sessionId: session.sessionId,
                revision: revision(),
                messageId: row().messageId,
                kind,
              });
              return (
                <View
                  style={{
                    height: rowHeight,
                    paddingHorizontal: 8,
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: 8,
                  }}
                >
                  <Icon name="queue" color={C.muted} />
                  <Text
                    numberOfLines={1}
                    style={{ ...captionTextStyle, color: C.secondary, flex: 1 }}
                  >
                    {row().kind === 'steering'
                      ? tr('Sending to current turn · {preview}', { preview: row().preview })
                      : row().preview}
                  </Text>
                  <Button
                    accessibilityLabel={tr('Edit queued message {number}', { number: number() })}
                    tooltip={tr('Edit message')}
                    disabled={busy() !== null || editing() !== null}
                    onPress={inputAction(act, request('edit'))}
                    style={actionStyle}
                    hoverStyle={{ backgroundColor: C.raised }}
                    focusStyle={{ backgroundColor: C.line }}
                  >
                    <Icon name="edit" color={C.muted} />
                  </Button>
                  <Button
                    accessibilityLabel={tr('Remove queued message {number}', { number: number() })}
                    tooltip={tr('Remove message')}
                    disabled={busy() !== null || editing() !== null}
                    onPress={inputAction(act, request('retract'))}
                    style={actionStyle}
                    hoverStyle={{ backgroundColor: C.raised }}
                    focusStyle={{ backgroundColor: C.line }}
                  >
                    <Icon name="close" color={C.muted} />
                  </Button>
                  <Button
                    accessibilityLabel={tr('Steer queued message {number} now', {
                      number: number(),
                    })}
                    tooltip={
                      row().kind === 'steering'
                        ? tr('Waiting for the next step')
                        : tr('Steer now · use in the current turn')
                    }
                    disabled={
                      busy() !== null ||
                      editing() !== null ||
                      row().kind !== 'followup' ||
                      !session.running()
                    }
                    onPress={inputAction(act, request('promote'))}
                    style={actionStyle}
                    hoverStyle={{ backgroundColor: C.raised }}
                    focusStyle={{ backgroundColor: C.line }}
                  >
                    <Icon name="send" color={C.muted} />
                  </Button>
                </View>
              );
            }}
          </List>
        </If>
        <Each of={editing() ? [editing()!] : []} key={(edit) => edit.messageId}>
          {(edit) => {
            let unbind = () => {};
            cleanup(() => unbind());
            return (
              <Scroll
                ref={(node) => {
                  unbind();
                  unbind = keymap.bind('escape', cancel, { when: 'always', within: node });
                }}
                style={{ maxHeight: Math.max(rowHeight * 3, windowSize().height / 3), flexGrow: 0 }}
              >
                <View style={{ padding: 12, gap: 8 }}>
                  <Text style={{ ...captionTextStyle, color: C.muted }}>
                    {entry(edit().messageId)
                      ? tr('Edit queued message')
                      : tr('Message no longer queued · your edit is kept')}
                    {edit().hasAttachments ? ' · attachments kept' : ''}
                  </Text>
                  <Input
                    accessibilityLabel={tr('Queued message editor')}
                    autoFocus
                    multiline
                    submitBehavior="submit"
                    value={edit().text}
                    readonly={busy() !== null}
                    onChange={(text) => editing.set({ ...edit(), text })}
                    onSubmit={({ text }) => {
                      editing.set({ ...edit(), text });
                      void save();
                    }}
                    style={{
                      ...bodyTextStyle,
                      color: C.text,
                      minHeight: 32,
                      maxHeight: readerHeight(),
                    }}
                  />
                  <If when={review()}>
                    <Text style={{ ...captionTextStyle, color: C.muted }}>
                      {tr('Current queued message')}
                    </Text>
                    <Scroll style={{ maxHeight: readerHeight(), flexGrow: 0 }}>
                      <Text selectable style={{ ...bodyTextStyle, color: C.secondary }}>
                        {review()!.message}
                      </Text>
                    </Scroll>
                    <View style={{ flexDirection: 'row', gap: 8 }}>
                      <Button
                        accessibilityLabel={tr('Keep my queued message edit')}
                        disabled={busy() !== null}
                        onPress={inputAction(resolveReview, false)}
                        style={controlStyle}
                      >
                        <Text style={{ color: C.secondary }}>{tr('Keep my edit')}</Text>
                      </Button>
                      <Button
                        accessibilityLabel={tr('Use current queued message')}
                        disabled={busy() !== null}
                        onPress={inputAction(resolveReview, true)}
                        style={controlStyle}
                      >
                        <Text style={{ color: C.secondary }}>{tr('Use current message')}</Text>
                      </Button>
                    </View>
                  </If>
                  <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                    <Button
                      accessibilityLabel={tr('Save queued message')}
                      disabled={
                        busy() !== null ||
                        !entry(edit().messageId) ||
                        edit().revision !== revision() ||
                        (!edit().text.trim() && !edit().hasAttachments)
                      }
                      onPress={inputAction(save, null)}
                      style={controlStyle}
                      hoverStyle={{ backgroundColor: C.raised }}
                      focusStyle={{ backgroundColor: C.line }}
                    >
                      <Text style={{ color: C.accent }}>{tr('Save')}</Text>
                    </Button>
                    <If when={entry(edit().messageId) && edit().revision !== revision()}>
                      <Button
                        accessibilityLabel={tr('Review current queued message')}
                        disabled={busy() !== null}
                        onPress={inputAction(reviewLatest, null)}
                        style={controlStyle}
                      >
                        <Text style={{ color: C.secondary }}>{tr('Review current message')}</Text>
                      </Button>
                    </If>
                    <If when={!entry(edit().messageId)}>
                      <Button
                        accessibilityLabel={tr('Copy queued message edit')}
                        onPress={inputAction(copyEdit, null)}
                        style={controlStyle}
                      >
                        <Text style={{ color: C.secondary }}>
                          {copied() === edit().text ? tr('Edit copied') : tr('Copy edit')}
                        </Text>
                      </Button>
                    </If>
                    <Button
                      accessibilityLabel={tr('Cancel queued message edit')}
                      disabled={busy() !== null}
                      onPress={inputAction(cancel, null)}
                      style={controlStyle}
                    >
                      <Text style={{ color: C.muted }}>{tr('Cancel')}</Text>
                    </Button>
                  </View>
                </View>
              </Scroll>
            );
          }}
        </Each>
        <If when={busy()}>
          <Text style={{ ...captionTextStyle, paddingHorizontal: 12, color: C.muted }}>
            {tr('Updating queue…')}
          </Text>
        </If>
        <If when={error()}>
          <Text selectable style={{ ...captionTextStyle, padding: 12, color: C.warning }}>
            {error()}
          </Text>
        </If>
      </View>
    </If>
  );
}
