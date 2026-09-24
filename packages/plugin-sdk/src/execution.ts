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

import type { Interaction, InteractionOutcome, InteractionPrompt } from './interaction.js';
import type { Json } from './host.js';
import type { ThinkingLevel } from './providers.js';

export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';

export type ApprovalPolicy =
  | { readonly kind: 'on-request' | 'never' }
  | {
      readonly kind: 'granular';
      readonly sandbox: boolean;
      readonly rules: boolean;
      readonly permissions: boolean;
      readonly client: boolean;
    };

export interface Invocation {
  session_id: string;
  turn_id: string;
  run_id: string;
  invocation_id: string;
}
export type AttachmentLocation =
  | { kind: 'session_file'; sessionId: string; relativePath: string }
  | { kind: 'workspace_file'; relativePath: string }
  | { kind: 'external_file'; absolutePath: string }
  | { kind: 'session_context'; sessionId: string; refId: string };
export interface Attachment {
  kind: 'image' | 'pdf' | 'doc' | 'code' | 'other';
  name: string;
  mimeType: string;
  bytes: number;
  ref: AttachmentLocation;
}
export interface MessageContent {
  text: string;
  display_text?: string | null;
  attachments?: readonly Attachment[] | null;
  quotes?: readonly { text: string; label?: string; sourceTurnId?: string }[] | null;
  directory_references?: readonly { hostId: string; path: string }[] | null;
  inline_references?:
    | readonly {
        kind: 'skill' | 'workspace_file';
        value: string;
        label: string;
        start: number;
      }[]
    | null;
}
export interface ExecutionReceipt {
  invocation: Invocation;
  messageId: string;
  contentDigest: string;
}
export interface Enqueue {
  operationId: string;
  messageId: string;
  invocation: Invocation;
  content: MessageContent;
  placement: 'current_turn' | 'next_turn';
}
export interface MessageReceipt {
  invocation: Invocation;
  messageId: string;
  requestDigest: string;
}
export interface MessageObservation {
  receipt: MessageReceipt;
  state:
    | { state: 'pending' | 'cancelled' }
    | {
        state: 'delivered';
        invocation: Invocation;
        exclusive: boolean;
        progress: ExecutionObservation['progress'];
        answer: { text: string; complete: boolean; next: AnswerCursor | null } | null;
        interactions: {
          requestId: string;
          kind: 'question' | 'form' | 'permissions' | 'client_capability';
        }[];
      };
}
export interface AnswerCursor {
  invocationId: string;
  /** UTF-8 byte offset within the exact terminal answer. */
  offset: number;
}
export interface WorkspacePatch {
  artifactId: string;
  sessionId: string;
  turnId: string;
  bytes: number;
  baseCommit: string;
}
export type ExecutionOutcome =
  | { kind: 'completed' }
  | { kind: 'cancelled'; source: string }
  | { kind: 'failed'; class: string; message: string | null }
  | { kind: 'handoff_paused'; pause: Json }
  | { kind: 'context_compact_finished'; outcome: Json };
export interface ExecutionObservation {
  receipt: ExecutionReceipt;
  progress:
    | { state: 'pending' | 'running' | 'waiting_for_user' | 'paused' }
    | { state: 'ended'; outcome: ExecutionOutcome };
  /** Pass this exact fence to events/event for a consistent view. */
  throughSequence: number;
  /** Exact canonical outcome record; absent until execution has settled. */
  terminalEventId?: string;
  /** Stable current interaction-set or handoff identity; unrelated log writes do not change it. */
  attentionId?: string;
}
export interface LogEvent {
  sequence: number;
  event: {
    id: string;
    recorded_at: { secs_since_epoch: number; nanos_since_epoch: number };
    invocation: Invocation;
    /** Canonical, versioned by Host; validate fact kinds before interpreting payloads. */
    fact: Json;
  };
}
export type ExecutionTarget =
  | {
      kind: 'model';
      model: { connection_id: string; connection_slug: string; model: string };
      thinkingLevel?: ThinkingLevel | null;
    }
  | { kind: 'executor'; executorId: string; settings?: ExecutorSettings };

/** Selection belongs to the executor; no Host model connection is implied. */
export type ExecutorSettings = {
  model?: string;
  thinkingLevel?: ThinkingLevel;
};
export interface SessionConfiguration {
  sessionId: string;
  revision: number;
  name: string;
  boundaryRevision: number;
  workspace: {
    target: { kind: 'project'; projectId: string } | { kind: 'host_path'; path: string };
    hostCwd: string;
  };
  target: ExecutionTarget;
  sandboxMode: SandboxMode;
  approvalPolicy: ApprovalPolicy;
  collaborationMode: 'agent' | 'plan';
  behavior: string;
  boundTools: readonly string[] | null;
}
export interface CreateChild {
  operationId: string;
  parentSessionId: string;
  name: string;
  /** May narrow the parent's current permission, never widen it. */
  sandboxMode?: SandboxMode;
  /** Intersected with the parent's ceiling, including future dynamic tools. */
  boundTools?: readonly string[];
  /** Appended to inherited instructions; the combined budget is 16 KiB UTF-8. */
  instructions?: string;
  /** Isolated Git workspaces are Host-owned and persist across child turns. */
  workspace?: 'inherit' | 'isolated_git';
  target?: ExecutionTarget;
}

export type Configured =
  | { kind: 'committed'; session: SessionConfiguration }
  | { kind: 'revision_conflict'; expectedRevision: number; actualRevision: number };

/** Durable acceptance; resource cleanup may still be pending. */
export interface RemovalReceipt {
  sessionId: string;
  archivedSubtaskCount: number;
}

