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

/** Application authoring types. Runtime admission remains in Rust. */
export type * from './generated/runtime.js';
export type { ServiceMethods } from './generated/methods.js';
export { contracts } from './contracts.js';
export { configurations } from './configurations.js';
export type * from './workbench.js';
export { defineUiViewContract } from './workbench.js';

import type {
  HostRequest,
  HostObservation,
  OperationReply,
  ResourceMetadata,
} from './generated/runtime.js';

/** Provided by the actual invocation. Retaining it does not retain request resources. */
export interface RequestContext {
  invoke(request: Extract<HostRequest, { operation: 'emit' }>): Promise<null>;
  invoke(request: Extract<HostRequest, { operation: 'mutate' }>): Promise<OperationReply>;
  invoke(request: Extract<HostRequest, { operation: 'recover' }>): Promise<OperationReply>;
  invoke(request: Extract<HostRequest, { operation: 'metadata' }>): Promise<ResourceMetadata>;
  invoke(request: Extract<HostRequest, { operation: 'read' }>): Promise<number[]>;
  invoke(request: HostRequest): Promise<unknown>;
}

export type HostService = Record<
  string,
  (input: unknown, observation: HostObservation, context: RequestContext) => unknown
>;

export { nativeImplementations } from './native.js';
export * from './workbench-views.js';
