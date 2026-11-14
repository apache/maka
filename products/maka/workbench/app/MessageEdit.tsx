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
  createText,
  UiError,
  errorText,
  message as uiMessage,
  renderText,
  type UiText,
} from './text';
import { tr } from './locale';
import { cleanup, computed, effect, inputAction, keymap, signal, Text, untracked, View } from 'nsh';
import type { Signal } from 'nsh';
import { Button, Input } from 'nsh/base';
import { useHost } from './host';
import {
  canRegenerateFromText,
  messageKey,
  sameHistoryRow,
  type Row,
  userAuthored,
} from './history';
import { readOriginal, type OriginalMessage } from './MessageCopy';
import type { MessageMenu } from './messageMenu';
import { forkTitle, type SessionAction } from './sessionLifecycle';
import { Icon } from './Icon';
import {
  C,
  bodyTextStyle,
  captionTextStyle,
  controlDisabledStyle,
  controlFocusStyle,
  controlHoverStyle,
  controlStyle,
  IconButton,
} from './ui';

type Target = OriginalMessage & { turnId?: string };
const sameTarget = (left: Target | null, right: Target | null) =>
  left === right ||
  (left !== null &&
    right !== null &&
    left.sessionId === right.sessionId &&
    left.key === right.key &&
    left.turnId === right.turnId &&
    sameHistoryRow(left.position, right.position));

/**
 * An edit open in place of a user message. It lives with the conversation's
 * row state, so it outlasts the row scrolling out of view. `text` is null
 * while the original loads.
 */
export type InlineEdit = { text: string | null; sending: boolean; notice: UiText };

type EditProps = {
  /** The user message; for a regenerated reply, the one that opened its turn. */
  row(): Row | null;
  /** Defaults to the row's own key. */
  ownerKey?(): string;
  regenerate?: boolean;
  sessionId: string;
  through(): number;
  /** Whether the row is the message that opened its turn; a steering message is not. */
  opensTurn(): boolean;
  /** Resolves whether the fork was opened; `send` sends the text there. */
  edit(
    action: Extract<SessionAction, { kind: 'fork' }>,
    text: string,
    send: boolean,
  ): Promise<boolean>;
};

function editTarget(props: EditProps) {
  return computed<Target | null>(
    () => {
      const row = props.row();
      if (!row || row.role !== 'user' || row.field !== 'body' || !row.position) return null;
      // A message the Host generated is not the user's to edit and resend as their own.
      if (!userAuthored(row)) return null;
      // Text replay must not drop attachments or structured references.
      if (props.regenerate && !canRegenerateFromText(row)) return null;
      // A fork before the turn of a steering message would also drop the message that opened it.
      if (!props.opensTurn()) return null;
      return {
        sessionId: props.sessionId,
        key: props.ownerKey?.() ?? messageKey(row),
        role: 'user',
        position: { ...row.position },
        through: row.metadataThrough ?? props.through(),
        turnId: row.turnId,
      };
    },
    { equals: sameTarget },
  );
}

/** Fork before the message's turn with `text`; null when the message changed meanwhile. */
async function forkBefore(
  host: ReturnType<typeof useHost>,
  props: EditProps,
  original: Target,
  text: string,
  send: boolean,
  owns: () => boolean,
): Promise<boolean | null> {
  const observed = await host.query('agent', 'observe', { sessionId: original.sessionId });
  if (!owns()) return null;
  if (observed.session.id !== original.sessionId)
    throw new UiError('The Host observed a different conversation.');
  return props.edit(
    {
      kind: 'fork',
      session: observed.session,
      title: forkTitle(observed.session.title),
      position: { kind: 'before_source_turn', position: original.position },
    },
    text,
    send,
  );
}

/**
 * Edit and resend a user message. With `inline`, a message of plain text opens
 * an editor in its place and nothing is created until it is sent; sending
 * forks the conversation before the message's turn and sends the edited text
 * there. A message with attachments or references forks at once and puts its
 * text in the fork's composer, where they can be added again. The original
 * stays as it is. To regenerate a reply, the fork sends the turn's opening
 * message again.
 */
