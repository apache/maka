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

import type { SessionEvent } from './events.js';
import type { SessionChangedEvent } from './session.js';

export type MakaClientWireValue =
  | null
  | boolean
  | number
  | string
  | readonly MakaClientWireValue[]
  | { readonly [key: string]: MakaClientWireValue };

export interface MakaClientRemoteMethod<Input = MakaClientWireValue, Output = MakaClientWireValue> {
  readonly input: Input;
  readonly output: Output;
}

export interface MakaClientRemoteStream<Input = MakaClientWireValue, Item = MakaClientWireValue> {
  readonly input: Input;
  readonly item: Item;
}

declare const remoteMethodMapBrand: unique symbol;
declare const remoteStreamMapBrand: unique symbol;

/** Host/Client packages declaration-merge their unary Remote methods here. */
export interface MakaClientRemoteMethodMap {
  readonly [remoteMethodMapBrand]?: never;
}

/** Host/Client packages declaration-merge their Remote streams here. */
export interface MakaClientRemoteStreamMap {
  readonly [remoteStreamMapBrand]?: never;
}

export type MakaClientRemoteMethodName = Extract<keyof MakaClientRemoteMethodMap, string>;
export type MakaClientRemoteStreamName = Extract<keyof MakaClientRemoteStreamMap, string>;

export type MakaClientRemoteInput<Name extends MakaClientRemoteMethodName> =
  MakaClientRemoteMethodMap[Name] extends MakaClientRemoteMethod<infer Input, unknown>
    ? Input
    : never;

export type MakaClientRemoteOutput<Name extends MakaClientRemoteMethodName> =
  MakaClientRemoteMethodMap[Name] extends MakaClientRemoteMethod<unknown, infer Output>
    ? Output
    : never;

export type MakaClientRemoteStreamInput<Name extends MakaClientRemoteStreamName> =
  MakaClientRemoteStreamMap[Name] extends MakaClientRemoteStream<infer Input, unknown>
    ? Input
    : never;

export type MakaClientRemoteStreamItem<Name extends MakaClientRemoteStreamName> =
  MakaClientRemoteStreamMap[Name] extends MakaClientRemoteStream<unknown, infer Item>
    ? Item
    : never;

export type MakaClientToolActivityEvent = Extract<
  SessionEvent,
  { readonly type: `tool_${string}` }
>;

/** Deliberate public product-event allowlist exposed to trusted Client plugins. */
export interface MakaClientProductEventMap {
  readonly 'session.changed': SessionChangedEvent;
  readonly 'session.event': {
    readonly sessionId: string;
    readonly event: SessionEvent;
  };
  readonly 'tool.activity': {
    readonly sessionId: string;
    readonly event: MakaClientToolActivityEvent;
  };
  readonly 'agent.graph.changed': { readonly sessionId: string };
}

export type MakaClientProductEventName = keyof MakaClientProductEventMap;

export interface MakaClientRemoteOptions {
  readonly sessionId?: string;
}

/** Cancellation stays in the Client runtime; it is never serialized into an RPC. */
export interface MakaClientRemoteStreamOptions extends MakaClientRemoteOptions {
  readonly signal?: AbortSignal;
}

/** Session identity is statically required exactly where the event source needs one. */
export type MakaClientProductEventOptions<Name extends MakaClientProductEventName> =
  Name extends 'session.changed' ? { readonly sessionId?: never } : { readonly sessionId: string };
