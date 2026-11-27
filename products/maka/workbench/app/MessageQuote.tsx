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

import type { QuoteRef } from '../../../../packages/plugin-sdk/src/index.js';
import { cleanup, computed, signal } from 'nsh';
import { hasTextPrefix, messageBytes, sameHistoryRow, type Row } from './history';
import { useHost } from './host';
import { tr } from './locale';
import { readOriginal, type OriginalMessage } from './MessageCopy';
import type { MessageMenu } from './messageMenu';
import type { MessageSelection } from './messageSelection';
import { errorText, renderText } from './text';
import { toast } from './toastStore';
import { IconButton } from './ui';

type QuoteTarget = OriginalMessage & {
  messageId?: string;
  turnId?: string;
};

const sameTarget = (left: QuoteTarget | null, right: QuoteTarget | null) =>
  left === right ||
  (left !== null &&
    right !== null &&
    left.sessionId === right.sessionId &&
    left.key === right.key &&
    left.role === right.role &&
    left.messageId === right.messageId &&
    left.turnId === right.turnId &&
    sameHistoryRow(left.position, right.position));

function hasCompleteBody(row: Row): boolean {
  return (
    hasTextPrefix(row) &&
    (row.totalBytes === undefined || messageBytes(row.text) === row.totalBytes)
  );
}

/** Quote a selected passage or a whole message into the current conversation's draft. */
export function MessageQuote(props: {
  compact?: boolean;
  menuOnly?: boolean;
  row(): Row;
  ownerKey(): string;
  sessionId: string;
  through(): number;
  menu?: MessageMenu;
  selection?: MessageSelection;
  quote(quote: QuoteRef): boolean;
}) {
  const host = useHost();
  const busy = signal(false);
  let alive = true;
  cleanup(() => {
    alive = false;
  });
  const target = computed<QuoteTarget | null>(
    () => {
      const row = props.row();
      if (row.field !== 'body' || !row.position) return null;
      if (
        row.role !== 'user' &&
        (row.role !== 'assistant' || (!row.finalOutput && row.position.kind === 'live'))
      )
        return null;
      if (hasCompleteBody(row) && !row.text.trim()) return null;
      return {
        sessionId: props.sessionId,
        key: props.ownerKey(),
        role: row.role,
        position: { ...row.position },
        through: row.metadataThrough ?? props.through(),
        messageId: row.messageId || undefined,
        turnId: row.turnId,
      };
    },
    { equals: sameTarget },
  );
  const owns = (original: QuoteTarget) => alive && sameTarget(target(), original);
  const buildQuote = (original: QuoteTarget, text: string): QuoteRef => ({
    text,
    ...(original.messageId ? { sourceMessageId: original.messageId } : {}),
    ...(original.turnId ? { sourceTurnId: original.turnId } : {}),
  });
  const quote = async (original: QuoteTarget | null, selected: string | null) => {
    if (original === null || !owns(original) || busy()) return;
    if (selected && selected.trim()) {
      if (props.quote(buildQuote(original, selected))) props.selection?.clear();
      return;
    }
    const current = props.row();
    if (hasCompleteBody(current)) {
      if (current.text.trim()) props.quote(buildQuote(original, current.text));
      return;
    }
    busy.set(true);
    try {
      const content = await readOriginal(host, original, () => owns(original));
      if (content !== null && content.trim() && owns(original))
        props.quote(buildQuote(original, content));
    } catch (reason) {
      if (owns(original)) {
        toast.show({
          id: 'message.quote',
          tone: 'danger',
          message: renderText(errorText(reason, 'Could not quote the message.')),
        });
      }
    } finally {
      if (owns(original)) busy.set(false);
    }
  };
  const label = () =>
    props.selection?.current()
      ? tr('Quote selection')
      : props.row().role === 'user'
        ? tr('Quote user message')
        : tr('Quote message');
  props.menu?.add({
    kind: 'quote',
    label,
    busy,
    // The menu holds the passage selected as it opened.
    action: () => {
      const current = target();
      if (current === null) return null;
      const selected = props.selection?.current() ?? null;
      return () => void quote(current, selected);
    },
  });
  if (props.menuOnly) return null;
  const press = props.selection
    ? props.selection.bindPress((selected) => void quote(target(), selected))
    : { onPress: () => void quote(target(), null) };
  return (
    <IconButton
      compact={props.compact}
      label={label()}
      tooltip={busy() ? tr('Reading original message…') : undefined}
      icon="snippet"
      disabled={busy() || target() === null}
      {...press}
    />
  );
}
