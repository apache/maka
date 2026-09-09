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

import type { PlanControlErrorCode } from '@maka/runtime-host/protocol';

/** Envelope the plan-mode control channels return across the Desktop IPC
 * boundary: the main process returns structured outcomes instead of throwing
 * typed errors, whose custom fields Electron strips. Desktop-only transport
 * shape — no Host wire codec uses it — so it lives beside the WorkBoardIpcResult
 * seam instead of under the Host protocol compatibility gate. As a type-only
 * `.d.ts` (the session-collaboration.d.ts precedent) it stays outside the
 * renderer architecture debt closure. Unknown codes keep version-skew safety,
 * so the failure branch admits undeclared strings. */
export type PlanControlIpcResult<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly error: {
        readonly code: PlanControlErrorCode | (string & {});
        readonly message: string;
      };
    };