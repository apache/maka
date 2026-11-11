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
import { createText, errorText, message as uiMessage } from './text';
import { tr } from './locale';
import { cleanup, computed, effect, inputAction, Scroll, signal, Text, View, List } from 'nsh';
import { Input } from 'nsh/base';
import { Button } from 'nsh/base';
import { keymap } from 'nsh';
import { Clipboard } from 'nsh';
import { platform } from 'nsh';
import type {
  AgentQueueAction,
  AgentQueueMessageResult,
} from '../../../../packages/plugin-sdk/src/index.js';
import type {
  ComposerSendStatus,
  ComposerSession,
} from '../../../../packages/plugin-sdk/src/composer-view.js';
import { PendingMessage } from './PendingMessage';
import { C, bodyTextStyle, captionTextStyle, controlStyle } from './ui';
import { Icon } from './Icon';

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
export function createMessagesDock(
  session: Pick<
    ComposerSession,
    'queue' | 'sends' | 'connected' | 'retrySend' | 'checkSend' | 'dismissSend'
  >,
  height: () => number,
) {
  const queue = session.queue;
  const connected = session.connected;
  const sends = computed(() => session.sends());
  const items = computed(
    () =>
      queue
        .snapshot()
        ?.entries.filter(
          (row) => row.kind === 'followup' && row.origin?.kind !== 'session_completion',
        ) ?? [],
  );
  type Message =
    | { kind: 'send'; id: string; status: ComposerSendStatus }
    | { kind: 'queued'; id: string; entry: ReturnType<typeof items>[number] };
  const messages = computed<Message[]>(() => [
    ...sends().map((status) => ({ kind: 'send' as const, id: `send/${status.id}`, status })),
    ...items().map((entry) => ({
      kind: 'queued' as const,
      id: `queued/${entry.messageId}`,
      entry,
    })),
  ]);
  const problems = computed(() =>
    sends().filter((item) => item.state === 'failed' || item.state === 'unknown'),
  );
  const editing = signal<Editing | null>(null);
  const composing = signal(false);
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
    if (pending?.through != null && (queue.snapshot()?.revision ?? -1) >= pending.through)
      busy.set(null);
  });
  const entry = (messageId: string) => items().find((row) => row.messageId === messageId);
  const revision = () => queue.snapshot()?.revision ?? -1;
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
    if (!alive || !connected() || busy()) return false;
    if (expectedRevision !== revision()) {
      error.set(changedMessage());
      return false;
    }
    busy.set({ through: null });
    error.set('');
    try {
      const result = await queue.change(expectedRevision, edit);
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
    if (!alive || !connected() || busy()) return null;
    busy.set({ through: null });
    error.set('');
    try {
      const result = await queue.read(messageId, expectedRevision);
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
    if (!alive || !connected() || request.sessionId !== queue.sessionId || busy()) return;
    const row = entry(request.messageId);
    if (!row || request.revision !== revision()) {
      error.set(uiMessage('The queue changed before this action. Select the current row again.'));
      return;
    }
    if (request.kind === 'edit') {
      const result = await read(row.messageId, request.revision);
      if (result && alive) {
        review.set(null);
        composing.set(false);
        editing.set({
          messageId: row.messageId,
          revision: result.revision,
          text: result.message,
          hasAttachments: result.hasAttachments,
        });
      }
    } else if (request.kind !== 'promote' || queue.running()) {
      await change(request.revision, { kind: request.kind, messageId: row.messageId });
    }
  };
  const save = async () => {
    const edit = editing();
    if (composing() || !edit || (!edit.text.trim() && !edit.hasAttachments)) return;
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
      composing.set(false);
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
  const rowHeight = platform.idiom === 'terminal' ? 32 : 40;
  const readerHeight = height;
  const feedback = () => (
    <>
      <If when={busy()}>
        <Text style={{ ...captionTextStyle, paddingHorizontal: 12, color: C.muted }}>
          {tr('Updating queue…')}
        </Text>
      </If>
      <If when={connected() && error()}>
        <Text
          style={[{ ...captionTextStyle, padding: 12, color: C.warning }, { userSelect: 'text' }]}
        >
          {error()}
        </Text>
      </If>
    </>
  );
  return {
    shown: () =>
      messages().length > 0 || editing() !== null || busy() !== null || (connected() && !!error()),
    summary: () =>
      problems().length
        ? tr('{count} · {problems} to review', {
            count: messages().length,
            problems: problems().length,
          })
        : String(messages().length),
    preview: () =>
      problems()[0]?.detail ||
      (connected() && error()) ||
      (editing()
        ? tr('Edit queued message')
        : busy()
          ? tr('Updating queue…')
          : sends()[0]?.detail || items()[0]?.preview || ''),
    problem: () => problems().length > 0 || (connected() && !!error()),
    content: () => (
      <View style={{ minHeight: 0, flexShrink: 1 }}>
        <If when={editing() === null}>
          <List
            accessibilityLabel={tr('Messages')}
            each={messages()}
            keyExtractor={(row) => row.id}
            estimatedItemSize={rowHeight}
            style={{
              height: Math.min(sends().length * 96 + items().length * rowHeight, height()),
              minHeight: 0,
              flexShrink: 1,
              flexGrow: 0,
            }}
          >
            {(item) => {
              const pending = () => {
                const message = item();
                return message.kind === 'send' ? [message.status] : [];
              };
              const queued = () => {
                const message = item();
                return message.kind === 'queued' ? [message.entry] : [];
              };
              return (
                <>
                  <Each of={pending()} key={(status) => status.id}>
                    {(status) => <PendingMessage session={session} message={status()} />}
                  </Each>
                  <Each of={queued()} key={(entry) => entry.messageId}>
                    {(row) => {
                      const number = () =>
                        items().findIndex((item) => item.messageId === row().messageId) + 1;
                      const request = (kind: RowAction['kind']): RowAction => ({
                        sessionId: queue.sessionId,
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
                            style={[
                              { ...captionTextStyle, color: C.secondary, flex: 1 },
                              { numberOfLines: 1 },
                            ]}
                          >
                            {row().preview}
                          </Text>
                          <Button
                            accessibilityLabel={tr('Edit queued message {number}', {
                              number: number(),
                            })}
                            tooltip={textTooltip(() => tr('Edit message'))}
                            disabled={!connected() || busy() !== null || editing() !== null}
                            onPress={inputAction(act, request('edit'))}
                            style={actionStyle}
                            hoverStyle={{ backgroundColor: C.cardRaised }}
                            focusStyle={{ backgroundColor: C.line }}
                          >
                            <Icon name="edit" color={C.muted} />
                          </Button>
                          <Button
                            accessibilityLabel={tr('Remove queued message {number}', {
                              number: number(),
                            })}
                            tooltip={textTooltip(() => tr('Remove message'))}
                            disabled={!connected() || busy() !== null || editing() !== null}
                            onPress={inputAction(act, request('retract'))}
                            style={actionStyle}
                            hoverStyle={{ backgroundColor: C.cardRaised }}
                            focusStyle={{ backgroundColor: C.line }}
                          >
                            <Icon name="close" color={C.muted} />
                          </Button>
                          <Button
                            accessibilityLabel={tr('Steer queued message {number} now', {
                              number: number(),
                            })}
                            tooltip={textTooltip(() => tr('Steer now · use in the current turn'))}
                            disabled={
                              !connected() ||
                              busy() !== null ||
                              editing() !== null ||
                              !queue.running()
                            }
                            onPress={inputAction(act, request('promote'))}
                            style={actionStyle}
                            hoverStyle={{ backgroundColor: C.cardRaised }}
                            focusStyle={{ backgroundColor: C.line }}
                          >
                            <Icon name="send" color={C.muted} />
                          </Button>
                        </View>
                      );
                    }}
                  </Each>
                </>
              );
            }}
          </List>
          {feedback()}
        </If>
        <Each of={editing() ? [editing()!] : []} key={(edit) => edit.messageId}>
          {(edit) => {
            let unbind = () => {};
            cleanup(() => unbind());
            return (
              <Scroll
                ref={(node) => {
                  unbind();
                  unbind = keymap.bind(
                    'escape',
                    () => {
                      if (!composing()) cancel();
                    },
                    { when: 'always', within: node },
                  );
                }}
                style={{ maxHeight: height(), minHeight: 0, flexShrink: 1, flexGrow: 0 }}
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
                    onChange={({ value: text }) => editing.set({ ...edit(), text })}
                    onCompositionChange={(event) => composing.set(event.composing)}
                    onSubmit={({ text }) => {
                      if (composing()) return;
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
                      <Text
                        style={[{ ...bodyTextStyle, color: C.secondary }, { userSelect: 'text' }]}
                      >
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
                        !connected() ||
                        busy() !== null ||
                        composing() ||
                        !entry(edit().messageId) ||
                        edit().revision !== revision() ||
                        (!edit().text.trim() && !edit().hasAttachments)
                      }
                      onPress={inputAction(save, null)}
                      style={controlStyle}
                      hoverStyle={{ backgroundColor: C.cardRaised }}
                      focusStyle={{ backgroundColor: C.line }}
                    >
                      <Text style={{ color: C.accent }}>{tr('Save')}</Text>
                    </Button>
                    <If when={entry(edit().messageId) && edit().revision !== revision()}>
                      <Button
                        accessibilityLabel={tr('Review current queued message')}
                        disabled={!connected() || busy() !== null}
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
                  {feedback()}
                </View>
              </Scroll>
            );
          }}
        </Each>
      </View>
    ),
  };
}
