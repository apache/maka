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

import { UiError } from './text';
import { tr } from './locale';
import { host as nativeHost } from 'maka/host';
import type { CapturedFile, ScopedHost } from 'maka/host';
import type {
  AgentFileKind,
  ClientDraft,
  ClientDraftEdit,
  ClientOperation,
  OperationReply,
  ServiceMethods,
} from '../../../../packages/plugin-sdk/src/index.js';
import type { UiHost } from '../../../../packages/plugin-sdk/src/workbench.js';

// Native JSON results have Rust-owned shapes. Project the shared API while
// retaining the admitted native Host object and its original request custody.
export const uiHost = nativeHost as UiHost;

// The default root declares these service contracts in its composition. The
// Host validates values against the selected contracts; this facade types the calls.
type Services = {
  agent: ServiceMethods['agent'];
  settings: ServiceMethods['settings'];
  authentication: ServiceMethods['settingsAuthentication'];
  setup: ServiceMethods['settingsSetup'];
  management: ServiceMethods['deploymentManager'];
  terminal: ServiceMethods['terminal'];
};
type Endpoint = keyof Services;
type Method<E extends Endpoint, Mode extends string> = {
  [M in keyof Services[E]]: Services[E][M] extends { mode: Mode } ? M : never;
}[keyof Services[E]] &
  string;
type Input<E extends Endpoint, M extends string> = M extends keyof Services[E]
  ? Services[E][M] extends { input: infer I }
    ? I
    : never
  : never;
type Output<E extends Endpoint, M extends string> = M extends keyof Services[E]
  ? Services[E][M] extends { output: infer O }
    ? O
    : never
  : never;
type Subscription<T> = { next(): Promise<T | null>; close(): Promise<void> };
type FileSubscription = { readFile(): Promise<FileView>; close(): Promise<void> };
type StreamMethod<E extends Endpoint> = E extends 'agent'
  ? Exclude<Method<E, 'subscription'>, 'readFile'>
  : Method<E, 'subscription'>;

// This is the native collector's presentation, not agent.readFile's wire stream.
export type FileView =
  | {
      kind: 'text';
      rows: CapturedFile;
      version: string;
      digest: string;
      bytes: number;
    }
  | {
      kind: 'image';
      uri: string;
      mimeType: string;
      version: string;
      digest: string;
      bytes: number;
    }
  | { kind: 'absent' }
  | { kind: 'changed' }
  | { kind: 'binary'; bytes: number }
  | { kind: 'unsupported'; fileKind: AgentFileKind };

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const count = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
function fileView(capture: CapturedFile): FileView {
  const value: unknown = capture.metadata();
  if (!object(value)) throw new UiError('Invalid native file presentation.');
  const { version, digest, bytes } = value;
  if (
    value.kind === 'text' &&
    typeof version === 'string' &&
    typeof digest === 'string' &&
    count(bytes) &&
    count(capture.length)
  )
    return { kind: 'text', rows: capture, version, digest, bytes };
  const captured = () =>
    typeof value.version === 'string' && typeof value.digest === 'string' && count(value.bytes);
  const valid =
    value.kind === 'absent' ||
    value.kind === 'changed' ||
    (value.kind === 'binary' && count(value.bytes)) ||
    (value.kind === 'unsupported' &&
      typeof value.fileKind === 'string' &&
      ['file', 'directory', 'symlink', 'other'].includes(value.fileKind)) ||
    (value.kind === 'image' &&
      captured() &&
      typeof value.uri === 'string' &&
      typeof value.mimeType === 'string');
  if (!valid) throw new UiError('Invalid native file presentation.');
  return value as FileView;
}

type Attempt = { operationId: string; reply: unknown };
export type OriginalMutationEvent =
  | { kind: 'progress'; value: unknown }
  | { kind: 'not_dispatched' }
  | { kind: 'finished'; reply: OperationReply; cleanupError: string | null };
export type OriginalMutation = {
  readonly operationId: string;
  next(): Promise<OriginalMutationEvent | null>;
  cancel(): void;
};
function attempt(value: unknown): Attempt {
  if (!object(value) || typeof value.operationId !== 'string' || !('reply' in value))
    throw new UiError('Invalid native operation observation.');
  return { operationId: value.operationId, reply: value.reply };
}

async function query<E extends Endpoint, M extends Method<E, 'query'>>(
  endpoint: E,
  method: M,
  input: Input<E, M>,
): Promise<Output<E, M>> {
  return nativeHost.query(endpoint, method, input) as Promise<Output<E, M>>;
}
function subscribe<E extends Endpoint, M extends StreamMethod<E>>(
  endpoint: E,
  method: M,
  input: Input<E, M>,
): Promise<Subscription<Output<E, M>>> {
  return nativeHost.subscribe(endpoint, method, input) as Promise<Subscription<Output<E, M>>>;
}
async function readFile(input: Input<'agent', 'readFile'>): Promise<FileSubscription> {
  const opened = await nativeHost.readFile(input);
  return {
    readFile: async () => fileView(await opened.readFile()),
    close: () => opened.close(),
  };
}

