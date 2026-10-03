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

import { useMemo, useRef } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, waitFor } from 'storybook/test';
import type { SessionTurnAccessRequest } from '@maka/runtime-host/protocol';
import type { SessionSummary } from '@maka/core/session';
import { ToastProvider, type ComposerHandle } from '@maka/ui';
import { ChatComposerRegion } from '../src/renderer/chat-composer-region';
import {
  GuestTurnRequests,
  SessionCollaborationServicesProvider,
  type SessionCollaborationServices,
} from '../src/renderer/features/session-collaboration/index.js';
import { createFakeSessionCollaborationServices } from '../src/renderer/features/session-collaboration/testing.js';

import {
  ComposerStagingProvider, ComposerStagingServicesProvider, createComposerStagingCommands,
  type ComposerStagingServices,
} from '../src/renderer/features/conversation/index.js';

const stagingServices: ComposerStagingServices = {
  pickFiles: async () => ({ ok: false, reason: 'cancelled' }),
  previewApproval: async () => ({ ok: false, reason: 'unavailable' }),
  readBytes: async () => ({ ok: false, reason: 'not_found' }),
};

const SESSION_ID = 'shared-session-story';
const SHARED_SESSION: SessionSummary = {
  id: SESSION_ID,
  name: '连接恢复方案评审',
  isFlagged: false,
  isArchived: false,
  labels: [],
  hasUnread: false,
  status: 'active',
  lastMessageAt: Date.UTC(2026, 8, 3, 1, 0, 0),
  backend: 'ai-sdk',
  llmConnectionId: 'connection-anthropic-main',
  llmConnectionSlug: 'anthropic-main',
  connectionLocked: false,
  model: 'claude-sonnet-4-5',
  permissionMode: 'ask',
};
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
    ...createFakeSessionCollaborationServices(),
    importInvitation: async () => {
      throw new Error('unused');
    },
    cancelImport: async () => 'cancelled',
    readInvitationClipboard: async () => '',
    listMounts: async () => [],
    subscribeMountChanges: () => () => undefined,
    removeMount: async () => undefined,
    retryMount: async () => undefined,
    renameMount: async () => undefined,
    renamePrincipal: async () => ({ renamed: true }),
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

// The same wiring AppShell mounts: the Guest projection wraps the one
// ChatComposerRegion, which sends Turn requests while the Session is shared.
function GuestComposer(props: { sessionId: string }) {
  const composerRef = useRef<ComposerHandle>(null);
  const stagingCommands = useMemo(createComposerStagingCommands, []);
  return (
    <ComposerStagingServicesProvider services={stagingServices}>
    <ComposerStagingProvider commands={stagingCommands} draftKey={props.sessionId}>
    <GuestTurnRequests sessionId={props.sessionId} composerRef={composerRef}>
      {(guest) => (
        <ChatComposerRegion
          composerRef={composerRef}
          guest={guest}
          active
          onboardingComposerHidden={false}
          activeInteraction={undefined}
          activeSession={SHARED_SESSION}
          activeModel={SHARED_SESSION.model}
          activeModelLabel="Claude Sonnet 4.5"
          activeModelConnectionId={SHARED_SESSION.llmConnectionId}
          modelLabel="Claude Sonnet 4.5"
          activeId={props.sessionId}
          contextUsageSessionId={props.sessionId}
          newTaskDraftKey="new-task:story"
          newTaskSendPending={false}
          stopPending={false}
          respondToSandboxBoundary={() => undefined}
          respondToClientCapability={() => undefined}
          respondToUserQuestion={() => undefined}
          respondToUserForm={() => undefined}
          stop={() => undefined}
          onOpenContextUsage={() => undefined}
          canStageContext={false}
          contextPickEnabled={false}
          directoryPickerEnabled={false}
          onSend={() => false}
          onStop={() => undefined}
        />
      )}
    </GuestTurnRequests>
    </ComposerStagingProvider>
    </ComposerStagingServicesProvider>
  );
}

const meta = {
  title: 'Product/Shared Session Guest',
  component: GuestComposer,
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
} satisfies Meta<typeof GuestComposer>;

export default meta;

type Story = StoryObj<typeof meta>;

// Real path: join a shared Session with Turn-request access. The Guest's
// requests sit in the composer staging drawer as one-line rows: a pending one
// can be withdrawn, a settled one dismissed.
export const RequestQueue: Story = {
  args: { sessionId: SESSION_ID },
  decorators: [
    (Story) => (
      <SessionCollaborationServicesProvider services={requestQueueServices}>
        <Story />
      </SessionCollaborationServicesProvider>
    ),
  ],
  play: async ({ canvasElement }) => {
    await waitFor(() => {
      const rows = [...canvasElement.querySelectorAll('.maka-composer-queue-text')].map((row) => row.textContent);
      expect(rows).toEqual(['请检查这个连接恢复方案，并给出可以直接执行的修复建议。', '重新生成回答']);
    });
    const labels = [...canvasElement.querySelectorAll('.maka-composer-queue-actions button[aria-label]')].map((button) => button.getAttribute('aria-label'));
    await expect(labels).toEqual(['撤回', '关闭']);
  },
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
