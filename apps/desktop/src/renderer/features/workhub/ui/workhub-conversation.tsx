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

import { useContext, useMemo, type ComponentProps, type CSSProperties } from 'react';
import { ChatView } from '@maka/ui';
import { Button } from '@astryxdesign/core';
import { WorkHubHighlightContext, workHubIdentityHue } from './workhub-work-identity.js';
import type { WorkHubLinkedWork } from '../model/linked-work.js';

export function WorkHubConversation(props: ComponentProps<typeof ChatView> & { workLinks: readonly WorkHubLinkedWork[]; onOpenWork(sessionId: string): void }) {
  const { onOpenWork, workLinks: assignments, ...chat } = props;
  const highlight = useContext(WorkHubHighlightContext);
  const workByTurn = useMemo(() => new Map(assignments.map((assignment) => [assignment.coordinationTurnId, assignment.targetSessionId])), [assignments]);
  const promptRailDecorations = useMemo(() => new Map([...workByTurn].map(([turnId, sessionId]) => [turnId, {
    accentColor: `oklch(var(--workhub-${highlight.sessionId === sessionId ? 'highlight' : 'tone'}) ${workHubIdentityHue(sessionId)})`,
    highlighted: highlight.sessionId === sessionId,
  }])), [workByTurn, highlight.sessionId]);
  return <ChatView {...chat}
    promptRailDecorations={promptRailDecorations}
    onPromptRailHighlight={(turnId) => highlight.highlight(turnId ? workByTurn.get(turnId) : undefined)}
    conversationItems={assignments.map((assignment) => ({
      id: assignment.id,
      afterTurnId: assignment.coordinationTurnId,
      renderWhenAnchorMissing: true,
      content: <div className="workhub-message-identity workhub-work-identity"
        style={{ '--workhub-work-hue': workHubIdentityHue(assignment.targetSessionId) } as CSSProperties}
        data-work-session-id={assignment.targetSessionId}
        data-work-highlighted={highlight.sessionId === assignment.targetSessionId}
        onMouseEnter={() => highlight.highlight(assignment.targetSessionId)}
        onMouseLeave={() => highlight.highlight(undefined)}
        onFocus={() => highlight.highlight(assignment.targetSessionId)}
        onBlur={() => highlight.highlight(undefined)}>
        <Button variant="ghost" label={assignment.targetSessionName} onClick={() => onOpenWork(assignment.targetSessionId)} />
      </div>,
    }))}
  />;
}