export function MessageEdit(
  props: EditProps & {
    menu?: MessageMenu;
    /** Where an in-place edit of this message is kept. */
    inline?: Signal<InlineEdit | null>;
  },
) {
  const host = useHost();
  const pending = signal(false);
  const notice = createText();
  let alive = true;
  cleanup(() => {
    alive = false;
  });
  const target = editTarget(props);
  const owns = (original: Target) => alive && sameTarget(target(), original);
  const editing = () => (props.inline?.() ?? null) !== null;
  const inPlace = () => {
    const row = props.row();
    return !!props.inline && !props.regenerate && row !== null && canRegenerateFromText(row);
  };
  const edit = async (original: Target | null) => {
    if (!original || !owns(original) || pending() || editing()) return;
    notice.set('');
    // The editor replaces this row of actions and reads the original itself.
    if (inPlace()) return props.inline!.set({ text: null, sending: false, notice: '' });
    pending.set(true);
    try {
      const text = await readOriginal(host, original, () => owns(original));
      if (text === null) return;
      if (text === '') throw new UiError('This message has no text to edit.');
      const opened = await forkBefore(host, props, original, text, props.regenerate ?? false, () =>
        owns(original),
      );
      if (opened === false && owns(original))
        notice.set(uiMessage('Fork created. Open it in Sessions.'));
    } catch (reason) {
      if (owns(original)) notice.set(errorText(reason, 'Could not fork the conversation.'));
    } finally {
      if (alive) pending.set(false);
    }
  };
  const label = () =>
    props.regenerate ? tr('Regenerate in a fork') : tr('Edit and resend in a fork');
  props.menu?.add({
    kind: props.regenerate ? 'regenerate' : 'edit',
    label,
    busy: () => pending() || editing(),
    action: () => (target() === null ? null : inputAction(edit, target())),
  });
  // Render nothing when hidden, so the row of actions keeps its spacing.
  return (
    <If when={Boolean(notice()) || target() !== null}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, minWidth: 0 }}>
        <If when={notice()}>
          <Text style={[{ color: C.danger, fontSize: 12, lineHeight: 16 }, { userSelect: 'text' }]}>
            {notice()}
          </Text>
        </If>
        <If when={target() !== null}>
          <IconButton
            label={label()}
            tooltip={pending() ? tr('Creating fork…') : undefined}
            icon={props.regenerate ? 'refresh' : 'edit'}
            disabled={pending() || editing()}
            onPress={inputAction(edit, target())}
          />
        </If>
      </View>
    </If>
  );
}

/**
 * The editor that takes a user message's place while it is edited. Sending
 * creates the fork; cancelling leaves no trace. A failed fork keeps the text.
 */
export function MessageEditor(props: EditProps & { state: Signal<InlineEdit | null> }) {
  const host = useHost();
  const composing = signal(false);
  let alive = true;
  cleanup(() => {
    alive = false;
  });
  const target = editTarget(props);
  const edit = () => props.state();
  // The original is read by the editor shown, so an edit that scrolled away
  // before it loaded reads it again when it returns.
  let loading: InlineEdit | null = null;
  const load = async (current: InlineEdit, original: Target) => {
    try {
      const text = await readOriginal(
        host,
        original,
        () => alive && sameTarget(target(), original),
      );
      if (text === null || props.state() !== current) return;
      if (text === '') throw new UiError('This message has no text to edit.');
      props.state.set({ ...current, text });
    } catch (reason) {
      if (props.state() === current)
        props.state.set({
          ...current,
          notice: errorText(reason, 'Could not load conversation history.'),
        });
    }
  };
  effect(() => {
    const current = edit();
    const original = target();
    if (!current || current.text !== null || current.notice || !original || loading === current)
      return;
    loading = current;
    untracked(() => void load(current, original));
  });
  const sendable = () => {
    const current = edit();
    return (
      current !== null &&
      current.text !== null &&
      current.text.trim() !== '' &&
      !current.sending &&
      !composing() &&
      target() !== null
    );
  };
  const cancel = () => {
    if (!edit()?.sending) props.state.set(null);
  };
  const send = async (original: Target | null) => {
    const current = edit();
    if (!original || !sendable() || !sameTarget(target(), original) || current?.text == null)
      return;
    const sending = { ...current, sending: true, notice: '' };
    props.state.set(sending);
    try {
      const opened = await forkBefore(
        host,
        props,
        original,
        current.text,
        true,
        () => alive && sameTarget(target(), original),
      );
      if (opened === true) props.state.set(null);
      else if (opened === false && props.state() === sending)
        props.state.set({
          ...sending,
          sending: false,
          notice: uiMessage('Fork created. Open it in Sessions.'),
        });
    } catch (reason) {
      if (props.state() === sending)
        props.state.set({
          ...sending,
          sending: false,
          notice: errorText(reason, 'Could not send the message.'),
        });
    } finally {
      if (props.state() === sending) props.state.set({ ...sending, sending: false });
    }
  };
  let unbind = () => {};
  cleanup(() => unbind());
  return (
    <If when={edit()}>
      {(current) => (
        <View
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
          style={{ alignSelf: 'flex-end', width: '78%', minWidth: 0, gap: 8 }}
        >
          <View
            style={{
              paddingHorizontal: 16,
              paddingVertical: 12,
              borderRadius: 20,
              backgroundColor: C.card,
              borderWidth: 1,
              borderColor: C.accent,
            }}
          >
            <If
              when={current().text !== null}
              else={
                <Text style={{ ...bodyTextStyle, color: C.muted }}>
                  {current().notice !== '' ? '' : tr('Loading…')}
                </Text>
              }
            >
              <Input
                accessibilityLabel={tr('Message editor')}
                autoFocus
                multiline
                submitBehavior="submit"
                value={current().text ?? ''}
                readonly={current().sending}
                onChange={({ value: text }) => {
                  const latest = edit();
                  if (latest && !latest.sending) props.state.set({ ...latest, text });
                }}
                onCompositionChange={(event) => composing.set(event.composing)}
                onSubmit={({ text }) => {
                  if (composing()) return;
                  const latest = edit();
                  if (!latest || latest.sending) return;
                  props.state.set({ ...latest, text });
                  void send(target());
                }}
                style={{ ...bodyTextStyle, color: C.text, minHeight: 24 }}
              />
            </If>
          </View>
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'flex-end',
              gap: 8,
            }}
          >
            <Text
              style={[
                {
                  ...captionTextStyle,
                  color: current().notice !== '' ? C.danger : C.muted,
                  flexShrink: 1,
                },
                { userSelect: 'text' },
              ]}
            >
              {current().notice !== ''
                ? renderText(current().notice)
                : current().sending
                  ? tr('Creating fork…')
                  : tr('Sending continues in a new conversation. This one stays as it is.')}
            </Text>
            <Button
              accessibilityLabel={tr('Cancel')}
              disabled={current().sending}
              onPress={inputAction(cancel, null)}
              style={controlStyle}
              hoverStyle={controlHoverStyle()}
              focusStyle={controlFocusStyle()}
              disabledStyle={controlDisabledStyle}
            >
              <Text style={{ ...captionTextStyle, color: C.secondary }}>{tr('Cancel')}</Text>
            </Button>
            <Button
              accessibilityLabel={tr('Send edited message in a fork')}
              disabled={!sendable()}
              onPress={inputAction(send, target())}
              style={{ ...controlStyle, flexDirection: 'row', alignItems: 'center', gap: 4 }}
              hoverStyle={controlHoverStyle()}
              focusStyle={controlFocusStyle()}
              disabledStyle={controlDisabledStyle}
            >
              <Icon name="send" color={C.accent} />
              <Text style={{ ...captionTextStyle, color: C.accent }}>{tr('Send')}</Text>
            </Button>
          </View>
        </View>
      )}
    </If>
  );
}

