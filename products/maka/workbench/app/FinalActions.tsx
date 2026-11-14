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

import { formatDuration } from './duration';
import { createText, UiError, errorText, message as uiMessage } from './text';
import { tr } from './locale';
import { cleanup, computed, inputAction, signal, Text, View } from 'nsh';
import type { JSX } from 'nsh';
import { useHost } from './host';
import { sameValue } from '../../../../plugins/shared/value';
import { sameHistoryRow, type Row } from './history';
import type { HistoryRowAddress } from '../../../../packages/plugin-sdk/src/index.js';
import { MessageCopy } from './MessageCopy';
import { forkTitle, type SessionAction } from './sessionLifecycle';
import { Button } from 'nsh/base';
import type { MessageMenu } from './messageMenu';
import { cacheHitRate, executorUsageLabel, TurnUsage } from './TurnUsage';
import { addPendingQuote, forgetPassage, pendingQuotes, selectedPassage } from './sideThreads';
import { SideThreadsMenu } from './SideThreadsMenu';
import {
  C,
  controlDisabledStyle,
  controlStyle,
  IconButton,
  quietActiveStyle,
  quietFocusStyle,
  quietHoverStyle,
  textTooltip,
} from './ui';

type Target = {
  sessionId: string;
  key: string;
  position: HistoryRowAddress;
  turnId?: string;
};
const sameTarget = (left: Target | null, right: Target | null) =>
  left === right ||
  (left !== null &&
    right !== null &&
    left.sessionId === right.sessionId &&
    left.key === right.key &&
    left.turnId === right.turnId &&
    sameHistoryRow(left.position, right.position));

