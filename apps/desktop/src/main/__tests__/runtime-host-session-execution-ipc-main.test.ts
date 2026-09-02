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

import assert from "node:assert/strict";
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { IpcMain } from "electron";
import { SIDE_CONVERSATION_SESSION_LABEL } from '@maka/core/side-conversation';
import { type AttachmentRef } from '@maka/core/events';
import {
  SESSION_CONTINUITY_SCHEMA_VERSION,
  type SessionCatalogProjection,
} from "@maka/runtime-host/protocol";
import {
  RuntimeHostOperationError,
  RuntimeHostRequestInterruptedError,
} from '@maka/runtime-host/client';
import { createAttachmentApprovalRegistry } from "../attachment-approval.js";
import type { DesktopRuntimeHostSession } from "../runtime-host-client.js";
import {
  registerRuntimeHostSessionExecutionIpc,
  registerRuntimeHostSessionObservationIpc,
  type RuntimeHostSessionExecutionIpcDeps,
} from "../runtime-host-session-execution-ipc-main.js";
import { RuntimeHostSessionObservationRegistry } from '../runtime-host-session-observation-registry.js';
import { RuntimeHostSessionObserver } from "../runtime-host-session-observer.js";
import { runtimeHostSessionFixture } from "./runtime-host-session-test-fixture.js";

test('registers Session observation as one reconnectable operation', () => {
  const ipc = ipcHarness();
  registerRuntimeHostSessionObservationIpc(
    {
      observations: new RuntimeHostSessionObservationRegistry(),
      resolveSideConversation: async () => false,
    },
    ipc,
  );

  assert.equal(ipc.reconnectableChannels.has('sessions:observe'), true);
});

test("keeps synthetic E2E interactions visible through Host hydration and retires their answer", async () => {
  const observer = observerWithSnapshot();
  const ipc = ipcHarness();
  const request = {
    type: "sandbox_boundary_request" as const,
    id: "event-1",
    turnId: "turn-1",
    ts: 1,
    requestId: "request-1",
    toolUseId: "tool-1",
    justification: "Write outside the workspace.",
    expansion: {
      filesystem: {
        entries: [
          { path: "/outside", access: "write" as const, scope: "subtree" as const },
        ],
      },
    },
  };
  let active = true;
  const configurationUpdates: unknown[] = [];
  registerExecutionIpc(
    {
      client: executionClient({
        updateSessionConfiguration: async (sessionId, patch) => {
          configurationUpdates.push({ sessionId, patch });
          return session();
        },
      }),
      observer,
      attachmentApprovals: createAttachmentApprovalRegistry(),
      emitSessionsChanged() {},
      stat: async () => ({ size: 0 }),
      resizeImage: async (bytes) => bytes,
      beforeStop() {},
      e2eInteractions: {
        list: () => (active ? [request] : []),
        respondToSandboxBoundary: async (_sessionId, response) => {
          if (response.requestId !== request.requestId) return { handled: false };
          active = false;
          return { handled: true, permissionMode: 'ask' };
        },
      },
    },
    ipc,
  );

  assert.deepEqual(
    await ipc.invoke("sessions:listActiveInteractions", "session-1"),
    [request],
  );
  await ipc.invoke("sessions:respondToSandboxBoundary", "session-1", {
    requestId: request.requestId,
    decision: "allow",
  });
  assert.deepEqual(
    await ipc.invoke("sessions:listActiveInteractions", "session-1"),
    [],
  );
  assert.deepEqual(configurationUpdates, [
    { sessionId: 'session-1', patch: { permissionMode: 'ask' } },
  ]);
  await observer.close();
});

test('answers a Client Capability approval through the existing Interaction authority', async () => {
  const pending = {
    schemaVersion: 1 as const,
    interactionId: 'capability-1',
    sessionId: 'session-1',
    turnId: 'turn-1',
    runId: 'run-1',
    revision: 1 as const,
    request: {
      kind: 'client_capability' as const,
      toolUseId: 'tool-1',
      target: {
        providerId: 'provider-1',
        contractId: 'contract-1',
        serverId: 'desktop_browser',
        toolName: 'browser_snapshot',
        capability: 'browser' as const,
        scope: { kind: 'browser_origin' as const, origin: 'https://example.com' },
      },
    },
    status: 'pending' as const,
    outcome: null,
  };
  const observer = observerWithSnapshot({
    interactions: { pending: [pending] },
  });
  const answers: unknown[] = [];
  const ipc = ipcHarness();
  registerExecutionIpc(
    {
      client: executionClient({
        answerInteraction: async (input) => {
          answers.push(input);
          return {
            ...pending,
            revision: 2,
            status: 'answered' as const,
            outcome: {
              kind: 'client_capability_decision' as const,
              decision: 'allow' as const,
              committedAt: 2,
            },
          };
        },
      }),
      observer,
    },
    ipc,
  );

  await ipc.invoke('sessions:listActiveInteractions', 'session-1');
  await ipc.invoke('sessions:respondToClientCapability', 'session-1', {
    requestId: 'capability-1',
    decision: 'allow',
  });
  assert.deepEqual(answers, [
    {
      sessionId: 'session-1',
      interactionId: 'capability-1',
      answer: { kind: 'client_capability', decision: 'allow' },
    },
  ]);
  await observer.close();
});

