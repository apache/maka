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

import { randomUUID } from "node:crypto";
import type { IpcMainInvokeEvent } from "electron";
import { RuntimeHostOperationError } from '@maka/runtime-host/client';
import { SKILL_INVOCATION_TOKEN_SOURCE } from '@maka/core/skill-invocation-token';
import {
  type SessionChangedEvent,
  type SessionChangedReason,
} from '@maka/core/session';
import { SIDE_CONVERSATION_SESSION_LABEL } from '@maka/core/side-conversation';
import { type ActiveInteractionRequestEvent, type AttachmentRef } from '@maka/core/events';
import { type PermissionMode } from '@maka/core/permission';
import { type SandboxBoundaryResponse } from '@maka/core/sandbox-boundary';
import type { AttachmentApprovalRegistry } from "./attachment-approval.js";
import {
  resolveAttachmentRefs,
  resolveIngestItems,
} from "./attachment-ingest.js";
import {
  normalizeRuntimeHostBranchFromTurnInput,
  normalizeRegenerateTurnInput,
  normalizeRuntimeHostReviseBeforeTurnInput,
  normalizeSandboxBoundaryResponse,
  normalizeSessionSendCommand,
  normalizeUserQuestionResponse,
} from "./permission-response-guard.js";
import {
  handleReconnectableRead,
  type ReconnectableReadIpcMain,
} from "./ipc-reconnect-policy.js";
import type { DesktopRuntimeHostClient } from "./runtime-host-client.js";
import type { SessionCopyCleanupAuthority } from './quote-companion-cleanup.js';
import type { RuntimeHostSessionObservationRegistry } from "./runtime-host-session-observation-registry.js";
import {
  RuntimeHostSessionObserver,
  type RuntimeHostSessionObserverTarget,
  type RuntimeHostTranscriptTarget,
} from "./runtime-host-session-observer.js";
import type { DesktopTranscriptRangeRequest } from '../preload/transcript-contract.js';
import { toDesktopHostSessionSummary } from "./runtime-host-session-catalog-ipc-main.js";
import { mergeWorkspaceFileInlineReferences } from "./session-workspace-inline-references.js";

type RuntimeHostSessionExecutionClient = Pick<
  DesktopRuntimeHostClient,
  | "answerInteraction"
  | "compactContext"
  | "copySession"
  | "getSession"
  | "ingestAttachment"
  | "interruptTurn"
  | 'listSessionTurns'
  | 'listSessionTurnLandmarks'
  | "queryTurnResume"
  | "readExecutionBoundary"
  | "regenerateTurn"
  | "setSessionReadMarker"
  | "startTurn"
  | "startTurnResume"
  | "submitMessage"
  | "updateSessionMetadata"
  | "updateSessionConfiguration"
>;

export interface RuntimeHostSessionExecutionIpcDeps {
  client: RuntimeHostSessionExecutionClient;
  observer: RuntimeHostSessionObserver;
  observations: Pick<
    RuntimeHostSessionObservationRegistry,
    | 'loadTranscriptAround'
    | 'loadTranscriptBefore'
    | 'observe'
    | 'openTranscript'
  >;
  attachmentApprovals: AttachmentApprovalRegistry;
  emitSessionsChanged: (
    reason: SessionChangedReason,
    sessionId?: string,
    extra?: Pick<SessionChangedEvent, "turnId">,
  ) => void;
  stat(path: string): Promise<{ size: number }>;
  resizeImage(bytes: Uint8Array): Promise<Uint8Array>;
  beforeStop(sessionId: string): void | Promise<void>;
  sessionCopyCleanup: SessionCopyCleanupAuthority;
  onBackgroundError(error: unknown): void;
  e2eInteractions?: {
    list(sessionId: string): readonly ActiveInteractionRequestEvent[];
    respondToSandboxBoundary(
      sessionId: string,
      response: SandboxBoundaryResponse,
    ): Promise<
      | { readonly handled: false }
      | { readonly handled: true; readonly permissionMode?: PermissionMode }
    >;
  };
  newId?: () => string;
}

