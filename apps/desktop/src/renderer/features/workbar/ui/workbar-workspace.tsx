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

import type { CSSProperties } from 'react';
import { useToast } from '@maka/ui';
import { WorkbarHost } from './workbar-host.js';
import { WorkbarToggle } from './workbar-toggle.js';
import { useWorkbarController } from '../controller/use-workbar-controller.js';
import type { SessionWorkspaceProps } from '../../../application/contracts/session-workspace.js';

/** Compose the session Workbar beside a conversation in its owning renderer. */
export function WorkbarWorkspace(props: SessionWorkspaceProps) {
  const toastApi = useToast();
  const workbar = useWorkbarController({
    available: Boolean(props.session),
    layoutSessionId: props.session?.id,
    layoutScope: props.layoutScope,
    activeSession: props.session,
    projectId: props.session?.projectId,
    projectAliases: [],
    authoritativeSessionIds: props.sessionIds,
    shellObscured: !props.visible,
    modelChoices: props.modelChoices,
    toastApi,
    composerRef: props.composerRef,
    openSessionInChat: props.onOpenSession,
  });
  return (
    <div className={`maka-detail-with-artifacts ${props.className ?? ''}`} style={{ '--maka-session-workbar-width': `${workbar.host.rightWidth}px` } as CSSProperties}>
      <div className="mainColumn">
        {props.children({
          openUsage: () => { props.onShowConversation(); workbar.commands.openTool('inspector'); },
          toggle: props.session && workbar.selectors.rightCollapsed ? <WorkbarToggle collapsed={workbar.selectors.rightCollapsed} size="sm" onToggle={() => { props.onShowConversation(); workbar.commands.toggleRight(); }} /> : null,
        })}
      </div>
      <WorkbarHost model={workbar.host} />
    </div>
  );
}
