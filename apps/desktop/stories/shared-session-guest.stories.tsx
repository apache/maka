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

import type { Meta, StoryObj } from '@storybook/react-vite';
import type { SessionTurnAccessRequest } from '@maka/runtime-host/protocol';
import { ToastProvider } from '@maka/ui';
import {
  SessionCollaborationServicesProvider,
  SessionTurnRequestComposer,
  type SessionCollaborationServices,
} from '../src/renderer/features/session-collaboration/index.js';

const SESSION_ID = 'shared-session-story';
const REQUESTS: readonly SessionTurnAccessRequest[] = [
  {
    requestId: 'pending-request',
    principalId: 'guest-story',
    grantId: 'turn-grant',
    intent: {
      sessionId: SESSION_ID,
      turnId: 'pending-turn',
      content: { text: '请检查这个连接恢复方案，并给出可以直接执行的修复建议。' },
    },
    createdAt: '2026-09-03T01:00:00.000Z',
    state: { kind: 'pending' },
  },
  {
    requestId: 'regenerate-request',
    principalId: 'guest-story',
    grantId: 'turn-grant',
    intent: {
      sessionId: SESSION_ID,
      turnId: 'regenerated-turn',
      sourceTurnId: 'source-turn',
    },
    createdAt: '2026-09-03T00:58:00.000Z',
    state: {
      kind: 'approved',
      decidedAt: '2026-09-03T00:59:00.000Z',
      decidedBy: 'owner-story',
      admission: 'started',
    },
  },
];

function services(
  query: () => Promise<{
    readonly canRequestTurns: boolean;
    readonly requests: readonly SessionTurnAccessRequest[];
  }>,
  withdrawTurnRequest: (
    sessionId: string,
    requestId: string,
  ) => Promise<{ readonly withdrawn: boolean }> = async () => ({ withdrawn: true }),
): SessionCollaborationServices {
  return {
    importInvitation: async () => {
      throw new Error('unused');
    },
    cancelImport: async () => 'cancelled',
    readInvitationClipboard: async () => '',
    listMounts: async () => [],
    removeMount: async () => undefined,
    requestTurn: async () => REQUESTS[0],
    getTurnRequests: query,
    acknowledgeTurnRequest: async () => ({ acknowledged: true }),
    withdrawTurnRequest,
    getPendingTurnRequests: async () => [],
    decideTurnRequest: async () => {
      throw new Error('unused');
    },
    createOperationId: () => 'story-turn',
  };
}

let requestQueueRequests = [...REQUESTS];
const requestQueueServices = services(
  async () => ({ canRequestTurns: true, requests: requestQueueRequests }),
  async (_sessionId, requestId) => {
    const current = requestQueueRequests.find(
      (request) => request.requestId === requestId,
    );
    if (current?.state.kind !== 'pending') return { withdrawn: false };
    requestQueueRequests = requestQueueRequests.filter(
      (request) => request.requestId !== requestId,
    );
    return { withdrawn: true };
  },
);

let reconnectQueryCount = 0;
const reconnectServices = services(async () => {
  reconnectQueryCount += 1;
  if (reconnectQueryCount === 1) {
    return { canRequestTurns: true, requests: [] };
  }
  throw new Error('Runtime Host is reconnecting');
});

const meta = {
  title: 'Product/Shared Session Guest',
  component: SessionTurnRequestComposer,
  parameters: { layout: 'fullscreen' },
  decorators: [
    (Story) => (
      <ToastProvider>
        <div
          className="maka-panel maka-panel-detail"
          style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}
        >
          <div className="maka-detail-with-artifacts">
            <div className="mainColumn" style={{ justifyContent: 'flex-end' }}>
              <Story />
            </div>
          </div>
        </div>
      </ToastProvider>
    ),
  ],
} satisfies Meta<typeof SessionTurnRequestComposer>;

export default meta;

type Story = StoryObj<typeof meta>;

// Real path: join a shared Session with Turn-request access. The queue is
// expanded because one active request arrived, and terminal history remains
// dismissible without pushing the composer away from the normal chat layout.
export const RequestQueue: Story = {
  args: { sessionId: SESSION_ID },
  decorators: [
    (Story) => (
      <SessionCollaborationServicesProvider services={requestQueueServices}>
        <Story />
      </SessionCollaborationServicesProvider>
    ),
  ],
};

// Real path: a Guest who already has Turn-request access loses the Runtime
// Host connection. The first projection establishes that access; subsequent
// refreshes fail so the composer exercises its stable reconnecting state.
export const Reconnecting: Story = {
  args: { sessionId: SESSION_ID },
  decorators: [
    (Story) => (
      <SessionCollaborationServicesProvider services={reconnectServices}>
        <Story />
      </SessionCollaborationServicesProvider>
    ),
  ],
};
