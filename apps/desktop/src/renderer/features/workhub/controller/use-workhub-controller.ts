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
  projectQueuedUserMessages,
  armLiveTurn,
  createTranscriptViewportNavigation,
  reconcileTerminalLiveTurn,
  settleLiveTurnStep,
  useUiLocale,
  type LiveTurnProjection,
  type TransientUserMessageProjection,
} from '@maka/ui';
import type { WorkHubAnswerInput, WorkHubAnswerResult } from '../../../../shared/workhub-conversation.js';
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
interface SendAttempt {
  sessionId: string;
  input: WorkHubAnswerInput;
  admission: 'pending' | 'unknown' | 'admitted' | 'terminal' | 'rejected';
  reconciling?: boolean;
  stop?: 'requested' | 'sending' | 'resend';
}
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
  const [messageQueue, setMessageQueue] = useState<{ entries: import('@maka/core/events').MessageQueueEntryProjection[]; revision?: number }>({ entries: [] });
  const [liveTurn, setLiveTurn] = useState<LiveTurnProjection>();
  const [sending, setSending] = useState(false);
  const [stopPending, setStopPending] = useState(false);
  const [error, setError] = useState<string>();
  const [readError, setReadError] = useState<string>();
  const [readRevision, setReadRevision] = useState(0);
  const retryResolution = useRef<() => void>(() => undefined);
  const refreshSessions = useRef<() => void>(() => undefined);
  const range = useRef<WorkHubTranscript | undefined>(undefined);
  const currentSessionId = useRef(sessionId);
  currentSessionId.current = sessionId;
  const sendingRef = useRef(false);
  const pendingSend = useRef<SendAttempt | undefined>(undefined);
  const pendingSteer = useRef<{ sessionId: string; turnId: string; messageId: string; text: string; attachments: AttachmentRef[]; observed: boolean }>(undefined);
  const report = (reason: unknown) =>
    setError(reason instanceof Error ? reason.message : String(reason));

  async function deliverStop(attempt: SendAttempt): Promise<void> {
    if (!attempt.stop || pendingSend.current !== attempt || currentSessionId.current !== attempt.sessionId) return;
    if (attempt.stop !== 'requested') { attempt.stop = 'resend'; return; }
    attempt.stop = 'sending';
    let failed = false;
    try {
      const result = await services.stop(attempt.sessionId, attempt.input.turnId);
      if (result) attempt.stop = undefined;
    } catch (reason) {
      failed = true;
      if (currentSessionId.current === attempt.sessionId) report(reason);
    } finally {
      // An observation may arrive while the stop owner is still reading its
      // old snapshot. Retry only for that new evidence, never on a timer.
      const again = (attempt.stop as SendAttempt['stop']) === 'resend';
      if (attempt.stop) attempt.stop = 'requested';
      if (pendingSend.current === attempt && currentSessionId.current === attempt.sessionId)
        setStopPending(Boolean(attempt.stop) && !failed);
      if (again) void deliverStop(attempt);
    }
  }

  function reconcileAdmission(target: string, turnId: string, terminal = false) {
    const attempt = pendingSend.current;
    if (!attempt || attempt.sessionId !== target || attempt.input.turnId !== turnId || attempt.admission === 'rejected') return;
    if (attempt.admission === 'unknown' && currentSessionId.current === target) setError(undefined);
    if (terminal) {
      attempt.admission = 'terminal';
      attempt.stop = undefined;
      setStopPending(false);
    } else if (attempt.admission !== 'terminal') {
      attempt.admission = 'admitted';
      void deliverStop(attempt);
    }
  }

  function acceptAnswer(attempt: SendAttempt, result: WorkHubAnswerResult): boolean {
    if (pendingSend.current !== attempt) return result.kind !== 'not_admitted';
    const current = currentSessionId.current === attempt.sessionId;
    if (result.kind === 'unknown') {
      // Late Host evidence outranks a missing response; never turn confirmed
      // execution back into an uncertain local submission.
      if (attempt.admission === 'pending' || attempt.admission === 'unknown') {
        attempt.admission = 'unknown';
        attempt.input = { ...attempt.input, originHostEpoch: result.originHostEpoch };
        if (current) setError(workHubLiveCopy[localeRef.current].sendUnknown);
      }
      return true;
    }
    if (result.kind === 'not_admitted') {
      if (attempt.admission === 'admitted' || attempt.admission === 'terminal') return true;
      attempt.admission = 'rejected';
      attempt.stop = undefined;
      if (current) {
        setStopPending(false);
        setTransientMessages((messages) => messages.filter((message) => message.hostTurnId !== attempt.input.turnId));
        setLiveTurn((previous) => previous?.turnId === attempt.input.turnId ? undefined : previous);
        setError(workHubLiveCopy[localeRef.current].sendNotAdmitted);
      }
      return false;
    }
    const terminal = result.status === 'completed' || result.status === 'failed' || result.status === 'cancelled';
    reconcileAdmission(attempt.sessionId, result.turnId, terminal);
    if (current) {
      setError(undefined);
      if (terminal) refreshSessions.current();
      setLiveTurn((previous) => {
        if (attempt.admission === 'terminal') return previous?.turnId === result.turnId ? undefined : previous;
        return previous?.turnId === result.turnId ? previous : reconcileTerminalLiveTurn(armLiveTurn(result.turnId), transcriptRef.current.messages);
      });
    }
    return true;
  }

  async function recoverSend(): Promise<void> {
    const attempt = pendingSend.current;
    if (!attempt || attempt.sessionId !== currentSessionId.current || attempt.admission !== 'unknown' || attempt.reconciling) return;
    attempt.reconciling = true;
    try {
      acceptAnswer(attempt, await services.answer(attempt.sessionId, attempt.input));
    } catch (reason) {
      // A failed recovery read says nothing about the original admission.
      if (pendingSend.current === attempt && currentSessionId.current === attempt.sessionId) report(reason);
    } finally {
      attempt.reconciling = false;
    }
  }

  useEffect(
    () =>
      startWorkHubCoordinationLifecycle({
        resolve: services.resolve,
        subscribeHostChanges: services.subscribeHosts,
        subscribeAvailabilityChanges: services.subscribeAvailability,
        onResolving: () => {
          currentSessionId.current = undefined;
          setSessionId(undefined);
          setStopPending(false);
          setError(undefined);
        },
        onResolved: setSessionId,
        reportFailure: (reason, action) => {
          report(reason);
          retryResolution.current = action;
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
          if (!disposed && read === revision) {
            setSessions(coordination ? [...next, coordination] : next);
            for (const turnId of coordination?.runningTurnIds ?? []) reconcileAdmission(sessionId!, turnId);
          }
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
    setReadError(undefined);
    const attempt = pendingSend.current;
    const pending = attempt && attempt.sessionId === sessionId && attempt.admission !== 'terminal' && attempt.admission !== 'rejected' ? attempt : undefined;
    setLiveTurn(pending ? armLiveTurn(pending.input.turnId) : undefined);
    setStopPending(Boolean(pending?.stop));
    setTransientMessages(pending ? [{
      id: pending.input.turnId, hostTurnId: pending.input.turnId, text: pending.input.text,
      attachments: pending.input.attachments, ts: Date.now(), transientPlacement: 'current_turn',
    }] : []);
  }, [sessionId]);

  useEffect(() => {
    if (!sessionId) return;
    setMessageQueue({ entries: [] });
    let disposed = false;
    let handle: WorkHubTranscript | undefined;
    let observationPhase: 'pending' | 'ready' = 'pending';
    const readFailed = (reason: unknown) => {
      if (!disposed) setReadError(reason instanceof Error ? reason.message : String(reason));
    };
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
        if (disposed) return;
        if (event.type === 'queue_update') {
          setMessageQueue({ entries: [...(event.steeringEntries ?? []), ...(event.followupEntries ?? [])], revision: event.queueRevision });
          const queued = projectQueuedUserMessages(event);
          if (queued.length) setTransientMessages((previous) => [
            ...previous.filter((message) => !queued.some((entry) => entry.id === message.id)),
            ...queued,
          ]);
        }
        if (event.type === 'message_admission' && event.outcome === 'retracted') {
          setTransientMessages((previous) => previous.filter((message) => message.id !== event.messageId));
        }
        if (event.type === 'steering_message') {
          setMessageQueue((previous) => ({ ...previous, entries: previous.entries.filter((entry) => entry.messageId !== event.messageId) }));
          if (pendingSteer.current?.messageId === event.messageId) pendingSteer.current.observed = true;
          // The live Turn now owns this row, before the durable transcript
          // necessarily catches up. Retire its admission placeholder.
          setTransientMessages((previous) => previous.filter((message) => message.id !== event.messageId));
        }
        reconcileAdmission(sessionId, event.turnId, event.type === 'abort' || event.type === 'error' || event.type === 'complete');
        setLiveTurn((previous) => {
          const next = applyLiveTurnEvent(previous, event, localeRef.current);
          return next ? reconcileTerminalLiveTurn(next, transcriptRef.current.messages) : next;
        });
      },
      (reason) => {
        observationPhase = 'pending';
        handle?.observationChanged('pending');
        readFailed(reason);
      },
      (phase) => {
        if (disposed) return;
        observationPhase = phase;
        handle?.observationChanged(phase);
        if (phase === 'ready') void recoverSend();
      },
    );
    const opening = services.openTranscript(sessionId, (snapshot) => {
      if (disposed) return;
      transcriptRef.current = snapshot;
      setTranscript(snapshot);
      if (snapshot.ready && observationPhase === 'ready') setReadError(undefined);
      const attempt = pendingSend.current;
      if (attempt?.sessionId === sessionId) {
        const messages = snapshot.messages.filter((message) => message.turnId === attempt.input.turnId);
        if (messages.length) reconcileAdmission(sessionId, attempt.input.turnId,
          messages.some((message) => message.type === 'turn_state' && message.status !== 'running'));
      }
      setTransientMessages((previous) => previous.filter((pending) =>
        !snapshot.messages.some((message) => message.type === 'user' &&
          (message.id === pending.id || (pending.id === pending.hostTurnId && message.turnId === pending.hostTurnId))),
      ));
      setLiveTurn((previous) =>
        previous ? reconcileTerminalLiveTurn(previous, [...snapshot.messages]) : previous,
      );
    }, transcriptAbort.signal, readFailed);
    void opening
      .then((opened) => {
        handle = opened;
        if (disposed) void opened.close();
        else {
          range.current = opened;
          opened.observationChanged(observationPhase);
        }
      })
      .catch(readFailed);
    return () => {
      disposed = true;
      transcriptAbort.abort();
      unsubscribe();
      unsubscribeModels();
      if (range.current === handle) range.current = undefined;
      void handle?.close().catch(() => undefined);
    };
  }, [services, sessionId, readRevision]);

  const session = sessions.find((candidate) => candidate.id === sessionId);
  const attempt = pendingSend.current;
  const pendingTurnId = attempt && attempt.sessionId === sessionId && (attempt.admission === 'pending' || attempt.admission === 'unknown') ? attempt.input.turnId : undefined;
  const runningTurnId =
    pendingTurnId ?? (liveTurn && !liveTurn.terminal ? liveTurn.turnId : session?.runningTurnIds?.[0]);
  const busy = sending || Boolean(runningTurnId);
  async function send(text: string, attachments: AttachmentRef[]) {
    if (!sessionId || !text.trim() || sendingRef.current) return false;
    const target = sessionId;
    const previousSteer = pendingSteer.current;
    const sameSteer = previousSteer?.sessionId === target && previousSteer.text === text &&
      JSON.stringify(previousSteer.attachments) === JSON.stringify(attachments) ? previousSteer : undefined;
    const steeringTurnId = sameSteer?.turnId ?? runningTurnId;
    sendingRef.current = true;
    setSending(true);
    setError(undefined);
    try {
      if (steeringTurnId) {
        const attempt = sameSteer ?? { sessionId: target, turnId: steeringTurnId, messageId: crypto.randomUUID(), text, attachments: [...attachments], observed: false };
        pendingSteer.current = attempt;
        setTransientMessages((messages) => [...messages.filter((message) => message.id !== attempt.messageId), {
          id: attempt.messageId, hostTurnId: steeringTurnId, text, attachments: [...attachments],
          ts: Date.now(), transientPlacement: 'current_turn', pendingSteering: true,
        }]);
        const result = await services.steer(target, attempt.messageId, text, attachments);
        if (result === 'rejected' && pendingSteer.current === attempt) {
          pendingSteer.current = undefined;
          setTransientMessages((messages) => messages.filter((message) => message.id !== attempt.messageId));
        }
        if (result !== 'admitted' && !attempt.observed) throw new Error(workHubLiveCopy[localeRef.current][result === 'unknown' ? 'sendUnknown' : 'sendNotAdmitted']);
        if (pendingSteer.current === attempt) pendingSteer.current = undefined;
        if (currentSessionId.current === target) {
          viewportNavigation.followLatest(target);
        }
        return true;
      }
      const previous = pendingSend.current;
      const sameRejected = previous?.sessionId === target && previous.admission === 'rejected' && previous.input.text === text && JSON.stringify(previous.input.attachments ?? []) === JSON.stringify(attachments);
      const attempt: SendAttempt = {
        sessionId: target,
        input: { turnId: sameRejected ? previous.input.turnId : crypto.randomUUID(), text, ...(attachments.length ? { attachments: [...attachments] } : {}) },
        admission: 'pending',
      };
      pendingSend.current = attempt;
      setLiveTurn(armLiveTurn(attempt.input.turnId));
      setTransientMessages((previous) => [...previous.filter((message) => message.hostTurnId !== attempt.input.turnId), {
        id: attempt.input.turnId, hostTurnId: attempt.input.turnId, text, ts: Date.now(),
        attachments: [...attachments], transientPlacement: 'current_turn',
      }]);
      viewportNavigation.followLatest(target);
      // Return a historical range to the tail without delaying message admission.
      void range.current?.loadLatest().catch((reason: unknown) => {
        if (currentSessionId.current === target) report(reason);
      });
      const result = await services.answer(target, attempt.input);
      return acceptAnswer(attempt, result);
    } catch (reason) {
      if (steeringTurnId) {
        if (currentSessionId.current === target) report(reason);
        return false;
      }
      if (currentSessionId.current === target) {
        const attempt = pendingSend.current;
        const failedTurnId = attempt?.input.turnId;
        if (attempt?.admission === 'pending') {
          attempt.admission = 'rejected';
          attempt.stop = undefined;
          setStopPending(false);
        }
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
    const attempt = pendingSend.current;
    if (attempt?.sessionId === sessionId && attempt.input.turnId === runningTurnId && attempt.admission !== 'terminal' && attempt.admission !== 'rejected') {
      attempt.stop = 'requested';
      await deliverStop(attempt);
      return;
    }
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
  async function mutateQueue(action: (target: string) => Promise<void>) {
    if (!sessionId) return;
    setError(undefined);
    try { await action(sessionId); }
    catch (reason) { report(reason); throw reason; }
  }
  return {
    services,
    sessionId,
    session,
    sessions,
    choices,
    transcript,
    transientMessages,
    messageQueue,
    updateQueuedEntry: (entryId: string, revision: number, text: string) => mutateQueue((target) => services.updateQueueEntry(target, entryId, revision, text)),
    deleteQueuedEntry: (entryId: string) => mutateQueue((target) => services.retractQueueEntry(target, entryId)),
    promoteQueuedEntry: (entryId: string) => mutateQueue((target) => services.promoteQueueEntry(target, entryId)),
    reorderQueuedEntries: (entryIds: readonly string[]) => mutateQueue((target) => services.reorderQueueEntries(target, entryIds)),
    viewportNavigation,
    liveTurn,
    busy,
    sending,
    stopPending,
    error: readError ?? error,
    canRetry: Boolean(readError || (!sessionId && error) || (error && (pendingSend.current?.admission === 'unknown' || pendingSend.current?.admission === 'rejected'))),
    send,
    stop,
    changeModel,
    retry: () => {
      const attempt = pendingSend.current;
      if (readError && sessionId) {
        setReadError(undefined);
        setReadRevision((revision) => revision + 1);
      } else if (attempt && attempt.sessionId === sessionId && attempt.admission === 'unknown') {
        void recoverSend();
      } else if (attempt && attempt.sessionId === sessionId && attempt.admission === 'rejected') {
        void send(attempt.input.text, attempt.input.attachments ?? []);
      } else retryResolution.current();
    },
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