/**
 * Send the opening message of a failed turn again in the same conversation.
 * It only sends from an empty composer, so a draft is never replaced; the
 * fork actions remain for changing the message first.
 */
export function TurnRetry(props: {
  /** The user message that opened the failed turn. */
  row(): Row | null;
  sessionId: string;
  through(): number;
  /** Why the text cannot be sent now, or null. */
  blocked(): string | null;
  send(text: string): Promise<void>;
}) {
  const host = useHost();
  const pending = signal(false);
  const notice = createText();
  let alive = true;
  cleanup(() => {
    alive = false;
  });
  const target = computed<Target | null>(
    () => {
      const row = props.row();
      if (!row || row.role !== 'user' || row.field !== 'body' || !row.position) return null;
      // Text replay must not drop attachments or structured references.
      if (!canRegenerateFromText(row)) return null;
      return {
        sessionId: props.sessionId,
        key: messageKey(row),
        role: 'user',
        position: { ...row.position },
        through: row.metadataThrough ?? props.through(),
        turnId: row.turnId,
      };
    },
    { equals: sameTarget },
  );
  const owns = (original: Target) => alive && sameTarget(target(), original);
  const retry = async (original: Target | null) => {
    if (!original || !owns(original) || pending()) return;
    notice.set(props.blocked() ?? '');
    if (props.blocked()) return;
    pending.set(true);
    try {
      const text = await readOriginal(host, original, () => owns(original));
      if (text === null) return;
      if (text === '') throw new UiError('This message has no text to edit.');
      // The draft may have changed while the text was read.
      const blocked = props.blocked();
      if (blocked) {
        notice.set(blocked);
        return;
      }
      await props.send(text);
    } catch (reason) {
      if (owns(original)) notice.set(errorText(reason, 'Could not send the message.'));
    } finally {
      if (alive) pending.set(false);
    }
  };
  return (
    <If when={target() !== null}>
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: 8,
          minWidth: 0,
          // The glyph starts where the failure above it does.
          marginLeft: -controlStyle.paddingHorizontal,
        }}
      >
        <Button
          accessibilityLabel={tr('Retry')}
          disabled={pending()}
          onPress={inputAction(retry, target())}
          style={{ ...controlStyle, flexDirection: 'row', alignItems: 'center', gap: 4 }}
          hoverStyle={controlHoverStyle()}
          focusStyle={controlFocusStyle()}
          disabledStyle={controlDisabledStyle}
        >
          <Icon name="refresh" color={C.accent} />
          <Text style={{ ...captionTextStyle, color: C.accent }}>{tr('Retry')}</Text>
        </Button>
        <If when={notice()}>
          <Text style={[{ ...captionTextStyle, color: C.muted }, { userSelect: 'text' }]}>
            {notice()}
          </Text>
        </If>
      </View>
    </If>
  );
}
