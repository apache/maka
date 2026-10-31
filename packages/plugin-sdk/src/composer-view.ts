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
  AgentAttachmentImageRead,
  AgentChecklist,
  AgentComputerApps,
  AgentFileCandidates,
  AgentQueue,
  AgentExecution,
  AgentPlanView,
  AgentResumable,
  AgentQueueAction,
  AgentQueueMessageResult,
  AgentQueueMutationResult,
  AgentSession,
  AgentToolImageRead,
  AgentWorkspacePermissions,
  AgentWorkspaceAccess,
  ClientDraftAttachment,
  CollaborationMode,
  ModelSelection,
  ThinkingLevel,
  WorkspacePath,
} from './generated/runtime.js';
import type { ServiceMethods } from './generated/methods.js';
import type { UiSubscription } from './workbench.js';

export interface ComposerFocusHandle {
  focus(): void;
}

export interface ComposerCommand {
  readonly id: string;
  readonly title: string;
  readonly detail?: string;
  readonly hint?: string;
  readonly trigger: string;
  readonly takesArgument?: boolean;
  run(argument?: string): void | boolean | Promise<void | boolean>;
}

export type ComposerBackend = {
  connectionId: string;
  modelId: string;
  thinkingLevel: ThinkingLevel | null;
} | null;

export type ComposerModelDetails =
  | { kind: 'loading' }
  | { kind: 'unavailable' }
  | {
      kind: 'ready';
      choice: {
        selection: ModelSelection;
        connectionName: string;
        label: string;
        thinkingLevels: ThinkingLevel[];
        defaultThinkingLevel: ThinkingLevel | null;
      };
    };

export interface ComposerSendAction {
  owner: string;
  text: string;
  backend: ComposerBackend;
  attachments: string[];
}

export interface ComposerImagePreview {
  source:
    | { kind: 'tool-image'; read: AgentToolImageRead }
    | { kind: 'attachment-image'; read: AgentAttachmentImageRead };
  uri: string;
  width: number;
  height: number;
  restoreFocus?(): boolean;
}

export interface ComposerAttachmentPickerInput {
  readonly visible: boolean;
  readonly disabled: boolean;
  readonly pathLabel: string;
  readonly pathPlaceholder: string;
  readonly uploadLabel: string;
  readonly uploadingLabel: string;
}

export interface ComposerUploadRow {
  id: string;
  name: string;
  kind: 'reading' | 'uploading' | 'failed' | 'unknown';
  error?: string;
  recovery: 'inspect' | 'recover' | 'recover_or_abandon';
}

export interface ComposerAttachmentTarget {
  owner: string;
  id: string;
}

/** The session owns uploads and receipts; a composer owns their presentation. */
export interface ComposerAttachments<Element = unknown> {
  readonly sessionId: string;
  files(): ClientDraftAttachment[];
  rows(): ComposerUploadRow[];
  ids(): string[];
  picker(): boolean;
  restoring(): boolean;
  error(): string;
  notice(): string;
  recovering(): string | null;
  imageUri(read: AgentAttachmentImageRead): string;
  /** Mount as a component so prop changes retain the native picker owner. */
  renderPicker(input: ComposerAttachmentPickerInput): Element;
  pasteClipboard(onText: (text: string) => void): void;
  dropFiles(uris: string[], onText: (text: string) => void): void;
  open(target: { owner: string; value: boolean }): void;
  remove(target: ComposerAttachmentTarget): void;
  recover(target: ComposerAttachmentTarget): Promise<void>;
  abandon(target: ComposerAttachmentTarget): Promise<void>;
  inspect(target: ComposerAttachmentTarget): Promise<void>;
  retry(): Promise<void>;
  reportError(reason: unknown): void;
  notify(reason: unknown): void;
  clearNotice(): void;
}

export interface ComposerQueue {
  readonly sessionId: string;
  snapshot(): AgentQueue | null;
  running(): boolean;
  read(messageId: string, expectedRevision: number): Promise<AgentQueueMessageResult>;
  change(expectedRevision: number, edit: AgentQueueAction): Promise<AgentQueueMutationResult>;
}

export interface ComposerPermissions {
  readonly sessionId: string;
  snapshot(): AgentSession | null;
  pending(): boolean;
  error(): string;
  select(input: { session: AgentSession; settings: AgentWorkspacePermissions }): Promise<void>;
}

export interface PendingComposerPermissions {
  readonly id: string;
  access(): AgentWorkspaceAccess | null;
  requestPermissions(): boolean | null;
  pending(): boolean;
  selectAccess(access: AgentWorkspaceAccess): void;
  selectRequests(request: boolean): void;
  /**
   * Applied with the sandbox settings once the conversation exists; null when
   * this Agent does not plan.
   */
  mode(): CollaborationMode | null;
  selectMode(mode: CollaborationMode): void;
}

