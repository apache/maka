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

export interface UiContext<Host = UiHost> {
  readonly source: DeploymentRef;
  readonly instance: InstanceId;
  readonly package: PackageRef;
  readonly configuration: Readonly<Record<string, unknown>>;
  readonly host: Host;
  readonly services: Readonly<Record<string, readonly UiService[]>>;
  readonly operations: UiOperations;
  locale(): string;
  asset(path: string): string;
  openPanel(id: string, input?: unknown): void;
}

export interface UiCommandContext {
  readonly sessionId: string | null;
}

export interface UiViewProps {
  readonly context: UiContext;
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

export type UiImplementation<Element = unknown> =
  | { kind: 'command'; run(context: UiCommandContext): void | Promise<void> }
  | { kind: 'panel' | 'settings'; render(props: UiViewProps): Element }
  | { kind: 'tool_renderer'; render(props: UiToolProps): Element };

export type UiExports<Element = unknown> = Readonly<Record<string, UiImplementation<Element>>>;

/** Called once under the enabled instance's NSH owner. Use NSH cleanup for resources. */
export interface UiModule<Element = unknown> {
  activate(context: UiContext): UiExports<Element>;
}
