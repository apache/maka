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

import type { Executions, ExecutorSettings, Invocation, MessageContent } from './execution.js';
import type { Processes } from './process.js';
import type { Terminals } from './terminal.js';
import type { Credentials } from './credentials.js';
import type { Http } from './http.js';
import type { Files, ReadDirectory, FileEntries } from './filesystem.js';

export type * from './execution.js';
export type * from './interaction.js';
export type * from './process.js';
export type * from './terminal.js';
export type * from './credentials.js';
export type * from './http.js';
export type * from './filesystem.js';
export type * from './database.js';
export type * from './llm.js';
export type * from './models.js';
export type * from './providers.js';
export type * from './clients.js';
export type * from './history.js';
export type * from './session-import.js';
export type * from './terminal-view.js';
export type * from './usage.js';
export type * from './pricing.js';

/** Independent API version, used by runtime.sdkVersion in maka.extension.json. */
export const HOST_SDK_VERSION = 1;
export type Json =
  | null
  | boolean
  | number
  | string
  | readonly Json[]
  | { readonly [key: string]: Json };
export type Awaitable<T> = T | PromiseLike<T>;
export interface Registration {
  /** Revokes this exact registration, never a newer replacement. Idempotent. */
  close(): Promise<void>;
}
export interface Cancellation {
  readonly aborted: boolean;
  wait(): Promise<void>;
  throwIfAborted(): void;
}
export interface Identity {
  readonly packageId: string;
  readonly entryId: string;
  readonly scope: 'profile' | 'desktop-ui' | `session:${string}`;
  readonly activation: string;
  /** Inspection only; not a durable identifier. */
  readonly generation: number;
}

/** User-facing Client calls, never an Agent tool invocation or implicit process grant. */
export interface RemoteCaller {
  readonly clientInstanceId: string;
  readonly documentId: string;
  readonly sessionId: string | null;
  readonly signal: Cancellation;
  readonly views: {
    authorize<T>(
      request: import('./authorization.js').AuthorizationRequest,
      use: (call: ResourceContext) => Awaitable<T>,
    ): Promise<T>;
    session(): Promise<SessionView>;
    workspace(input: WorkspaceViewInput): Promise<SessionView>;
    queryDatabase(
      input: import('./database.js').DatabaseRead,
    ): Promise<readonly import('./database.js').DatabaseTable[]>;
  };
}
export interface WorkspaceViewInput {
  workspace: { kind: 'project'; projectId: string } | { kind: 'host_path'; path: string };
  sandboxMode: 'read-only' | 'workspace-write' | 'danger-full-access';
  collaborationMode: 'agent' | 'plan';
}
export interface SessionView {
  /** Borrowed for this Remote callback; current credentials and workspace are rechecked. */
  readonly files: ReadDirectory;
  workspace: { target: WorkspaceViewInput['workspace']; hostCwd: string };
  tools: readonly string[];
}
export interface RemoteOptions {
  /** Host rejects the endpoint for callers without path access. */
  access?: 'granted' | 'host_paths';
}
export interface RemoteMethodOptions extends RemoteOptions {
  /** Navigation is bound to this exact Remote registration. */
  terminalView?: import('./terminal-view.js').TerminalView;
}
/** Throw an Error carrying this code to preserve its meaning across Remote.
 * Unclassified exceptions become unavailable. An unknown outcome requires
 * domain recovery; it does not imply that the plugin failed to clean up.
 */
export interface RemoteFailure extends Error {
  readonly code: 'invalid' | 'revoked' | 'cancelled' | 'outcome_unknown' | 'unavailable';
}
export interface RemoteStream<T extends Json> {
  next(): Awaitable<IteratorResult<T, void>>;
  /** Signal synchronously; unblock any pending next(). */
  cancel(): void;
  close(): Awaitable<void>;
}
export interface Services {
  get<Input = Json, Output = Json>(name: string): Promise<Service<Input, Output> | undefined>;
}
export interface Service<Input, Output> extends Registration {
  call(input: Input): Promise<Output>;
}
export type CallSource =
  | { readonly kind: 'agent'; readonly invocation: Invocation; readonly operationId: string | null }
  | { readonly kind: 'remote'; readonly requestId: string }
  | { readonly kind: 'background'; readonly grant: string };
