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

import type { CheckinCard } from '@maka/core/session-checkin';
import type { ConversationCheckinPort } from '../ports.js';

export type CheckinActionOutcome = 'done' | 'stale' | 'failed';

/**
 * One click, one action. A card made against an older revision of its Session
 * only opens it: the work it pointed at may already have moved.
 */
export async function runCheckinAction(
  card: CheckinCard,
  deps: {
    readonly port: Pick<ConversationCheckinPort, 'readRevision' | 'resume' | 'send' | 'startSession'>;
    openSession(sessionId: string): void;
  },
): Promise<CheckinActionOutcome> {
  if (card.action === 'answer') {
    deps.openSession(card.sessionId);
    return 'done';
  }
  if (card.action !== 'new_session') {
    const revision = await deps.port.readRevision(card.sessionId).catch(() => undefined);
    if (revision !== card.sessionRevision) {
      if (revision !== undefined) deps.openSession(card.sessionId);
      return 'stale';
    }
  }
  try {
    switch (card.action) {
      case 'resume': {
        const resumed = await deps.port.resume(card.sessionId);
        const continued =
          resumed || (card.instruction ? await deps.port.send(card.sessionId, card.instruction) : false);
        deps.openSession(card.sessionId);
        return continued ? 'done' : 'failed';
      }
      case 'continue': {
        const sent = card.instruction ? await deps.port.send(card.sessionId, card.instruction) : false;
        deps.openSession(card.sessionId);
        return sent ? 'done' : 'failed';
      }
      case 'new_session': {
        const sessionId = card.instruction
          ? await deps.port.startSession(card.sessionId, card.instruction)
          : undefined;
        deps.openSession(sessionId ?? card.sessionId);
        return sessionId ? 'done' : 'failed';
      }
    }
  } catch {
    deps.openSession(card.sessionId);
    return 'failed';
  }
}

/**
 * "Change" hands the card to the user: its Session opens with the card's words
 * in that Session's Composer, focused, to rewrite and send themselves. The
 * draft is written once navigation lands, when that Composer is the one shown.
 */
export function editCheckinCard(
  card: CheckinCard,
  text: string,
  deps: {
    openSession(sessionId: string): void;
    seedDraft(draftKey: string, text: string): void;
    focus(): void;
    afterNavigation(run: () => void): void;
  },
): void {
  deps.openSession(card.sessionId);
  deps.afterNavigation(() => {
    deps.seedDraft(card.sessionId, text);
    deps.focus();
  });
}
