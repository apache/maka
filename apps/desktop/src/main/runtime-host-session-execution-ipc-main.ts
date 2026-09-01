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
import { MAX_ATTACHMENT_COUNT } from '@maka/core/attachments';
import { isSideConversationSession } from '@maka/core/side-conversation';
import {
  RuntimeHostOperationError,
  RuntimeHostRequestInterruptedError,
} from '@maka/runtime-host/client';
import {
  type SessionChangedEvent,
  type SessionChangedReason,
} from '@maka/core/session';
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
  normalizeClientCapabilityResponse,
  normalizeSessionSendCommand,
  normalizeStopSessionInput,
  normalizeUserQuestionResponse,
} from "./permission-response-guard.js";
import {
  handleReconnectableRead,
  type ReconnectableReadIpcMain,
} from "./ipc-reconnect-policy.js";
import type { DesktopRuntimeHostClient } from "./runtime-host-client.js";
import type { SessionCopyCleanupAuthority } from '@maka/storage/session-copy-cleanup';
import type { RuntimeHostSessionObservationRegistry } from "./runtime-host-session-observation-registry.js";
import {
  RuntimeHostSessionObserver,
  type RuntimeHostSessionObserverTarget,
  type RuntimeHostTranscriptTarget,
} from "./runtime-host-session-observer.js";
import type { DesktopTranscriptRangeRequest } from '../preload/transcript-contract.js';
import type { DesktopSessionStopResult } from '../preload/bridge-contract.js';
import { toDesktopHostSessionSummary } from "./runtime-host-session-catalog-ipc-main.js";
import { mergeWorkspaceFileInlineReferences } from "./session-workspace-inline-references.js";

type SideConversationBranchResult =
  | { readonly ok: true; readonly session: ReturnType<typeof toDesktopHostSessionSummary> }
  | { readonly ok: false; readonly reason: 'session_busy' | 'operation_unavailable' };

async function retryDispatchedCommand<T>(
  command: () => Promise<T>,
  waitForReconnect: () => Promise<unknown>,
): Promise<T> {
  try {
    return await command();
  } catch (error) {
    if (
      !(error instanceof RuntimeHostRequestInterruptedError) ||
      error.dispatch !== 'dispatched'
    ) {
      throw error;
    }
    await waitForReconnect();
    return command();
  }
}

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
  | 'queryMessageExecutions'
  | 'queryMessages'
  | "queryTurnResume"
  | "readExecutionBoundary"
  | "regenerateTurn"
  | "retractQueueEntry"
  | "promoteQueueEntry"
  | "updateQueueEntry"
  | "reorderQueueEntries"
  | "setSessionReadMarker"
  | "startTurnResume"
  | "submitMessage"
  | "updateSessionMetadata"
  | "updateSessionConfiguration"
>;

/** No Skill was named, so the Host resolved none. */
const EMPTY_SKILL_INVOCATION = { loaded: [], failed: [], receipts: [] } as const;

async function submitMessageWithReconnect(
  client: Pick<RuntimeHostSessionExecutionClient, 'getSession' | 'submitMessage'>,
  input: Parameters<RuntimeHostSessionExecutionClient['submitMessage']>[0],
): Promise<Awaited<ReturnType<RuntimeHostSessionExecutionClient['submitMessage']>> | undefined> {
  try {
    return await retryDispatchedCommand(
      () => client.submitMessage(input),
      () => client.getSession(input.sessionId),
    );
  } catch (error) {
    if (error instanceof RuntimeHostOperationError && error.code === 'outcome_unknown') {
      return undefined;
    }
    // `dispatched` means the request reached Runtime Host and the answer was
    // lost, which is the same thing `outcome_unknown` says. The retry above
    // covers one interruption; a second one is still an unknown outcome, and
    // raising it would have the renderer delete a Message the Host may hold
    // — and, on a first send, the Session created for it.
    if (
      error instanceof RuntimeHostRequestInterruptedError &&
      error.dispatch === 'dispatched'
    ) {
      return undefined;
    }
    throw error;
  }
}