test("retries committed Branch and Revision copies with the renderer-owned identity", async () => {
  const committed = new Map<string, SessionCatalogProjection>();
  const lostResponses = new Set(["branch-copy-1", "revision-copy-1"]);
  const calls: Array<{
    kind: "branch" | "revision";
    targetSessionId: string;
    sourceTurnId: string;
  }> = [];
  let fallbackIds = 0;
  const ipc = ipcHarness();
  registerExecutionIpc(
    {
      client: executionClient({
        copySession: async (kind, input) => {
          calls.push({
            kind,
            targetSessionId: input.targetSessionId,
            sourceTurnId: input.sourceTurnId,
          });
          let copy = committed.get(input.targetSessionId);
          if (!copy) {
            copy = {
              ...session(),
              id: input.targetSessionId,
              name: input.targetSessionId,
            };
            committed.set(input.targetSessionId, copy);
          }
          if (lostResponses.delete(input.targetSessionId)) {
            throw new Error("Committed response was lost");
          }
          return copy;
        },
      }),
      observer: unusedObserver(),
      attachmentApprovals: createAttachmentApprovalRegistry(),
      emitSessionsChanged() {},
      stat: async () => ({ size: 0 }),
      resizeImage: async (bytes) => bytes,
      beforeStop() {},
      newId: () => `fallback-${++fallbackIds}`,
    },
    ipc,
  );

  for (const input of [
    {
      channel: "sessions:branchFromTurn",
      copyId: "branch-copy-1",
      sourceTurnId: "branch-source-turn",
    },
    {
      channel: "sessions:reviseBeforeTurn",
      copyId: "revision-copy-1",
      sourceTurnId: "revision-source-turn",
    },
  ] as const) {
    await assert.rejects(
      ipc.invoke(input.channel, "source-session", {
        sourceTurnId: input.sourceTurnId,
        copyId: input.copyId,
      }),
      /response was lost/,
    );
    const retried = (await ipc.invoke(input.channel, "source-session", {
      sourceTurnId: input.sourceTurnId,
      copyId: input.copyId,
    })) as { id: string };
    assert.equal(retried.id, input.copyId);
  }

  assert.deepEqual(calls, [
    { kind: "branch", targetSessionId: "branch-copy-1", sourceTurnId: "branch-source-turn" },
    { kind: "branch", targetSessionId: "branch-copy-1", sourceTurnId: "branch-source-turn" },
    {
      kind: "revision",
      targetSessionId: "revision-copy-1",
      sourceTurnId: "revision-source-turn",
    },
    {
      kind: "revision",
      targetSessionId: "revision-copy-1",
      sourceTurnId: "revision-source-turn",
    },
  ]);
  assert.equal(committed.size, 2);
  assert.equal(fallbackIds, 0);

  const newBranch = (await ipc.invoke("sessions:branchFromTurn", "source-session", {
    sourceTurnId: "branch-source-turn",
    copyId: "branch-copy-2",
  })) as { id: string };
  assert.equal(newBranch.id, "branch-copy-2");
  assert.equal(committed.size, 3);
});

test("sends Side Conversation intent and metadata atomically to Runtime Host", async () => {
  const copyInputs: unknown[] = [];
  const metadataUpdates: unknown[] = [];
  const abandonedOwners: string[] = [];
  const backgroundErrors: unknown[] = [];
  const ipc = ipcHarness();
  const sessionCopyCleanup = {
    ownCreation: <T>(_creation: unknown, operation: () => Promise<T>) => operation(),
    async rejectCreation() {},
    async cleanup() {},
    async schedule() {},
    async abandonOwner(ownerId: string) {
      abandonedOwners.push(ownerId);
      throw new Error('cleanup unavailable');
    },
    async recover() {
      return { removed: [], failed: [] };
    },
  };
  registerExecutionIpc(
    {
      client: executionClient({
        copySession: async (_kind, input) => {
          copyInputs.push(input);
          return {
            ...session(),
            id: input.targetSessionId,
            labels: ["source-label", SIDE_CONVERSATION_SESSION_LABEL],
          };
        },
        updateSessionMetadata: async (sessionId, patch) => {
          metadataUpdates.push({ sessionId, patch });
          return {
            ...session(),
            id: sessionId,
            labels: patch.labels ?? ['source-label', SIDE_CONVERSATION_SESSION_LABEL],
          };
        },
      }),
      observer: unusedObserver(),
      attachmentApprovals: createAttachmentApprovalRegistry(),
      emitSessionsChanged() {},
      stat: async () => ({ size: 0 }),
      resizeImage: async (bytes) => bytes,
      beforeStop() {},
      sessionCopyCleanup,
      onBackgroundError: (error) => backgroundErrors.push(error),
    },
    ipc,
  );

  const branchResult = (await ipc.invoke("sessions:branchFromTurn", "source-session", {
    sourceTurnId: "source-turn",
    copyId: "side-copy",
    name: "Side chat",
    sideConversation: true,
  })) as { ok: true; session: { labels: string[] } };

  assert.deepEqual(copyInputs, [
    {
      sourceSessionId: 'source-session',
      targetSessionId: 'side-copy',
      sourceTurnId: 'source-turn',
      intent: 'side_conversation',
    },
  ]);
  assert.deepEqual(metadataUpdates, [
    { sessionId: 'side-copy', patch: { name: 'Side chat' } },
  ]);
  assert.equal(branchResult.ok, true);
  assert.deepEqual(branchResult.session.labels, [
    "source-label",
    SIDE_CONVERSATION_SESSION_LABEL,
  ]);
  ipc.rendererGone();
  ipc.rendererDestroyed();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(abandonedOwners, ['web-contents:9']);
  assert.deepEqual(backgroundErrors.map((error) => (error as Error).message), [
    'cleanup unavailable',
  ]);
});

test('returns structured Side Conversation setup failures across IPC', async () => {
  for (const reason of ['session_busy', 'operation_unavailable'] as const) {
    const ipc = ipcHarness();
    const rejectedCreations: string[] = [];
    registerExecutionIpc(
      {
        client: executionClient({
          copySession: async () => {
            throw new RuntimeHostOperationError(
              'session.branch.create',
              reason,
              'Side Conversation setup failed',
            );
          },
        }),
        observer: unusedObserver(),
        attachmentApprovals: createAttachmentApprovalRegistry(),
        emitSessionsChanged() {},
        stat: async () => ({ size: 0 }),
        resizeImage: async (bytes) => bytes,
        beforeStop() {},
        newId: () => 'id-1',
        sessionCopyCleanup: {
          ...unusedSessionCopyCleanup(),
          async rejectCreation(sessionId) {
            rejectedCreations.push(sessionId);
          },
        },
      },
      ipc,
    );

    assert.deepEqual(
      await ipc.invoke('sessions:branchFromTurn', 'source-session', {
        sourceTurnId: 'source-turn',
        copyId: `side-copy-${reason}`,
        sideConversation: true,
      }),
      { ok: false, reason },
    );
    assert.deepEqual(rejectedCreations, [`side-copy-${reason}`]);
  }
});