export type ComposerPlanAction =
  | { kind: 'approve'; proposalId: string; proposalRevision: number }
  | { kind: 'revise'; proposalId: string }
  | { kind: 'abandon'; proposalId: string }
  | { kind: 'resume'; executionId: string }
  | { kind: 'cancel'; executionId: string };

export interface ComposerPlan {
  /** Null until the first read; `enabled` says whether this Agent plans at all. */
  view(): AgentPlanView | null;
  mode(): CollaborationMode | null;
  pending(): boolean;
  error(): string;
  selectMode(mode: CollaborationMode): Promise<void>;
  /** Approving or resuming runs the Plan with the conversation's current model. */
  change(action: ComposerPlanAction): Promise<void>;
}

type McpConfiguration = Extract<
  ServiceMethods['agent']['projectMcp']['output'],
  { kind: 'configuration' }
>;

export interface ComposerProjectMcp {
  proposal(): McpConfiguration | null;
  pending(): boolean;
  error(): string;
  notice(): string;
  trust(revision: string): Promise<void>;
  dismiss(): void;
}

export interface ComposerComputerAccess {
  snapshot(): AgentComputerApps;
  stop(operationId: string): Promise<void>;
}

export interface ComposerChecklistSource {
  read(offset: number): Promise<AgentChecklist>;
  watch(offset: number): Promise<UiSubscription<AgentChecklist>>;
}

export interface ComposerCompletionSource {
  files(
    query: string,
    directory: WorkspacePath | null,
  ): Promise<UiSubscription<AgentFileCandidates>>;
  skills(input: {
    query: string;
    model: ModelSelection;
    thinkingLevel: ThinkingLevel | null;
  }): Promise<ServiceMethods['agent']['skillCandidates']['output']>;
  pathLabel(path: WorkspacePath): string;
}

/** A stable projection of the resident session, without its lifecycle or subscriptions. */
export interface ComposerSession<Element = unknown> {
  readonly sessionId: string;
  readonly queue: ComposerQueue;
  readonly attachments: ComposerAttachments<Element>;
  readonly permissions: ComposerPermissions;
  readonly projectMcp: ComposerProjectMcp;
  readonly checklist: ComposerChecklistSource;
  readonly plan: ComposerPlan;
  readonly computerAccess: ComposerComputerAccess;
  readonly completion: ComposerCompletionSource;
  draft(): string;
  previewImage(image: ComposerImagePreview): void;
  editable(): boolean;
  blockedReason(): string;
  backend(): ComposerBackend;
  modelDetails(): ComposerModelDetails;
  refreshModel(): Promise<void>;
  workspace(): string;
  empty(): boolean;
  error(): string;
  notice(): string;
  recoverable(): boolean;
  recovering(): boolean;
  unconfirmed(): string[];
  connected(): boolean;
  invocation(): string | null;
  stopping(): boolean;
  resumable(): AgentResumable | null;
  resuming(): boolean;
  resume(source: AgentExecution, backend: ComposerBackend): Promise<void>;
  metrics(): string;
  /** How much of its model's context the conversation uses, when the model reports a window. */
  contextUsage?(): ComposerContextUsage | null;
  changeDraft(text: string): void;
  submit(event: { text: string }): void;
  sendRendered(action: ComposerSendAction): void;
  recover(): Promise<void>;
  abandon(id: string): Promise<void>;
  stop(invocationId: string | null): Promise<void>;
}

export interface ComposerViewInput<Element = unknown> {
  session(): ComposerSession<Element> | null;
  pending?(): {
    readonly id: string;
    draft(): string;
    workspace(): string;
    permissions: PendingComposerPermissions;
    changeDraft(text: string): void;
    confirmation(): string;
    submit(text: string, expected?: string): void;
    sending(): boolean;
    ready(): boolean;
    files(): { id: string; name: string; bytes: number }[];
    picking(): boolean;
    selectFiles(files: string[]): void;
    pasteClipboard(onText: (text: string) => void): void;
    reportError(reason: unknown): void;
    removeFile(id: string): void;
    openPicker(open: boolean): void;
  } | null;
  attach(node: ComposerFocusHandle): void;
  commands(): ComposerCommand[];
  active(): boolean;
  blocked?(): boolean;
  readonly models: Element;
  readonly request: Element;
  stopAction(): () => void;
  chooseWorkspace(): void;
  settings(): void;
  /** The Host has no model connection: a desktop start pane asks for one first. */
  needsConnection?(): boolean;
  dropFiles?(drop: (event: { uris: string[] }) => void): void;
  /** Files dragged from another application are over the conversation. */
  fileDragging?(): boolean;
}

export type ComposerContextUsage = {
  tokens: number;
  window: number;
  /** The count is an estimate or predates the latest additions. */
  approximate: boolean;
};