export interface Executions {
  /** Every directly removed revision-family member must be authorized. */
  removeSession(input: {
    sessionId: string;
    expectedRevision: number;
  }): Promise<
    | { kind: 'removed'; receipt: RemovalReceipt }
    | { kind: 'revision_conflict'; expectedRevision: number; actualRevision: number }
  >;
  /** Recover acceptance without requiring the deleted catalog record. */
  removalReceipt(sessionId: string): Promise<RemovalReceipt | null>;
  /** Advisory dependent-family count, recomputed and authorized on removal. */
  previewRemoval(sessionId: string): Promise<number>;
  /** Host-local immutable copy; both capability endpoints require current authority. */
  copyAttachment(
    source: Executions,
    targetSessionId: string,
    attachment: Attachment,
  ): Promise<Attachment>;
  /** Original message of this exact logical execution, including handoff predecessors. */
  input(invocation: Invocation): Promise<MessageContent | null>;
  /** Resume this exact sealed model Run; retries preserve its canonical receipt. */
  resume(input: { operationId: string; source: Invocation }): Promise<Invocation>;
  /** Every committed choice advances revision, including identical values. */
  configure(input: {
    sessionId: string;
    expectedRevision: number;
    target: ExecutionTarget;
  }): Promise<Configured>;
  /** Exact authorized Session/message, including non-plugin input. Null is not proof of delivery. */
  readMessage(input: {
    sessionId: string;
    messageId: string;
    cursor?: AnswerCursor | null;
  }): Promise<MessageObservation['state'] | null>;
  /** Exact owner; a finished Run never turns this request into new root work. */
  enqueue(input: Enqueue): Promise<MessageReceipt>;
  message(operationId: string): Promise<MessageObservation>;
  /** Only retract pending input; delivery is not authority to stop shared work. */
  retract(operationId: string): Promise<MessageObservation>;
  /** Idempotent, package/scope-owned user input. Cannot create permission requests. */
  offerInteraction(input: {
    operationId: string;
    invocation: Invocation;
    prompt: InteractionPrompt;
  }): Promise<Interaction>;
  interaction(operationId: string): Promise<Interaction | null>;
  /** Cancellation ends observation, not the accepted request. */
  waitInteraction(operationId: string): Promise<InteractionOutcome>;
  /** Never replaces an already committed user answer. */
  closeInteraction(operationId: string): Promise<Interaction>;
  /** Requires workspace execution consent; never derives authority from a path. */
  createRoot(input: {
    /** Restrict admission/configuration to this package and scope. */
    managed?: boolean;
    operationId: string;
    name: string;
    settings: {
      target: ExecutionTarget;
      sandboxMode: SandboxMode;
      approvalPolicy: ApprovalPolicy;
      collaborationMode: 'agent' | 'plan';
      behavior: string;
      boundTools?: readonly string[] | null;
      instructions?: string | null;
    };
  }): Promise<{ sessionId: string }>;
  /** Recover a root created by this package/scope under current workspace/source ceilings.
   * Never creates or reconfigures it; null does not rule out a concurrent creation.
   */
  restoreRoot(operationId: string): Promise<{ sessionId: string } | null>;
  /** Same workspace grant as root creation. Append at most eight records per
   * request; exact retries retain their receipt. Only publish exposes the Session.
   */
  importSession(
    command: import('./session-import.js').SessionImportCommand,
  ): Promise<import('./session-import.js').SessionImportReceipt>;
  /** Only unused owned revisions disappear. Accepted work and exact retries retain their facts. */
  abandonRevision(operationId: string): Promise<'abandoned' | 'retained'>;
  /** Reads only an authorized Session, never the global catalog. */
  session(sessionId: string): Promise<SessionConfiguration>;
  /** Registered plugin tools/executors visible within this Session's ceiling, not a grant. */
  capabilities(
    sessionId: string,
  ): Promise<{ tools: readonly string[]; executors: readonly string[] }>;
  /** Current ownership, including queued work and cleanup; not a durable intent. */
  activity(sessionId: string): Promise<{
    execution: {
      invocation: Invocation;
      behavior: string | null;
      progress: ExecutionObservation['progress'];
    } | null;
    busy: boolean;
  }>;
  /** Stop this exact logical execution; never retarget a retry to a later Turn.
   * Completion confirms the request, not that all resource cleanup has finished. */
  stop(invocation: Invocation): Promise<void>;
  /** Uses current source authorization and the captured Session ceiling. */
  submit(input: {
    operationId: string;
    sessionId: string;
    content: MessageContent;
    /** Applies to this execution without changing the Session default. */
    orchestrationMode?: string;
  }): Promise<ExecutionReceipt>;
  createChild(input: CreateChild): Promise<{ sessionId: string }>;
  /** Recover an existing child without creating a Session or workspace. */
  restoreChild(input: CreateChild): Promise<{ sessionId: string } | null>;
  /** Requires settled workspace writers; retries return the same immutable Artifact. */
  workspacePatch(operationId: string): Promise<WorkspacePatch | null>;
  query(operationId: string): Promise<ExecutionObservation>;
  cancel(operationId: string): Promise<ExecutionObservation>;
  events(input: {
    operationId: string;
    after: number;
    through: number;
  }): Promise<{ events: LogEvent[]; throughSequence: number; nextAfter: number | null }>;
  /** Reads at most 64 KiB from this operation's Turn, never a global artifact ID. */
  artifact(input: {
    operationId: string;
    artifactId: string;
    offset: number;
    limit: number;
  }): Promise<{ bytes: readonly number[]; totalBytes: number } | null>;
  event(input: { operationId: string; eventId: string; through: number }): Promise<LogEvent | null>;
}