/**
 * Project Host-owned Session execution onto the Desktop renderer IPC contract.
 * The adapter owns client validation and presentation events, never Runtime
 * execution or Session persistence.
 */
export function registerRuntimeHostSessionExecutionIpc(
  deps: RuntimeHostSessionExecutionIpcDeps,
  ipcMain: ReconnectableReadIpcMain,
): (sessionId: string) => Promise<void> {
  const observedCopyOwners = new Set<string>();
  const bindCopyOwner = (event: IpcMainInvokeEvent): string => {
    const ownerId = `web-contents:${event.sender.id}`;
    if (!observedCopyOwners.has(ownerId)) {
      observedCopyOwners.add(ownerId);
      const abandon = () => {
        if (!observedCopyOwners.delete(ownerId)) return;
        event.sender.removeListener('render-process-gone', abandon);
        event.sender.removeListener('destroyed', abandon);
        void deps.sessionCopyCleanup.abandonOwner(ownerId).catch(deps.onBackgroundError);
      };
      event.sender.once('render-process-gone', abandon);
      event.sender.once('destroyed', abandon);
    }
    return ownerId;
  };
  const newId = deps.newId ?? randomUUID;
  const stopSession = createRuntimeHostSessionStop(deps, newId);

  ipcMain.handle(
    "sessions:observe",
    async (event, sessionId: unknown, observerId: unknown) => {
      const normalizedSessionId = requiredId(sessionId, "Session");
      const normalizedObserverId = requiredId(observerId, "Session observer");
      await deps.observations.observe(
        normalizedSessionId,
        normalizedObserverId,
        event.sender as RuntimeHostSessionObserverTarget,
      );
    },
  );
  ipcMain.handle(
    'sessions:transcript:open',
    async (event, sessionId: unknown, consumerId: unknown) => {
      const result = await deps.observations.openTranscript(
        requiredId(sessionId, 'Session'),
        requiredId(consumerId, 'Transcript consumer'),
        event.sender as RuntimeHostTranscriptTarget,
      );
      return result;
    },
  );
  ipcMain.handle('sessions:transcript:load-before', async (event, input: unknown) => {
    await deps.observations.loadTranscriptBefore(
      normalizeTranscriptRangeRequest(input),
      event.sender.id,
    );
  });
  ipcMain.handle('sessions:transcript:load-around', async (event, input: unknown) => {
    await deps.observations.loadTranscriptAround(
      normalizeTranscriptRangeRequest(input),
      event.sender.id,
    );
  });
  handleReconnectableRead(ipcMain, 'sessions:listTurns', async (_event, sessionId: unknown) =>
    deps.client.listSessionTurns(requiredId(sessionId, 'Session')),
  );
  handleReconnectableRead(
    ipcMain,
    'sessions:listTurnLandmarks',
    async (_event, sessionId: unknown) =>
      deps.client.listSessionTurnLandmarks(requiredId(sessionId, 'Session')),
  );
  handleReconnectableRead(
    ipcMain,
    "sessions:readExecutionBoundary",
    (_event, sessionId: string) => deps.client.readExecutionBoundary(sessionId),
  );
  handleReconnectableRead(
    ipcMain,
    "sessions:listActiveInteractions",
    async (_event, sessionId: string) => [
      ...(deps.e2eInteractions?.list(sessionId) ?? []),
      ...(await deps.observer.readActiveInteractions(sessionId)),
    ],
  );

  ipcMain.handle(
    "sessions:send",
    async (event, sessionId: string, input: unknown) => {
      const command = normalizeSessionSendCommand(input);
      if (!command) return;
      const session = await deps.client.getSession(sessionId);
      if (!session)
        throw new Error(`Runtime Host Session not found: ${sessionId}`);
      const turnId = command.turnId ?? newId();
      let attachments: AttachmentRef[] = [];
      if (command.attachmentItems !== undefined) {
        const files = await resolveIngestItems({
          senderId: event.sender.id,
          items: command.attachmentItems,
          approvals: deps.attachmentApprovals,
          stat: deps.stat,
        });
        attachments = await resolveAttachmentRefs({
          files,
          resizeImage: deps.resizeImage,
          snapshot: ({ name, mimeType, content }) =>
            deps.client.ingestAttachment({
              sessionId,
              name,
              mimeType,
              content,
            }),
        });
      }
      const displayText =
        command.displayText ??
        (command.text.trim().length > 0
          ? command.text
          : (command.skillIds ?? []).map((id) => `/skill:${id}`).join(" "));
      const inlineReferences = mergeWorkspaceFileInlineReferences({
        displayText,
        workspaceFileReferences: command.workspaceFileReferences,
      });
      const startInput = {
        sessionId,
        turnId,
        content: {
          text: command.text,
          ...(command.displayText !== undefined
            ? { displayText: command.displayText }
            : {}),
          ...(attachments.length > 0 ? { attachments } : {}),
          ...(command.quotes ? { quotes: command.quotes } : {}),
          inlineReferences,
        },
        ...((command.skillIds?.length ?? 0) > 0
          ? { skillIds: command.skillIds }
          : {}),
        ...(command.turnOrchestration
          ? { turnOrchestration: command.turnOrchestration }
          : {}),
      };
      let startResult;
      try {
        startResult = await deps.client.startTurn(startInput);
      } catch (error) {
        // The renderer routes text at a session it sees as running to
        // `sessions:steer`, but its view can lag the Host: another window, a
        // Bot, or a Goal continuation may have opened the root Turn first, and
        // that race surfaced here as a session_busy send failure that dropped
        // the user's message (#1954). `turn.message.submit` resolves the race
        // on the Host: an active session queues the text as steering, an idle
        // one starts the Turn. Skill and orchestration sends keep the error —
        // their turn semantics cannot be expressed as a queued message — and
        // the Desktop composer carries Skills as canonical /skill: tokens in
        // the text, not as skillIds.
        if (
          !(error instanceof RuntimeHostOperationError) ||
          error.code !== "session_busy" ||
          (command.skillIds?.length ?? 0) > 0 ||
          command.turnOrchestration ||
          new RegExp(SKILL_INVOCATION_TOKEN_SOURCE).test(command.text)
        ) {
          throw error;
        }
        const submitted = await deps.client.submitMessage({
          sessionId,
          messageId: newId(),
          content: startInput.content,
          placement: "current_turn",
        });
        const emptySkillInvocation = { loaded: [], failed: [], receipts: [] };
        if (submitted.disposition === "turn_started") {
          deps.emitSessionsChanged("status-change", sessionId, {
            turnId: submitted.turnId,
          });
          return {
            ok: true as const,
            turnId: submitted.turnId,
            attachments,
            inlineReferences,
            skillInvocation: emptySkillInvocation,
          };
        }
        // The steering renderer believed this session idle; nudge it to
        // refresh so its composer converges on the running turn.
        deps.emitSessionsChanged("status-change", sessionId);
        return {
          ok: true as const,
          steered: true as const,
          turnId,
          attachments,
          inlineReferences,
          skillInvocation: emptySkillInvocation,
        };
      }
      if (startResult.kind === "blocked") {
        return {
          ok: false as const,
          attachments,
          inlineReferences,
          skillInvocation: startResult.skillInvocation,
        };
      }
      deps.emitSessionsChanged("status-change", sessionId, { turnId });
      return {
        ok: true as const,
        turnId,
        attachments,
        inlineReferences,
        skillInvocation: startResult.skillInvocation,
      };
    },
  );

  ipcMain.handle(
    "sessions:steer",
    async (_event, sessionId: string, text: unknown) => {
      const content = steeringContent(text);
      await deps.client.submitMessage({
        sessionId,
        messageId: newId(),
        content: { text: content },
        placement: "current_turn",
      });
      return { kind: "queued" as const };
    },
  );
  ipcMain.handle("sessions:stop", async (_event, sessionId: string) =>
    stopSession(sessionId),
  );

  ipcMain.handle(
    "sessions:respondToSandboxBoundary",
    async (_event, sessionId: string, input: unknown) => {
      const response = normalizeSandboxBoundaryResponse(input);
      const fixtureResult = await deps.e2eInteractions?.respondToSandboxBoundary(
        sessionId,
        response,
      );
      if (fixtureResult?.handled) {
        if (fixtureResult.permissionMode) {
          await deps.client.updateSessionConfiguration(sessionId, {
            permissionMode: fixtureResult.permissionMode,
          });
          deps.emitSessionsChanged("mode-change", sessionId);
        }
        return;
      }
      const pending = await requireInteraction(
        deps.observer,
        sessionId,
        response.requestId,
      );
      if (pending.request.kind !== "sandbox_boundary") {
        throw new Error("Interaction is not a sandbox boundary request");
      }
      const answered = await deps.client.answerInteraction({
        sessionId,
        interactionId: response.requestId,
        answer: { kind: "sandbox_boundary", decision: response.decision },
      });
      deps.observer.publishInteractionAnswer(answered, pending);
    },
  );
  ipcMain.handle(
    "sessions:respondToUserQuestion",
    async (_event, sessionId: string, input: unknown) => {
      const response = normalizeUserQuestionResponse(input);
      const pending = await requireInteraction(
        deps.observer,
        sessionId,
        response.requestId,
      );
      if (pending.request.kind !== "question") {
        throw new Error("Interaction is not a user question request");
      }
      const answered = await deps.client.answerInteraction({
        sessionId,
        interactionId: response.requestId,
        answer: { kind: "question", answers: response.answers },
      });
      deps.observer.publishInteractionAnswer(answered, pending);
    },
  );

  ipcMain.handle("sessions:compact", async (_event, sessionId: string) => {
    const turnId = newId();
    await deps.client.compactContext({ sessionId, turnId });
    deps.emitSessionsChanged("status-change", sessionId, { turnId });
  });
  ipcMain.handle("sessions:resumeLatest", async (_event, sessionId: string) => {
    const plan = await deps.client.queryTurnResume({ sessionId });
    if (plan.disposition === "parked") {
      return {
        disposition: "park" as const,
        rejectionReasons: [plan.reason],
        diagnostics: [],
      };
    }
    const turnId = newId();
    const result = await deps.client.startTurnResume({
      sessionId,
      turnId,
      sourceRunId: plan.sourceRunId,
      sourceRuntimeEventHighWater: plan.sourceRuntimeEventHighWater,
    });
    if (result.kind === "parked") {
      return {
        disposition: "park" as const,
        rejectionReasons: [result.plan.reason],
        diagnostics: [],
      };
    }
    deps.emitSessionsChanged("status-change", sessionId, { turnId });
    return {
      disposition: "started" as const,
      runId: result.turn.runId,
      turnId: result.turn.turnId,
    };
  });
  ipcMain.handle(
    "sessions:regenerateTurn",
    async (_event, sessionId: string, input: unknown) => {
      const normalized = normalizeRegenerateTurnInput(input);
      const turnId = normalized.turnId ?? newId();
      await deps.client.regenerateTurn({
        sessionId,
        sourceTurnId: normalized.sourceTurnId,
        turnId,
      });
      deps.emitSessionsChanged("status-change", sessionId, { turnId });
    },
  );

  ipcMain.handle(
    "sessions:branchFromTurn",
    async (event, sessionId: string, input: unknown) => {
      const normalized = normalizeRuntimeHostBranchFromTurnInput(input);
      const createBranch = () =>
        deps.client.copySession("branch", {
          sourceSessionId: sessionId,
          targetSessionId: normalized.copyId,
          sourceTurnId: normalized.sourceTurnId,
        });
      let branch = normalized.sideConversation
        ? await deps.sessionCopyCleanup.ownCreation(
            {
              sessionId: normalized.copyId,
              kind: 'branch',
              sourceSessionId: sessionId,
              sourceTurnId: normalized.sourceTurnId,
              ownerId: bindCopyOwner(event),
            },
            createBranch,
          )
        : await createBranch();
      if (normalized.name || normalized.sideConversation) {
        branch = await deps.client.updateSessionMetadata(branch.id, {
          ...(normalized.name ? { name: normalized.name } : {}),
          ...(normalized.sideConversation
            ? {
                labels: [
                  ...new Set([
                    ...branch.labels,
                    SIDE_CONVERSATION_SESSION_LABEL,
                  ]),
                ],
              }
            : {}),
        });
      }
      deps.emitSessionsChanged("created", branch.id);
      return toDesktopHostSessionSummary(branch);
    },
  );
  ipcMain.handle(
    "sessions:reviseBeforeTurn",
    async (_event, sessionId: string, input: unknown) => {
      const normalized = normalizeRuntimeHostReviseBeforeTurnInput(input);
      const revision = await deps.client.copySession("revision", {
        sourceSessionId: sessionId,
        targetSessionId: normalized.copyId,
        sourceTurnId: normalized.sourceTurnId,
      });
      deps.emitSessionsChanged("created", revision.id);
      return toDesktopHostSessionSummary(revision);
    },
  );
  return stopSession;
}

