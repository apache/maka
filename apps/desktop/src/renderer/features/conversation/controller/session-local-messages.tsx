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
  const latest = useRef(props);
  latest.current = props;
  const pending = useRef<string | undefined>(undefined);
  const [busy, setBusy] = useState<string>();
  const [feedback, setFeedback] = useState<Record<string, string>>({});
  const [snapshot, setSnapshot] = useState<{ sessionId: string; messages: readonly DesktopLocalMessage[] }>();
  const { sessionId, publish, update, retire, queue } = props;
  const runningTurnIds = props.session?.localState ? undefined : props.session?.runningTurnIds;
  const published = useRef<{ sessionId?: string; ids: Set<string> }>({ ids: new Set() });
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
    if (published.current.sessionId !== sessionId) published.current = { sessionId, ids: new Set() };
    if (!sessionId || snapshot?.sessionId !== sessionId) return;
    const copy = getSessionLocalCopy(locale);
    for (const message of snapshot.messages) {
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
        if (!latest.current.canRestoreDraft()) {
          setFeedback((current) => ({ ...current, [key]: copy.draftBlocked })); return;
        }
        const draft = await services.readFailedMessage(sessionId, message.messageId);
        if (generation.current !== owner || latest.current.sessionId !== sessionId) return;
        if (!latest.current.canRestoreDraft()) {
          setFeedback((current) => ({ ...current, [key]: copy.draftBlocked })); return;
        }
        latest.current.restoreDraft(draft);
        setFeedback((current) => ({ ...current, [key]: copy.draftReady }));
      }) });
      if (message.canCancel) actions.push({
        label: message.state === 'failed' ? copy.remove : copy.cancel, disabled: !!busy,
        onClick: run(async () => {
          await services.cancelMessage(sessionId, message.messageId);
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
      // Queue/Turn refreshes update existing rows. They must not recreate a row
      // already retired by a Host retraction or canonical transcript handoff.
      const project = published.current.ids.has(message.messageId) ? update : publish;
      published.current.ids.add(message.messageId);
      project(sessionId, {
        id: message.messageId, text: message.text, ts: message.createdAt,
        transientPlacement: message.placement, attachments: message.attachments,
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
