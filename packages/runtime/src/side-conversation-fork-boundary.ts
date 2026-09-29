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
 * A conversation copy clones the source's history up to and INCLUDING the turn
 * the copy branches through (`header.conversationCopy.sourceTurnId`), so
 * everything after the last event of that turn is copy-owned: the first user
 * text event after it is the copy's first user turn and owns the boundary on
 * EVERY request. An empty copy (no sourceTurnId) cloned nothing, so the first
 * replayed user turn owns the boundary.
 *
 * A REVISION or branch of an existing side conversation copies turns BEFORE
 * the named source turn and inherits that copy's side label, so its
 * sourceTurnId names a turn that is absent from the replay. There the copy is
 * a continuation of the source fork's conversation: the first copied turn is
 * the source fork's own first turn (whose user message already carries the
 * boundary in the cached prefix it was created with), so the boundary stays on
 * the first user AFTER it — the copy's own first user turn.
 */
export function resolveSideConversationForkBoundaryEventId(
  events: readonly RuntimeEvent[],
  header: Pick<SessionHeader, 'labels' | 'conversationCopy'>,
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
  }
  if (cutIndex < 0 && sourceTurnId !== undefined) {
    // The source turn is absent: this is a copy OF a side conversation
    // (revision/branch), not a fresh fork of a normal session. The copy's
    // first turn belongs to the source fork, so the boundary stays on the
    // first user AFTER it — the copy's own first user turn.
    const firstCopiedTurnId = events[0]?.turnId;
    for (const event of events) {
      if (event.turnId === firstCopiedTurnId) continue;
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
