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

import { createContext, useContext, useMemo, type ReactNode } from 'react';
import type { ToastApi } from '@maka/ui';
import { useSessionTurnRequestInbox } from './controller/use-turn-request-inbox.js';

export interface SessionTurnRequestInboxCopy {
  readonly sharedTask: string;
  readonly newTurnRequestTitle: (count: number) => string;
  readonly newTurnRequestSummary: (count: number) => string;
  readonly reviewTurnRequest: string;
  readonly turnRequests: string;
  readonly ownerTurnRequestTitle: string;
  readonly reject: string;
  readonly approve: string;
  readonly moreTurnRequests: (count: number) => string;
  readonly pendingTurnRequestCount: (count: number) => string;
}

type SessionTurnRequestInbox = ReturnType<typeof useSessionTurnRequestInbox> & {
  readonly copy: SessionTurnRequestInboxCopy;
};

const SessionTurnRequestInboxContext = createContext<SessionTurnRequestInbox | null>(null);

export function SessionTurnRequestInboxProvider(props: {
  readonly sessions: readonly { readonly id: string; readonly name: string }[];
  readonly toast: ToastApi;
  readonly onOpenSession: (sessionId: string) => void;
  readonly copy: SessionTurnRequestInboxCopy;
  readonly children?: ReactNode;
}) {
  const inbox = useSessionTurnRequestInbox(props);
  const value = useMemo<SessionTurnRequestInbox>(
    () => ({ ...inbox, copy: props.copy }),
    [
      inbox.decide,
      inbox.requests,
      inbox.requestsBySession,
      inbox.workingRequestIds,
      props.copy,
    ],
  );
  return (
    <SessionTurnRequestInboxContext.Provider value={value}>
      {props.children}
    </SessionTurnRequestInboxContext.Provider>
  );
}

export function useSessionTurnRequestInboxContext(): SessionTurnRequestInbox {
  const inbox = useContext(SessionTurnRequestInboxContext);
  if (!inbox) throw new Error('SessionTurnRequestInboxProvider is missing');
  return inbox;
}
