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

import { useLayoutEffect, type ComponentProps } from 'react';
import { composerMessageRecovery } from '../controller/composer-message-recovery.js';
import { SessionLocalMessages } from '../controller/session-local-messages.js';
import { useComposerStaging } from './composer-staging-context.js';
import { useConversationQueueCommands } from './conversation-provider.js';
import { useConversationOwner } from './conversation-context.js';

/** Local recovery reads the same staging owner as the persistent composer. */
export function StagedLocalMessages(props: Omit<ComponentProps<typeof SessionLocalMessages>,
  'canRestoreDraft' | 'restoreDraft' | 'restoreUnsentDraft' | 'publish' | 'update' | 'retire'> & {
  readonly directoryHostId?: string;
  readonly enabled: boolean;
}) {
  const { directoryHostId, enabled, ...localMessages } = props;
  const { composer: composerRef, draftContextRestorer, restoreDraft } = useConversationQueueCommands();
  const { commands } = useConversationOwner().workspace;
  const staging = useComposerStaging();
  const restoreQueuedDraftContext = staging.restoreQueuedDraftContext;
  useLayoutEffect(() => {
    draftContextRestorer.current = restoreQueuedDraftContext;
    return () => {
      if (draftContextRestorer.current === restoreQueuedDraftContext)
        draftContextRestorer.current = undefined;
    };
  }, [draftContextRestorer, restoreQueuedDraftContext]);
  return <SessionLocalMessages {...localMessages} restoreUnsentDraft={restoreDraft}
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