export interface ResourceContext {
  /** Borrow this call's execution authority; close the view after use. */
  readonly executions: { open(): Promise<Executions & Registration> };
  readonly signal: Cancellation;
  readonly processes: Processes;
  readonly terminals: Terminals;
  readonly http: Http;
  /** Agent execution additions; independent work uses explicit authorization. */
  readonly permissions: import('./permissions.js').Permissions;
  /** Metadata only; Agent scopes see their own Session, independent scopes require read_sessions. */
  readonly sessions: {
    list(
      input?: import('./history.js').SessionCatalogInput,
    ): Promise<import('./history.js').SessionCatalogPage>;
  };
  /** Trusted Agent recall reads the Host profile; independent scopes use read_history. */
  readonly history: import('./history.js').History;
  readonly usage: import('./usage.js').Usage;
  readonly pricing: import('./pricing.js').Prices;
  readonly files: Files;
  readonly llm: import('./llm.js').Llm;
  readonly clients: import('./clients.js').ClientCapabilities;
  readonly services: Services;
}
export interface CallContext extends ResourceContext {
  readonly invocation: Invocation;
  readonly operationId?: string | null;
}
export type ServiceContext = { readonly configuration: readonly Json[] } & (
  | (ResourceContext & {
      readonly source: CallSource;
      readonly invocation?: Invocation | null;
      readonly operationId?: string | null;
    })
  | { readonly signal: Cancellation; readonly invocation?: undefined; readonly source?: undefined }
);
/** Provider-executed SDK contract; no local invoke function or implicit permission. */
export interface ProviderTool {
  readonly id: string;
  readonly args: { readonly [key: string]: Json };
}
export interface ModelToolContext {
  readonly model: string;
  readonly providerTools: 'openai_responses' | 'anthropic_messages' | null;
  readonly capabilities: {
    readonly chat?: boolean;
    readonly vision?: boolean;
    readonly reasoning?: boolean;
    readonly functionCalling?: boolean;
    readonly parallelToolCalls?: boolean;
    readonly imageGeneration?: boolean;
    readonly webSearch?: boolean;
  };
}
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Json;
  provider?: ProviderTool;
  directOnly?: boolean;
  alwaysVisible?: boolean;
  semantics?: 'parallel' | 'exclusive_step' | 'finish_turn';
}
export interface ExecutorDefinition {
  name: string;
  displayName: string;
  capabilities?: {
    thinking?: boolean;
    toolActivity?: boolean;
    attachments?: boolean;
    /** Can initialize from Host-owned copied history; opaque provider state is never copied. */
    historyCopy?: boolean;
  };
}
export type ExecutorChoice = {
  id: string;
  displayName: string;
  capabilities: {
    thinking: boolean;
    toolActivity: boolean;
    attachments: boolean;
    historyCopy: boolean;
  };
};
export type ExecutorChoices = {
  revision: number;
  executors: readonly ExecutorChoice[];
  complete: boolean;
};
export interface ExecutorRequest {
  settings: ExecutorSettings;
  invocation: Invocation;
  conversationKey: string;
  content: MessageContent;
  cwd: string;
  instructions: string | null;
}
export type ExecutorOutput =
  | { type: 'output_delta' | 'thinking_delta'; text: string }
  | { type: 'tool_start'; toolCallId: string; name: string; input: Json }
  | { type: 'tool_progress'; toolCallId: string; text: string }
  | { type: 'tool_result'; toolCallId: string; text: string; isError?: boolean };
export type ExecutorOutcome =
  | { status: 'completed'; text: string }
  | { status: 'cancelled'; reason?: string | null }
  | { status: 'failed'; message: string; code?: string | null; recoverable?: boolean };
export interface ExecutorContext extends CallContext {
  /** Resolves after durable recording. Tool activity is observation, not dispatch. */
  emit(output: ExecutorOutput): Promise<void>;
}
export type TextProvider =
  | string
  | ((
      request: PromptRequest,
      call: { signal: Cancellation; workspace: ReadDirectory },
    ) => Awaitable<string | null | undefined>);
export type PromptRequest =
  | { readonly kind: 'session'; readonly sessionId: string; readonly cwd: string }
  | { readonly kind: 'model_step'; readonly invocation: Invocation; readonly cwd: string };
