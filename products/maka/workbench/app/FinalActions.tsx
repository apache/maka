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
import { createText, UiError, errorText, message as uiMessage } from './text';
import { tr } from './locale';
import { cleanup, computed, inputAction, signal, Text, View } from 'nsh';
import { Button } from 'nsh/base';
import { host } from './host';
import { sameValue } from '../../../../plugins/shared/value';
import type { Position, Row } from './history';
import { MessageCopy } from './MessageCopy';
import { forkTitle, type SessionAction } from './sessionLifecycle';
import { TurnUsage } from './TurnUsage';
import { C, controlStyle } from './ui';
import { Icon } from './Icon';

type Target = {
  sessionId: string;
  key: string;
  position: Position;
  turnId: string;
};
const sameTarget = (left: Target | null, right: Target | null) =>
  left === right ||
  (left !== null &&
    right !== null &&
    left.sessionId === right.sessionId &&
    left.key === right.key &&
    left.turnId === right.turnId &&
    left.position.sourceSequence === right.position.sourceSequence &&
    left.position.itemIndex === right.position.itemIndex);

/** Actions retain this exact completed reply, even if a later turn is running. */
export function FinalActions(props: {
  row(): Row;
  ownerKey(): string;
  sessionId: string;
  through(): number;
  fork(action: Extract<SessionAction, { kind: 'fork' }>): Promise<void>;
}) {
  const pending = signal(false);
  const notice = createText();
  const usage = signal<Target | null>(null);
  let alive = true;
  cleanup(() => {
    alive = false;
  });
  const target = computed<Target | null>(
    () => {
      const row = props.row();
      return row.finalOutput && row.position && row.turnId
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
        turnId: original.turnId,
      });
      if (owns(original)) notice.set(uiMessage('Fork created. Open it in Sessions.'));
    } catch (reason) {
      if (owns(original)) notice.set(errorText(reason));
    } finally {
      if (alive) pending.set(false);
    }
  };
  const showUsage = (original: Target | null) => {
    if (original && owns(original)) usage.set(original);
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
    const duration =
      elapsed === null
        ? ''
        : elapsed < 60000
          ? `${(elapsed / 1000).toFixed(1)}s`
          : `${Math.floor(elapsed / 60000)}m ${Math.floor(elapsed / 1000) % 60}s`;
    return [name, duration].filter(Boolean).join(' · ');
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
        />
        <Button
          style={{ ...controlStyle, width: 32, paddingHorizontal: 8, alignItems: 'center' }}
          accessibilityLabel={tr('Fork from this turn')}
          tooltip={textTooltip(() =>
            pending() ? tr('Creating fork…') : tr('Fork from this turn'),
          )}
          disabled={pending() || target() === null}
          onPress={inputAction(fork, target())}
          hoverStyle={{ backgroundColor: C.surface }}
          focusStyle={{ backgroundColor: C.raised }}
        >
          <Icon name="fork" color={C.muted} />
        </Button>
        <Button
          style={{ ...controlStyle, width: 32, paddingHorizontal: 8, alignItems: 'center' }}
          accessibilityLabel={tr("View this turn's model usage")}
          tooltip={textTooltip(() => tr("View this turn's model usage"))}
          disabled={target() === null}
          onPress={inputAction(showUsage, target())}
          hoverStyle={{ backgroundColor: C.surface }}
          focusStyle={{ backgroundColor: C.raised }}
        >
          <Icon name="activity" color={C.muted} />
        </Button>
        <If when={details()}>
          <Text style={{ color: C.muted, fontSize: 12, lineHeight: 16 }}>{details()}</Text>
        </If>
      </View>
      <If when={notice()}>
        <Text selectable style={{ color: C.warning }}>
          {notice()}
        </Text>
      </If>
      <If when={usage()}>
        <TurnUsage
          sessionId={usage()!.sessionId}
          turnId={usage()!.turnId}
          current={() => usage() !== null && owns(usage()!)}
          close={inputAction(closeUsage, usage())}
        />
      </If>
    </View>
  );
}
