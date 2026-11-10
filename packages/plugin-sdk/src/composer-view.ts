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
  AgentGoalView,
  GoalControl,
  AgentAdjudicateRisk,
  RunId,
  AgentQueueAction,
  AgentQueueMessageResult,
  AgentQueueMutationResult,
  AgentSession,
  AgentToolImageRead,
  AgentWorkspacePermissions,
  AgentWorkspaceAccess,
  ClientDraftAttachment,
  AgentBackendPreference,
  AgentModelChoice,
  WorkspacePath,
  QuoteRef,
} from './generated/runtime.js';
import type { ServiceMethods } from './generated/methods.js';
import type { UiSubscription } from './workbench.js';

export interface ComposerFocusHandle {
  focus(): void;
  bindKey(key: string, action: () => void, options?: { fallback?: boolean }): () => void;
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

export type ComposerBackend = AgentBackendPreference | null;

export type ComposerModelDetails =
  | { kind: 'loading' }
  | { kind: 'unavailable' }
  | { kind: 'ready'; choice: AgentModelChoice };

export interface ComposerSendAction {
  quotes: QuoteRef[];
  owner: string;
  text: string;
  backend: ComposerBackend;
  attachments: string[];
  delivery?: 'steer' | 'queue';
}

export interface ComposerSendStatus {
  id: string;
  text: string;
  attachments: ClientDraftAttachment[];
  state: 'sending' | 'accepted' | 'failed' | 'unknown';
  detail: string;
  retryable: boolean;
  busy: boolean;
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
}

export interface ComposerGoal {
  view(): AgentGoalView | null;
  pending(): boolean;
  error(): string;
  create(objective: string, tokenBudget: number | null): Promise<boolean>;
  change(action: GoalControl, budget?: { tokenBudget: number | null }): Promise<boolean>;
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

/** A suggested draft is separate from the text the user is editing. */
export interface ComposerPrediction {
  current(): { sourceTurnId: string; text: string } | null;
  dismiss(sourceTurnId: string): void;
}

export interface ComposerChecklistSource {
  read(offset: number, limit?: number): Promise<AgentChecklist>;
  watch(offset: number): Promise<UiSubscription<AgentChecklist>>;
}

export interface ComposerCompletionSource {
  files:
    | ((
        query: string,
        directory: WorkspacePath | null,
      ) => Promise<UiSubscription<AgentFileCandidates>>)
    | null;
  skills(input: {
    query: string;
    backend: AgentBackendPreference;
  }): Promise<ServiceMethods['agent']['skillCandidates']['output']>;
  pathLabel(path: WorkspacePath): string;
}

/** A terminal source observed at its exact Run-local fence. Continuing admits a new Run. */
export interface ComposerContinuation {
  readonly source: AgentExecution & {
    readonly state: Extract<
      AgentExecution['state'],
      { kind: 'completed' | 'failed' | 'cancelled' }
    >;
  };
}

/** A stable projection of the resident session, without its lifecycle or subscriptions. */
export interface ComposerSession<Element = unknown> {
  quotes(): QuoteRef[];
  removeQuote(index: number): void;
  readonly sessionId: string;
  readonly prediction: ComposerPrediction;
  readonly queue: ComposerQueue;
  readonly attachments: ComposerAttachments<Element>;
  readonly permissions: ComposerPermissions;
  readonly projectMcp: ComposerProjectMcp;
  readonly checklist: ComposerChecklistSource;
  readonly goal?: ComposerGoal;
  readonly computerAccess: ComposerComputerAccess;
  readonly completion: ComposerCompletionSource;
  draft(): string;
  previewImage(image: ComposerImagePreview): void;
  editable(): boolean;
  loading(): boolean;
  blockedReason(): string;
  backend(): ComposerBackend;
  modelDetails(): ComposerModelDetails;
  refreshModel(): Promise<void>;
  workspace(): string;
  empty(): boolean;
  error(): string;
  notice(): string;
  sends(): ComposerSendStatus[];
  retrySend(id: string): Promise<void>;
  checkSend(id: string): Promise<void>;
  dismissSend(id: string): Promise<void>;
  recovering(): boolean;
  connected(): boolean;
  run(): RunId | null;
  execution(): AgentExecution | null;
  stopping(): boolean;
  continuation(): ComposerContinuation | null;
  continuing(): boolean;
  continueRun(source: AgentExecution, backend: ComposerBackend): Promise<void>;
  adjudicating(): boolean;
  adjudicateRisk(input: AgentAdjudicateRisk): Promise<void>;
  metrics(): string;
  /** How much of its model's context the conversation uses, when the model reports a window. */
  contextUsage?(): ComposerContextUsage | null;
  changeDraft(text: string): void;
  submit(event: { text: string }): void;
  sendRendered(action: ComposerSendAction): void;
  stop(runId: RunId | null): Promise<void>;
}

export interface ComposerViewInput<Element = unknown> {
  session(): ComposerSession<Element> | null;
  pending?(): {
    readonly id: string;
    readonly completion: ComposerCompletionSource;
    draft(): string;
    workspace(): string;
    backend(): ComposerBackend;
    modelDetails(): ComposerModelDetails;
    permissions: PendingComposerPermissions;
    changeDraft(text: string): void;
    confirmation(): string;
    submit(text: string, expected?: string): void;
    sending(): boolean;
    ready(): boolean;
    files(): { id: string; name: string; bytes: number; imageUri: string | null }[];
    picking(): boolean;
    selectFiles(files: string[]): void;
    dropFiles(uris: string[], onText: (text: string) => void): void;
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
  /** Optional product-owned directory switcher, in the existing composer location. */
  readonly workspacePicker?: Element;
  settings(): void;
  /** The Host has no model connection: a desktop start pane asks for one first. */
  needsConnection?(): boolean;
  dropFiles?(drop: (event: { uris: string[] }) => void): void;
  /** Files dragged from another application are over the conversation. */
  fileDragging?(): boolean;
}

export type ComposerContextUsage = {
  outputTokensPerSecond: number | null;
  tokens: number;
  window: number;
  /** The count is an estimate or predates the latest additions. */
  approximate: boolean;
};
