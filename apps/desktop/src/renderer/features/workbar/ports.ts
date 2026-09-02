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

import type {
  QuoteRef,
  SessionEvent,
  ShellRunUpdate,
} from '@maka/core/events';
import type {
  ArtifactBinaryReadResult,
  ArtifactChangedEvent,
  ArtifactDescriptor,
  ArtifactSaveResult,
  ArtifactTextReadResult,
} from '@maka/core/artifacts';
import type { BrowserState, BrowserViewRect } from '@maka/core/browser';
import type { GitReviewReadResult, GitReviewSource } from '@maka/core/git-review';
import type { PermissionMode } from '@maka/core/permission';
import type { RegenerateTurnInput } from '@maka/core/runtime-inputs';
import type { SandboxBoundaryResponse } from '@maka/core/sandbox-boundary';
import type { ClientCapabilityResponse } from '@maka/core/client-capability-grant';
import type {
  SessionChangedEvent,
  SessionSummary,
  StoredMessage,
  TurnRecord,
} from '@maka/core/session';
import type { SessionTrace } from '@maka/core/session-trace';
import type { SessionTodoItem } from '@maka/core/session-todo';
import type { UserQuestionResponse } from '@maka/core/user-question';
import type { Result } from '@maka/core/result';
import type { ContextDiagnosticsResult } from '@maka/runtime-host/protocol';
import type { MergedUsageSummary } from '@maka/core/usage-ledger-merge';
import type {
  ShellRunPtyDataEvent,
  ShellRunPtySnapshot,
} from '@maka/runtime/shell-run-contract';

export type WorkbarUnsubscribe = () => void;

export type WorkbarIngestInput =
  | { approvalId: string; name: string; mimeType?: string }
  | { file: File };

export interface WorkbarReviewService {
  read(input: {
    sessionId: string;
    source: GitReviewSource;
    baseBranch?: string;
  }): Promise<GitReviewReadResult>;
  subscribeSessionEvents(
    sessionId: string,
    handler: (event: SessionEvent) => void,
  ): WorkbarUnsubscribe;
}

export interface WorkbarTerminalService {
  start(sessionId: string): Promise<ShellRunUpdate>;
  stop(input: { sessionId: string; ref: string }): Promise<ShellRunUpdate | null>;
  attach(input: {
    sessionId: string;
    ref: string;
  }): Promise<ShellRunPtySnapshot | null>;
  detach(input: { sessionId: string; ref: string }): Promise<void>;
  write(input: {
    sessionId: string;
    ref: string;
    input?: string;
    size?: { cols: number; rows: number };
  }): Promise<ShellRunUpdate | null>;
  subscribePtyData(
    handler: (event: ShellRunPtyDataEvent) => void,
  ): WorkbarUnsubscribe;
  subscribeResync(
    handler: (event: { sessionId: string }) => void,
  ): WorkbarUnsubscribe;
}

export interface WorkbarTodoService {
  read(sessionId: string): Promise<SessionTodoItem[]>;
  subscribeChanges(
    handler: (event: { sessionId: string; at: number }) => void,
  ): WorkbarUnsubscribe;
}

export interface WorkbarBrowserService {
  setActiveSession(sessionId: string | null): void;
  setViewport(input: { sessionId: string; rect: BrowserViewRect | null }): void;
  navigate(sessionId: string, url: string): Promise<void>;
  back(sessionId: string): Promise<void>;
  forward(sessionId: string): Promise<void>;
  reload(sessionId: string): Promise<void>;
  stop(sessionId: string): Promise<void>;
  close(sessionId: string): Promise<void>;
  getState(sessionId: string): Promise<BrowserState | null>;
  subscribeState(
    handler: (payload: { sessionId: string; state: BrowserState }) => void,
  ): WorkbarUnsubscribe;
  subscribeLive(
    handler: (payload: { sessionIds: string[] }) => void,
  ): WorkbarUnsubscribe;
}

export type WorkbarOpenArtifactResult =
  | { ok: true; opened: string }
  | {
      ok: false;
      reason:
        | 'unknown-key'
        | 'not-allowed'
        | 'missing'
        | 'not-a-directory'
        | 'open-failed';
    };

export interface WorkbarArtifactsService {
  list(
    sessionId: string,
    options?: { includeDeleted?: boolean },
  ): Promise<ArtifactDescriptor[]>;
  readText(
    sessionId: string,
    artifactId: string,
  ): Promise<ArtifactTextReadResult>;
  readBinary(
    sessionId: string,
    artifactId: string,
  ): Promise<ArtifactBinaryReadResult>;
  delete(sessionId: string, artifactId: string): Promise<void>;
  subscribeChanges(
    handler: (event: ArtifactChangedEvent) => void,
  ): WorkbarUnsubscribe;
  openPath(
    sessionId: string,
    artifactId: string,
  ): Promise<WorkbarOpenArtifactResult>;
  saveAs(sessionId: string, artifactId: string): Promise<ArtifactSaveResult>;
}