test("sends canonical content and uploads owned Attachment bytes through the Host", async () => {
  const starts: unknown[] = [];
  const uploads: unknown[] = [];
  const changes: unknown[] = [];
  const attachment: AttachmentRef = {
    kind: "other",
    name: "notes.txt",
    mimeType: "text/plain",
    bytes: 5,
    ref: {
      kind: "session_file",
      sessionId: "session-1",
      relativePath: "artifact-1",
    },
  };
  const client = executionClient({
    getSession: async () => session(),
    ingestAttachment: async (input) => {
      uploads.push(input);
      return attachment;
    },
    submitMessage: async (input) => {
      starts.push(input);
      return {
        disposition: "turn_started",
        turnId: "turn-1",
        skillInvocation: { loaded: [], failed: [], receipts: [] },
      };
    },
  });
  const ipc = ipcHarness();
  registerExecutionIpc(
    {
      client,
      observer: unusedObserver(),
      attachmentApprovals: createAttachmentApprovalRegistry(),
      emitSessionsChanged: (reason, sessionId, extra) =>
        changes.push({ reason, sessionId, ...extra }),
      stat: async () => ({ size: 0 }),
      resizeImage: async (bytes) => bytes,
      beforeStop() {},
      newId: () => "turn-1",
    },
    ipc,
  );

  const result = await ipc.invoke("sessions:send", "session-1", {
    type: "send",
    text: "Read @notes.txt",
    attachmentItems: [
      {
        name: "notes.txt",
        mimeType: "text/plain",
        base64: Buffer.from("hello").toString("base64"),
      },
    ],
    workspaceFileReferences: [{ value: "@notes.txt", start: 5 }],
  });

  assert.equal((uploads[0] as { content: Uint8Array }).content.byteLength, 5);
  assert.deepEqual(starts, [
    {
      sessionId: "session-1",
      messageId: "turn-1",
      placement: "current_turn",
      content: {
        text: "Read @notes.txt",
        attachments: [attachment],
        inlineReferences: [
          {
            kind: "workspace_file",
            value: "@notes.txt",
            start: 5,
            label: "notes.txt",
          },
        ],
      },
    },
  ]);
  assert.deepEqual(result, {
    ok: true,
    turnId: "turn-1",
    attachments: [attachment],
    inlineReferences: [
      {
        kind: "workspace_file",
        value: "@notes.txt",
        start: 5,
        label: "notes.txt",
      },
    ],
    skillInvocation: { loaded: [], failed: [], receipts: [] },
  });
  assert.deepEqual(changes, [
    { reason: "status-change", sessionId: "session-1", turnId: "turn-1" },
  ]);
});

test("uploads a selected workspace file as a Host-owned Session Artifact", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "maka-host-attachment-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const path = join(cwd, "notes.txt");
  await writeFile(path, "hello");
  const approvals = createAttachmentApprovalRegistry();
  const [approved] = approvals.issueApprovals(9, [
    { path, name: "notes.txt", mimeType: "text/plain", size: 5 },
  ]);
  assert.ok(approved);
  const uploads: Array<{ content: Uint8Array }> = [];
  const starts: unknown[] = [];
  const attachment: AttachmentRef = {
    kind: "other",
    name: "notes.txt",
    mimeType: "text/plain",
    bytes: 5,
    ref: {
      kind: "session_file",
      sessionId: "session-1",
      relativePath: "artifact-1",
    },
  };
  const ipc = ipcHarness();
  registerExecutionIpc(
    {
      client: executionClient({
        getSession: async () => session(cwd),
        ingestAttachment: async (input) => {
          uploads.push(input);
          return attachment;
        },
        submitMessage: async (input) => {
          starts.push(input);
          return {
            disposition: "turn_started",
            turnId: "turn-1",
            skillInvocation: { loaded: [], failed: [], receipts: [] },
          };
        },
      }),
      observer: unusedObserver(),
      attachmentApprovals: approvals,
      emitSessionsChanged() {},
      stat: async () => ({ size: 5 }),
      resizeImage: async (bytes) => bytes,
      beforeStop() {},
      newId: () => "turn-1",
    },
    ipc,
  );

  await ipc.invoke("sessions:send", "session-1", {
    type: "send",
    text: "Read the attachment",
    attachmentItems: [approved],
  });

  assert.equal(
    Buffer.from(uploads[0]?.content ?? []).toString("utf8"),
    "hello",
  );
  assert.deepEqual(
    (starts[0] as { content: { attachments: AttachmentRef[] } }).content
      .attachments,
    [attachment],
  );
});

test("forwards explicit Skill invocation to the Host-owned Turn admission", async () => {
  const starts: unknown[] = [];
  const ipc = ipcHarness();
  registerExecutionIpc(
    {
      client: executionClient({
        getSession: async () => session(),
        submitMessage: async (input) => {
          starts.push(input);
          return {
            disposition: "turn_started",
            turnId: "turn-skill",
            skillInvocation: {
              loaded: [{ id: "review", name: "Review" }],
              failed: [],
              receipts: [],
            },
          };
        },
      }),
      observer: unusedObserver(),
      attachmentApprovals: createAttachmentApprovalRegistry(),
      emitSessionsChanged() {},
      stat: async () => ({ size: 0 }),
      resizeImage: async (bytes) => bytes,
      beforeStop() {},
      newId: () => "turn-skill",
    },
    ipc,
  );

  const result = await ipc.invoke("sessions:send", "session-1", {
    type: "send",
    text: "",
    displayText: "/skill:review",
    skillIds: ["review"],
  });

  assert.deepEqual(starts, [
    {
      sessionId: "session-1",
      messageId: "turn-skill",
      placement: "current_turn",
      content: { text: "", displayText: "/skill:review", inlineReferences: [] },
      skillIds: ["review"],
    },
  ]);
  assert.deepEqual(result, {
    ok: true,
    turnId: "turn-skill",
    attachments: [],
    inlineReferences: [],
    skillInvocation: {
      loaded: [{ id: "review", name: "Review" }],
      failed: [],
      receipts: [],
    },
  });
});

test("submits an ordinary composer message once under its stable message identity", async () => {
  const submits: unknown[] = [];
  const ipc = ipcHarness();
  registerExecutionIpc(
    {
      client: executionClient({
        getSession: async () => session(),
        submitMessage: async (input) => {
          submits.push(input);
          return {
            disposition: "turn_started",
            turnId: "host-turn",
            skillInvocation: { loaded: [], failed: [], receipts: [] },
          };
        },
      }),
      observer: unusedObserver(),
      attachmentApprovals: createAttachmentApprovalRegistry(),
      emitSessionsChanged() {},
      stat: async () => ({ size: 0 }),
      resizeImage: async (bytes) => bytes,
      beforeStop() {},
      newId: () => "unexpected-generated-id",
    },
    ipc,
  );

  const result = await ipc.invoke("sessions:submitMessage", "session-1", "current_turn", {
    messageId: "message-1",
    text: "check the projection",
  });

  assert.deepEqual(submits, [
    {
      sessionId: "session-1",
      messageId: "message-1",
      content: {
        text: "check the projection",
        inlineReferences: [],
      },
      placement: "current_turn",
    },
  ]);
  assert.deepEqual(result, {
    ok: true,
    disposition: "turn_started",
    turnId: "host-turn",
    attachments: [],
    inlineReferences: [],
    skillInvocation: { loaded: [], failed: [], receipts: [] },
  });
});