export interface RuntimeHostSessionExecutionIpcDeps {
  client: RuntimeHostSessionExecutionClient;
  observer: RuntimeHostSessionObserver;
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

export interface RuntimeHostSessionObservationIpcDeps {
  observations: Pick<
    RuntimeHostSessionObservationRegistry,
    | 'loadTranscriptAround'
    | 'loadTranscriptBefore'
    | 'observe'
    | 'openTranscript'
  >;
  resolveSideConversation(sessionId: string): Promise<boolean>;
}

/** Register the complete Desktop surface available to an observation-only Session. */
export function registerRuntimeHostSessionObservationIpc(
  deps: RuntimeHostSessionObservationIpcDeps,
  ipcMain: ReconnectableReadIpcMain,
): void {
  handleReconnectableRead(
    ipcMain,
    'sessions:observe',
    async (event, sessionId: unknown, observerId: unknown) => {
      const normalizedSessionId = requiredId(sessionId, 'Session');
      await deps.observations.observe(
        normalizedSessionId,
        requiredId(observerId, 'Session observer'),
        event.sender as RuntimeHostSessionObserverTarget,
        await deps.resolveSideConversation(normalizedSessionId),
      );
    },
  );
  ipcMain.handle(
    'sessions:transcript:open',
    async (event, sessionId: unknown, consumerId: unknown) =>
      deps.observations.openTranscript(
        requiredId(sessionId, 'Session'),
        requiredId(consumerId, 'Transcript consumer'),
        event.sender as RuntimeHostTranscriptTarget,
      ),
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
    'sessions:queryCancelledMessages',
    async (_event, sessionId: string, messageIds: unknown) => {
      if (!Array.isArray(messageIds)) throw new Error('Invalid Message identities');
      return deps.client.queryMessages({ sessionId, messageIds });
    },
  );

  ipcMain.handle(
    'sessions:queryMessageExecutions',
    async (_event, sessionId: string, messageIds: unknown) => {
      if (!Array.isArray(messageIds)) throw new Error('Invalid Message identities');
      return deps.client.queryMessageExecutions({ sessionId, messageIds });
    },
  );

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
      const sideConversation = isSideConversationSession(session.labels);
      const turnId = command.turnId ?? newId();
      let attachments = retainedAttachmentsForSession(
        sessionId,
        command.retainedAttachments ?? [],
      );
      if (command.attachmentItems !== undefined) {
        const files = await resolveIngestItems({
          senderId: event.sender.id,
          items: command.attachmentItems,
          approvals: deps.attachmentApprovals,
          stat: deps.stat,
        });
        attachments = [
          ...attachments,
          ...(await resolveAttachmentRefs({
            files,
            resizeImage: deps.resizeImage,
            snapshot: ({ name, mimeType, content }) =>
              deps.client.ingestAttachment({
                sessionId,
                name,
                mimeType,
                content,
              }),
          })),
        ];
      }
      if (attachments.length > MAX_ATTACHMENT_COUNT) {
        throw new Error("Too many attachments");
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
      // Runtime Host is the sole admission authority: one submit answers
      // whether the words opened a Turn or joined the running one, and the
      // Desktop never routes on content — an explicit Skill or orchestration
      // still fails closed on a busy Session, in the Host. The Message identity
      // is the Turn id the caller reserved: one submit, one durable Message,
      // and a retry the Host recognizes as the same one.
      const messageId = turnId;
      const submitted = await submitMessageWithReconnect(deps.client, {
        sessionId,
        messageId,
        placement: "current_turn" as const,
        content: {
          text: command.text,
          ...(command.displayText !== undefined
            ? { displayText: command.displayText }
            : {}),
          ...(attachments.length > 0 ? { attachments } : {}),
          ...(command.directoryReferences ? { directoryReferences: command.directoryReferences } : {}),
          ...(command.quotes ? { quotes: command.quotes } : {}),
          inlineReferences,
        },
        ...((command.skillIds?.length ?? 0) > 0 ? { skillIds: command.skillIds } : {}),
        ...(command.turnOrchestration
          ? { turnOrchestration: command.turnOrchestration }
          : {}),
      });
      if (!submitted) {
        return {
          ok: false as const,
          reason: 'outcome_unknown' as const,
          messageId,
          skillInvocation: EMPTY_SKILL_INVOCATION,
        };
      }
      if (submitted.disposition === "blocked") {
        return {
          ok: false as const,
          reason: "skill_invocation_failed" as const,
          skillInvocation: submitted.skillInvocation,
        };
      }
      if (submitted.disposition === "turn_started") {
        deps.emitSessionsChanged("status-change", sessionId, {
          turnId: submitted.turnId,
        });
        return {
          ok: true as const,
          turnId: submitted.turnId,
          attachments,
          inlineReferences,
          skillInvocation: submitted.skillInvocation,
        };
      }
      // The sending surface believed this Session idle; nudge it to refresh so
      // its composer converges on the running Turn.
      deps.emitSessionsChanged("status-change", sessionId);
      return {
        ok: true as const,
        steered: true as const,
        turnId,
        ...(sideConversation ? { messageId } : {}),
        attachments,
        inlineReferences,
        skillInvocation: submitted.skillInvocation,
      };
    },
  );

