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

import { useRef, type ReactNode } from 'react';
import {
  type TurnFooterActionMeta,
  type TurnPresentation,
  type TurnPresentationDeriver,
  useToast,
  useUiLocale,
} from '@maka/ui';
import { getDesktopConversationCopy } from '../../../locales/conversation-copy.js';
import { getSessionCollaborationCopy } from '../../../locales/session-collaboration-copy.js';
import {
  getShellCopy,
  localizedShellErrorMessage,
} from '../../../locales/shell-copy.js';
import { useSessionCollaborationServices } from '../services-context.js';

type TurnFooterActionHandler = (
  turnId: string,
  actionId: TurnFooterActionMeta['id'],
) => void | Promise<void>;

interface GuestTurnActions {
  readonly deriveTurnPresentation: TurnPresentationDeriver;
  readonly onTurnFooterAction: TurnFooterActionHandler;
}

export function SessionGuestTurnActionBoundary(props: {
  readonly sessionId: string | undefined;
  readonly deriveTurnPresentation: TurnPresentationDeriver;
  readonly ownerTurnFooterAction: TurnFooterActionHandler;
  readonly turnActionRegistry: {
    readonly addKey: (key: string) => boolean;
    readonly clearKey: (key: string) => void;
    readonly keyOf: (sessionId: string, turnId: string, actionId: string) => string;
  };
  readonly children: (actions: GuestTurnActions) => ReactNode;
}) {
  const locale = useUiLocale();
  const toast = useToast();
  const services = useSessionCollaborationServices();
  const attemptsRef = useRef(new Map<string, string>());
  const presentationRef = useRef<{
    readonly source: TurnPresentation;
    readonly tooltip: string;
    readonly result: TurnPresentation;
  } | undefined>(undefined);
  const collaborationCopy = getSessionCollaborationCopy(locale);
  const requestTooltip = getDesktopConversationCopy(locale).footer.requestRegenerate;

  const deriveGuestTurnPresentation: TurnPresentationDeriver = (turns) => {
    const source = props.deriveTurnPresentation(turns);
    const cached = presentationRef.current;
    if (cached?.source === source && cached.tooltip === requestTooltip) return cached.result;
    const result = guestTurnPresentation(source, requestTooltip);
    presentationRef.current = { source, tooltip: requestTooltip, result };
    return result;
  };

  const requestGuestRegeneration: TurnFooterActionHandler = async (turnId, actionId) => {
    if (actionId !== 'regenerate') {
      await props.ownerTurnFooterAction(turnId, actionId);
      return;
    }
    if (!props.sessionId) return;
    const sessionId = props.sessionId;
    const pendingKey = props.turnActionRegistry.keyOf(sessionId, turnId, actionId);
    if (!props.turnActionRegistry.addKey(pendingKey)) return;
    const attemptKey = `${sessionId}\u0000${turnId}`;
    const requestTurnId =
      attemptsRef.current.get(attemptKey) ?? services.createOperationId();
    attemptsRef.current.set(attemptKey, requestTurnId);
    let outcomeKnown = false;
    try {
      await services.requestTurn(sessionId, {
        kind: 'regenerate',
        turnId: requestTurnId,
        sourceTurnId: turnId,
      });
      outcomeKnown = true;
      toast.success(
        collaborationCopy.turnRequests,
        collaborationCopy.regenerateRequestSent,
      );
    } catch (error) {
      try {
        const projection = await services.getTurnRequests(sessionId);
        outcomeKnown = true;
        if (projection.requests.some((request) => request.intent.turnId === requestTurnId)) {
          toast.success(
            collaborationCopy.turnRequests,
            collaborationCopy.regenerateRequestSent,
          );
          return;
        }
      } catch {
        // Preserve the Turn identity so the next explicit click is idempotent.
      }
      toast.error(
        collaborationCopy.turnRequests,
        localizedShellErrorMessage(
          error,
          getShellCopy(locale).app.tryAgainLater,
          locale,
        ),
      );
    } finally {
      if (outcomeKnown) attemptsRef.current.delete(attemptKey);
      props.turnActionRegistry.clearKey(pendingKey);
    }
  };

  return props.children(
    props.sessionId
      ? {
          deriveTurnPresentation: deriveGuestTurnPresentation,
          onTurnFooterAction: requestGuestRegeneration,
        }
      : {
          deriveTurnPresentation: props.deriveTurnPresentation,
          onTurnFooterAction: props.ownerTurnFooterAction,
        },
  );
}

function guestTurnPresentation(
  source: TurnPresentation,
  requestTooltip: string,
): TurnPresentation {
  return {
    ...source,
    footerActionsByTurn: Object.fromEntries(
      Object.entries(source.footerActionsByTurn).map(([turnId, actions]) => [
        turnId,
        actions.flatMap((action) => {
          if (action.id === 'branch') return [];
          if (action.id !== 'regenerate' || !action.enabled) return [action];
          return [{ ...action, tooltip: requestTooltip }];
        }),
      ]),
    ),
  };
}
