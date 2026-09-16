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

import { useEffect, useId, useRef, useState } from 'react';
import {
  ChatComposer,
  ChatComposerInput,
} from '@astryxdesign/core/Chat';
import { Tooltip } from '@astryxdesign/core/Tooltip';
import {
  Button,
  readComposerDraft,
  rememberComposerDraft,
  Text,
  useToast,
  useUiLocale,
} from '@maka/ui';
import { ChevronDown, ICON_SIZE, Loader2 } from '@maka/ui/icons';
import type { SessionTurnAccessRequest } from '@maka/runtime-host/protocol';
import { getSessionCollaborationCopy } from '../../../locales/session-collaboration-copy.js';
import {
  describeTurnRequestIntent,
  turnRequestStateLabel,
} from '../model/turn-request-inbox.js';
import { useSessionCollaborationServices } from '../services-context.js';

const guestTurnRequestDrafts = new Map<string, string>();
const guestTurnRequestDraftTokens = new Map<string, symbol>();
const guestTurnRequestAttempts = new Map<string, TurnRequestAttempt>();

interface TurnRequestAttempt {
  readonly turnId: string;
  readonly text: string;
  readonly draftToken: symbol;
  readonly phase: 'submitting' | 'reconciling' | 'retryable';
}

export function SessionTurnRequestComposer(props: {
  readonly sessionId: string;
}) {
  return <SessionTurnRequestComposerForSession key={props.sessionId} {...props} />;
}