function normalizeTranscriptRangeRequest(input: unknown): DesktopTranscriptRangeRequest {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Invalid Desktop transcript range request');
  }
  const value = input as Record<string, unknown>;
  const anchorSequence = value.anchorSequence;
  const maxBytes = value.maxBytes;
  if (
    anchorSequence !== null &&
    (!Number.isSafeInteger(anchorSequence) || (anchorSequence as number) < 0)
  ) {
    throw new Error('Invalid Desktop transcript range anchor');
  }
  if (!Number.isSafeInteger(maxBytes)) {
    throw new Error('Invalid Desktop transcript range byte limit');
  }
  return {
    consumerId: requiredId(value.consumerId, 'Transcript consumer'),
    generation: requiredId(value.generation, 'Transcript generation'),
    anchorSequence: anchorSequence as number | null,
    maxBytes: maxBytes as number,
  };
}

function createRuntimeHostSessionStop(
  deps: Pick<
    RuntimeHostSessionExecutionIpcDeps,
    "beforeStop" | "client" | "observer" | "emitSessionsChanged"
  >,
  newId: () => string = randomUUID,
): (sessionId: string) => Promise<void> {
  return async (sessionId) => {
    await deps.beforeStop(sessionId);
    const turn = (await deps.observer.snapshot(sessionId)).rootTurn;
    if (!turn || isTerminalStatus(turn.status)) return;
    await deps.client.interruptTurn({
      sessionId,
      interruptId: newId(),
      turnId: turn.turnId,
      runId: turn.runId,
    });
    deps.emitSessionsChanged("turn-status-change", sessionId, {
      turnId: turn.turnId,
    });
  };
}

async function requireInteraction(
  observer: RuntimeHostSessionObserver,
  sessionId: string,
  interactionId: string,
) {
  const interaction = await observer.readInteraction(sessionId, interactionId);
  if (!interaction)
    throw new Error(`Runtime Host Interaction not found: ${interactionId}`);
  return interaction;
}

function requiredId(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 256) {
    throw new Error(`Invalid ${label} identity`);
  }
  return value;
}

function requiredSequence(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`Invalid ${label} sequence`);
  }
  return value as number;
}

function steeringContent(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > 128_000
  ) {
    throw new Error("Invalid steering text");
  }
  return value.trim();
}

function isTerminalStatus(status: string): boolean {
  return (
    status === "completed" || status === "failed" || status === "cancelled"
  );
}
