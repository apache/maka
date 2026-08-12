import assert from "node:assert/strict";
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { IpcMain } from "electron";
import { SIDE_CONVERSATION_SESSION_LABEL } from '@maka/core/side-conversation';
import { type AttachmentRef } from '@maka/core/events';
import type { SessionCatalogProjection } from "@maka/runtime-host/protocol";
import { createAttachmentApprovalRegistry } from "../attachment-approval.js";
import type { DesktopRuntimeHostSession } from "../runtime-host-client.js";
import {
  registerRuntimeHostSessionExecutionIpc,
  type RuntimeHostSessionExecutionIpcDeps,
} from "../runtime-host-session-execution-ipc-main.js";
import { RuntimeHostSessionObserver } from "../runtime-host-session-observer.js";

test("advances the Host read marker through the last visible message", async () => {
  const readMarkers: unknown[] = [];
  const observer = observerWithTranscript([
    {
      type: "user",
      id: "user-1",
      turnId: "turn-1",
      ts: 1,
      text: "Hello",
    },
    {
      type: "assistant",
      id: "assistant-1",
      turnId: "turn-1",
      ts: 2,
      text: "Hi",
      modelId: "test-model",
    },
    {
      type: "system_note",
      id: "internal-tail",
      turnId: "turn-1",
      ts: 3,
      kind: "session_resume",
    },
  ]);
  const ipc = ipcHarness();
  registerExecutionIpc(
    {
      client: executionClient({
        setSessionReadMarker: async (sessionId, readThroughMessageId) => {
          readMarkers.push({ sessionId, readThroughMessageId });
          return session();
        },
      }),
      observer,
      attachmentApprovals: createAttachmentApprovalRegistry(),
      emitSessionsChanged() {},
      stat: async () => ({ size: 0 }),
      resizeImage: async (bytes) => bytes,
      beforeStop() {},
    },
    ipc,
  );

  assert.equal(
    ((await ipc.invoke("sessions:readMessages", "session-1")) as unknown[])
      .length,
    3,
  );
  assert.deepEqual(readMarkers, [
    { sessionId: "session-1", readThroughMessageId: "assistant-1" },
  ]);
  await observer.close();
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
            copy = { ...session(), id: input.targetSessionId, name: input.targetSessionId };
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

test("marks Runtime Host Branch copies as side conversations", async () => {
  const metadataUpdates: unknown[] = [];
  const abandonedOwners: string[] = [];
  const backgroundErrors: unknown[] = [];
  const ipc = ipcHarness();
  const sessionCopyCleanup = {
    ownCreation: <T>(_creation: unknown, operation: () => Promise<T>) => operation(),
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
        copySession: async (_kind, input) => ({
          ...session(),
          id: input.targetSessionId,
          labels: ["source-label"],
        }),
        updateSessionMetadata: async (sessionId, patch) => {
          metadataUpdates.push({ sessionId, patch });
          return {
            ...session(),
            id: sessionId,
            labels: patch.labels ?? [],
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

  const branch = (await ipc.invoke("sessions:branchFromTurn", "source-session", {
    sourceTurnId: "source-turn",
    copyId: "side-copy",
    name: "Side chat",
    sideConversation: true,
  })) as { labels: string[] };

  assert.deepEqual(metadataUpdates, [
    {
      sessionId: "side-copy",
      patch: {
        name: "Side chat",
        labels: ["source-label", SIDE_CONVERSATION_SESSION_LABEL],
      },
    },
  ]);
  assert.deepEqual(branch.labels, [
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
    startTurn: async (input) => {
      starts.push(input);
      return {
        kind: "started",
        turn: {
          sessionId: input.sessionId,
          turnId: input.turnId,
          runId: "run-1",
          status: "running",
        },
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
      turnId: "turn-1",
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
        startTurn: async (input) => {
          starts.push(input);
          return {
            kind: "started",
            turn: {
              sessionId: input.sessionId,
              turnId: input.turnId,
              runId: "run-1",
              status: "running",
            },
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
        startTurn: async (input) => {
          starts.push(input);
          return {
            kind: "started",
            turn: {
              sessionId: input.sessionId,
              turnId: input.turnId,
              runId: "run-1",
              status: "running",
            },
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
      turnId: "turn-skill",
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

test("binds steer and stop to Host-owned queue and active Turn identities", async () => {
  const submits: unknown[] = [];
  const interrupts: unknown[] = [];
  const stopLifecycle: string[] = [];
  let sequence = 0;
  const client = executionClient({
    submitMessage: async (input) => {
      submits.push(input);
      return { disposition: "steering", queueRevision: 2 };
    },
    interruptTurn: async (input) => {
      stopLifecycle.push("interrupt");
      interrupts.push(input);
      return {
        queueRevision: 3,
        retracted: [],
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
  });
  const observer = observerWithSnapshot();
  const ipc = ipcHarness();
  registerExecutionIpc(
    {
      client,
      observer,
      attachmentApprovals: createAttachmentApprovalRegistry(),
      emitSessionsChanged() {},
      stat: async () => ({ size: 0 }),
      resizeImage: async (bytes) => bytes,
      beforeStop() {
        stopLifecycle.push("teardown");
      },
      newId: () => `id-${++sequence}`,
    },
    ipc,
  );

  assert.deepEqual(
    await ipc.invoke("sessions:steer", "session-1", "  Continue  "),
    {
      kind: "queued",
    },
  );
  await ipc.invoke("sessions:stop", "session-1");
  assert.deepEqual(stopLifecycle, ["teardown", "interrupt"]);

  assert.deepEqual(submits, [
    {
      sessionId: "session-1",
      messageId: "id-1",
      content: { text: "Continue" },
      placement: "current_turn",
    },
  ]);
  assert.deepEqual(interrupts, [
    {
      sessionId: "session-1",
      interruptId: "id-2",
      turnId: "turn-1",
      runId: "run-1",
    },
  ]);
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
    queryTurnResume: unavailable,
    readExecutionBoundary: unavailable,
    regenerateTurn: unavailable,
    setSessionReadMarker: unavailable,
    startTurn: unavailable,
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

function observerWithSnapshot(): RuntimeHostSessionObserver {
  return observerWithTranscript([]);
}

function observerWithTranscript(
  transcript: readonly import('@maka/core/session').StoredMessage[],
): RuntimeHostSessionObserver {
  let finishEvents!: () => void;
  const eventsFinished = new Promise<void>((resolve) => {
    finishEvents = resolve;
  });
  return new RuntimeHostSessionObserver({
    client: {
      openSession: async () => ({
        snapshot: {
          schemaVersion: 3,
          session: {
            sessionId: "session-1",
            metadataRevision: 1,
            status: "running",
            createdAt: 1,
            lastUsedAt: 1,
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
  const sender = Object.assign(new EventEmitter(), { id: 9 });
  return {
    handle(channel: string, handler: IpcHandler) {
      assert.equal(
        handlers.has(channel),
        false,
        `duplicate handler: ${channel}`,
      );
      handlers.set(channel, handler);
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
  deps: Omit<
    RuntimeHostSessionExecutionIpcDeps,
    'sessionCopyCleanup' | 'onBackgroundError' | 'observations'
  > &
    Partial<
      Pick<
        RuntimeHostSessionExecutionIpcDeps,
        'sessionCopyCleanup' | 'onBackgroundError' | 'observations'
      >
    >,
  ipcMain: Pick<IpcMain, 'handle'>,
): (sessionId: string) => Promise<void> {
  return registerRuntimeHostSessionExecutionIpc(
    {
      ...deps,
      observations: deps.observations ?? deps.observer,
      sessionCopyCleanup: deps.sessionCopyCleanup ?? unusedSessionCopyCleanup(),
      onBackgroundError: deps.onBackgroundError ?? (() => undefined),
    },
    ipcMain,
  );
}

function unusedSessionCopyCleanup(): RuntimeHostSessionExecutionIpcDeps['sessionCopyCleanup'] {
  return {
    ownCreation: async (_creation, operation) => operation(),
    async cleanup() {},
    async schedule() {},
    async abandonOwner() {},
    async recover() {
      return { removed: [], failed: [] };
    },
  };
}

function session(cwd = "/workspace"): SessionCatalogProjection {
  return {
    id: "session-1",
    revision: 1,
    workspace: {
      target: { kind: 'host_path', path: cwd },
      hostCwd: cwd,
    },
    createdAt: 1,
    lastUsedAt: 1,
    name: "Session",
    isFlagged: false,
    isArchived: false,
    labels: [],
    labelsTruncated: false,
    hasUnread: false,
    status: "active",
    backend: "ai-sdk",
    llmConnectionSlug: "test-connection",
    connectionLocked: true,
    model: "test-model",
    permissionMode: "ask",
    collaborationMode: "agent",
    orchestrationMode: "default",
  };
}
