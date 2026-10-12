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

import { useLayoutEffect, type ReactNode } from 'react';
import { CatalogRowWatch } from '../../../application/contracts/session-catalog/catalog-row-watch.js';
import { useSessionCatalogController } from '../../../application/contracts/session-catalog/session-catalog-state.js';
import { SessionLocalMessages } from '../controller/session-local-messages.js';
import { useComposerSubmission } from '../controller/use-composer-submission.js';
import { submissionBindings } from '../model/composer-submission-binding.js';
import type { ComposerStagingCommands } from '../model/composer-staging-contract.js';
import type {
  ComposerNewTaskSubmission,
  ComposerSubmissionCommands,
  ComposerSubmissionShell,
  ComposerSurfaceOwner,
} from '../model/composer-submission-contract.js';
import { ComposerSubmissionContext, ComposerTurnContext } from './composer-submission-context.js';

/**
 * Sole owner of the Composer's submission: the send-pending flag, the
 * edit-and-resend draft and the submit, follow-up and interaction-answer paths.
 * It stays mounted beside the staging owner, so a draft and an in-flight send
 * keep their owner across Session and section switches. The shell holds only
 * the stable command handle; the Composer slot reads the rest from here.
 */
export function ComposerSubmissionProvider<Owner extends ComposerSurfaceOwner>(props: {
  readonly commands: ComposerSubmissionCommands;
  readonly staging: ComposerStagingCommands;
  readonly shell: ComposerSubmissionShell<Owner>;
  readonly newTask: ComposerNewTaskSubmission;
  readonly sharedSessionActive: boolean;
  readonly ownerSessionId: string | undefined;
  readonly children?: ReactNode;
}) {
  const submission = useComposerSubmission({
    staging: props.staging,
    shell: props.shell,
    newTask: props.newTask,
    sharedSessionActive: props.sharedSessionActive,
    ownerSessionId: props.ownerSessionId,
  });
  const catalog = useSessionCatalogController();
  const { shellCommands } = submission;
  useLayoutEffect(() => {
    const binding = submissionBindings.get(props.commands);
    if (!binding) throw new Error('Unknown Composer submission commands');
    binding.current = shellCommands;
    return () => { if (binding.current === shellCommands) binding.current = undefined; };
  }, [props.commands, shellCommands]);
  return (
    <ComposerSubmissionContext.Provider value={submission.reader}>
      <ComposerTurnContext.Provider value={submission.turnReader}>
        <CatalogRowWatch catalog={catalog} sessionIds={submission.revisionWatch.sessionIds}
          onRows={submission.revisionWatch.onRows} />
        <SessionLocalMessages sessionId={submission.turnReader.activeId} {...submission.localMessages} />
        {props.children}
      </ComposerTurnContext.Provider>
    </ComposerSubmissionContext.Provider>
  );
}
