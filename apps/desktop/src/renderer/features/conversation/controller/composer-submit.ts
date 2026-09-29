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

import type { FollowUpMode, InlineReference, QuoteRef } from '@maka/core/events';
import type { ParsedGraphCommand } from '@maka/core/graph-command';
import type { OrchestrationMode } from '@maka/core/orchestration';
import type { TurnOrchestration } from '@maka/core/runtime-inputs';
import type { ParsedSwarmCommand } from '@maka/core/swarm-command';
import type {
  ComposerHandle,
  ComposerSendMetadata,
  TransientUserMessageProjection,
} from '@maka/ui';
import type { PendingAttachment } from '@maka/ui/composer-attachments';

type RefBox<T> = { current: T };
type WorkspaceFileReference = NonNullable<ComposerSendMetadata['workspaceFileReferences']>[number];

export type ComposerSlashCommand =
  | { kind: 'compact' }
  | { kind: 'side'; command: { prompt: string } }
  | { kind: 'graph'; command: ParsedGraphCommand }
  | { kind: 'swarm'; command: ParsedSwarmCommand };

export interface RevisionDraftIdentity {
  sourceSessionId: string;
  draftSessionId: string;
}

type SubmitOptions = {
  directoryReferences?: NonNullable<TransientUserMessageProjection['directoryReferences']>;
  quotes?: readonly QuoteRef[];
  workspaceFileReferences?: readonly WorkspaceFileReference[];
  waitForHostAdmission?: boolean;
  targetSessionId?: string;
  turnOrchestration?: TurnOrchestration;
  onSessionResolved?: (sessionId: string, newTaskDraftKey?: string) => void;
};

/** The shell-copy fields this send path reads. Structural so tests do not need the full copy. */
export interface RevisionSendShellCopy {
  sideChatUnavailableTitle: string;
  sideChatUnavailableDescription: string;
  sideChatContextPendingTitle: string;
  sideChatContextPendingDescription: string;
  swarmModeEnabledTitle: string;
  swarmModeDisabledTitle: string;
  swarmModeStatusDescription: string;
  graphModeEnabledTitle: string;
  graphModeDisabledTitle: string;
  graphModeStatusDescription: string;
  graphHistoryTitle: string;
  graphHistoryDescription: string;
}

/**
 * Dependencies of the composer's submit path. AppShell passes its live
 * readings; tests pass doubles. The function below is the production path —
 * tests must call it rather than re-implementing its ordering.
 */
export interface RevisionSendPorts<TDraft extends RevisionDraftIdentity> {
  shellCopy: RevisionSendShellCopy;
  toastApi: {
    info(title: string, description?: string): void;
  };
  activeIdRef: RefBox<string | undefined>;
  revisionDraftRef: RefBox<TDraft | null>;
  composerRef: RefBox<ComposerHandle | null>;
  retractedWorkspaceReferencesRef: RefBox<Record<string, InlineReference[]>>;
  hasPendingContext: boolean;
  hasStagedQuotes: boolean;
  submittableAttachments: readonly PendingAttachment[] | undefined;
  directoryOptions: {
    directoryReferences?: NonNullable<
      TransientUserMessageProjection['directoryReferences']
    >;
  };
  quotesForSend: () => QuoteRef[] | undefined;
  clearSubmittedContext: (
    submitted?: readonly PendingAttachment[],
  ) => void;
  clearQuotes: () => void;
  prepareRevisionSend: (text: string) => Promise<boolean>;
  send: (text: string, pending?: readonly PendingAttachment[], options?: SubmitOptions) => Promise<boolean>;
  enqueueFollowUp: (
    sessionId: string,
    text: string,
    mode: FollowUpMode,
    metadata?: ComposerSendMetadata,
  ) => Promise<boolean>;
  settleNewTaskImageNoticeOwner: (sourceSessionId?: string) => void;
  commitRevisionDraft: (draft: TDraft | null) => void;
  completeRevisionCopyAttempt: (draft: TDraft) => void;
  parseSlashCommand: (text: string) => ComposerSlashCommand | null;
  mergeWorkspaceReferences: (
    text: string,
    live: readonly WorkspaceFileReference[] | undefined,
    restored: readonly InlineReference[] | undefined,
  ) => WorkspaceFileReference[];
  rebaseWorkspaceFileReferences: (
    sourceText: string,
    projectedText: string,
    references: readonly WorkspaceFileReference[],
  ) => WorkspaceFileReference[];
  revisionUnavailableCopy: {
    revisionUnavailableTitle: string;
    revisionAttachmentsUnsupported: string;
    revisionCommandUnsupported: string;
  };
  compactSession: (sessionId: string) => Promise<boolean>;
  resolveNewTaskSessionHandler: () => (
    sessionId: string,
    newTaskDraftKey?: string,
  ) => void;
  openSideChat: (options: { initialPrompt?: string }) => void;
  getActiveOrchestrationMode: () => OrchestrationMode;
  setOrchestrationModeActive: (
    mode: Exclude<OrchestrationMode, 'default'>,
    active: boolean,
  ) => Promise<boolean>;
}