test('returns Host-owned cancellation proof to the renderer', async () => {
  const ipc = ipcHarness();
  registerExecutionIpc(
    {
      client: executionClient({
        queryMessages: async (input) => ({
          cancelledMessageIds: input.messageIds.filter(
            (messageId) => messageId === 'message-cancelled',
          ),
        }),
      }),
    },
    ipc,
  );

  assert.deepEqual(
    await ipc.invoke('sessions:queryCancelledMessages', 'session-1', [
      'message-accepted',
      'message-cancelled',
    ]),
    { cancelledMessageIds: ['message-cancelled'] },
  );
});

test('returns Host-owned Message execution resolutions to the renderer', async () => {
  const ipc = ipcHarness();
  registerExecutionIpc(
    {
      client: executionClient({
        queryMessageExecutions: async (input) => ({
          resolutions: input.messageIds.map((messageId) => messageId === 'message-cancelled'
            ? { messageId, state: 'cancelled' as const }
            : {
                messageId,
                state: 'owned' as const,
                turnId: 'successor-turn',
                runId: 'successor-run',
              }),
        }),
      }),
    },
    ipc,
  );

  assert.deepEqual(
    await ipc.invoke('sessions:queryMessageExecutions', 'session-1', [
      'message-delegated',
      'message-cancelled',
    ]),
    {
      resolutions: [
        {
          messageId: 'message-delegated',
          state: 'owned',
          turnId: 'successor-turn',
          runId: 'successor-run',
        },
        { messageId: 'message-cancelled', state: 'cancelled' },
      ],
    },
  );
});

test('submits a slash Skill message and reports the Host Skill outcome', async () => {
  const submits: unknown[] = [];
  const ipc = ipcHarness();
  registerExecutionIpc(
    {
      client: executionClient({
        getSession: async () => session(),
        submitMessage: async (input) => {
          submits.push(input);
          return {
            disposition: 'blocked',
            skillInvocation: {
              loaded: [],
              failed: [{ request: 'missing', reason: 'not_found' }],
              receipts: [],
            },
          };
        },
      }),
      newId: () => 'unexpected-generated-id',
    },
    ipc,
  );

  const result = await ipc.invoke('sessions:submitMessage', 'session-1', 'current_turn', {
    messageId: 'message-skill',
    text: '/skill:missing inspect this',
  });

  assert.deepEqual(submits, [{
    sessionId: 'session-1',
    messageId: 'message-skill',
    placement: 'current_turn',
    content: { text: '/skill:missing inspect this', inlineReferences: [] },
  }]);
  assert.deepEqual(result, {
    ok: false,
    reason: 'skill_invocation_failed',
    skillInvocation: {
      loaded: [],
      failed: [{ request: 'missing', reason: 'not_found' }],
      receipts: [],
    },
  });
});

test("queues a mid-turn send as steering when the Host reports the session busy", async () => {
  const submits: unknown[] = [];
  const changes: unknown[] = [];
  const skillInvocation = {
    loaded: [{ id: 'review', name: 'Review' }],
    failed: [{ request: 'typo', reason: 'not_found' as const }],
    receipts: [],
  };
  const ipc = ipcHarness();
  registerExecutionIpc(
    {
      client: executionClient({
        getSession: async () => session(),
        submitMessage: async (input) => {
          submits.push(input);
          return { disposition: "steering", queueRevision: 1, skillInvocation };
        },
      }),
      observer: unusedObserver(),
      attachmentApprovals: createAttachmentApprovalRegistry(),
      emitSessionsChanged: (reason, sessionId, extra) =>
        changes.push({ reason, sessionId, ...extra }),
      stat: async () => ({ size: 0 }),
      resizeImage: async (bytes) => bytes,
      beforeStop() {},
      newId: () => "id-1",
    },
    ipc,
  );

  const result = await ipc.invoke("sessions:send", "session-1", {
    type: "send",
    turnId: "turn-1",
    text: "also check the tests",
  });

  assert.deepEqual(submits, [
    {
      sessionId: "session-1",
      messageId: "turn-1",
      content: { text: "also check the tests", inlineReferences: [] },
      placement: "current_turn",
    },
  ]);
  assert.deepEqual(result, {
    ok: true,
    steered: true,
    turnId: "turn-1",
    attachments: [],
    inlineReferences: [],
    skillInvocation,
  });
  assert.deepEqual(changes, [
    { reason: "status-change", sessionId: "session-1" },
  ]);
});

test("resolves a twice-interrupted send as an unknown outcome", async () => {
  let submits = 0;
  let sessionQueries = 0;
  const ipc = ipcHarness();
  registerExecutionIpc(
    {
      client: executionClient({
        getSession: async () => {
          sessionQueries += 1;
          return session();
        },
        submitMessage: async () => {
          submits += 1;
          throw new RuntimeHostRequestInterruptedError(
            "turn.message.submit",
            "command",
            "dispatched",
            "connection_lost",
          );
        },
      }),
      newId: () => "turn-1",
    },
    ipc,
  );

  // The Message identity is stable, so one retry is safe; a second lost answer
  // is still an outcome the renderer must not resolve on its own.
  assert.deepEqual(
    await ipc.invoke("sessions:send", "session-1", {
      type: "send",
      text: "preserve the ordinary send contract",
    }),
    {
      ok: false,
      reason: "outcome_unknown",
      messageId: "turn-1",
      skillInvocation: { loaded: [], failed: [], receipts: [] },
    },
  );
  assert.equal(submits, 2);
  assert.equal(sessionQueries, 2, "initial Session lookup plus reconnect probe");
});