export interface WorkbarSessionTracePage {
  readonly trace: SessionTrace;
  readonly nextCursor: string | null;
}

export type WorkbarSessionUsageSummary = MergedUsageSummary;

export interface WorkbarInspectorService {
  trace(
    sessionId: string,
    cursor?: string,
  ): Promise<Result<WorkbarSessionTracePage>>;
  summary(sessionId: string): Promise<Result<WorkbarSessionUsageSummary>>;
  context(sessionId: string): Promise<Result<ContextDiagnosticsResult>>;
  subscribeSessionEvents(
    sessionId: string,
    handler: (event: SessionEvent) => void,
  ): WorkbarUnsubscribe;
  subscribeUsageChanges(
    sessionId: string,
    handler: () => void,
  ): WorkbarUnsubscribe;
}

export interface WorkbarAttachmentsService {
  readBytes(sessionId: string, artifactId: string): Promise<ArtifactBinaryReadResult>;
  pickFiles(): Promise<
    | {
        ok: true;
        files: Array<{
          approvalId: string;
          name: string;
          mimeType?: string;
          size: number;
        }>;
      }
    | { ok: false; reason: 'cancelled' }
  >;
  previewApproval(approvalId: string): Promise<
    | { ok: true; base64: string; mimeType: string }
    | { ok: false; reason: string }
  >;
}

export type SideChatSendResult =
  | { ok: true; turnId: string; steered?: false }
  | { ok: true; turnId: string; steered: true; messageId: string }
  | { ok: false; reason: 'outcome_unknown'; messageId: string }
  | { ok: false; reason?: string; messageId?: never };

export type SideChatSteerResult =
  | { kind: 'queued'; messageId: string }
  | { kind: 'outcome_unknown'; messageId: string }
  | { kind: 'started'; turnId: string };

export type SideChatStopTarget =
  | { readonly kind: 'admission'; readonly messageId: string }
  | { readonly kind: 'turn'; readonly turnId: string };

export interface SideChatSessionPort {
  listSessions(): Promise<SessionSummary[]>;
  listTurns(sessionId: string): Promise<TurnRecord[]>;
  readSettledMessages(
    sessionId: string,
    options?: { requiredAssistantMessageId?: string },
  ): Promise<{ messages: StoredMessage[]; settled: boolean }>;
  branchFromTurn(
    sessionId: string,
    input: {
      sourceTurnId: string;
      name?: string;
      copyId: string;
      sideConversation: true;
    },
  ): Promise<
    | { ok: true; session: SessionSummary }
    | { ok: false; reason: 'session_busy' | 'operation_unavailable' }
  >;
  cleanupSessionCopy(sessionId: string): Promise<void>;
  abandonSessionCopy(sourceSessionId: string, copyId: string): Promise<void>;
  send(
    sessionId: string,
    command: {
      type: 'send';
      turnId: string;
      text: string;
      quotes?: QuoteRef[];
      attachmentItems?: WorkbarIngestInput[];
    },
  ): Promise<SideChatSendResult>;
  stop(
    sessionId: string,
    target?: SideChatStopTarget,
  ): Promise<{ kind: 'retracted'; messageId: string } | undefined>;
  steer(sessionId: string, text: string, admissionId?: string): Promise<SideChatSteerResult>;
  setPermissionMode(
    sessionId: string,
    mode: PermissionMode,
  ): Promise<SessionSummary>;
  regenerateTurn(sessionId: string, input: RegenerateTurnInput): Promise<void>;
  respondToSandboxBoundary(
    sessionId: string,
    response: SandboxBoundaryResponse,
  ): Promise<void>;
  respondToClientCapability(
    sessionId: string,
    response: ClientCapabilityResponse,
  ): Promise<void>;
  respondToUserQuestion(
    sessionId: string,
    response: UserQuestionResponse,
  ): Promise<void>;
  subscribeEvents(
    sessionId: string,
    handler: (event: SessionEvent) => void,
    onSeeded?: () => void,
    onSeedError?: (error: unknown) => void,
  ): WorkbarUnsubscribe;
  subscribeSessionChanges(handler: (event: SessionChangedEvent) => void): WorkbarUnsubscribe;
}

export interface WorkbarServices {
  readonly review: WorkbarReviewService;
  readonly terminal: WorkbarTerminalService;
  readonly todo: WorkbarTodoService;
  readonly browser: WorkbarBrowserService;
  readonly artifacts: WorkbarArtifactsService;
  readonly inspector: WorkbarInspectorService;
  readonly attachments: WorkbarAttachmentsService;
  readonly sideChat: SideChatSessionPort;
}