export interface RevisionAwareOnSendPorts<TDraft extends RevisionDraftIdentity> extends RevisionSendPorts<TDraft> {
  setNewTaskSendPending: (pending: boolean) => void;
}

/**
 * The exact callback AppShell hands to the composer, built by the same
 * factory in production and in tests. It wraps {@link revisionAwareSend} so
 * the new-task target cannot move out from under a send (#3408).
 * `sendCurrent` captures the draft key it submitted from and clears exactly
 * that key once this resolves; the picker stays live throughout, and the
 * catalog can settle on its own. Holding the flag for the whole call gives
 * the submission one owner, and ChatComposerRegion defers its carry until it
 * drops.
 */
export function createRevisionAwareOnSend<TDraft extends RevisionDraftIdentity>(
  ports: RevisionAwareOnSendPorts<TDraft>,
): (text: string, metadata?: ComposerSendMetadata) => Promise<boolean | void> {
  return async function sendOwningItsTarget(
    text: string,
    metadata?: ComposerSendMetadata,
  ): Promise<boolean | void> {
    ports.setNewTaskSendPending(true);
    try {
      return await revisionAwareSend(ports, text, metadata);
    } finally {
      ports.setNewTaskSendPending(false);
    }
  };
}

/**
 * The submit AppShell hands to the composer, extracted so the unchanged-text
 * edit-and-resend regression test can drive the production ordering
 * (revision prepare -> normal send with the child target) through a real
 * Composer submit instead of calling the prepare helper directly.
 *
 * Moved from AppShellContent.sendWithAttachments; AppShell uses this same
 * function through createRevisionAwareOnSend.
 */