function SessionTurnRequestComposerForSession(props: {
  readonly sessionId: string;
}) {
  const copy = getSessionCollaborationCopy(useUiLocale());
  const toast = useToast();
  const services = useSessionCollaborationServices();
  const [text, setText] = useState(() => readComposerDraft(guestTurnRequestDrafts, props.sessionId));
  const [requests, setRequests] = useState<readonly SessionTurnAccessRequest[]>([]);
  const [canRequestTurns, setCanRequestTurns] = useState(false);
  const [authorityAvailable, setAuthorityAvailable] = useState<boolean>();
  const [reconciling, setReconciling] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [workingRequestIds, setWorkingRequestIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const historyId = useId();
  const attemptRef = useRef<TurnRequestAttempt | undefined>(
    guestTurnRequestAttempts.get(props.sessionId),
  );
  const submissionInFlightRef = useRef(false);
  const previousActiveCountRef = useRef(0);

  const activeRequestCount = requests.filter((request) => !isTurnRequestTerminal(request)).length;
  const connectionPending = authorityAvailable !== true || reconciling;

  useEffect(() => {
    if (activeRequestCount > previousActiveCountRef.current) setExpanded(true);
    previousActiveCountRef.current = activeRequestCount;
  }, [activeRequestCount]);

  function setDraft(value: string): void {
    rememberComposerDraft(guestTurnRequestDrafts, props.sessionId, value);
    if (value.trim()) guestTurnRequestDraftTokens.set(props.sessionId, Symbol());
    else guestTurnRequestDraftTokens.delete(props.sessionId);
    for (const sessionId of guestTurnRequestDraftTokens.keys()) {
      if (!guestTurnRequestDrafts.has(sessionId)) {
        guestTurnRequestDraftTokens.delete(sessionId);
      }
    }
    setText(value);
  }

  function ownsDraft(attempt: TurnRequestAttempt): boolean {
    return guestTurnRequestDraftTokens.get(props.sessionId) === attempt.draftToken;
  }

  function restoreDraft(attempt: TurnRequestAttempt): void {
    if (ownsDraft(attempt)) setText(attempt.text);
  }

  function rememberAttempt(attempt: TurnRequestAttempt): void {
    guestTurnRequestAttempts.set(props.sessionId, attempt);
    attemptRef.current = attempt;
  }

  function changeAttemptPhase(
    attempt: TurnRequestAttempt,
    phase: TurnRequestAttempt['phase'],
  ): void {
    const current = guestTurnRequestAttempts.get(props.sessionId);
    if (current?.turnId !== attempt.turnId) return;
    rememberAttempt({ ...current, phase });
  }

  function acceptRequest(request: SessionTurnAccessRequest): void {
    const attempt = attemptRef.current;
    const shouldClearDraft = attempt?.turnId === request.intent.turnId && ownsDraft(attempt);
    setRequests((current) =>
      current.some((candidate) => candidate.requestId === request.requestId)
        ? current
        : [...current, request],
    );
    if (guestTurnRequestAttempts.get(props.sessionId)?.turnId === request.intent.turnId) {
      guestTurnRequestAttempts.delete(props.sessionId);
    }
    if (attempt?.turnId === request.intent.turnId) attemptRef.current = undefined;
    setReconciling(false);
    if (shouldClearDraft) setDraft('');
    toast.success(
      'content' in request.intent ? copy.turnRequestSent : copy.regenerateRequestSent,
    );
  }

  function applyProjection(result: {
    readonly canRequestTurns: boolean;
    readonly requests: readonly SessionTurnAccessRequest[];
  }): SessionTurnAccessRequest | undefined {
    setAuthorityAvailable(true);
    setCanRequestTurns(result.canRequestTurns);
    setRequests(result.requests);
    const sharedAttempt = guestTurnRequestAttempts.get(props.sessionId);
    if (!sharedAttempt) {
      if (attemptRef.current) {
        attemptRef.current = undefined;
        setText(readComposerDraft(guestTurnRequestDrafts, props.sessionId));
      }
      setReconciling(false);
      return;
    }
    attemptRef.current = sharedAttempt;
    const request = result.requests.find(
      (candidate) => candidate.intent.turnId === sharedAttempt.turnId,
    );
    if (request) acceptRequest(request);
    else if (sharedAttempt.phase === 'submitting') {
      setReconciling(true);
    } else if (sharedAttempt.phase === 'reconciling') {
      changeAttemptPhase(sharedAttempt, 'retryable');
      setReconciling(false);
      restoreDraft(sharedAttempt);
    } else setReconciling(false);
    return request;
  }

  useEffect(() => {
    let disposed = false;
    let timer: number | undefined;
    const refresh = async () => {
      try {
        const result = await services.getTurnRequests(props.sessionId);
        if (!disposed) {
          applyProjection(result);
        }
      } catch {
        if (!disposed) setAuthorityAvailable(false);
        // The Host remains authoritative; a later refresh or submit retries the projection.
      } finally {
        if (!disposed) timer = window.setTimeout(() => void refresh(), 2_000);
      }
    };
    void refresh();
    return () => {
      disposed = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [props.sessionId, services]);

  async function submit(value: string): Promise<void> {
    const content = value.trim();
    if (!content) return;
    const draftToken = guestTurnRequestDraftTokens.get(props.sessionId) ?? Symbol();
    guestTurnRequestDraftTokens.set(props.sessionId, draftToken);
    const attempt = attemptRef.current?.text === content
      ? { ...attemptRef.current, draftToken, phase: 'submitting' as const }
      : {
          turnId: services.createOperationId(),
          text: content,
          draftToken,
          phase: 'submitting' as const,
        };
    rememberAttempt(attempt);
    submissionInFlightRef.current = true;
    setSubmitting(true);
    try {
      const request = await services.requestTurn(
        props.sessionId,
        { kind: 'start', turnId: attempt.turnId, text: attempt.text },
      );
      acceptRequest(request);
    } catch (error) {
      // Astryx clears its visible input as soon as onSubmit returns. Request
      // creation is not yet conclusive, so restore the still-owned draft before
      // reconciliation can wait on a recovering Host.
      restoreDraft(attempt);
      changeAttemptPhase(attempt, 'reconciling');
      try {
        const current = await services.getTurnRequests(props.sessionId);
        const request = applyProjection(current);
        if (
          request ||
          guestTurnRequestAttempts.get(props.sessionId)?.turnId !== attempt.turnId
        ) return;
      } catch {
        if (guestTurnRequestAttempts.get(props.sessionId)?.turnId !== attempt.turnId) return;
        setReconciling(true);
        setAuthorityAvailable(false);
        return;
      }
      restoreDraft(attempt);
      toast.error(copy.submitTurnRequest, errorMessage(error));
    } finally {
      submissionInFlightRef.current = false;
      setSubmitting(false);
    }
  }

  async function dismiss(requestId: string): Promise<void> {
    setRequestWorking(requestId, true);
    try {
      await services.acknowledgeTurnRequest(
        props.sessionId,
        requestId,
      );
      setRequests((current) =>
        current.filter((request) => request.requestId !== requestId),
      );
    } catch (error) {
      toast.error(copy.turnRequests, errorMessage(error));
    } finally {
      setRequestWorking(requestId, false);
    }
  }

  async function withdraw(requestId: string): Promise<void> {
    setRequestWorking(requestId, true);
    try {
      const result = await services.withdrawTurnRequest(
        props.sessionId,
        requestId,
      );
      if (result.withdrawn) {
        setRequests((current) => current.filter((request) => request.requestId !== requestId));
        toast.info(copy.turnRequestWithdrawn);
      } else {
        const current = await services.getTurnRequests(props.sessionId);
        applyProjection(current);
      }
    } catch (error) {
      toast.error(copy.turnRequests, errorMessage(error));
    } finally {
      setRequestWorking(requestId, false);
    }
  }

  function setRequestWorking(requestId: string, working: boolean): void {
    setWorkingRequestIds((current) => {
      const next = new Set(current);
      if (working) next.add(requestId);
      else next.delete(requestId);
      return next;
    });
  }

  return (
    <div className="sessionTurnRequestSurface">
      {requests.length > 0 ? (
        <div className="maka-composer-queue sessionTurnRequestQueue">
          <Button
            variant="ghost"
            size="sm"
            className="sessionTurnRequestQueueToggle"
            label={copy.turnRequestCount(requests.length)}
            aria-expanded={expanded}
            aria-controls={historyId}
            endContent={(
              <ChevronDown
                className={expanded ? 'isExpanded' : undefined}
                size={ICON_SIZE.chrome}
                aria-hidden="true"
              />
            )}
            onClick={() => setExpanded((current) => !current)}
          />
          {expanded ? (
            <div
              id={historyId}
              className="sessionTurnRequestHistory"
              aria-label={copy.turnRequests}
            >
              {requests.slice().reverse().map((request) => {
                const description = describeTurnRequestIntent(
                  request.intent,
                  copy.regenerateRequest,
                );
                const requestWorking = workingRequestIds.has(request.requestId);
                return (
                  <div className="sessionTurnRequestHistoryRow" key={request.requestId}>
                    <div className="sessionTurnRequestHistoryBody" title={description}>
                      <Text
                        type="body"
                        className="sessionTurnRequestHistoryText"
                      >
                        {description}
                      </Text>
                      <Text type="supporting" color="secondary">
                        {turnRequestStateLabel(request, copy)}
                      </Text>
                    </div>
                    {request.state.kind === 'pending' ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        label={copy.withdrawTurnRequest}
                        isDisabled={authorityAvailable !== true || requestWorking}
                        onClick={() => void withdraw(request.requestId)}
                      />
                    ) : isTurnRequestTerminal(request) ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        label={copy.dismissTurnRequest}
                        isDisabled={authorityAvailable !== true || requestWorking}
                        onClick={() => void dismiss(request.requestId)}
                      />
                    ) : null}
                  </div>
                );
              })}
            </div>
          ) : null}
        </div>
      ) : null}
      {canRequestTurns ? (
        <div className="composer sessionTurnRequestComposer">
          <ChatComposer
            className="maka-composer-astryx"
            value={text}
            placeholder={copy.turnRequestPlaceholder}
            isDisabled={submitting}
            input={(
              <ChatComposerInput
                label={copy.turnRequestPlaceholder}
                maxRows={8}
                hasHistory={false}
                pasteAsToken={false}
                onKeyDown={(event) => {
                  if (connectionPending && event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault();
                  }
                }}
              />
            )}
            sendButton={connectionPending ? (
              <Tooltip
                content={reconciling ? copy.turnRequestReconciling : copy.turnRequestReconnecting}
              >
                <span className="sessionTurnRequestReconnectButton">
                  <Button
                    variant="primary"
                    size="md"
                    label={
                      reconciling ? copy.turnRequestReconciling : copy.turnRequestReconnecting
                    }
                    isDisabled
                    isIconOnly
                    icon={(
                      <Loader2
                        size={ICON_SIZE.control}
                        className="maka-spin"
                        aria-hidden="true"
                      />
                    )}
                  />
                </span>
              </Tooltip>
            ) : undefined}
            onChange={(value) => {
              // ChatComposer clears itself immediately after invoking onSubmit.
              // Reflect that transient state without deleting the remembered
              // draft until the Host has conclusively accepted the request.
              if (submissionInFlightRef.current && value === '' && attemptRef.current) {
                setText('');
                return;
              }
              if (
                !submissionInFlightRef.current &&
                value.trim() !== attemptRef.current?.text
              ) {
                const attempt = attemptRef.current;
                if (
                  attempt?.phase === 'retryable' &&
                  guestTurnRequestAttempts.get(props.sessionId)?.turnId === attempt.turnId
                ) {
                  guestTurnRequestAttempts.delete(props.sessionId);
                }
                attemptRef.current = undefined;
              }
              setDraft(value);
            }}
            onSubmit={(value) => void submit(value)}
          />
        </div>
      ) : authorityAvailable === false ? (
        <div className="sessionCollaborationReadOnly">{copy.accessUnavailable}</div>
      ) : authorityAvailable === true ? (
        <div className="sessionCollaborationReadOnly">{copy.observeHelp}</div>
      ) : null}
    </div>
  );
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
