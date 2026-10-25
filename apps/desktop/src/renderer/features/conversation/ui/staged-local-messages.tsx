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

import { useCallback, useLayoutEffect, useRef, useSyncExternalStore, type ComponentProps } from 'react';
import { selectSessionById, useSessionCatalogController } from '../../../application/contracts/session-catalog/session-catalog-state.js';
import { composerMessageRecovery } from '../controller/composer-message-recovery.js';
import { SessionLocalMessages } from '../controller/session-local-messages.js';
import { useSessionUiRead } from '../controller/use-session-ui-read.js';
import type { ComposerStagingCommands } from '../model/composer-staging-contract.js';
import { useComposerStaging } from './composer-staging-context.js';
import { useConversationQueueCommands } from './conversation-provider.js';
import { useConversationOwner } from './conversation-context.js';

/** Local recovery reads the same staging owner as the persistent composer. */
export function StagedLocalMessages(props: Omit<ComponentProps<typeof SessionLocalMessages>,
  'canRestoreDraft' | 'restoreDraft' | 'captureUnsentDraftRestore' | 'publish' | 'update' | 'retire' | 'profileId'> & {
  readonly directoryHostId?: string;
  readonly enabled: boolean;
  readonly restoreContext: ComposerStagingCommands['restoreContext'];
}) {
  const { directoryHostId, enabled, restoreContext, ...localMessages } = props;
  const { composer: composerRef, draftContextRestorer } = useConversationQueueCommands();
  const catalog = useSessionCatalogController();
  const profileId = useSyncExternalStore(catalog.subscribe, () =>
    props.sessionId ? selectSessionById(catalog.getState(), props.sessionId)?.profileId : undefined,
  );
  const { commands, ui } = useConversationOwner().workspace;
  const queue = useSessionUiRead(ui.reads, 'queue', props.sessionId);
  const staging = useComposerStaging();
  const latest = useRef({ staging, sessionId: props.sessionId });
  latest.current = { staging, sessionId: props.sessionId };
  const captureUnsentDraftRestore = useCallback<NonNullable<ComponentProps<typeof SessionLocalMessages>['captureUnsentDraftRestore']>>((sessionId, messageId) => {
    const owner = latest.current;
    const handle = composerRef.current;
    const session = selectSessionById(catalog.getState(), sessionId);
    if (owner.sessionId !== sessionId || owner.staging.draftKey !== sessionId || !handle || !session) return undefined;
    const sameSession = () => {
      const current = selectSessionById(catalog.getState(), sessionId);
      return !!current && current.runtimeHostId === session.runtimeHostId && current.profileId === session.profileId
        && !current.isArchived && !catalog.isAutomaticQueryBlocked(sessionId);
    };
    if (!sameSession()) return undefined;
    const text = handle.captureEmptyDraft?.(sessionId);
    if (!text) return undefined;
    const context = owner.staging.captureContext(sessionId);
    let valid = true;
    const checkSession = () => { if (!sameSession()) valid = false; };
    const unsubscribe = catalog.subscribe(checkSession);
    checkSession();
    return {
      restore(draft) {
        // Check every owner before any write. B's content, focus and enabled
        // state are immaterial; all writes below are explicitly keyed to A.
        if (!valid || !sameSession() || composerRef.current !== handle || !text.isCurrent() || !context.isCurrent()
          || draft.replacesLocalMessageId !== messageId) return false;
        valid = false;
        owner.staging.restoreQueuedDraftContext(sessionId, draft);
        text.restore(draft.text, draft.inlineReferences ?? [], messageId);
        return true;
      },
      release() { valid = false; unsubscribe(); text.release(); context.release(); },
    };
  }, [catalog, composerRef]);
  useLayoutEffect(() => {
    draftContextRestorer.current = restoreContext;
    return () => {
      if (draftContextRestorer.current === restoreContext)
        draftContextRestorer.current = undefined;
    };
  }, [draftContextRestorer, restoreContext]);
  return <SessionLocalMessages {...localMessages} profileId={profileId} queue={props.queue ?? queue?.entries} captureUnsentDraftRestore={captureUnsentDraftRestore}
    publish={commands.addTransientMessage} update={commands.updateTransientMessage}
    retire={commands.removeTransientMessage} {...composerMessageRecovery({
    sessionId: props.sessionId,
    directoryHostId,
    composerRef,
    enabled,
    hasPendingContext: staging.hasPendingContextNow,
    pendingQuotes: staging.pendingQuotes,
    restoreMessageContext: staging.restoreMessageContext,
    restoreQuotes: staging.restoreQuotes,
  })} />;
}
