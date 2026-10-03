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

import type { RuntimeEvent } from '@maka/core/runtime-event';
import { runtimeEventHasModelVisibleContent } from '@maka/core/runtime-event';
import type { SessionHeader } from '@maka/core/session';
import { isSideConversationSession } from '@maka/core/side-conversation';

/**
 * The RuntimeEvent id of the replay item that owns the side-conversation
 * boundary — the fork's first OWN user message — or undefined.
 *
 * The boundary always belongs to the fork's first own user message: the first
 * user text event AFTER the inherited parent prefix. A fresh fork clones the
 * source's history through its fork boundary turn (`header.conversationCopy.
 * sourceTurnId`, which equals `header.branchOfTurnId`), so everything after
 * the last event of that turn is fork-owned and its first user text event
 * owns the boundary on EVERY request. An empty fork (no fork boundary turn)
 * cloned nothing, so the first replayed user turn owns the boundary.
 *
 * A REVISION or branch of an existing side conversation copies turns BEFORE
 * the named source turn, so `conversationCopy.sourceTurnId` names a turn that
 * is absent from the replay. The copy still replays the inherited parent
 * prefix AND the source fork's own early turns verbatim, and it INHERITS the
 * original fork boundary through `header.branchOfTurnId` — the same parent
 * turn the source fork branched through. Cutting on that inherited turn keeps
 * the boundary on the fork's first OWN user message (not on a user message
 * inside the inherited parent prefix), so the cached provider prefix stays
 * byte-identical across the fork, its revisions, and their follow-ups.
 */
export function resolveSideConversationForkBoundaryEventId(
  events: readonly RuntimeEvent[],
  header: Pick<SessionHeader, 'labels' | 'conversationCopy' | 'branchOfTurnId'>,
): string | undefined {
  if (!isSideConversationSession(header.labels)) return undefined;
  const sourceTurnId = header.conversationCopy?.sourceTurnId;
  let cutIndex = -1;
  if (sourceTurnId !== undefined) {
    for (let index = events.length - 1; index >= 0; index -= 1) {
      if (events[index]?.turnId === sourceTurnId) {
        cutIndex = index;
        break;
      }
    }
    if (cutIndex < 0) {
      // The source turn is absent: this is a copy OF a side conversation
      // (revision/branch), not a fresh fork of a normal session. The copy
      // inherits the source fork's boundary turn, whose turns were copied
      // verbatim into the replay even when earlier parent turns precede them.
      const forkBoundaryTurnId = header.branchOfTurnId;
      if (forkBoundaryTurnId !== undefined) {
        for (let index = events.length - 1; index >= 0; index -= 1) {
          if (events[index]?.turnId === forkBoundaryTurnId) {
            cutIndex = index;
            break;
          }
        }
        if (cutIndex < 0) {
          // The inherited fork boundary turn was itself sliced out: the replay
          // holds only inherited parent history with no fork-owned user
          // message, so the caller prefixes the new fork turn instead.
          return undefined;
        }
      }
      // A copy of an empty side fork has no fork boundary turn and no parent
      // prefix: every replayed turn is fork-owned, so the first user text
      // event owns the boundary (cutIndex stays -1).
    }
  }
  for (let index = cutIndex + 1; index < events.length; index += 1) {
    const event = events[index];
    if (
      event.role === 'user' &&
      event.content?.kind === 'text' &&
      runtimeEventHasModelVisibleContent(event)
    ) {
      return event.id;
    }
  }
  return undefined;
}
