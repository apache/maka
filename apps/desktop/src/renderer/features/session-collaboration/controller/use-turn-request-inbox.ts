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

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { SessionTurnAccessRequest } from '@maka/runtime-host/protocol';
import type { ToastApi } from '@maka/ui';
import {
  groupPendingTurnRequests,
  samePendingTurnRequests,
  turnRequestPreview,
  unseenTurnRequests,
} from '../model/turn-request-inbox.js';
import { useSessionCollaborationServices } from '../services-context.js';

const INBOX_REFRESH_INTERVAL_MS = 2_000;

export function useSessionTurnRequestInbox(input: {
  readonly sessions: readonly { readonly id: string; readonly name: string }[];
  readonly toast: ToastApi;
  readonly onOpenSession: (sessionId: string) => void;
  readonly copy: {
    readonly sharedTask: string;
    readonly newTurnRequestTitle: (count: number) => string;
    readonly newTurnRequestSummary: (count: number) => string;
    readonly reviewTurnRequest: string;
    readonly turnRequests: string;
  };
}) {
  const services = useSessionCollaborationServices();
  const [requests, setRequests] = useState<readonly SessionTurnAccessRequest[]>([]);
  const [workingRequestIds, setWorkingRequestIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const seenRequestIdsRef = useRef(new Set<string>());
  const latestRef = useRef(input);
  latestRef.current = input;

  const applyProjection = useCallback((next: readonly SessionTurnAccessRequest[]) => {
    const unseen = unseenTurnRequests(next, seenRequestIdsRef.current);
    for (const request of next) seenRequestIdsRef.current.add(request.requestId);
    setRequests((current) => samePendingTurnRequests(current, next) ? current : next);
    if (unseen.length === 0) return;

    const first = unseen[0]!;
    const latest = latestRef.current;
    const copy = latest.copy;
    const sessionName = latest.sessions.find(
      (session) => session.id === first.intent.sessionId,
    )?.name ?? copy.sharedTask;
    latest.toast.toast({
      variant: 'warning',
      title: copy.newTurnRequestTitle(unseen.length),
      description: unseen.length === 1
        ? `${sessionName} · ${turnRequestPreview(first.intent.content.text)}`
        : copy.newTurnRequestSummary(unseen.length),
      duration: 10_000,
      action: {
        label: copy.reviewTurnRequest,
        onClick: () => latest.onOpenSession(first.intent.sessionId),
      },
    });
  }, []);

  const refresh = useCallback(async () => {
    const next = await services.getPendingTurnRequests();
    applyProjection(next);
  }, [applyProjection, services]);

  useEffect(() => {
    let disposed = false;
    let timer: number | undefined;
    const poll = async () => {
      try {
        const next = await services.getPendingTurnRequests();
        if (!disposed) applyProjection(next);
      } catch {
        // Keep the last durable projection while a Host reconnects and retry.
      } finally {
        if (!disposed) timer = window.setTimeout(() => void poll(), INBOX_REFRESH_INTERVAL_MS);
      }
    };
    void poll();
    return () => {
      disposed = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [applyProjection, services]);

  const decide = useCallback(async (
    request: SessionTurnAccessRequest,
    decision: 'approve' | 'reject',
  ) => {
    setWorkingRequestIds((current) => new Set(current).add(request.requestId));
    try {
      await services.decideTurnRequest(
        request.intent.sessionId,
        request.requestId,
        decision,
      );
      setRequests((current) => current.filter(
        (candidate) => candidate.requestId !== request.requestId,
      ));
      await refresh();
    } catch (error) {
      const copy = latestRef.current.copy;
      latestRef.current.toast.error(copy.turnRequests, errorMessage(error));
    } finally {
      setWorkingRequestIds((current) => {
        const next = new Set(current);
        next.delete(request.requestId);
        return next;
      });
    }
  }, [refresh]);

  return {
    requests,
    requestsBySession: useMemo(() => groupPendingTurnRequests(requests), [requests]),
    workingRequestIds,
    decide,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
