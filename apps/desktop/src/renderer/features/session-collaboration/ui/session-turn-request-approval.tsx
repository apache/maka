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

import type { SessionTurnAccessRequest } from '@maka/runtime-host/protocol';
import type { StoredMessage } from '@maka/core/session';
import { HoverCard } from '@astryxdesign/core/HoverCard';
import { Banner, Button } from '@maka/ui';
import {
  useSessionTurnRequestInboxContext,
  type SessionTurnRequestInboxCopy,
} from '../turn-request-inbox-context.js';
import { describeOwnerTurnRequestIntent } from '../model/turn-request-inbox.js';

export function SessionTurnRequestApprovalForSession(props: {
  readonly sessionId: string;
  readonly messages: readonly StoredMessage[];
  readonly onOpenSession: (sessionId: string, turnId?: string) => void;
}) {
  const inbox = useSessionTurnRequestInboxContext();
  return (
    <SessionTurnRequestApproval
      requests={inbox.requestsBySession.get(props.sessionId) ?? []}
      messages={props.messages}
      workingRequestIds={inbox.workingRequestIds}
      copy={inbox.copy}
      onDecide={inbox.decide}
      onOpenSource={(turnId) => props.onOpenSession(props.sessionId, turnId)}
    />
  );
}

export function SessionTurnRequestApproval(props: {
  readonly requests: readonly SessionTurnAccessRequest[];
  readonly messages: readonly StoredMessage[];
  readonly workingRequestIds: ReadonlySet<string>;
  readonly copy: Pick<
    SessionTurnRequestInboxCopy,
    | 'ownerTurnRequestTitle'
    | 'ownerRegenerateRequestTitle'
    | 'regenerateRequest'
    | 'viewSourceTurn'
    | 'reject'
    | 'approve'
    | 'moreTurnRequests'
  >;
  readonly onDecide: (
    request: SessionTurnAccessRequest,
    decision: 'approve' | 'reject',
  ) => void | Promise<void>;
  readonly onOpenSource: (turnId: string) => void;
}) {
  const request = props.requests[0];
  const copy = props.copy;
  if (!request) return null;
  const working = props.workingRequestIds.has(request.requestId);
  const sourceTurnId = 'content' in request.intent
    ? undefined
    : request.intent.sourceTurnId;
  const description = describeOwnerTurnRequestIntent(
    request.intent,
    props.messages,
    copy.regenerateRequest,
  );
  const title = sourceTurnId === undefined
    ? copy.ownerTurnRequestTitle
    : copy.ownerRegenerateRequestTitle;
  return (
    <div className="sessionTurnRequestApproval">
      <Banner
        className="sessionTurnRequestApprovalBanner"
        status="warning"
        role="status"
        title={title}
        description={(
          <HoverCard
            content={(
              <div className="sessionTurnRequestApprovalDetails">
                {description}
              </div>
            )}
            label={title}
            placement="above"
            alignment="start"
            focusTrigger="always"
            hasHoverIndication={false}
          >
            <span className="sessionTurnRequestApprovalIntent" tabIndex={0}>
              {description}
            </span>
          </HoverCard>
        )}
        endContent={(
          <div className="sessionTurnRequestApprovalActions">
            {sourceTurnId ? (
              <Button
                variant="ghost"
                size="sm"
                label={copy.viewSourceTurn}
                onClick={() => props.onOpenSource(sourceTurnId)}
              />
            ) : null}
            <Button
              variant="secondary"
              size="sm"
              label={copy.reject}
              isDisabled={working}
              onClick={() => void props.onDecide(request, 'reject')}
            />
            <Button
              variant="primary"
              size="sm"
              label={copy.approve}
              isDisabled={working}
              onClick={() => void props.onDecide(request, 'approve')}
            />
          </div>
        )}
      />
      {props.requests.length > 1 ? (
        <span className="sessionTurnRequestApprovalMore">
          {copy.moreTurnRequests(props.requests.length - 1)}
        </span>
      ) : null}
    </div>
  );
}