// Local journal methods serialize these actual Rust DTOs. Their receipt business
// values remain unknown and continue through the application's existing guards.
export const host = {
  markdownImageSource(target: string) {
    const source = nativeHost.markdownImageSource(target);
    return source.kind === 'workspace'
      ? { kind: 'workspace' as const, path: { bytesBase64: source.path } }
      : source;
  },
  async openLink(target: string) {
    const link = await nativeHost.openLink(target);
    return link === null
      ? null
      : {
          path: { bytesBase64: link.path },
          parent: link.parent == null ? null : { bytesBase64: link.parent },
        };
  },
  query,
  hasService: (endpoint: string) => nativeHost.hasService(endpoint),
  refresh: () => nativeHost.refresh(),
  subscribe,
  readFile,
  get initialSession() {
    return nativeHost.initialSession;
  },
  session(sessionId: string) {
    return nativeHost.session(sessionId);
  },
  pathLabel(path: unknown) {
    return nativeHost.pathLabel(path);
  },
  async control(method: string, input: unknown) {
    return attempt(await nativeHost.control(method, input));
  },
  async settingsMutation(endpoint: string, method: string, input: unknown, secret?: string | null) {
    return attempt(await nativeHost.settingsMutation(endpoint, method, input, secret));
  },
  beginSetting<E extends Exclude<Endpoint, 'agent' | 'terminal'>, M extends Method<E, 'mutation'>>(
    endpoint: E,
    method: M,
    input: Input<E, M>,
    secret?: string | null,
  ): Promise<OriginalMutation> {
    return nativeHost.beginSetting(endpoint, method, input, secret) as Promise<OriginalMutation>;
  },
  pendingSettings: () => nativeHost.pendingSettings() as Promise<ClientOperation[]>,
  recoverSetting: (id: string) => nativeHost.recoverSetting(id) as Promise<OperationReply>,
  abandonSetting: (id: string) => nativeHost.abandonSetting(id) as Promise<ClientOperation>,
  pendingControls: () => nativeHost.pendingControls() as Promise<ClientOperation[]>,
  recoverControl: (id: string) => nativeHost.recoverControl(id) as Promise<OperationReply>,
  abandonControl: (id: string) => nativeHost.abandonControl(id) as Promise<ClientOperation>,
};

// Session methods take the original native Instance. In particular, the same
// instance still goes directly into AttachmentPicker.client.
export type { ScopedHost };
// Native draft results always include attachments, including [] for an empty draft.
type SavedDraft = ClientDraft & Required<Pick<ClientDraft, 'attachments'>>;
export const loadDraft = (scope: ScopedHost) => scope.loadDraft() as Promise<SavedDraft>;
export const saveDraft = (scope: ScopedHost, revision: number, edit: ClientDraftEdit) =>
  scope.saveDraft(revision, edit) as Promise<SavedDraft>;
export async function sendDraft(scope: ScopedHost, revision: number, selection: unknown) {
  return attempt(await scope.send(revision, selection));
}
export const pendingSends = (scope: ScopedHost) => scope.pending() as Promise<ClientOperation[]>;
export const recoverSend = (scope: ScopedHost, id: string) =>
  scope.recover(id) as Promise<OperationReply>;
export const abandonSend = (scope: ScopedHost, id: string) =>
  scope.abandonUnprepared(id) as Promise<ClientOperation>;
export const findUpload = (scope: ScopedHost, id: string) =>
  scope.findUpload(id) as Promise<ClientOperation | null>;
export const recoverUpload = (scope: ScopedHost, id: string) =>
  scope.recoverUpload(id) as Promise<ClientOperation>;
export const abandonUpload = (scope: ScopedHost, id: string) =>
  scope.abandonUpload(id) as Promise<ClientOperation>;
export const watchUploads = (scope: ScopedHost) =>
  scope.watchUploads() as { next(): Promise<ClientOperation[] | null>; close(): void };

// The immutable native scope checks the original terminal session before dispatch.
export async function terminalMutation<M extends Method<'terminal', 'mutation'>>(
  scope: ScopedHost,
  method: M,
  input: Input<'terminal', M>,
): Promise<Output<'terminal', M>> {
  const observed = await scope.terminal(method, input);
  if (!object(observed) || !object(observed.reply)) throw new UiError('Invalid terminal receipt.');
  const reply = observed.reply as unknown as OperationReply;
  if (reply.receipt.kind !== 'recorded' || reply.receipt.outcome.kind !== 'returned')
    throw new UiError(
      'Terminal result is unknown. Recover the original action before trying again.',
    );
  if (observed.cleanupError)
    throw new UiError(
      'Terminal result was recorded, but its original call did not finish cleanup: {reason}. Do not repeat this action.',
      { reason: String(observed.cleanupError) },
    );
  return reply.receipt.outcome.value as Output<'terminal', M>;
}
export const pendingTerminals = (scope: ScopedHost) =>
  scope.pendingTerminals() as Promise<ClientOperation[]>;
export const recoverTerminal = (scope: ScopedHost, id: string) =>
  scope.recoverTerminal(id) as Promise<OperationReply>;
export const abandonTerminal = (scope: ScopedHost, id: string) =>
  scope.abandonTerminal(id) as Promise<ClientOperation>;
