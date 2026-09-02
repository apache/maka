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
import { HoverCard } from '@astryxdesign/core/HoverCard';
import { Banner, Button } from '@maka/ui';
import {
  useSessionTurnRequestInboxContext,
  type SessionTurnRequestInboxCopy,
} from '../turn-request-inbox-context.js';

export function SessionTurnRequestApprovalForSession(props: { readonly sessionId: string }) {
  const inbox = useSessionTurnRequestInboxContext();
  return (
    <SessionTurnRequestApproval
      requests={inbox.requestsBySession.get(props.sessionId) ?? []}
      workingRequestIds={inbox.workingRequestIds}
      copy={inbox.copy}
      onDecide={inbox.decide}
    />
  );
}

export function SessionTurnRequestApproval(props: {
  readonly requests: readonly SessionTurnAccessRequest[];
  readonly workingRequestIds: ReadonlySet<string>;
  readonly copy: Pick<
    SessionTurnRequestInboxCopy,
    'ownerTurnRequestTitle' | 'reject' | 'approve' | 'moreTurnRequests'
  >;
  readonly onDecide: (
    request: SessionTurnAccessRequest,
    decision: 'approve' | 'reject',
  ) => void | Promise<void>;
}) {
  const request = props.requests[0];
  const copy = props.copy;
  if (!request) return null;
  const working = props.workingRequestIds.has(request.requestId);
  return (
    <div className="sessionTurnRequestApproval">
      <Banner
        className="sessionTurnRequestApprovalBanner"
        status="warning"
        role="status"
        title={copy.ownerTurnRequestTitle}
        description={(
          <HoverCard
            content={(
              <div className="sessionTurnRequestApprovalDetails">
                {request.intent.content.text}
              </div>
            )}
            label={copy.ownerTurnRequestTitle}
            placement="above"
            alignment="start"
            focusTrigger="always"
            hasHoverIndication={false}
          >
            <span className="sessionTurnRequestApprovalIntent" tabIndex={0}>
              {request.intent.content.text}
            </span>
          </HoverCard>
        )}
        endContent={(
          <div className="sessionTurnRequestApprovalActions">
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