test("retries a dispatched send with its original message identity", async () => {
  const submits: unknown[] = [];
  let reconnectQueries = 0;
  const ipc = ipcHarness();
  registerExecutionIpc(
    {
      client: executionClient({
        getSession: async (sessionId) => {
          reconnectQueries += 1;
          return sessionId === 'side-session'
            ? sideConversationSession(sessionId)
            : session();
        },
        submitMessage: async (input) => {
          submits.push(input);
          if (
            input.messageId === "turn-unknown" ||
            input.content.text === "ordinary chat keeps the existing failure contract"
          ) {
            throw new RuntimeHostOperationError(
              "turn.message.submit",
              "outcome_unknown",
              "Message disposition cannot be proven in this Host Epoch",
            );
          }
          if (submits.length === 1) {
            throw new RuntimeHostRequestInterruptedError(
              "turn.message.submit",
              "command",
              "dispatched",
              "connection_lost",
            );
          }
          return {
            disposition: "steering",
            queueRevision: 1,
            skillInvocation: { loaded: [], failed: [], receipts: [] },
          };
        },
      }),
      newId: () => "id-1",
    },
    ipc,
  );

  const result = await ipc.invoke("sessions:send", "side-session", {
    type: "send",
    turnId: "turn-1",
    text: "keep this message identity",
  });

  assert.equal(reconnectQueries, 2, 'initial Session lookup plus reconnect probe');
  assert.deepEqual(submits, [
    {
      sessionId: "side-session",
      messageId: "turn-1",
      content: { text: "keep this message identity", inlineReferences: [] },
      placement: "current_turn",
    },
    {
      sessionId: "side-session",
      messageId: "turn-1",
      content: { text: "keep this message identity", inlineReferences: [] },
      placement: "current_turn",
    },
  ]);
  assert.deepEqual(result, {
    ok: true,
    steered: true,
    turnId: "turn-1",
    messageId: "turn-1",
    attachments: [],
    inlineReferences: [],
    skillInvocation: { loaded: [], failed: [], receipts: [] },
  });
  assert.deepEqual(
    await ipc.invoke("sessions:send", "session-1", {
      type: "send",
      turnId: "turn-unknown",
      text: "ordinary chat keeps the existing failure contract",
    }),
    {
      ok: false,
      reason: "outcome_unknown",
      messageId: "turn-unknown",
      skillInvocation: { loaded: [], failed: [], receipts: [] },
    },
  );
  assert.deepEqual(
    await ipc.invoke("sessions:send", "side-session", {
      type: "send",
      turnId: "turn-unknown",
      text: "keep waiting for the Host outcome",
    }),
    {
      ok: false,
      reason: "outcome_unknown",
      messageId: "turn-unknown",
      skillInvocation: { loaded: [], failed: [], receipts: [] },
    },
  );
});

test("answers a send with the Turn the Host started for it", async () => {
  const changes: unknown[] = [];
  const submits: unknown[] = [];
  const ipc = ipcHarness();
  registerExecutionIpc(
    {
      client: executionClient({
        getSession: async () => session(),
        submitMessage: async (input) => {
          submits.push(input);
          return {
            disposition: "turn_started",
            turnId: "turn-9",
            skillInvocation: { loaded: [], failed: [], receipts: [] },
          };
        },
      }),
      observer: unusedObserver(),
      attachmentApprovals: createAttachmentApprovalRegistry(),
      emitSessionsChanged: (reason, sessionId, extra) =>
        changes.push({ reason, sessionId, ...extra }),
      stat: async () => ({ size: 0 }),
      resizeImage: async (bytes) => bytes,
      beforeStop() {},
      newId: () => "id-1",
    },
    ipc,
  );

  const result = await ipc.invoke("sessions:send", "session-1", {
    type: "send",
    turnId: "turn-1",
    text: "also check the tests",
  });

  assert.deepEqual(result, {
    ok: true,
    turnId: "turn-9",
    attachments: [],
    inlineReferences: [],
    skillInvocation: { loaded: [], failed: [], receipts: [] },
  });
  assert.deepEqual(submits, [{
    sessionId: "session-1",
    messageId: "turn-1",
    content: { text: "also check the tests", inlineReferences: [] },
    placement: "current_turn",
  }]);
  assert.deepEqual(changes, [
    { reason: "status-change", sessionId: "session-1", turnId: "turn-9" },
  ]);
});

test("propagates a busy explicit Skill send instead of degrading it to steering", async () => {
  const submits: unknown[] = [];
  const ipc = ipcHarness();
  registerExecutionIpc(
    {
      client: executionClient({
        getSession: async () => session(),
        submitMessage: async (input) => {
          submits.push(input);
          throw new RuntimeHostOperationError(
            "turn.message.submit",
            "session_busy",
            "Session already has an active root Turn",
          );
        },
      }),
      newId: () => "id-1",
    },
    ipc,
  );

  // Explicit skillIds are exact-Turn intent, so the Host refuses on a busy
  // Session. The Desktop no longer carves that case out — it just reports it.
  await assert.rejects(
    ipc.invoke("sessions:send", "session-1", {
      type: "send",
      turnId: "turn-1",
      text: "",
      displayText: "/skill:review",
      skillIds: ["review"],
    }),
    (error: unknown) =>
      error instanceof RuntimeHostOperationError && error.code === "session_busy",
  );
  assert.deepEqual(submits, [
    {
      sessionId: "session-1",
      messageId: "turn-1",
      placement: "current_turn",
      content: {
        text: "",
        displayText: "/skill:review",
        inlineReferences: [],
      },
      skillIds: ["review"],
    },
  ]);
});

test("lets the Host queue a textual Skill token as steering", async () => {
  const submits: unknown[] = [];
  const ipc = ipcHarness();
  registerExecutionIpc(
    {
      client: executionClient({
        getSession: async () => session(),
        submitMessage: async (input) => {
          submits.push(input);
          return {
            disposition: "steering",
            queueRevision: 1,
            skillInvocation: { loaded: [], failed: [], receipts: [] },
          };
        },
      }),
      newId: () => "id-1",
    },
    ipc,
  );

  // A `/skill:` token in the text is not exact-Turn intent: Host message
  // preparation expands it on the queued path too. The Desktop stopped
  // sniffing content for it, so this send is reported as the steering the
  // Host made of it.
  assert.deepEqual(
    await ipc.invoke("sessions:send", "session-1", {
      type: "send",
      turnId: "turn-1",
      text: "/skill:review explain the tests",
    }),
    {
      ok: true,
      steered: true,
      turnId: "turn-1",
      attachments: [],
      inlineReferences: [],
      skillInvocation: { loaded: [], failed: [], receipts: [] },
    },
  );
  assert.equal(submits.length, 1);
});

