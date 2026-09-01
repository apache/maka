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
import type { QuoteRef } from '@maka/core/events';
import type { ConversationSession } from '../ports.js';
import { sessionSnapshotToQuote } from '@maka/core/session-reference';
import { useConversationServices } from '../services-context.js';

export interface SessionReferenceSession {
  readonly id: string;
  readonly name: string;
  readonly status?: string;
  readonly lastMessageAt?: number;
  readonly lastMessagePreview?: string;
}

export interface SessionReferenceErrorCopy {
  readonly unavailableTitle: string;
  readonly unavailableDetail: string;
  readonly emptyTitle: string;
  readonly emptyDetail: string;
  readonly readFailedTitle: string;
  readonly readFailedDetail: string;
}

export function useSessionReferenceComposer(options: {
  readonly sessions: readonly ConversationSession[];
  readonly activeId?: string;
  readonly hostId?: string;
  readonly addQuote?: (quote: QuoteRef) => void;
  readonly errorCopy: SessionReferenceErrorCopy;
}) {
  const services = useConversationServices();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<{
    contextKey: string;
    title: string;
    detail: string;
  }>();
  const generation = useRef(0);
  const contextKey = `${options.activeId ?? ''}\u0000${options.hostId ?? ''}`;
  const contextKeyRef = useRef(contextKey);
  contextKeyRef.current = contextKey;
  const pendingPromise = useRef<Promise<boolean> | null>(null);
  const pendingContextKey = useRef<string | undefined>(undefined);
  const references = useMemo(
    () => options.sessions
      .filter((session) =>
        session.runtimeHostId === options.hostId &&
        session.id !== options.activeId &&
        !session.isArchived &&
        session.shared !== true,
      )
      .map((session) => ({
        id: session.id,
        name: session.name,
        status: session.status,
        lastMessageAt: session.lastMessageAt,
        lastMessagePreview: session.lastMessagePreview,
      })),
    [options.activeId, options.hostId, options.sessions],
  );
  useEffect(() => {
    generation.current += 1;
    pendingPromise.current = null;
    pendingContextKey.current = undefined;
    setPending(false);
    setError(undefined);
  }, [contextKey]);

  const reportError = useCallback((title: string, detail: string) => {
    setError({ contextKey, title, detail });
  }, [contextKey]);
  const pick = useCallback(async (session: { id: string }): Promise<void> => {
    const request = ++generation.current;
    const requestContextKey = contextKey;
    const source = options.sessions.find((candidate) => candidate.id === session.id);
    if (
      !source ||
      source.isArchived ||
      source.shared === true ||
      source.id === options.activeId ||
      source.runtimeHostId !== options.hostId
    ) {
      pendingPromise.current = null;
      pendingContextKey.current = undefined;
      setPending(false);
      reportError(options.errorCopy.unavailableTitle, options.errorCopy.unavailableDetail);
      return;
    }
    setError(undefined);
    setPending(true);
    pendingContextKey.current = requestContextKey;
    const operation = (async (): Promise<boolean> => {
      try {
        const snapshot = await services.sessions.readSnapshot(source.id);
        if (request !== generation.current || requestContextKey !== contextKeyRef.current) return false;
        if (!snapshot.text.trim()) {
          reportError(options.errorCopy.emptyTitle, options.errorCopy.emptyDetail);
          return false;
        }
        options.addQuote?.(sessionSnapshotToQuote(snapshot));
        return options.addQuote !== undefined;
      } catch {
        if (request === generation.current && requestContextKey === contextKeyRef.current) {
          reportError(options.errorCopy.readFailedTitle, options.errorCopy.readFailedDetail);
        }
        return false;
      } finally {
        if (request === generation.current) {
          pendingPromise.current = null;
          pendingContextKey.current = undefined;
          setPending(false);
        }
      }
    })();
    pendingPromise.current = operation;
    await operation;
  }, [contextKey, options.activeId, options.addQuote, options.errorCopy, options.hostId, options.sessions, reportError, services]);

  const waitForPending = useCallback(async (): Promise<boolean> => {
    const operation = pendingPromise.current;
    return operation && pendingContextKey.current === contextKey ? operation : true;
  }, [contextKey]);

  return {
    references,
    pick,
    pending,
    error: error?.contextKey === contextKey
      ? { title: error.title, detail: error.detail }
      : undefined,
    waitForPending,
  };
}
