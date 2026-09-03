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

/**
 * Compatibility exports for callers that used the feasibility-spike name.
 * There is intentionally no Windows service implementation: lifecycle
 * ownership belongs exclusively to MakaCuService.
 */
export {
  MakaCuLifecycleError as WindowsCuLifecycleError,
  MakaCuRpcError as WindowsCuRpcError,
  MakaCuService as WindowsCuService,
} from './maka-cu-service.js';
export { MAKA_CU_PROTOCOL_VERSION as WINDOWS_CU_PROTOCOL_VERSION } from './maka-cu-protocol.js';
export type {
  MakaCuHandshake as WindowsCuHandshake,
  MakaCuReleaseEvent as WindowsCuReleaseEvent,
  MakaCuServiceOptions as WindowsCuServiceOptions,
  MakaCuServiceSnapshot as WindowsCuServiceSnapshot,
  MakaCuServiceState as WindowsCuServiceState,
} from './maka-cu-service.js';
