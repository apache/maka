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

import { createElement, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useToast, useUiLocale, type TransientUserMessageProjection } from '@maka/ui';
import { ICON_SIZE, Undo2, X } from '@maka/ui/icons';
import type { SessionTurnAccessRequest } from '@maka/runtime-host/protocol';
import { getSessionCollaborationCopy } from '../../../locales/session-collaboration-copy.js';
import { describeTurnRequestIntent, turnRequestStateLabel } from '../model/turn-request-inbox.js';
import { useSessionCollaborationServices } from '../services-context.js';

/** How the shared composer behaves while the active Session is a Guest's. */
export interface GuestComposerProjection {
  /** Stands in for the composer while the Guest cannot request Turns. */
  readonly notice?: string;
  /** Present while the Guest can request Turns: sends become Turn requests. */
  readonly composer?: {
    readonly placeholder: string;
    readonly onSend: (text: string) => Promise<boolean>;
    readonly sendBlocked: boolean;
    readonly sendBlockedReason?: string;
    readonly pendingMessages: readonly TransientUserMessageProjection[];
  };
}

interface TurnRequestProjection {
  readonly sessionId: string;
  readonly canRequestTurns: boolean;
  readonly authorityAvailable?: boolean;
  readonly requests: readonly SessionTurnAccessRequest[];
}

interface TurnRequestAttempt {
  readonly turnId: string;
  readonly text: string;
}

const REFRESH_INTERVAL_MS = 2_000;

export function useGuestTurnRequests(
  sessionId: string | undefined,
  /** Takes a settled request's text out of the Composer's draft for that Session. */
  discardDraft: (draftKey: string) => void,
): GuestComposerProjection | undefined {
  const services = useSessionCollaborationServices();
  const copy = getSessionCollaborationCopy(useUiLocale());
  const toast = useToast();
  const [projection, setProjection] = useState<TurnRequestProjection>();
  // Retrying the same text reuses its Turn id, so a request the Host already
  // created before a lost response is not created twice.
  const attempts = useRef(new Map<string, TurnRequestAttempt>());

  const apply = useCallback(
    (result: { canRequestTurns: boolean; requests: readonly SessionTurnAccessRequest[] }) => {
      if (!sessionId) return undefined;
      setProjection({ sessionId, canRequestTurns: result.canRequestTurns, authorityAvailable: true, requests: result.requests });
      const attempt = attempts.current.get(sessionId);
      if (!attempt || !result.requests.some((request) => request.intent.turnId === attempt.turnId)) return undefined;
      attempts.current.delete(sessionId);
      return attempt;
    },
    [sessionId],
  );

  const markUnavailable = useCallback((target: string) => {
    setProjection((current) => ({
      sessionId: target,
      canRequestTurns: current?.sessionId === target && current.canRequestTurns,
      authorityAvailable: false,
      requests: current?.sessionId === target ? current.requests : [],
    }));
  }, []);

  useEffect(() => {
    if (!sessionId) return;
    let disposed = false;
    let timer: number | undefined;
    const refresh = async () => {
      try {
        const result = await services.getTurnRequests(sessionId);
        if (disposed) return;
        // A request whose response was lost can surface here later; its text
        // leaves the draft only if the user has not changed it since.
        const settled = apply(result);
        if (settled) discardDraft(sessionId);
      } catch {
        if (!disposed) markUnavailable(sessionId);
      } finally {
        if (!disposed) timer = window.setTimeout(() => void refresh(), REFRESH_INTERVAL_MS);
      }
    };
    void refresh();
    return () => {
      disposed = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [sessionId, services, apply, markUnavailable, discardDraft]);

  const submit = useCallback(async (text: string): Promise<boolean> => {
    const content = text.trim();
    if (!sessionId || !content) return false;
    const previous = attempts.current.get(sessionId);
    const turnId = previous?.text === content ? previous.turnId : services.createOperationId();
    attempts.current.set(sessionId, { turnId, text: content });
    try {
      const request = await services.requestTurn(sessionId, { kind: 'start', turnId, text: content });
      attempts.current.delete(sessionId);
      setProjection((current) =>
        current?.sessionId === sessionId && !current.requests.some((candidate) => candidate.requestId === request.requestId)
          ? { ...current, requests: [...current.requests, request] }
          : current,
      );
      toast.success(copy.turnRequestSent);
      return true;
    } catch (error) {
      let current: Awaited<ReturnType<typeof services.getTurnRequests>>;
      try {
        current = await services.getTurnRequests(sessionId);
      } catch {
        markUnavailable(sessionId);
        return false;
      }
      if (apply(current)) {
        toast.success(copy.turnRequestSent);
        return true;
      }
      toast.error(copy.submitTurnRequest, errorMessage(error));
      return false;
    }
  }, [sessionId, services, apply, markUnavailable, toast, copy]);

  const settleRequest = useCallback(async (requestId: string, withdraw: boolean) => {
    if (!sessionId) return;
    try {
      if (withdraw && !(await services.withdrawTurnRequest(sessionId, requestId)).withdrawn) {
        apply(await services.getTurnRequests(sessionId));
        return;
      }
      if (!withdraw) await services.acknowledgeTurnRequest(sessionId, requestId);
      setProjection((current) =>
        current?.sessionId === sessionId
          ? { ...current, requests: current.requests.filter((request) => request.requestId !== requestId) }
          : current,
      );
      if (withdraw) toast.info(copy.turnRequestWithdrawn);
    } catch (error) {
      toast.error(copy.turnRequests, errorMessage(error));
    }
  }, [sessionId, services, apply, toast, copy]);

  const current = projection?.sessionId === sessionId ? projection : undefined;
  const pendingMessages = useMemo(
    () => (current?.requests ?? []).map((request): TransientUserMessageProjection => {
      const pending = request.state.kind === 'pending';
      const action = pending
        ? { label: copy.withdrawTurnRequest, glyph: Undo2 }
        : isTurnRequestTerminal(request) ? { label: copy.dismissTurnRequest, glyph: X } : undefined;
      return {
        id: request.requestId,
        text: describeTurnRequestIntent(request.intent, copy.regenerateRequest),
        ts: Date.parse(request.createdAt) || 0,
        transientPlacement: 'follow_up',
        deliveryStatus: turnRequestStateLabel(request, copy),
        deliveryActions: action
          ? [{
              label: action.label,
              icon: createElement(action.glyph, { size: ICON_SIZE.control, 'aria-hidden': true }),
              onClick: () => settleRequest(request.requestId, pending),
            }]
          : [],
      };
    }),
    [current?.requests, copy, settleRequest],
  );

  if (!sessionId) return undefined;
  if (!current?.canRequestTurns) {
    if (current?.authorityAvailable === undefined) return {};
    return { notice: current.authorityAvailable ? copy.observeHelp : copy.accessUnavailable };
  }
  const connectionPending = current.authorityAvailable !== true;
  return {
    composer: {
      placeholder: copy.turnRequestPlaceholder,
      onSend: submit,
      sendBlocked: connectionPending,
      ...(connectionPending ? { sendBlockedReason: copy.turnRequestReconnecting } : {}),
      pendingMessages,
    },
  };
}

function isTurnRequestTerminal(request: SessionTurnAccessRequest): boolean {
  return (
    request.state.kind === 'rejected' ||
    (request.state.kind === 'approved' && request.state.admission !== 'pending')
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
