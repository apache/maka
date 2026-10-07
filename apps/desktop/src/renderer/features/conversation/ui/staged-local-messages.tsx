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
import { useSessionUiRead } from '../controller/use-session-ui-read.js';
import type { ComposerStagingCommands } from '../model/composer-staging-contract.js';
import { useComposerStaging } from './composer-staging-context.js';
import { useConversationQueueCommands } from './conversation-provider.js';
import { useConversationOwner } from './conversation-context.js';

/** Local recovery reads the same staging owner as the persistent composer. */
export function StagedLocalMessages(props: Omit<ComponentProps<typeof SessionLocalMessages>,
  'canRestoreDraft' | 'restoreDraft' | 'restoreUnsentDraft' | 'publish' | 'update' | 'retire'> & {
  readonly directoryHostId?: string;
  readonly enabled: boolean;
  readonly restoreContext: ComposerStagingCommands['restoreContext'];
}) {
  const { directoryHostId, enabled, restoreContext, ...localMessages } = props;
  const { composer: composerRef, draftContextRestorer, restoreDraft } = useConversationQueueCommands();
  const { commands, ui } = useConversationOwner().workspace;
  const queue = useSessionUiRead(ui.reads, 'queue', props.sessionId);
  const staging = useComposerStaging();
  useLayoutEffect(() => {
    draftContextRestorer.current = restoreContext;
    return () => {
      if (draftContextRestorer.current === restoreContext)
        draftContextRestorer.current = undefined;
    };
  }, [draftContextRestorer, restoreContext]);
  return <SessionLocalMessages {...localMessages} queue={props.queue ?? queue?.entries} restoreUnsentDraft={restoreDraft}
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