/** Actions retain this exact completed reply, even if a later turn is running. */
export function FinalActions(props: {
  row(): Row;
  ownerKey(): string;
  sessionId: string;
  through(): number;
  fork(action: Extract<SessionAction, { kind: 'fork' }>): Promise<void>;
  /** Forks at this turn beside it, quoting `passage` (the selection, if any). */
  askBeside?(turnId: string, passage: string | null): Promise<void>;
  /** Another action on this turn, after the fork. */
  extra?: JSX.Element;
  menu?: MessageMenu;
}) {
  const host = useHost();
  const pending = signal(false);
  const notice = createText();
  const usage = signal<(Target & { turnId: string }) | null>(null);
  let alive = true;
  cleanup(() => {
    alive = false;
  });
  const target = computed<Target | null>(
    () => {
      const row = props.row();
      return row.position &&
        (row.finalOutput ||
          (row.position.kind !== 'live' && row.role === 'assistant' && row.field === 'body'))
        ? {
            sessionId: props.sessionId,
            key: props.ownerKey(),
            position: { ...row.position },
            turnId: row.turnId,
          }
        : null;
    },
    // Final output is published after this turn's model outcomes and usage settle.
    // Later turns must not rebind actions for the same completed reply.
    { equals: sameTarget },
  );
  const owns = (original: Target) => alive && sameTarget(target(), original);
  const fork = async (original: Target | null) => {
    if (!original || !owns(original) || pending()) return;
    pending.set(true);
    notice.set('');
    try {
      const observed = await host.query('agent', 'observe', {
        sessionId: original.sessionId,
      });
      if (!owns(original)) return;
      if (observed.session.id !== original.sessionId)
        throw new UiError('The Host observed a different conversation.');
      await props.fork({
        kind: 'fork',
        session: observed.session,
        title: forkTitle(observed.session.title),
        position: { kind: 'through_source_turn', position: original.position },
      });
      if (owns(original)) notice.set(uiMessage('Fork created. Open it in Sessions.'));
    } catch (reason) {
      if (owns(original)) notice.set(errorText(reason, 'Could not fork the conversation.'));
    } finally {
      if (alive) pending.set(false);
    }
  };
  const asking = signal(false);
  const askLabel = () =>
    pendingQuotes(props.sessionId).length > 0
      ? tr('Ask beside with the {count} quoted', { count: pendingQuotes(props.sessionId).length })
      : selectedPassage(props.sessionId, props.row().turnId ?? '')
        ? tr('Ask about the selection beside')
        : tr('Ask beside');
  // The menu passes the passage selected as it opened: it may stay open longer
  // than a cleared selection counts.
  const ask = async (original: Target | null, held?: string | null) => {
    if (!original || !owns(original) || asking() || !props.askBeside) return;
    const turnId = original.turnId;
    if (turnId === undefined) return;
    asking.set(true);
    notice.set('');
    try {
      const passage = held === undefined ? selectedPassage(original.sessionId, turnId) : held;
      await props.askBeside(turnId, passage);
      if (passage) forgetPassage();
    } catch (reason) {
      if (owns(original)) notice.set(errorText(reason, 'Could not fork the conversation.'));
    } finally {
      if (alive) asking.set(false);
    }
  };
  const askHeld = (held: { original: Target; passage: string | null }) =>
    ask(held.original, held.passage);
  // Gather the selected passage to ask about with others (the tray above the composer).
  const quote = (held: { original: Target | null; passage?: string | null }) => {
    const original = held.original;
    if (!original || !owns(original)) return;
    const turnId = original.turnId;
    if (turnId === undefined) return;
    const passage =
      held.passage === undefined ? selectedPassage(original.sessionId, turnId) : held.passage;
    if (!passage) {
      notice.set(uiMessage('Select a passage of this reply first.'));
      return;
    }
    notice.set(
      addPendingQuote(original.sessionId, { turnId, text: passage })
        ? ''
        : uiMessage('Already quoted, or eight passages are gathered.'),
    );
    forgetPassage();
  };
  if (props.askBeside)
    props.menu?.add({
      kind: 'quote',
      label: () => tr('Quote for a side question'),
      busy: () => false,
      action: () => {
        const original = target();
        const passage =
          original?.turnId !== undefined && selectedPassage(original.sessionId, original.turnId);
        return original && passage ? inputAction(quote, { original, passage }) : null;
      },
    });
  if (props.askBeside)
    props.menu?.add({
      kind: 'ask',
      label: () => askLabel(),
      busy: asking,
      action: () => {
        const original = target();
        return original?.turnId === undefined
          ? null
          : inputAction(askHeld, {
              original,
              passage: selectedPassage(original.sessionId, original.turnId),
            });
      },
    });
  props.menu?.add({
    kind: 'fork',
    label: () => tr('Fork from this turn'),
    busy: pending,
    action: () => (target() === null ? null : inputAction(fork, target())),
  });
  const reportedUsage = () => props.row().timing?.executorUsage ?? undefined;
  const showUsage = (original: Target | null) => {
    if (
      original &&
      owns(original) &&
      (original.position.kind === 'live' || reportedUsage() !== undefined) &&
      original.turnId !== undefined
    )
      usage.set({ ...original, turnId: original.turnId });
  };
  const closeUsage = (original: Target | null) => {
    if (!alive || original === null || !sameValue(usage(), original)) return;
    usage.set(null);
  };
  const details = () => {
    const row = props.row();
    const model = row.model;
    const name =
      model?.kind === 'native' ? (model.reportedModelId ?? model.requestedModelId) : model?.modelId;
    const timing = row.timing;
    const elapsed =
      timing?.finished && timing.finished.at >= timing.startedAt
        ? timing.finished.at - timing.startedAt
        : null;
    const duration = elapsed === null ? '' : formatDuration(elapsed, true);
    const reported = reportedUsage();
    const cache = row.timing?.promptCache;
    return [
      name,
      duration,
      reported ? executorUsageLabel(reported) : '',
      cache ? tr('Cache hit {rate}', { rate: cacheHitRate(cache) }) : '',
    ]
      .filter(Boolean)
      .join(' · ');
  };
  return (
    <View style={{ gap: 8, maxWidth: '100%' }}>
      <View
        style={{
          flexDirection: 'row',
          flexWrap: 'wrap',
          alignItems: 'center',
          gap: 8,
        }}
      >
        <MessageCopy
          row={props.row}
          ownerKey={props.ownerKey}
          sessionId={props.sessionId}
          through={props.through}
          menu={props.menu}
        />
        <If when={props.askBeside}>
          <IconButton
            label={askLabel()}
            tooltip={asking() ? tr('Creating fork…') : undefined}
            icon="ask"
            disabled={asking() || target() === null}
            onPress={inputAction(ask, target())}
          />
          <IconButton
            label={tr('Quote for a side question')}
            icon="quote"
            disabled={target() === null}
            onPress={inputAction(quote, { original: target() })}
          />
          <SideThreadsMenu parentId={props.sessionId} turnId={() => props.row().turnId} />
        </If>
        <IconButton
          label={tr('Fork from this turn')}
          tooltip={pending() ? tr('Creating fork…') : undefined}
          icon="fork"
          disabled={pending() || target() === null}
          onPress={inputAction(fork, target())}
        />
        {props.extra}
        <Button
          accessibilityLabel={tr("View this turn's model usage")}
          tooltip={textTooltip(() => tr("View this turn's model usage"))}
          disabled={
            (target()?.position.kind !== 'live' && !reportedUsage()) ||
            target()?.turnId === undefined
          }
          onPress={inputAction(showUsage, target())}
          style={{ ...controlStyle, paddingHorizontal: 8 }}
          hoverStyle={quietHoverStyle()}
          activeStyle={quietActiveStyle()}
          focusStyle={quietFocusStyle()}
          disabledStyle={controlDisabledStyle}
        >
          <Text style={{ color: C.muted, fontSize: 12, lineHeight: 16 }}>
            {details() || tr(reportedUsage() ? 'Turn usage' : 'Main model usage')}
          </Text>
        </Button>
      </View>
      <If when={notice()}>
        <Text style={[{ color: C.warning }, { userSelect: 'text' }]}>{notice()}</Text>
      </If>
      <If when={usage()}>
        <TurnUsage
          sessionId={usage()!.sessionId}
          reported={reportedUsage()}
          promptCache={props.row().timing?.promptCache}
          turnId={usage()!.turnId}
          current={() => usage() !== null && owns(usage()!)}
          close={inputAction(closeUsage, usage())}
        />
      </If>
    </View>
  );
}
