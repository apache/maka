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

export {
  selectComputerUseBackend,
  CU_BACKEND_IDS,
  DEFAULT_CU_BACKEND_ID,
} from './select-backend.js';
export type {
  ComputerUseBackendSelection,
  CuBackendId,
  MakaCuSelection,
  SelectedComputerUseBackend,
} from './select-backend.js';

export { createMakaCuBackend } from './maka-cu-backend.js';
export type { MakaCuBackendOptions, MakaCuTraceEvent } from './maka-cu-backend.js';
export {
  MakaCuLifecycleError,
  MakaCuRpcError,
  MakaCuService,
  isMakaCuLifecycleError,
} from './maka-cu-service.js';
export type {
  MakaCuCapabilities,
  MakaCuHandshake,
  MakaCuLimits,
  MakaCuReleaseEvent,
  MakaCuServiceOptions,
  MakaCuServiceSnapshot,
} from './maka-cu-service.js';
export {
  MAKA_CU_PROTOCOL_VERSION,
  MAKA_CU_RPC_ERROR,
  MakaCuProtocolViolation,
  mapMakaCuDomainError,
  readDispatchResult,
  readEnvelope,
  readSnapshot,
} from './maka-cu-protocol.js';
export type {
  MakaCuDispatchResult,
  MakaCuDomainError,
  MakaCuElement,
  MakaCuEnvelope,
  MakaCuSnapshot,
} from './maka-cu-protocol.js';
export { decodeJsonLines } from './stdio-json-rpc.js';
export type { HostLifecycleErrorCode, HostRequestStage } from './stdio-json-rpc.js';

export { resolveCuaDisplaySnapshots } from './display-snapshot.js';
export type { CuaHostDisplay } from './display-snapshot.js';
export { createComputerUseOverlayHook } from './computer-use-overlay-hook.js';
export type {
  CursorActionKind,
  CursorCancelInput,
  CursorCompleteInput,
  CursorMoveInput,
  OverlayCursorSink,
} from './computer-use-overlay-hook.js';