export async function revisionAwareSend<TDraft extends RevisionDraftIdentity>(
  ports: RevisionSendPorts<TDraft>,
  text: string,
  metadata?: ComposerSendMetadata,
): Promise<boolean | void> {
  const revision = ports.revisionDraftRef.current;
  const revisionSend = Boolean(
    revision && ports.activeIdRef.current === revision.draftSessionId,
  );
  const slashCommand = ports.parseSlashCommand(text);
  // Message placement expresses user intent; Host decides admission.
  const sessionId = ports.activeIdRef.current;
  const workspaceFileReferences = ports.mergeWorkspaceReferences(
    text,
    metadata?.workspaceFileReferences,
    sessionId ? ports.retractedWorkspaceReferencesRef.current[sessionId] : undefined,
  );
  const followUpAtSubmit = slashCommand ? undefined : metadata?.followUpMode;
  if (sessionId && followUpAtSubmit) {
    const queued = await ports.enqueueFollowUp(sessionId, text, followUpAtSubmit, {
      ...metadata,
      workspaceFileReferences,
    });
    if (queued) delete ports.retractedWorkspaceReferencesRef.current[sessionId];
    return queued;
  }
  if (revisionSend && revision) {
    const actionCopy = ports.revisionUnavailableCopy;
    if (ports.hasPendingContext) {
      ports.toastApi.info(actionCopy.revisionUnavailableTitle, actionCopy.revisionAttachmentsUnsupported);
      return false;
    }
    if (slashCommand) {
      ports.toastApi.info(actionCopy.revisionUnavailableTitle, actionCopy.revisionCommandUnsupported);
      return false;
    }
    if (!(await ports.prepareRevisionSend(text))) return false;
  }
  if (slashCommand?.kind === 'compact') {
    const compactSessionId = ports.activeIdRef.current;
    if (!compactSessionId) return true;
    return ports.compactSession(compactSessionId);
  }
  if (slashCommand?.kind === 'side') {
    if (!ports.activeIdRef.current) {
      ports.toastApi.info(
        ports.shellCopy.sideChatUnavailableTitle,
        ports.shellCopy.sideChatUnavailableDescription,
      );
      return false;
    }
    if (
      ports.hasPendingContext ||
      ports.hasStagedQuotes ||
      metadata?.workspaceFileReferences?.length
    ) {
      ports.toastApi.info(
        ports.shellCopy.sideChatContextPendingTitle,
        ports.shellCopy.sideChatContextPendingDescription,
      );
      return false;
    }
    ports.openSideChat(
      slashCommand.command.prompt
        ? { initialPrompt: slashCommand.command.prompt }
        : {},
    );
    return true;
  }
  if (slashCommand?.kind === 'swarm') {
    const swarmCommand = slashCommand.command;
    if (swarmCommand.kind === 'status') {
      const active = ports.getActiveOrchestrationMode() === 'swarm';
      ports.toastApi.info(
        active ? ports.shellCopy.swarmModeEnabledTitle : ports.shellCopy.swarmModeDisabledTitle,
        ports.shellCopy.swarmModeStatusDescription,
      );
      return true;
    }
    if (swarmCommand.kind === 'set_mode') {
      const changed = await ports.setOrchestrationModeActive('swarm', swarmCommand.mode === 'swarm');
      if (changed) {
        ports.toastApi.info(
          swarmCommand.mode === 'swarm'
            ? ports.shellCopy.swarmModeEnabledTitle
            : ports.shellCopy.swarmModeDisabledTitle,
          ports.shellCopy.swarmModeStatusDescription,
        );
      }
      return changed;
    }
    const pending = ports.submittableAttachments;
    const quotes = ports.quotesForSend();
    const ok = await ports.send(swarmCommand.task, pending, {
      turnOrchestration: { mode: 'swarm', source: 'slash_command' },
      ...ports.directoryOptions,
      ...(quotes ? { quotes } : {}),
      ...(metadata?.workspaceFileReferences?.length
        ? {
            workspaceFileReferences: ports.rebaseWorkspaceFileReferences(
              text,
              swarmCommand.task,
              metadata.workspaceFileReferences,
            ),
          }
        : {}),
    });
    if (ok !== false) {
      ports.clearSubmittedContext(pending);
      if (quotes) ports.clearQuotes();
      ports.settleNewTaskImageNoticeOwner(sessionId);
    }
    return ok;
  }
  if (slashCommand?.kind === 'graph') {
    const graphCommand = slashCommand.command;
    if (graphCommand.kind === 'status') {
      const active = ports.getActiveOrchestrationMode() === 'graph';
      ports.toastApi.info(
        active ? ports.shellCopy.graphModeEnabledTitle : ports.shellCopy.graphModeDisabledTitle,
        ports.shellCopy.graphModeStatusDescription,
      );
      return true;
    }
    if (graphCommand.kind === 'history') {
      ports.toastApi.info(ports.shellCopy.graphHistoryTitle, ports.shellCopy.graphHistoryDescription);
      return true;
    }
    if (graphCommand.kind === 'set_mode') {
      const changed = await ports.setOrchestrationModeActive('graph', graphCommand.mode === 'graph');
      if (changed) {
        ports.toastApi.info(
          graphCommand.mode === 'graph'
            ? ports.shellCopy.graphModeEnabledTitle
            : ports.shellCopy.graphModeDisabledTitle,
          ports.shellCopy.graphModeStatusDescription,
        );
      }
      return changed;
    }
    const pending = ports.submittableAttachments;
    const quotes = ports.quotesForSend();
    const ok = await ports.send(graphCommand.task, pending, {
      turnOrchestration: { mode: 'graph', source: 'slash_command' },
      ...ports.directoryOptions,
      ...(quotes ? { quotes } : {}),
      ...(metadata?.workspaceFileReferences?.length
        ? {
            workspaceFileReferences: ports.rebaseWorkspaceFileReferences(
              text,
              graphCommand.task,
              metadata.workspaceFileReferences,
            ),
          }
        : {}),
    });
    if (ok !== false) {
      ports.clearSubmittedContext(pending);
      if (quotes) ports.clearQuotes();
      ports.settleNewTaskImageNoticeOwner(sessionId);
    }
    return ok;
  }
  const pending = ports.submittableAttachments;
  const expectedRevisionDraft = revisionSend
    ? ports.revisionDraftRef.current
    : undefined;
  const quotes = ports.quotesForSend();
  const ok = await ports.send(text, pending, {
    waitForHostAdmission: revisionSend,
    targetSessionId: expectedRevisionDraft?.draftSessionId,
    onSessionResolved: ports.resolveNewTaskSessionHandler(),
    ...ports.directoryOptions,
    ...(quotes ? { quotes } : {}),
    ...(workspaceFileReferences.length
      ? { workspaceFileReferences }
      : {}),
  });
  if (ok !== false) {
    ports.clearSubmittedContext(pending);
    if (quotes) ports.clearQuotes();
    ports.settleNewTaskImageNoticeOwner(sessionId);
    if (sessionId) delete ports.retractedWorkspaceReferencesRef.current[sessionId];
  }
  if (ok !== false && revisionSend) {
    if (expectedRevisionDraft) {
      ports.completeRevisionCopyAttempt(expectedRevisionDraft);
      ports.composerRef.current?.clearDraft(expectedRevisionDraft.draftSessionId);
      if (expectedRevisionDraft.sourceSessionId !== expectedRevisionDraft.draftSessionId) {
        ports.composerRef.current?.clearDraft(expectedRevisionDraft.sourceSessionId);
      }
    }
    ports.commitRevisionDraft(null);
  }
  return ok;
}
