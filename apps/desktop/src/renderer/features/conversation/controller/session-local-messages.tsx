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

import { useEffect, useRef, useState } from 'react';
import type { MessageQueueEntryProjection } from '@maka/core/events';
import { useUiLocale, type TransientUserMessageProjection } from '@maka/ui';
import type { DesktopLocalMessage, DesktopLocalMessageDraft } from '../../../../shared/session-local-contract.js';
import { getSessionLocalCopy } from '../../../locales/session-local-copy.js';
import { useConversationServices } from '../services.js';
import { useComposerMentionsContext } from '../ui/composer-mentions-provider.js';
import { localMessagePresentation } from './local-message-presentation.js';

export function SessionLocalMessages(props: {
  readonly sessionId?: string;
  readonly queue?: readonly MessageQueueEntryProjection[];
  readonly session?: { readonly localState?: 'pending' | 'cached'; readonly runningTurnIds?: readonly string[] };
  readonly publish: (sessionId: string, message: TransientUserMessageProjection) => void;
  readonly update: (sessionId: string, message: TransientUserMessageProjection) => void;
  readonly retire: (sessionId: string, messageId: string) => void;
  readonly canRestoreDraft: () => boolean;
  readonly restoreDraft: (draft: DesktopLocalMessageDraft) => void;
}): null {
  const services = useConversationServices();
  const locale = useUiLocale();
  const hasPendingSessionReferences = useComposerMentionsContext()?.hasPendingSessionReferences;
  const latest = useRef({ ...props, hasPendingSessionReferences });
  latest.current = { ...props, hasPendingSessionReferences };
  const pending = useRef<string | undefined>(undefined);
  const [busy, setBusy] = useState<string>();
  const [feedback, setFeedback] = useState<Record<string, string>>({});
  const [snapshot, setSnapshot] = useState<{ sessionId: string; messages: readonly DesktopLocalMessage[] }>();
  const { sessionId, publish, update, retire, queue } = props;
  const runningTurnIds = props.session?.localState ? undefined : props.session?.runningTurnIds;
  // Workspace transients survive selection changes, so their ownership must too.
  const publishedBySession = useRef(new Map<string, {
    states: Map<string, 'seen' | 'retired'>;
    snapshotIds: Set<string>;
  }>());
  const generation = useRef(0);
  useEffect(() => {
    const owner = ++generation.current;
    if (!sessionId) return;
    let revision = 0;
    const refresh = () => {
      const request = ++revision;
      void services.listMessages(sessionId).then((messages) => {
        if (generation.current === owner && revision === request) setSnapshot({ sessionId, messages });
      }).catch(() => undefined);
    };
    const unsubscribe = services.subscribeChanges((changedSessionId) => {
      if (changedSessionId === sessionId) refresh();
    });
    refresh();
    return () => { generation.current++; unsubscribe(); };
  }, [sessionId, services]);

  useEffect(() => {
    if (!sessionId || snapshot?.sessionId !== sessionId) return;
    let published = publishedBySession.current.get(sessionId);
    if (!published) {
      published = { states: new Map(), snapshotIds: new Set() };
      publishedBySession.current.set(sessionId, published);
    }
    const states = published.states;
    const snapshotIds = new Set(snapshot.messages.map((message) => message.messageId));
    for (const messageId of published.snapshotIds) {
      if (!snapshotIds.has(messageId)) {
        states.set(messageId, 'retired');
        retire(sessionId, messageId);
      }
    }
    // Cancellation can remove durable rows without a Turn or Host event. The
    // snapshot owns only their transient presentation; retain published IDs as
    // tombstones so a later stale local row cannot recreate retired messages.
    published.snapshotIds = snapshotIds;
    const copy = getSessionLocalCopy(locale);
    const queuedIds = new Set(queue?.map((entry) => entry.messageId));
    for (const message of snapshot.messages) {
      const previous = states.get(message.messageId);
      if (previous !== 'retired') states.set(message.messageId, 'seen');
      if (message.state !== 'failed' && queuedIds.has(message.messageId)) {
        // The Host queue may arrive before the first local snapshot. Its exact
        // identity already owns presentation, including a stale unknown receipt.
        // Remember the handoff so a later queue removal cannot recreate the row.
        retire(sessionId, message.messageId);
        continue;
      }
      const key = `${sessionId}:${message.messageId}`;
      const run = (operation: () => Promise<void>) => () => {
        if (pending.current) return;
        pending.current = key;
        setBusy(key);
        const owner = generation.current;
        setFeedback((current) => ({ ...current, [key]: '' }));
        void operation().catch(() => {
          if (generation.current === owner) setFeedback((current) => ({ ...current, [key]: copy.updateError }));
        }).finally(() => {
          if (pending.current === key) { pending.current = undefined; setBusy(undefined); }
        });
      };
      const actions: NonNullable<TransientUserMessageProjection['deliveryActions']>[number][] = [];
      if (message.state === 'failed') actions.push({ label: copy.edit, disabled: !!busy, onClick: run(async () => {
        const owner = generation.current;
        if (!latest.current.canRestoreDraft() || latest.current.hasPendingSessionReferences?.()) {
          setFeedback((current) => ({ ...current, [key]: copy.draftBlocked })); return;
        }
        const draft = await services.readFailedMessage(sessionId, message.messageId);
        if (generation.current !== owner || latest.current.sessionId !== sessionId) return;
        if (!latest.current.canRestoreDraft() || latest.current.hasPendingSessionReferences?.()) {
          setFeedback((current) => ({ ...current, [key]: copy.draftBlocked })); return;
        }
        latest.current.restoreDraft(draft);
        setFeedback((current) => ({ ...current, [key]: copy.draftReady }));
      }) });
      if (message.canCancel) actions.push({
        label: message.state === 'failed' ? copy.remove : copy.cancel, disabled: !!busy,
        onClick: run(async () => {
          await services.cancelMessage(sessionId, message.messageId);
          states.set(message.messageId, 'retired');
          setSnapshot((current) => current?.sessionId === sessionId
            ? { ...current, messages: current.messages.filter((item) => item.messageId !== message.messageId) }
            : current);
          retire(sessionId, message.messageId);
        }),
      });
      if (message.state === 'unknown') actions.push({ label: copy.check, disabled: !!busy || message.checking,
        onClick: run(() => services.reconcileMessage(sessionId, message.messageId)),
      });
      const presentation = localMessagePresentation(message, locale, queue, runningTurnIds);
      // A current durable failure owns its recovery actions even after a late
      // Host retraction. Upsert it by identity, unless durable deletion already
      // retired it. Ordinary refreshes still cannot recreate handed-off rows.
      const project = previous === undefined || (message.state === 'failed' && previous !== 'retired') ? publish : update;
      project(sessionId, {
        id: message.messageId, text: message.text, ts: message.createdAt,
        transientPlacement: message.turnId ? 'current_turn' : (message.localDisplayPlacement ?? message.placement), attachments: message.attachments,
        directoryReferences: message.directoryReferences, quotes: message.quotes,
        inlineReferences: message.inlineReferences, hostTurnId: message.turnId,
        deliveryStatus: presentation.status,
        deliveryDetail: feedback[key] || presentation.detail,
        deliveryTone: presentation.tone,
        deliveryDiagnostic: message.error, deliveryDiagnosticLabel: copy.diagnostics,
        deliveryActions: actions,
      });
    }
  }, [sessionId, snapshot, services, publish, update, retire, locale, queue, runningTurnIds, busy, feedback]);
  return null;
}
