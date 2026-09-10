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
import { useConversationServices } from '../services.js';

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
  readonly limitDetail?: string;
}

export function useSessionReferenceComposer(options: {
  readonly sessions: readonly ConversationSession[];
  readonly activeId?: string;
  readonly hostId?: string;
  readonly addQuote?: (quote: QuoteRef) => void;
  readonly pendingQuotes?: readonly QuoteRef[];
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
  const [pendingReferences, setPendingReferences] = useState<readonly SessionReferenceSession[]>([]);
  const pendingReferencesRef = useRef<SessionReferenceSession[]>([]);
  const pendingPromise = useRef<Promise<boolean> | null>(null);
  const pendingQuotesRef = useRef(options.pendingQuotes);
  pendingQuotesRef.current = options.pendingQuotes;
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
    pendingReferencesRef.current = [];
    setPendingReferences([]);
    pendingPromise.current = null;
    pendingContextKey.current = undefined;
    setPending(false);
    setError(undefined);
  }, [contextKey]);

  const reportError = useCallback((title: string, detail: string) => {
    setError({ contextKey, title, detail });
  }, [contextKey]);
  const pick = useCallback(async (session: { id: string }): Promise<void> => {
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
    const selected = {
      id: source.id,
      name: source.name,
      status: source.status,
      lastMessageAt: source.lastMessageAt,
      lastMessagePreview: source.lastMessagePreview,
    } satisfies SessionReferenceSession;
    if (!pendingReferencesRef.current.some((reference) => reference.id === selected.id)) {
      if (pendingReferencesRef.current.length + (pendingQuotesRef.current?.length ?? 0) >= 16) {
        reportError(options.errorCopy.unavailableTitle, options.errorCopy.limitDetail ?? 'Remove a quote before adding another (maximum 16).');
        return;
      }
      generation.current += 1;
      pendingPromise.current = null;
      setPending(false);
      const next = [...pendingReferencesRef.current, selected];
      pendingReferencesRef.current = next;
      setPendingReferences(next);
    }
  }, [options.activeId, options.errorCopy, options.hostId, options.sessions, reportError]);

  const waitForPending = useCallback(async (): Promise<boolean> => {
    const operation = pendingPromise.current;
    if (operation && pendingContextKey.current === contextKey) return operation;
    const selected = pendingReferencesRef.current;
    if (selected.length === 0) return true;
    if (selected.length + (pendingQuotesRef.current?.length ?? 0) > 16) {
      reportError(options.errorCopy.unavailableTitle, options.errorCopy.limitDetail ?? 'Remove a quote before sending (maximum 16).');
      return false;
    }
    const request = ++generation.current;
    const requestContextKey = contextKey;
    pendingContextKey.current = requestContextKey;
    setPending(true);
    const operationPromise = (async (): Promise<boolean> => {
      try {
        const sources = selected.map((reference) => options.sessions.find((candidate) =>
          candidate.id === reference.id &&
          !candidate.isArchived &&
          candidate.shared !== true &&
          candidate.id !== options.activeId &&
          candidate.runtimeHostId === options.hostId,
        ));
        if (sources.some((source) => source === undefined)) {
          reportError(options.errorCopy.unavailableTitle, options.errorCopy.unavailableDetail);
          return false;
        }
        const snapshots = await Promise.all(
          sources.map((source) => services.sessions.readSnapshot(source!.id)),
        );
        if (request !== generation.current || requestContextKey !== contextKeyRef.current) return false;
        if (selected.length + (pendingQuotesRef.current?.length ?? 0) > 16) {
          reportError(options.errorCopy.unavailableTitle, options.errorCopy.limitDetail ?? 'Remove a quote before sending (maximum 16).');
          return false;
        }
        if (snapshots.some((snapshot) => !snapshot.text.trim())) {
          reportError(options.errorCopy.emptyTitle, options.errorCopy.emptyDetail);
          return false;
        }
        if (!options.addQuote) return false;
        for (const snapshot of snapshots) options.addQuote(sessionSnapshotToQuote(snapshot));
        pendingReferencesRef.current = [];
        setPendingReferences([]);
        return true;
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
    pendingPromise.current = operationPromise;
    return operationPromise;
  }, [contextKey, options.activeId, options.addQuote, options.errorCopy, options.hostId, options.sessions, reportError, services]);

  const removePendingReference = useCallback((sessionId: string): void => {
    const next = pendingReferencesRef.current.filter((reference) => reference.id !== sessionId);
    if (next.length === pendingReferencesRef.current.length) return;
    generation.current += 1;
    pendingPromise.current = null;
    setPending(false);
    pendingReferencesRef.current = next;
    setPendingReferences(next);
  }, []);

  return {
    references,
    pick,
    pending,
    pendingReferences,
    removePendingReference,
    error: error?.contextKey === contextKey
      ? { title: error.title, detail: error.detail }
      : undefined,
    waitForPending,
  };
}
