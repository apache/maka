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

import { createText, UiError, errorText, message as uiMessage } from './text';
import { tr } from './locale';
import { cleanup, computed, inputAction, signal, Text, View } from 'nsh';
import { useHost } from './host';
import { messageKey, type Position, type Row } from './history';
import { readOriginal, type OriginalMessage } from './MessageCopy';
import { forkTitle, type SessionAction } from './sessionLifecycle';
import { C, IconButton } from './ui';

const samePosition = (left: Position, right: Position) =>
  left.sourceSequence === right.sourceSequence && left.itemIndex === right.itemIndex;
type Target = OriginalMessage & { turnId: string };
const sameTarget = (left: Target | null, right: Target | null) =>
  left === right ||
  (left !== null &&
    right !== null &&
    left.sessionId === right.sessionId &&
    left.key === right.key &&
    left.turnId === right.turnId &&
    samePosition(left.position, right.position));

/**
 * Edit and resend a user message: fork the conversation before its turn and
 * put the message's text in the fork's composer. The original stays as it is.
 * To regenerate a reply, the fork sends the turn's opening message again.
 */
export function MessageEdit(props: {
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
      if (!row || row.role !== 'user' || row.field !== 'body' || !row.position || !row.turnId)
        return null;
      // Only the text is resent; a regenerated reply would lose the attachments.
      // Unknown attachments (a later fragment loaded alone) count as some.
      if (props.regenerate && (row.attachments === undefined || row.attachments.length > 0))
        return null;
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
  const owns = (original: Target) => alive && sameTarget(target(), original);
  const edit = async (original: Target | null) => {
    if (!original || !owns(original) || pending()) return;
    pending.set(true);
    notice.set('');
    try {
      const text = await readOriginal(host, original, () => owns(original));
      if (text === null) return;
      if (text === '') throw new UiError('This message has no text to edit.');
      const observed = await host.query('agent', 'observe', { sessionId: original.sessionId });
      if (!owns(original)) return;
      if (observed.session.id !== original.sessionId)
        throw new UiError('The Host observed a different conversation.');
      const opened = await props.edit(
        {
          kind: 'fork',
          session: observed.session,
          title: forkTitle(observed.session.title),
          position: { kind: 'before_turn', turnId: original.turnId },
        },
        text,
        props.regenerate ?? false,
      );
      if (!opened && owns(original)) notice.set(uiMessage('Fork created. Open it in Sessions.'));
    } catch (reason) {
      if (owns(original)) notice.set(errorText(reason));
    } finally {
      if (alive) pending.set(false);
    }
  };
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
            label={props.regenerate ? tr('Regenerate in a fork') : tr('Edit and resend')}
            tooltip={pending() ? tr('Creating fork…') : undefined}
            icon={props.regenerate ? 'refresh' : 'edit'}
            disabled={pending()}
            onPress={inputAction(edit, target())}
          />
        </If>
      </View>
    </If>
  );
}