test("reports a Host-blocked Skill send as a Skill failure", async () => {
  const ipc = ipcHarness();
  registerExecutionIpc(
    {
      client: executionClient({
        getSession: async () => session(),
        submitMessage: async () => ({
          disposition: "blocked",
          skillInvocation: {
            loaded: [],
            failed: [{ request: "missing", reason: "not_found" }],
            receipts: [],
          },
        }),
      }),
      newId: () => "id-1",
    },
    ipc,
  );

  assert.deepEqual(
    await ipc.invoke("sessions:send", "session-1", {
      type: "send",
      turnId: "turn-1",
      text: "/skill:missing inspect this",
    }),
    {
      ok: false,
      reason: "skill_invocation_failed",
      skillInvocation: {
        loaded: [],
        failed: [{ request: "missing", reason: "not_found" }],
        receipts: [],
      },
    },
  );
});

test("queues explicit Desktop follow-ups", async () => {
  const submits: unknown[] = [];
  let sequence = 0;
  const skillInvocation = {
    loaded: [{ id: 'writer', name: 'Writer' }],
    failed: [{ request: 'missing', reason: 'not_found' as const }],
    receipts: [],
  };
  const ipc = ipcHarness();
  registerExecutionIpc(
    {
      client: executionClient({
        getSession: async () => session(),
        submitMessage: async (input) => {
          submits.push(input);
          return { disposition: "followup", queueRevision: 4, skillInvocation };
        },
      }),
      observer: unusedObserver(),
      attachmentApprovals: createAttachmentApprovalRegistry(),
      emitSessionsChanged() {},
      stat: async () => ({ size: 0 }),
      resizeImage: async (bytes) => bytes,
      beforeStop() {},
      newId: () => `id-${++sequence}`,
    },
    ipc,
  );

  assert.deepEqual(
    await ipc.invoke("sessions:submitMessage", "session-1", "next_turn", {
      messageId: "followup-message",
      text: "do this next",
      quotes: [{ text: "quoted context" }],
      retainedAttachments: [
        {
          kind: "other",
          name: "notes.txt",
          mimeType: "text/plain",
          bytes: 5,
          ref: {
            kind: "session_file",
            sessionId: "session-1",
            relativePath: "attachments/notes.txt",
          },
        },
      ],
    }),
    {
      ok: true,
      disposition: "followup",
      attachments: [
        {
          kind: "other",
          name: "notes.txt",
          mimeType: "text/plain",
          bytes: 5,
          ref: {
            kind: "session_file",
            sessionId: "session-1",
            relativePath: "attachments/notes.txt",
          },
        },
      ],
      inlineReferences: [],
      skillInvocation,
    },
  );
  assert.deepEqual(submits, [
    {
      sessionId: "session-1",
      messageId: "followup-message",
      content: {
        text: "do this next",
        attachments: [
          {
            kind: "other",
            name: "notes.txt",
            mimeType: "text/plain",
            bytes: 5,
            ref: {
              kind: "session_file",
              sessionId: "session-1",
              relativePath: "attachments/notes.txt",
            },
          },
        ],
        quotes: [{ text: "quoted context" }],
        inlineReferences: [],
      },
      placement: "next_turn",
    },
  ]);
});

test('keeps an unknown Desktop follow-up admission available for reconciliation', async () => {
  const ipc = ipcHarness();
  registerExecutionIpc(
    {
      client: executionClient({
        getSession: async () => session(),
        submitMessage: async () => {
          throw new RuntimeHostOperationError(
            'turn.message.submit',
            'outcome_unknown',
            'Message disposition cannot be proven in this Host Epoch',
          );
        },
      }),
      observer: unusedObserver(),
      attachmentApprovals: createAttachmentApprovalRegistry(),
      emitSessionsChanged() {},
      stat: async () => ({ size: 0 }),
      resizeImage: async (bytes) => bytes,
      beforeStop() {},
    },
    ipc,
  );

  assert.deepEqual(
    await ipc.invoke('sessions:submitMessage', 'session-1', 'next_turn', {
      messageId: 'followup-unknown',
      text: 'keep this visible',
    }),
    { ok: false, reason: 'outcome_unknown' },
  );
});

test("routes per-entry queue mutations to the Runtime Host", async () => {
  const calls: unknown[] = [];
  let sequence = 0;
  const ipc = ipcHarness();
  registerExecutionIpc(
    {
      client: executionClient({
        retractQueueEntry: async (input) => {
          calls.push({ operation: "retract", ...input });
          return { queueRevision: 3 };
        },
        promoteQueueEntry: async (input) => {
          calls.push({ operation: "promote", ...input });
          return { queueRevision: 4 };
        },
        updateQueueEntry: async (input) => {
          calls.push({ operation: "update", ...input });
          return { queueRevision: 5 };
        },
        reorderQueueEntries: async (input) => {
          calls.push({ operation: "reorder", ...input });
          return { queueRevision: 6 };
        },
      }),
      observer: unusedObserver(),
      attachmentApprovals: createAttachmentApprovalRegistry(),
      emitSessionsChanged() {},
      stat: async () => ({ size: 0 }),
      resizeImage: async (bytes) => bytes,
      beforeStop() {},
      newId: () => `id-${++sequence}`,
    },
    ipc,
  );

  assert.equal(await ipc.invoke("sessions:retractQueueEntry", "session-1", "entry-1"), undefined);
  await ipc.invoke("sessions:promoteQueueEntry", "session-1", "entry-2");
  await ipc.invoke(
    "sessions:updateQueueEntry",
    "session-1",
    "entry-2",
    4,
    " revised ",
  );
  await ipc.invoke("sessions:reorderQueueEntries", "session-1", ["entry-3", "entry-2"]);

  assert.deepEqual(calls, [
    {
      operation: "retract",
      sessionId: "session-1",
      entryId: "entry-1",
      retractId: "id-1",
    },
    {
      operation: "promote",
      sessionId: "session-1",
      entryId: "entry-2",
      promoteId: "id-2",
    },
    {
      operation: "update",
      sessionId: "session-1",
      entryId: "entry-2",
      updateId: "id-3",
      expectedQueueRevision: 4,
      text: "revised",
    },
    {
      operation: "reorder",
      sessionId: "session-1",
      reorderId: "id-4",
      entryIds: ["entry-3", "entry-2"],
    },
  ]);

  await assert.rejects(
    () => ipc.invoke("sessions:updateQueueEntry", "session-1", "entry-1", 4, " "),
    /Invalid Queued message text/,
  );
  await assert.rejects(
    () => ipc.invoke("sessions:promoteQueueEntry", "session-1", 42),
    /Invalid queue entry identity/,
  );
  await assert.rejects(
    () => ipc.invoke("sessions:reorderQueueEntries", "session-1", ["entry-1", 42]),
    /Invalid queue entry order/,
  );
});

