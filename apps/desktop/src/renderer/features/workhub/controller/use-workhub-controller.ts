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

import { useEffect, useRef, useState } from 'react';
import {
  applyLiveTurnEvent,
  armLiveTurn,
  createTranscriptViewportNavigation,
  reconcileTerminalLiveTurn,
  settleLiveTurnStep,
  useUiLocale,
  type LiveTurnProjection,
  type TransientUserMessageProjection,
} from '@maka/ui';
import type { AttachmentRef } from '@maka/core/events';
import type { ChatModelChoice } from '@maka/core/chat-model-choice';
import { startWorkHubCoordinationLifecycle } from './coordination-lifecycle.js';
import { useWorkHubServices } from '../services.js';
import { workHubLiveCopy } from '../locales/workhub-live-copy.js';
import type { WorkHubServices, WorkHubTranscript, WorkHubTranscriptSnapshot } from '../ports.js';

const emptyTranscript: WorkHubTranscriptSnapshot = {
  messages: [],
  hasOlder: false,
  hasNewer: false,
  ready: false,
};
export function useWorkHubController() {
  const services = useWorkHubServices();
  const locale = useUiLocale();
  const localeRef = useRef(locale);
  localeRef.current = locale;
  const [sessionId, setSessionId] = useState<string>();
  const [sessions, setSessions] = useState<Awaited<ReturnType<WorkHubServices['listSessions']>>>(
    [],
  );
  const [choices, setChoices] = useState<ChatModelChoice[]>([]);
  const [transcript, setTranscript] = useState(emptyTranscript);
  const transcriptRef = useRef(emptyTranscript);
  const [viewportNavigation] = useState(createTranscriptViewportNavigation);
  const [transientMessages, setTransientMessages] = useState<TransientUserMessageProjection[]>([]);
  const [liveTurn, setLiveTurn] = useState<LiveTurnProjection>();
  const [sending, setSending] = useState(false);
  const [stopPending, setStopPending] = useState(false);
  const [error, setError] = useState<string>();
  const retry = useRef<() => void>(() => undefined);
  const refreshSessions = useRef<() => void>(() => undefined);
  const range = useRef<WorkHubTranscript | undefined>(undefined);
  const currentSessionId = useRef(sessionId);
  currentSessionId.current = sessionId;
  const sendingRef = useRef(false);
  const pendingSend = useRef<{ sessionId: string; turnId: string; text: string; attachmentKey: string } | undefined>(
    undefined,
  );
  const report = (reason: unknown) =>
    setError(reason instanceof Error ? reason.message : String(reason));

  useEffect(
    () =>
      startWorkHubCoordinationLifecycle({
        resolve: services.resolve,
        subscribeHostChanges: services.subscribeHosts,
        subscribeAvailabilityChanges: services.subscribeAvailability,
        onResolving: () => {
          currentSessionId.current = undefined;
          setSessionId(undefined);
          setError(undefined);
        },
        onResolved: setSessionId,
        reportFailure: (reason, action) => {
          report(reason);
          retry.current = action;
        },
      }),
    [services],
  );

  useEffect(() => {
    let disposed = false;
    let revision = 0;
    const refresh = () => {
      const read = ++revision;
      void Promise.all([services.listSessions(), sessionId ? services.getSession(sessionId) : undefined])
        .then(([next, coordination]) => {
          if (!disposed && read === revision) setSessions(coordination ? [...next, coordination] : next);
        })
        .catch((reason: unknown) => {
          if (!disposed) report(reason);
        });
    };
    const unsubscribe = services.subscribeSessions(refresh);
    refreshSessions.current = refresh;
    refresh();
    return () => {
      disposed = true;
      if (refreshSessions.current === refresh) refreshSessions.current = () => undefined;
      unsubscribe();
    };
  }, [services, sessionId]);

  useEffect(() => {
    setChoices([]);
    transcriptRef.current = emptyTranscript;
    setTranscript(emptyTranscript);
    setTransientMessages([]);
    setLiveTurn(undefined);
    if (!sessionId) return;
    let disposed = false;
    let handle: WorkHubTranscript | undefined;
    const transcriptAbort = new AbortController();
    const refreshModels = () => {
      void services
        .modelChoices(sessionId)
        .then((next) => {
          if (!disposed) setChoices(next);
        })
        .catch((reason: unknown) => {
          if (!disposed) report(reason);
        });
    };
    const unsubscribeModels = services.subscribeAvailability(refreshModels);
    refreshModels();
    const unsubscribe = services.observe(
      sessionId,
      (event) => {
        if (!disposed)
          setLiveTurn((previous) => {
            const next = applyLiveTurnEvent(previous, event, localeRef.current);
            return next ? reconcileTerminalLiveTurn(next, transcriptRef.current.messages) : next;
          });
      },
      (reason) => {
        if (!disposed) report(reason);
      },
    );
    const opening = services.openTranscript(sessionId, (snapshot) => {
      if (disposed) return;
      transcriptRef.current = snapshot;
      setTranscript(snapshot);
      setTransientMessages((previous) => previous.filter((pending) =>
        !snapshot.messages.some((message) => message.type === 'user' && message.turnId === pending.hostTurnId),
      ));
      setLiveTurn((previous) =>
        previous ? reconcileTerminalLiveTurn(previous, [...snapshot.messages]) : previous,
      );
    }, transcriptAbort.signal);
    void opening
      .then((opened) => {
        handle = opened;
        if (disposed) void opened.close();
        else range.current = opened;
      })
      .catch((reason: unknown) => {
        if (!disposed) report(reason);
      });
    return () => {
      disposed = true;
      transcriptAbort.abort();
      unsubscribe();
      unsubscribeModels();
      if (range.current === handle) range.current = undefined;
      void handle?.close().catch(() => undefined);
    };
  }, [services, sessionId]);

  const session = sessions.find((candidate) => candidate.id === sessionId);
  const runningTurnId =
    liveTurn && !liveTurn.terminal ? liveTurn.turnId : session?.runningTurnIds?.[0];
  const busy = sending || Boolean(runningTurnId);
  async function send(text: string, attachments: AttachmentRef[]) {
    if (!sessionId || !text.trim() || busy || sendingRef.current) return false;
    const target = sessionId;
    sendingRef.current = true;
    setSending(true);
    setError(undefined);
    try {
      const previous = pendingSend.current;
      const attachmentKey = JSON.stringify(attachments);
      const attempt =
        previous?.sessionId === target && previous.text === text && previous.attachmentKey === attachmentKey
          ? previous
          : { sessionId: target, turnId: crypto.randomUUID(), text, attachmentKey };
      pendingSend.current = attempt;
      setLiveTurn(armLiveTurn(attempt.turnId));
      setTransientMessages((previous) => [...previous.filter((message) => message.hostTurnId !== attempt.turnId), {
        id: attempt.turnId, hostTurnId: attempt.turnId, text, ts: Date.now(),
        attachments: [...attachments], transientPlacement: 'current_turn',
      }]);
      viewportNavigation.followLatest(target);
      // Return a historical range to the tail without delaying message admission.
      void range.current?.loadLatest().catch((reason: unknown) => {
        if (currentSessionId.current === target) report(reason);
      });
      const result = await services.answer(target, {
        turnId: attempt.turnId,
        text,
        ...(attachments.length ? { attachments } : {}),
      });
      pendingSend.current = undefined;
      if (currentSessionId.current === target)
        setLiveTurn((previous) =>
          previous?.turnId === result.turnId ? previous : reconcileTerminalLiveTurn(armLiveTurn(result.turnId), transcriptRef.current.messages),
        );
      return true;
    } catch (reason) {
      if (currentSessionId.current === target) {
        const failedTurnId = pendingSend.current?.turnId;
        setTransientMessages((previous) => previous.filter((message) => message.hostTurnId !== failedTurnId));
        setLiveTurn((previous) => previous?.turnId === failedTurnId && previous?.unconfirmed ? undefined : previous);
        report(reason);
      }
      return false;
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  }
  async function stop() {
    if (!sessionId || !runningTurnId || stopPending) return;
    setStopPending(true);
    try {
      await services.stop(sessionId, runningTurnId);
    } catch (reason) {
      report(reason);
    } finally {
      setStopPending(false);
    }
  }
  async function changeModel(input: {
    llmConnectionId: string;
    llmConnectionSlug: string;
    model: string;
  }) {
    if (!sessionId || !session || busy) return;
    try {
      const result = await services.configureModel(sessionId, {
        expectedRevision: session.revision,
        modelTarget: {
          kind: 'explicit',
          connectionId: input.llmConnectionId,
          connectionSlug: input.llmConnectionSlug,
          model: input.model,
        },
      });
      refreshSessions.current();
      if (result.kind === 'revision_conflict')
        throw new Error(workHubLiveCopy[localeRef.current].modelConflict);
      setError(undefined);
    } catch (reason) {
      report(reason);
    }
  }
  return {
    services,
    sessionId,
    session,
    sessions,
    choices,
    transcript,
    transientMessages,
    viewportNavigation,
    liveTurn,
    busy,
    sending,
    stopPending,
    error,
    send,
    stop,
    changeModel,
    retry: () => retry.current(),
    loadOlder: () => range.current?.loadOlder(),
    loadLatest: () => range.current?.loadLatest(),
    report,
    streamingSettled(messageId?: string) {
      if (!messageId || !transcriptRef.current.messages.some((message) => message.id === messageId && message.type === 'assistant')) return;
      setLiveTurn((previous) => {
        const next = previous ? settleLiveTurnStep(previous, messageId) : undefined;
        return next ? reconcileTerminalLiveTurn(next, transcriptRef.current.messages) : next;
      });
    },
  };
}
