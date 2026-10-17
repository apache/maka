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

import { useEffect, useLayoutEffect, useRef } from 'react';
import { flushSync } from 'react-dom';
import { useUiLocale, type ComposerHandle } from '@maka/ui';
import { createSessionWindowCommandHandler } from '../controller/session-window-command.js';
import type { SessionWindowNavigation } from '../ports.js';
import { useSessionWindowServices } from '../services-context.js';
import { sessionWindowCopy } from '../copy.js';
import type { SessionWindowProjection } from './session-window-root.js';

export function SessionWindowBinding(props: {
  window: SessionWindowProjection;
  staging: { hasPendingContext(sessionIds: readonly string[]): boolean };
  submission: { hasPendingEdit(sessionIds: readonly string[]): boolean };
  workbar: { hasSessionContent(sessionIds: readonly string[]): boolean };
  conversation: {
    composer: { readonly current: ComposerHandle | null };
    readActiveSessionId(): string | undefined;
    clearOwnedSessionState(sessionId: string): void;
  };
  openLocal(navigation: SessionWindowNavigation): void;
  clearLocal(): void;
}) {
  const services = useSessionWindowServices();
  const locale = useUiLocale();
  const current = useRef({ props, locale });
  useLayoutEffect(() => { current.current = { props, locale }; });
  useEffect(() => {
    const editor = () => {
      const composer = current.current.props.conversation.composer.current;
      if (!composer) throw new Error('Session composer is not ready');
      return composer;
    };
    const blocked = (ids: readonly string[]) => {
      const p = current.current.props;
      return editor().hasPendingAction() || p.staging.hasPendingContext(ids)
        || p.submission.hasPendingEdit(ids) || p.workbar.hasSessionContent(ids);
    };
    const handler = createSessionWindowCommandHandler({
      freeze: (value) => flushSync(() => current.current.props.window.setFrozen(value)),
      activeSessionId: () => current.current.props.conversation.readActiveSessionId(),
      capture: (ids) => {
        const drafts = editor().captureDrafts(ids);
        if (blocked(ids) || drafts.some((draft) => draft.replacesMessageId)) throw new Error(sessionWindowCopy(current.current.locale).unsupported);
        return drafts.map((draft) => ({ sessionId: draft.draftKey, text: draft.text, references: draft.references }));
      },
      hasUnsent: (ids) => blocked(ids) || editor().captureDrafts(ids).some((draft) => Boolean(draft.text.trim() || draft.references.length || draft.replacesMessageId)),
      restore: (drafts) => flushSync(() => editor().restoreDrafts(drafts.map((draft) => ({ ...draft, draftKey: draft.sessionId })))),
      clear: (ids) => flushSync(() => {
        for (const id of ids) {
          editor().clearDraft(id);
          current.current.props.conversation.clearOwnedSessionState(id);
        }
      }),
      navigate: (navigation) => flushSync(() => current.current.props.openLocal(navigation)),
      suspend: (ids) => flushSync(() => {
        const conversation = current.current.props.conversation;
        const displayed = conversation.readActiveSessionId();
        for (const id of ids) conversation.clearOwnedSessionState(id);
        if (displayed && ids.includes(displayed)) current.current.props.clearLocal();
      }),
    });
    const unsubscribe = services.subscribeSessionWindowCommand((command) => {
      let reply;
      try { reply = { requestId: command.requestId, ok: true as const, result: handler.execute(command) }; }
      catch (error) { reply = { requestId: command.requestId, ok: false as const, error: error instanceof Error ? error.message : String(error) }; }
      void services.ackSessionWindowCommand(reply);
    });
    let version = -1;
    const unsubscribeOwnership = services.subscribeSessionWindowOwnership((snapshot) => {
      if (snapshot.version < version) return;
      version = snapshot.version;
      handler.ownershipChanged(new Set(snapshot.sessionIds));
    });
    const unsubscribeDeleted = services.subscribeDeleted(handler.deleted);
    void services.sessionWindowReady();
    return () => { unsubscribe(); unsubscribeOwnership(); unsubscribeDeleted(); };
  }, [services]);
  return null;
}