test("binds steer and stop to Host-owned queue and active Turn identities", async () => {
  const submits: unknown[] = [];
  const interrupts: unknown[] = [];
  const retractions: unknown[] = [];
  const stopLifecycle: string[] = [];
  let sequence = 0;
  const client = executionClient({
    getSession: async () => sideConversationSession(),
    submitMessage: async (input) => {
      submits.push(input);
      if (input.messageId === 'unknown-ticket') {
        throw new RuntimeHostOperationError(
          'turn.message.submit',
          'outcome_unknown',
          'Message disposition cannot be proven in this Host Epoch',
        );
      }
      return {
        disposition: "steering",
        queueRevision: 2,
        skillInvocation: { loaded: [], failed: [], receipts: [] },
      };
    },
    interruptTurn: async (input) => {
      stopLifecycle.push("interrupt");
      interrupts.push(input);
      return {
        queueRevision: 3,
        retracted: [{
          entryId: 'entry-followup',
          messageId: 'message-followup',
          content: { text: 'Do this next' },
          placement: 'next_turn',
          state: 'retracted',
        }],
        turn: {
          sessionId: input.sessionId,
          turnId: input.turnId,
          runId: input.runId,
          status: "cancelled",
          terminalEventId: "terminal-1",
          abortSource: "user",
        },
      };
    },
    retractQueueEntry: async (input) => {
      retractions.push(input);
      if (retractions.length === 1) {
        throw new RuntimeHostRequestInterruptedError(
          'queue.retract',
          'command',
          'dispatched',
          'connection_lost',
        );
      }
      return { queueRevision: 3 };
    },
  });
  const observer = observerWithSnapshot({
    queue: {
      hostEpoch: 'host-1',
      queueRevision: 2,
      steering: [
        {
          entryId: 'entry-1',
          messageId: 'steer-ticket-1',
          content: { text: 'Continue' },
          placement: 'current_turn',
          state: 'queued',
        },
        {
          entryId: 'entry-2',
          messageId: 'in-flight-ticket',
          content: { text: 'Already accepted' },
          placement: 'current_turn',
          state: 'in_flight',
        },
      ],
      followup: [],
    },
  });
  const ipc = ipcHarness();
  registerExecutionIpc(
    {
      client,
      observer,
      beforeStop() {
        stopLifecycle.push("teardown");
      },
      newId: () => `id-${++sequence}`,
    },
    ipc,
  );

  assert.deepEqual(
    await ipc.invoke("sessions:submitMessage", "session-1", "current_turn", {
      messageId: "steer-ticket-1",
      text: "Continue",
    }),
    {
      ok: true,
      disposition: "steering",
      attachments: [],
      inlineReferences: [],
      skillInvocation: { loaded: [], failed: [], receipts: [] },
    },
  );
  assert.deepEqual(
    await ipc.invoke('sessions:submitMessage', 'session-1', 'current_turn', {
      messageId: 'unknown-ticket',
      text: 'Continue',
    }),
    { ok: false, reason: 'outcome_unknown' },
  );
  assert.deepEqual(
    await ipc.invoke("sessions:stop", "session-1", {
      source: "stop_button",
      expectedAdmissionId: "steer-ticket-1",
    }),
    { kind: 'retracted', messageId: 'steer-ticket-1' },
  );
  assert.deepEqual(retractions, [
    {
      sessionId: 'session-1',
      entryId: 'entry-1',
      retractId: 'id-1',
    },
    {
      sessionId: 'session-1',
      entryId: 'entry-1',
      retractId: 'id-1',
    },
  ]);
  assert.deepEqual(stopLifecycle, []);
  await assert.rejects(
    () =>
      ipc.invoke('sessions:stop', 'session-1', {
        source: 'stop_button',
        expectedAdmissionId: 'in-flight-ticket',
      }),
    /Host admission outcome is unknown/,
  );
  assert.deepEqual(stopLifecycle, []);
  await ipc.invoke("sessions:stop", "session-1", {
    source: "stop_button",
    expectedTurnId: "turn-unrelated",
  });
  assert.deepEqual(stopLifecycle, []);
  assert.deepEqual(await ipc.invoke("sessions:stop", "session-1", {
    source: "stop_button",
    expectedTurnId: "turn-1",
  }), { kind: 'interrupted', retractedMessageIds: ['message-followup'] });
  assert.deepEqual(stopLifecycle, [
    'teardown',
    'interrupt',
  ]);

  assert.deepEqual(submits, [
    {
      sessionId: "session-1",
      messageId: "steer-ticket-1",
      content: { text: "Continue", inlineReferences: [] },
      placement: "current_turn",
    },
    {
      sessionId: 'session-1',
      messageId: 'unknown-ticket',
      content: { text: 'Continue', inlineReferences: [] },
      placement: 'current_turn',
    },
  ]);
  assert.deepEqual(interrupts, [
    {
      sessionId: "session-1",
      interruptId: "id-2",
      turnId: 'turn-1',
      runId: 'run-1',
    },
  ]);
  await observer.close();
});

test('does not let an admitted Stop interrupt a replacement Turn', async () => {
  const interrupts: unknown[] = [];
  const observer = observerWithSnapshot();
  const originalSnapshot = observer.snapshot.bind(observer);
  let replaced = false;
  observer.snapshot = async (sessionId) => {
    const current = await originalSnapshot(sessionId);
    return replaced
      ? {
          ...current,
          rootTurn: {
            sessionId,
            turnId: 'turn-2',
            runId: 'run-2',
            status: 'running',
          },
        }
      : current;
  };
  const ipc = ipcHarness();
  registerExecutionIpc(
    {
      client: executionClient({
        interruptTurn: async (input) => {
          interrupts.push(input);
          throw new Error('replacement Turn must not be interrupted');
        },
      }),
      observer,
      beforeStop() {
        replaced = true;
      },
    },
    ipc,
  );

  await assert.rejects(
    () =>
      ipc.invoke('sessions:stop', 'session-1', {
        source: 'stop_button',
        expectedAdmissionId: 'turn-1',
      }),
    /Host admission outcome is unknown/,
  );
  assert.deepEqual(interrupts, []);
  await observer.close();
});

type ExecutionClient = RuntimeHostSessionExecutionIpcDeps["client"];