  ipcMain.handle(
    "sessions:submitMessage",
    async (event, sessionId: string, placement: unknown, value: unknown) => {
      if (placement !== "current_turn" && placement !== "next_turn") {
        throw new Error("Invalid message placement");
      }
      const command = normalizeSessionSendCommand({
        ...(value && typeof value === "object" ? value : {}),
        type: "send",
      });
      if (!command) throw new Error("Invalid submitted message");
      // The submitting surface owns the Message identity: it is what reconciles
      // the row it already rendered, and what makes a retry the same Message.
      // Minting one here would hand back an identity the caller never showed.
      if (!command.messageId) throw new Error("Submitted message has no identity");
      const session = await deps.client.getSession(sessionId);
      if (!session) {
        throw new Error(`Runtime Host Session not found: ${sessionId}`);
      }
      let attachments = retainedAttachmentsForSession(
        sessionId,
        command.retainedAttachments ?? [],
      );
      if (command.attachmentItems !== undefined) {
        const files = await resolveIngestItems({
          senderId: event.sender.id,
          items: command.attachmentItems,
          approvals: deps.attachmentApprovals,
          stat: deps.stat,
        });
        attachments = [
          ...attachments,
          ...(await resolveAttachmentRefs({
            files,
            resizeImage: deps.resizeImage,
            snapshot: ({ name, mimeType, content }) =>
              deps.client.ingestAttachment({
                sessionId,
                name,
                mimeType,
                content,
              }),
          })),
        ];
      }
      if (attachments.length > MAX_ATTACHMENT_COUNT) {
        throw new Error("Too many attachments");
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
      const messageId = command.messageId;
      // Skill and orchestration intent travels with the Message. Runtime Host
      // decides whether it opens its own Turn, steers the running one, or
      // fails closed; the Desktop never routes on message content.
      const result = await submitMessageWithReconnect(deps.client, {
        sessionId,
        messageId,
        placement,
        content: {
          text: command.text,
          ...(command.displayText !== undefined
            ? { displayText: command.displayText }
            : {}),
          ...(attachments.length > 0 ? { attachments } : {}),
          ...(command.directoryReferences ? { directoryReferences: command.directoryReferences } : {}),
          ...(command.quotes ? { quotes: command.quotes } : {}),
          inlineReferences,
        },
        ...((command.skillIds?.length ?? 0) > 0 ? { skillIds: command.skillIds } : {}),
        ...(command.turnOrchestration
          ? { turnOrchestration: command.turnOrchestration }
          : {}),
      });
      if (!result) return { ok: false as const, reason: 'outcome_unknown' as const };
      if (result.disposition === 'blocked') {
        return {
          ok: false as const,
          reason: 'skill_invocation_failed' as const,
          skillInvocation: result.skillInvocation,
        };
      }
      if (result.disposition === "turn_started") {
        deps.emitSessionsChanged("status-change", sessionId, {
          turnId: result.turnId,
        });
        return {
          ok: true as const,
          disposition: result.disposition,
          turnId: result.turnId,
          attachments,
          inlineReferences,
          skillInvocation: result.skillInvocation,
        };
      }
      // The submitting surface believed this Session idle when it steered;
      // nudge it to refresh so its composer converges on the running Turn.
      deps.emitSessionsChanged("status-change", sessionId);
      return {
        ok: true as const,
        disposition: result.disposition,
        attachments,
        inlineReferences,
        skillInvocation: result.skillInvocation,
      };
    },
  );
  ipcMain.handle(
    "sessions:retractQueueEntry",
    async (_event, sessionId: string, entryId: unknown) => {
      if (typeof entryId !== "string") {
        throw new TypeError("Invalid queue entry identity");
      }
      await deps.client.retractQueueEntry({
        sessionId,
        entryId,
        retractId: newId(),
      });
    },
  );
  ipcMain.handle(
    "sessions:promoteQueueEntry",
    async (_event, sessionId: string, entryId: unknown) => {
      if (typeof entryId !== "string") {
        throw new TypeError("Invalid queue entry identity");
      }
      await deps.client.promoteQueueEntry({
        sessionId,
        entryId,
        promoteId: newId(),
      });
    },
  );
  ipcMain.handle(
    "sessions:updateQueueEntry",
    async (
      _event,
      sessionId: unknown,
      entryId: unknown,
      expectedQueueRevision: unknown,
      text: unknown,
    ) => {
      const normalizedText = requiredText(text, "Queued message").trim();
      await deps.client.updateQueueEntry({
        sessionId: requiredId(sessionId, "Session"),
        entryId: requiredId(entryId, "Queue entry"),
        updateId: newId(),
        expectedQueueRevision: requiredSequence(expectedQueueRevision, "Queue"),
        text: normalizedText,
      });
    },
  );
  ipcMain.handle(
    "sessions:reorderQueueEntries",
    async (_event, sessionId: string, entryIds: unknown) => {
      if (
        !Array.isArray(entryIds) ||
        entryIds.some((entryId) => typeof entryId !== "string")
      ) {
        throw new TypeError("Invalid queue entry order");
      }
      await deps.client.reorderQueueEntries({
        sessionId,
        reorderId: newId(),
        entryIds,
      });
    },
  );
  ipcMain.handle(
    "sessions:stop",
    async (_event, sessionId: string, input: unknown) => {
      const normalized = normalizeStopSessionInput(input);
      return stopSession(sessionId, normalized);
    },
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
  ipcMain.handle(
    "sessions:respondToClientCapability",
    async (_event, sessionId: string, input: unknown) => {
      const response = normalizeClientCapabilityResponse(input);
      const pending = await requireInteraction(deps.observer, sessionId, response.requestId);
      if (pending.request.kind !== "client_capability") {
        throw new Error("Interaction is not a Client Capability request");
      }
      const answered = await deps.client.answerInteraction({
        sessionId,
        interactionId: response.requestId,
        answer: { kind: "client_capability", decision: response.decision },
      });
      deps.observer.publishInteractionAnswer(answered, pending);
    },
  );

  ipcMain.handle("sessions:compact", async (_event, sessionId: string) => {
    const turnId = newId();
    const result = await deps.client.compactContext({ sessionId, turnId });
    deps.emitSessionsChanged("status-change", sessionId, { turnId });
    return result;
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
          ...(normalized.sideConversation ? { intent: 'side_conversation' as const } : {}),
        });
      let branch;
      try {
        branch = normalized.sideConversation
          ? await deps.sessionCopyCleanup.ownCreation(
              {
                sessionId: normalized.copyId,
                kind: 'branch',
                sourceSessionId: sessionId,
                sourceTurnId: normalized.sourceTurnId,
                intent: 'side_conversation',
                ownerId: bindCopyOwner(event),
              },
              createBranch,
            )
          : await createBranch();
      } catch (error) {
        if (
          normalized.sideConversation &&
          error instanceof RuntimeHostOperationError &&
          (error.code === 'session_busy' || error.code === 'operation_unavailable')
        ) {
          await deps.sessionCopyCleanup.rejectCreation(normalized.copyId);
          return {
            ok: false,
            reason: error.code,
          } satisfies SideConversationBranchResult;
        }
        throw error;
      }
      if (normalized.name) {
        branch = await deps.client.updateSessionMetadata(branch.id, {
          name: normalized.name,
        });
      }
      deps.emitSessionsChanged("created", branch.id);
      const summary = toDesktopHostSessionSummary(branch);
      return normalized.sideConversation
        ? ({ ok: true, session: summary } satisfies SideConversationBranchResult)
        : summary;
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
  return async (sessionId) => {
    await stopSession(sessionId);
  };
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
    sessionId: requiredId(value.sessionId, 'Session'),
    hostEpoch: requiredId(value.hostEpoch, 'Host epoch'),
    anchorSequence: anchorSequence as number | null,
    maxBytes: maxBytes as number,
  };
}

function retainedAttachmentsForSession(
  sessionId: string,
  attachments: readonly AttachmentRef[],
): AttachmentRef[] {
  return attachments.map((attachment) => {
    if (attachment.ref.kind === "external_file") {
      throw new Error("External file attachments must be selected again");
    }
    if (
      attachment.ref.kind === "session_file" &&
      attachment.ref.sessionId !== sessionId
    ) {
      throw new Error("Retained attachment belongs to another Session");
    }
    return structuredClone(attachment);
  });
}

function createRuntimeHostSessionStop(
  deps: Pick<
    RuntimeHostSessionExecutionIpcDeps,
    "beforeStop" | "client" | "observer" | "emitSessionsChanged"
  >,
  newId: () => string = randomUUID,
): (
  sessionId: string,
  target?: { readonly expectedTurnId?: string; readonly expectedAdmissionId?: string },
) => Promise<DesktopSessionStopResult> {
  return async (sessionId, target = {}) => {
    let expectedTurnId = target.expectedTurnId;
    if (target.expectedAdmissionId) {
      const observed = await deps.observer.snapshot(sessionId);
      const root = observed.rootTurn;
      const entry = [...observed.queue.steering, ...observed.queue.followup].find(
        (candidate) => candidate.messageId === target.expectedAdmissionId,
      );
      if (entry?.state === 'queued') {
        const retractId = newId();
        await retryDispatchedCommand(
          () =>
            deps.client.retractQueueEntry({
              sessionId,
              entryId: entry.entryId,
              retractId,
            }),
          () => deps.client.getSession(sessionId),
        );
        deps.emitSessionsChanged('status-change', sessionId);
        return { kind: 'retracted', messageId: entry.messageId };
      }
      if (
        root &&
        !isTerminalStatus(root.status) &&
        root.turnId === target.expectedAdmissionId
      ) {
        expectedTurnId = root.turnId;
      } else {
        throw new Error('Host admission outcome is unknown');
      }
    }
    if (expectedTurnId) {
      const observed = (await deps.observer.snapshot(sessionId)).rootTurn;
      if (
        !observed ||
        isTerminalStatus(observed.status) ||
        observed.turnId !== expectedTurnId
      ) {
        return;
      }
    }
    await deps.beforeStop(sessionId);
    const turn = (await deps.observer.snapshot(sessionId)).rootTurn;
    if (
      !turn ||
      isTerminalStatus(turn.status) ||
      (expectedTurnId && turn.turnId !== expectedTurnId)
    ) {
      if (target.expectedAdmissionId) {
        throw new Error('Host admission outcome is unknown');
      }
      return;
    }
    const interrupted = await deps.client.interruptTurn({
      sessionId,
      interruptId: newId(),
      turnId: turn.turnId,
      runId: turn.runId,
    });
    deps.emitSessionsChanged("turn-status-change", sessionId, {
      turnId: turn.turnId,
    });
    return {
      kind: 'interrupted',
      retractedMessageIds: interrupted.retracted.map((message) => message.messageId),
    };
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

function requiredText(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    Buffer.byteLength(value, "utf8") > 48 * 1024
  ) {
    throw new Error(`Invalid ${label} text`);
  }
  return value;
}

function requiredSequence(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`Invalid ${label} sequence`);
  }
  return value as number;
}


function isTerminalStatus(status: string): boolean {
  return (
    status === "completed" || status === "failed" || status === "cancelled"
  );
}
