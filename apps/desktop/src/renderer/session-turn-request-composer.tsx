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
import { Button, Text, TextArea, useToast, useUiLocale } from '@maka/ui';
import type { SessionTurnAccessRequest } from '@maka/runtime-host/protocol';
import { getSessionCollaborationCopy } from './locales/session-collaboration-copy.js';

export function SessionTurnRequestComposer(props: {
  readonly sessionId: string;
}) {
  const copy = getSessionCollaborationCopy(useUiLocale());
  const toast = useToast();
  const [text, setText] = useState('');
  const [requests, setRequests] = useState<readonly SessionTurnAccessRequest[]>([]);
  const [canRequestTurns, setCanRequestTurns] = useState(false);
  const [authorityAvailable, setAuthorityAvailable] = useState<boolean>();
  const [reconciling, setReconciling] = useState(false);
  const [working, setWorking] = useState(false);
  const attemptRef = useRef<{ readonly turnId: string; readonly text: string } | undefined>(
    undefined,
  );
  const reconcilingTurnIdRef = useRef<string | undefined>(undefined);

  function acceptRequest(request: SessionTurnAccessRequest): void {
    setRequests((current) =>
      current.some((candidate) => candidate.requestId === request.requestId)
        ? current
        : [...current, request],
    );
    attemptRef.current = undefined;
    reconcilingTurnIdRef.current = undefined;
    setReconciling(false);
    setText('');
    toast.success(copy.turnRequestSent);
  }

  function applyProjection(result: {
    readonly canRequestTurns: boolean;
    readonly requests: readonly SessionTurnAccessRequest[];
  }): SessionTurnAccessRequest | undefined {
    setAuthorityAvailable(true);
    setCanRequestTurns(result.canRequestTurns);
    setRequests(result.requests);
    const turnId = reconcilingTurnIdRef.current;
    if (!turnId) return;
    const request = result.requests.find((candidate) => candidate.intent.turnId === turnId);
    if (request) acceptRequest(request);
    else {
      reconcilingTurnIdRef.current = undefined;
      setReconciling(false);
    }
    return request;
  }

  useEffect(() => {
    let disposed = false;
    let timer: number | undefined;
    const refresh = async () => {
      try {
        const result = await window.maka.sessionCollaboration.getTurnRequests(props.sessionId);
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
  }, [props.sessionId]);

  async function submit(): Promise<void> {
    const content = text.trim();
    if (!content) return;
    const attempt = attemptRef.current?.text === content
      ? attemptRef.current
      : { turnId: crypto.randomUUID(), text: content };
    attemptRef.current = attempt;
    setWorking(true);
    try {
      const request = await window.maka.sessionCollaboration.requestTurn(
        props.sessionId,
        attempt,
      );
      acceptRequest(request);
    } catch (error) {
      try {
        const current = await window.maka.sessionCollaboration.getTurnRequests(props.sessionId);
        reconcilingTurnIdRef.current = attempt.turnId;
        const request = applyProjection(current);
        if (request) {
          return;
        }
      } catch {
        reconcilingTurnIdRef.current = attempt.turnId;
        setReconciling(true);
        setAuthorityAvailable(false);
        return;
      }
      toast.error(copy.submitTurnRequest, errorMessage(error));
    } finally {
      setWorking(false);
    }
  }

  async function dismiss(requestId: string): Promise<void> {
    try {
      await window.maka.sessionCollaboration.acknowledgeTurnRequest(
        props.sessionId,
        requestId,
      );
      setRequests((current) =>
        current.filter((request) => request.requestId !== requestId),
      );
    } catch (error) {
      toast.error(copy.turnRequests, errorMessage(error));
    }
  }

  return (
    <div className="sessionTurnRequestSurface">
      {requests.length > 0 ? (
        <div className="sessionTurnRequestHistory" aria-label={copy.turnRequests}>
          {requests.slice().reverse().map((request) => (
            <div className="sessionTurnRequestHistoryRow" key={request.requestId}>
              <Text type="body" className="sessionTurnRequestHistoryText">
                {request.intent.content.text}
              </Text>
              <Text type="supporting" color="secondary">
                {turnRequestStateLabel(request, copy)}
              </Text>
              {isTurnRequestTerminal(request) ? (
                <Button
                  variant="ghost"
                  size="sm"
                  label={copy.dismissTurnRequest}
                  isDisabled={authorityAvailable !== true}
                  onClick={() => void dismiss(request.requestId)}
                />
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
      {authorityAvailable === false ? (
        <div className="sessionCollaborationReadOnly">
          {reconciling ? copy.turnRequestReconciling : copy.accessUnavailable}
        </div>
      ) : authorityAvailable === true && canRequestTurns ? (
        <div className="sessionTurnRequestComposer">
          <TextArea
            label={copy.turnRequestPlaceholder}
            isLabelHidden
            value={text}
            rows={2}
            placeholder={copy.turnRequestPlaceholder}
            isDisabled={working || reconciling}
            onChange={(value) => {
              if (value.trim() !== attemptRef.current?.text) attemptRef.current = undefined;
              setText(value);
            }}
          />
          <div className="sessionTurnRequestComposerFooter">
            <Text type="supporting" color="secondary">
              {copy.requestTurnHelp}
            </Text>
            <Button
              variant="primary"
              size="sm"
              label={copy.submitTurnRequest}
              isDisabled={working || reconciling || text.trim().length === 0}
              onClick={() => void submit()}
            />
          </div>
        </div>
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

export function turnRequestStateLabel(
  request: SessionTurnAccessRequest,
  copy: ReturnType<typeof getSessionCollaborationCopy>,
): string {
  if (request.state.kind === 'pending') return copy.turnRequestPending;
  if (request.state.kind === 'rejected') return copy.turnRequestRejected;
  if (request.state.admission === 'pending') return copy.turnRequestApproved;
  if (request.state.admission === 'started') return copy.turnRequestStarted;
  if (request.state.admission === 'blocked') return copy.turnRequestBlocked;
  return copy.turnRequestFailed;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