function executionClient(overrides: Partial<ExecutionClient>): ExecutionClient {
  const unavailable = async (): Promise<never> => {
    throw new Error("Unexpected Runtime Host Session execution operation");
  };
  return {
    answerInteraction: unavailable,
    compactContext: unavailable,
    copySession: unavailable,
    getSession: unavailable,
    ingestAttachment: unavailable,
    interruptTurn: unavailable,
    listSessionTurnLandmarks: unavailable,
    listSessionTurns: unavailable,
    queryMessageExecutions: unavailable,
    queryMessages: unavailable,
    queryTurnResume: unavailable,
    readExecutionBoundary: unavailable,
    regenerateTurn: unavailable,
    retractQueueEntry: unavailable,
    promoteQueueEntry: unavailable,
    updateQueueEntry: unavailable,
    reorderQueueEntries: unavailable,
    setSessionReadMarker: unavailable,
    startTurnResume: unavailable,
    submitMessage: unavailable,
    updateSessionConfiguration: unavailable,
    updateSessionMetadata: unavailable,
    ...overrides,
  };
}

function unusedObserver(): RuntimeHostSessionObserver {
  return new RuntimeHostSessionObserver({
    client: {
      openSession: async (): Promise<DesktopRuntimeHostSession> => {
        throw new Error("Unexpected Runtime Host Session subscription");
      },
    },
    emitSessionsChanged() {},
  });
}

function observerWithSnapshot(
  overrides: Partial<import('@maka/runtime-host/protocol').SessionContinuitySnapshot> = {},
): RuntimeHostSessionObserver {
  return observerWithTranscript([], overrides);
}

function observerWithTranscript(
  transcript: readonly import('@maka/core/session').StoredMessage[],
  overrides: Partial<import('@maka/runtime-host/protocol').SessionContinuitySnapshot> = {},
): RuntimeHostSessionObserver {
  let finishEvents!: () => void;
  const eventsFinished = new Promise<void>((resolve) => {
    finishEvents = resolve;
  });
  return new RuntimeHostSessionObserver({
    client: {
      openSession: async () => runtimeHostSessionFixture({
        snapshot: {
          schemaVersion: SESSION_CONTINUITY_SCHEMA_VERSION,
          session: {
            sessionId: "session-1",
            metadataRevision: 1,
            status: "running",
            createdAt: 1,
            isArchived: false,
          },
          projectionRevision: 1,
          rootTurn: {
            sessionId: "session-1",
            turnId: "turn-1",
            runId: "run-1",
            status: "running",
          },
          goal: null,
          queue: {
            hostEpoch: "host-1",
            queueRevision: 0,
            steering: [],
            followup: [],
          },
          interactions: { pending: [] },
          ...overrides,
        },
        activeAssistantStreams: [],
        transcript: Promise.resolve([...transcript]),
        events: waitForEnd(eventsFinished),
        async close() {
          finishEvents();
        },
      }),
    },
    emitSessionsChanged() {},
  });
}

async function* waitForEnd(done: Promise<void>): AsyncIterable<never> {
  await done;
}

type IpcHandler = Parameters<Pick<IpcMain, "handle">["handle"]>[1];

function ipcHarness() {
  const handlers = new Map<string, IpcHandler>();
  const reconnectableChannels = new Set<string>();
  const sender = Object.assign(new EventEmitter(), { id: 9, send() {} });
  const register = (channel: string, handler: IpcHandler) => {
    assert.equal(
      handlers.has(channel),
      false,
      `duplicate handler: ${channel}`,
    );
    handlers.set(channel, handler);
  };
  return {
    reconnectableChannels,
    handle(channel: string, handler: IpcHandler) {
      register(channel, handler);
    },
    handleReconnectableRead(channel: string, handler: IpcHandler) {
      reconnectableChannels.add(channel);
      register(channel, handler);
    },
    async invoke(channel: string, ...args: unknown[]): Promise<unknown> {
      const handler = handlers.get(channel);
      assert.ok(handler, `missing handler: ${channel}`);
      return handler({ sender } as never, ...args);
    },
    rendererGone() {
      sender.emit('render-process-gone');
    },
    rendererDestroyed() {
      sender.emit('destroyed');
    },
  };
}

function registerExecutionIpc(
  deps: Pick<RuntimeHostSessionExecutionIpcDeps, 'client'> &
    Partial<Omit<RuntimeHostSessionExecutionIpcDeps, 'client'>>,
  ipcMain: Pick<IpcMain, 'handle'> & { handleReconnectableRead?: IpcMain['handle'] },
): (sessionId: string) => Promise<void> {
  const observer = deps.observer ?? unusedObserver();
  return registerRuntimeHostSessionExecutionIpc(
    {
      observer,
      attachmentApprovals: createAttachmentApprovalRegistry(),
      emitSessionsChanged() {},
      stat: async () => ({ size: 0 }),
      resizeImage: async (bytes) => bytes,
      beforeStop() {},
      ...deps,
      sessionCopyCleanup: deps.sessionCopyCleanup ?? unusedSessionCopyCleanup(),
      onBackgroundError: deps.onBackgroundError ?? (() => undefined),
    },
    ipcMain,
  );
}

function unusedSessionCopyCleanup(): RuntimeHostSessionExecutionIpcDeps['sessionCopyCleanup'] {
  return {
    ownCreation: async (_creation, operation) => operation(),
    async rejectCreation() {},
    async cleanup() {},
    async schedule() {},
    async abandonOwner() {},
    async recover() {
      return { removed: [], failed: [] };
    },
  };
}

function session(cwd = "/workspace", id = 'session-1'): SessionCatalogProjection {
  return {
    id,
    revision: 1,
    workspace: {
      target: { kind: 'host_path', path: cwd },
      hostCwd: cwd,
    },
    createdAt: 1,
    activityAt: 1,
    name: "Session",
    isFlagged: false,
    isArchived: false,
    labels: [],
    labelsTruncated: false,
    hasUnread: false,
    status: "active",
    backend: "ai-sdk",
    llmConnectionId: "connection-1",
    llmConnectionSlug: "test-connection",
    connectionLocked: true,
    model: "test-model",
    permissionMode: "ask",
    collaborationMode: "agent",
    orchestrationMode: "default",
  };
}

function sideConversationSession(id = 'session-1'): SessionCatalogProjection {
  return { ...session('/workspace', id), labels: [SIDE_CONVERSATION_SESSION_LABEL] };
}
