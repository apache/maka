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
import { Clipboard } from 'nsh';
import { useHost } from './host';
import { messageBytes, type Position, type Row } from './history';
import { C, IconButton } from './ui';

type OriginalMessage = {
  sessionId: string;
  key: string;
  role: 'user' | 'assistant';
  position: Position;
  through: number;
};
const samePosition = (left: Position, right: Position) =>
  left.sourceSequence === right.sourceSequence && left.itemIndex === right.itemIndex;
const sameMessage = (left: OriginalMessage | null, right: OriginalMessage | null) =>
  left === right ||
  (left !== null &&
    right !== null &&
    left.sessionId === right.sessionId &&
    left.key === right.key &&
    left.role === right.role &&
    samePosition(left.position, right.position));

/** Copy one canonical body, including text outside the loaded history window. */
export function MessageCopy(props: {
  row(): Row;
  ownerKey(): string;
  sessionId: string;
  through(): number;
}) {
  const host = useHost();
  const busy = signal(false);
  const notice = createText();
  const failed = signal(false);
  let alive = true;
  cleanup(() => {
    alive = false;
  });
  const target = computed<OriginalMessage | null>(
    () => {
      const row = props.row();
      if (row.field !== 'body' || !row.position) return null;
      if (row.role !== 'user' && (row.role !== 'assistant' || !row.finalOutput)) return null;
      return {
        sessionId: props.sessionId,
        key: props.ownerKey(),
        role: row.role,
        position: { ...row.position },
        through: row.metadataThrough ?? props.through(),
      };
    },
    // A canonical body is immutable at its position. New metadata fences
    // do not replace the original copy target while another turn streams.
    { equals: sameMessage },
  );
  const owns = (original: OriginalMessage) => alive && sameMessage(target(), original);
  const copy = async (original: OriginalMessage | null) => {
    if (original === null || !owns(original) || busy()) return;
    busy.set(true);
    notice.set('');
    failed.set(false);
    try {
      let content = '';
      let offset = 0;
      let total: number | null = null;
      for (;;) {
        const page = await host.query('agent', 'source', {
          sessionId: original.sessionId,
          through: original.through,
          source: { kind: 'row', position: original.position },
          field: 'body',
          position: offset === 0 ? { kind: 'start' } : { kind: 'after', offset },
        });
        if (!owns(original)) return;
        const source = page.source;
        const end = offset + messageBytes(source.text);
        if (
          page.kind !== 'ready' ||
          page.through !== original.through ||
          !samePosition(source.position, original.position) ||
          source.field !== 'body' ||
          source.role !== original.role ||
          source.format !== 'text' ||
          source.path != null ||
          source.offset !== offset ||
          !Number.isSafeInteger(source.totalBytes) ||
          source.totalBytes < 0 ||
          (total !== null && source.totalBytes !== total) ||
          end > source.totalBytes ||
          (end === offset && end !== source.totalBytes)
        ) {
          throw new UiError('The original message source could not be verified.');
        }
        total = source.totalBytes;
        content += source.text;
        offset = end;
        if (offset === total) break;
      }
      if (!owns(original)) return;
      await Clipboard.writeText(content);
      if (owns(original))
        notice.set(
          original.role === 'user' ? uiMessage('User message copied') : uiMessage('Message copied'),
        );
    } catch (reason) {
      if (owns(original)) {
        failed.set(true);
        notice.set(errorText(reason));
      }
    } finally {
      if (owns(original)) busy.set(false);
    }
  };
  return (
    <View
      style={{
        flexDirection: 'row',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: 8,
        minWidth: 0,
        maxWidth: '100%',
      }}
    >
      <If when={notice()}>
        <Text style={{ color: failed() ? C.danger : C.muted, fontSize: 12, lineHeight: 16 }}>
          {notice()}
        </Text>
      </If>
      <IconButton
        label={props.row().role === 'user' ? tr('Copy user message') : tr('Copy message')}
        tooltip={busy() ? tr('Reading original message…') : undefined}
        icon={notice() && !failed() ? 'check' : 'copy'}
        disabled={target() === null}
        onPress={inputAction(copy, target())}
      />
    </View>
  );
}
