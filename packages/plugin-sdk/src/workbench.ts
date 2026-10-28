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
  ClientOperation,
  OperationReply,
  DeploymentRef,
  HistoryTool,
  InstanceId,
  PackageRef,
  UiCatalog,
  UiContribution,
  UiInstance,
  UiRead,
  UiRoot,
  UiTarget,
} from './generated/runtime.js';

export interface UiSubscription<T = unknown> {
  next(): Promise<T | null>;
  close(): Promise<void>;
}

/** The native client remains available to trusted modules through `maka/host`. */
export interface UiHost {
  hasService(endpoint: string): Promise<boolean>;
  query(endpoint: string, method: string, input: unknown): Promise<unknown>;
  subscribe(endpoint: string, method: string, input: unknown): Promise<UiSubscription>;
  mutation(endpoint: string, method: string, input: unknown): Promise<UiOperation>;
  beginMutation(endpoint: string, method: string, input: unknown): Promise<UiMutation>;
  readUi(input: UiRead): Promise<UiCatalog>;
  settingsMutation(
    endpoint: string,
    method: string,
    input: unknown,
    secret?: string | null,
  ): Promise<unknown>;
}

export interface UiOperation {
  readonly operationId: string;
  readonly reply: OperationReply;
}

export type UiMutationEvent =
  | { kind: 'progress'; value: unknown }
  | { kind: 'not_dispatched' }
  | { kind: 'finished'; reply: OperationReply; cleanupError: string | null };

export interface UiMutation {
  readonly operationId: string;
  next(): Promise<UiMutationEvent | null>;
  cancel(): void;
}

export interface UiOperations {
  pending(): Promise<ClientOperation[]>;
  recover(id: string): Promise<OperationReply>;
  abandon(id: string): Promise<ClientOperation>;
}

export interface UiService {
  query(method: string, input: unknown): Promise<unknown>;
  subscribe(method: string, input: unknown): Promise<UiSubscription>;
  mutation(method: string, input: unknown): Promise<UiOperation>;
  beginMutation(method: string, input: unknown): Promise<UiMutation>;
}

export interface UiContext<Host = UiHost, Element = unknown> {
  readonly source: DeploymentRef;
  readonly instance: InstanceId;
  readonly package: PackageRef;
  readonly configuration: Readonly<Record<string, unknown>>;
  readonly host: Host;
  /** Application calls use this instance's declared service bindings. */
  readonly application: UiHost;
  readonly services: Readonly<Record<string, readonly UiService[]>>;
  readonly operations: UiOperations;
  readonly runtime: UiRuntime<Element>;
  /** JSON returned by this instance's prepareReload, or null on first activation. */
  readonly restored: unknown;
  locale(): string;
  asset(path: string): string;
  openPanel(id: string, input?: unknown): void;
}

export interface UiCommandContext {
  readonly sessionId: string | null;
  readonly argument?: string;
}

export interface UiViewProps<Element = unknown> {
  readonly context: UiContext<UiHost, Element>;
  readonly runtime: UiRuntime<Element>;
  readonly sessionId: string | null;
  readonly input?: unknown;
}

export interface UiToolProps {
  readonly context: UiContext;
  readonly field: 'arguments' | 'result';
  readonly value: unknown;
  readonly sessionId: string;
  readonly through: number;
  readonly tool: HistoryTool;
  userScroll(): void;
}

export interface UiContributionRef {
  readonly key: string;
  readonly id: string;
  readonly instance: UiInstance;
  readonly declaration: UiContribution;
}

export type UiRootSelection = UiRoot;

declare const uiViewInput: unique symbol;

/** A shared contract name carries its input type without a second runtime schema. */
export interface UiViewContract<Input> {
  readonly id: string;
  readonly [uiViewInput]?: (input: Input) => Input;
}

export function defineUiViewContract<Input>(id: string): UiViewContract<Input> {
  return { id };
}

export interface UiEmbeddedViewProps<Input, Element = unknown> {
  readonly context: UiContext<UiHost, Element>;
  readonly runtime: UiRuntime<Element>;
  readonly input: Input;
}

export interface UiViewImplementation<Input = unknown, Element = unknown> {
  readonly kind: 'view';
  readonly contract: string;
  render(props: UiEmbeddedViewProps<Input, Element>): Element;
}

export interface UiContributionProps {
  readonly sessionId: string | null;
  readonly input?: unknown;
  readonly tool?: Omit<UiToolProps, 'context'>;
}

/** The shared catalog and components; the selected root owns their presentation. */
export interface UiRuntime<Element = unknown> {
  source(): DeploymentRef | null;
  root(): UiRootSelection | null;
  ready(): boolean;
  contributions(): readonly UiContributionRef[];
  panels(): readonly UiContributionRef[];
  settings(): readonly UiContributionRef[];
  renderer(presentation: string | null | undefined): UiContributionRef | undefined;
  view<Input>(target: UiTarget, contract: UiViewContract<Input>): UiContributionRef;
  renderView<Input>(target: UiTarget, contract: UiViewContract<Input>, input: Input): Element;
  render(contribution: UiContributionRef, props: UiContributionProps): Element;
  openPanel(target: UiTarget, input?: unknown): void;
  commandEnabled(contribution: UiContributionRef, context: UiCommandContext): boolean;
  invoke(
    contribution: UiContributionRef,
    context: UiCommandContext,
    current?: () => boolean,
  ): Promise<boolean>;
  handlePanels(handler: (contribution: UiContributionRef, input?: unknown) => void): () => void;
  locale(): string;
  setLocale(locale: string): void;
  reloading(): boolean;
  updateError(): unknown | null;
  retryUpdates(): void;
}

export interface UiRootProps<Element = unknown> {
  readonly context: UiContext<UiHost, Element>;
  readonly runtime: UiRuntime<Element>;
}

export type UiImplementation<Element = unknown> =
  | {
      kind: 'command';
      enabled?(context: UiCommandContext): boolean;
      run(context: UiCommandContext): void | boolean | Promise<void | boolean>;
    }
  | {
      kind: 'root';
      render(props: UiRootProps<Element>): Element;
    }
  | UiViewImplementation<unknown, Element>
  | { kind: 'panel' | 'settings'; render(props: UiViewProps<Element>): Element }
  | { kind: 'tool_renderer'; render(props: UiToolProps): Element };

export type UiExports<Element = unknown> = Readonly<Record<string, UiImplementation<Element>>>;

export interface UiActivation<Element = unknown> {
  readonly exports: UiExports<Element>;
  /** Persist owned edits and return JSON before replacing the shared VM. */
  prepareReload?(): Promise<unknown>;
}

/** Called once under the enabled instance's NSH owner. Use NSH cleanup for resources. */
export interface UiModule<Element = unknown> {
  activate(context: UiContext<UiHost, Element>): UiActivation<Element>;
}