export interface PromptSection {
  /** Use plain for resolved or user-authored text; template interpolates registered variables. */
  format?: 'plain' | 'template';
  name: string;
  order?: number;
  text: TextProvider;
}
export type StorageData = { kind: 'present'; value: Json } | { kind: 'deleted' };
export interface StorageRecord {
  revision: number;
  data: StorageData;
}
export interface StorageMutation {
  key: string;
  /** null means the key must never have existed; deletions retain a revision. */
  expectedRevision: number | null;
  data: StorageData;
}
/** Process-local observation; never persist it or treat it as permission. */
export interface PreparationBasis {
  readonly handle: string;
  readonly version: number;
}
export interface PreparationRevision extends Registration {
  /** Capture before reading the domain state used for preparation. */
  capture(): Promise<PreparationBasis>;
  /** Order the domain update with accepted preparations; the callback owns its transaction. */
  invalidate<T>(update: () => Awaitable<T>): Promise<T>;
}
export interface BehaviorPreparation {
  basis?: PreparationBasis;
  instructions?: string;
  nativeTools?: 'workspace' | 'attachments';
  requiredClients?: {
    required: readonly string[];
    optional?: readonly string[];
    private?: readonly string[];
  } | null;
  toolCeiling?: readonly string[] | null;
}
export interface HostContext {
  revision(): Promise<PreparationRevision>;
  /** Explicitly shared non-secret inputs, never ambient home or Host state access. */
  readonly inputs: {
    names(): Promise<readonly string[]>;
    at(name: string): ReadDirectory;
  };
  /** Opens current background authority and confirms cleanup after the callback. */
  withAuthorization<T>(
    id: string,
    use: (
      call: ResourceContext & { readonly source: CallSource },
      grant: import('./authorization.js').AuthorizationGrant,
      boundary: import('./authorization.js').AuthorizationBoundary,
    ) => Awaitable<T>,
  ): Promise<T>;
  readonly behaviors: {
    /** Preparation narrows capabilities; it never grants execution authority.
     * Close/re-register when the source changes to invalidate stale admissions.
     */
    register(
      name: string,
      prepare: (
        request: { readonly session: import('./execution.js').SessionConfiguration },
        call: { readonly signal: Cancellation },
      ) => Awaitable<BehaviorPreparation>,
    ): Promise<Registration>;
  };
  readonly background: {
    /** Prevent idle expiry while durable work remains; grants no execution authority.
     * Close when idle. Restore intent and register again after activation.
     * System-resume notifications are coalesced and serial, not a timer or task scheduler.
     * Close never waits for the active wake callback; it may close its own registration.
     */
    pending(name: string, wake: (signal: Cancellation) => Awaitable<void>): Promise<Registration>;
  };
  readonly input: {
    /** Pure preparation. Close/re-register when its source changes to revoke stale admissions. */
    prepare(
      name: string,
      prepare: (request: InputPreparationRequest) => Awaitable<InputPreparationOutcome>,
    ): Promise<Registration>;
  };
  readonly remote: {
    method<I extends Json, O extends Json>(
      name: string,
      invoke: (input: I, caller: RemoteCaller) => Awaitable<O>,
      options?: RemoteMethodOptions,
    ): Promise<Registration>;
    stream<I extends Json, O extends Json>(
      name: string,
      open: (input: I, caller: RemoteCaller) => Awaitable<RemoteStream<O>>,
      options?: RemoteOptions,
    ): Promise<Registration>;
  };
  readonly identity: Identity;
  readonly signal: Cancellation;
  readonly tools: {
    /** Capture one handler/context for this group per logical model step.
     * Returning null omits the group. Physical retries and returned calls keep
     * the captured implementation; retiring its registration rejects new starts.
     */
    bind<Input = Json>(
      definitions: readonly ToolDefinition[],
      capture: (
        request: {
          readonly invocation: Invocation;
          readonly cwd: string;
          readonly tools: readonly string[];
          readonly model: ModelToolContext | null;
        },
        call: { readonly signal: Cancellation; readonly workspace: ReadDirectory },
      ) => Awaitable<
        | {
            readonly context?: string;
            readonly providerTools?: Readonly<Record<string, ProviderTool>>;
            invoke?(name: string, input: Input, call: CallContext): Awaitable<Json>;
          }
        | null
        | undefined
      >,
    ): Promise<Registration>;
    register<Input = Json>(
      definition: ToolDefinition,
      invoke: (input: Input, call: CallContext) => Awaitable<Json>,
    ): Promise<Registration>;
  };
  readonly modelAdapters: import('./models.js').ModelAdapters;
  readonly modelProviders: import('./providers.js').ModelProviders;
  readonly executors: {
    /** Scope-visible choices, not execution permission. Refine the query when incomplete. */
    search(query?: { query?: string }): Promise<ExecutorChoices>;
    register(
      definition: ExecutorDefinition,
      execute: (request: ExecutorRequest, call: ExecutorContext) => Awaitable<ExecutorOutcome>,
    ): Promise<Registration>;
  };
  readonly prompt: {
    section(definition: PromptSection & { complete?: boolean }): Promise<Registration>;
    variable(name: string, text: TextProvider): Promise<Registration>;
    context(definition: PromptSection): Promise<Registration>;
  };
  readonly services: Services & {
    provide<Input = Json, Output = Json>(
      name: string,
      invoke: (input: Input, call: ServiceContext) => Awaitable<Output>,
    ): Promise<Registration>;
  };
  readonly storage: {
    /** Current ordered pages, including tombstones; not a cross-page snapshot. */
    scan(query?: { prefix?: string; after?: string }): Promise<{
      entries: { key: string; record: StorageRecord }[];
      nextAfter: string | null;
    }>;
    read(key: string): Promise<StorageRecord | null>;
    /** Atomic CAS: up to 128 values, 1 MiB per value and 16 MiB total data. */
    batch(mutations: readonly StorageMutation[]): Promise<StorageRecord[]>;
  };
  /** Non-secret selection lookup; grants no model execution permission. */
  readonly models: {
    /** Enabled chat choices, not a grant or a promise of provider readiness.
     * At most 50 entries / 48 KiB; refine the query when incomplete.
     */
    search(query?: { query?: string }): Promise<import('./llm.js').ModelChoices>;
    resolve(
      selection: { kind: 'default' } | { kind: 'named'; connectionSlug: string; model: string },
    ): Promise<import('./llm.js').ModelChoice | null>;
  };
  /** Non-secret rates, readable during activation. */
  readonly pricing: import('./pricing.js').PricingCatalog;
  /** Non-secret user preferences; no configuration or execution authority. */
  readonly preferences: {
    read(): Promise<{
      revision: number;
      personalization: { displayName: string; assistantTone: string };
      workspaceInstructions: boolean;
      privacy: { incognitoActive: boolean };
    }>;
  };
  readonly executions: {
    /** Restore explicit Host consent; the ID alone is not permission. Closing
     * releases this view, never cancels work already accepted by the Host. */
    restore(id: string): Promise<Executions & Registration>;
  };
  /** Package/scope-private files; the plugin owns file formats and recovery. */
  readonly data: FileEntries & {
    /** Host path for process arguments; observing it grants no filesystem authority. */
    location(): Promise<string>;
  };
  readonly credentials: Credentials;
  sleep(milliseconds: number): Promise<void>;
  /** Cleanup runs in reverse registration order. */
  effect(dispose: () => Awaitable<void>): void;
  /** Stage during activation; starts only after publication becomes effective. */
  run(task: () => Awaitable<void>): void;
}
/** No invocation exists yet; preparation borrows read-only workspace access, not execution authority. */
export interface InputReceipt {
  readonly source: {
    readonly kind: 'input';
    readonly name: string;
    readonly packageId: string;
    readonly entryId: string;
    readonly activation: string;
    readonly revision: string;
  };
  readonly receipt: Json;
}
export interface InputPreparationRequest {
  readonly workspace: ReadDirectory;
  readonly sessionId: string;
  readonly cwd: string;
  readonly content: MessageContent;
  /** Evidence from preceding providers; a provider cannot replace it. */
  readonly preparation: readonly InputReceipt[];
  readonly selections: Readonly<Record<string, readonly string[]>>;
  readonly tools: readonly string[];
  readonly signal: Cancellation;
}
export type InputPreparationOutcome =
  | { readonly kind: 'unchanged' }
  | {
      readonly kind: 'ready';
      readonly content: MessageContent;
      readonly receipt: Json;
      readonly requiredTools?: readonly string[];
      readonly basis?: PreparationBasis;
    }
  | { readonly kind: 'blocked'; readonly message: string; readonly receipt: Json };
export type HostPlugin<Config = Json> = (
  context: HostContext,
  config: Config,
) => Awaitable<void | (() => Awaitable<void>)>;
export interface HostError extends Error {
  code:
    | 'invalid'
    | 'revoked'
    | 'conflict'
    | 'outcome_unknown'
    | 'unavailable'
    | 'busy'
    | 'not_found';
}
