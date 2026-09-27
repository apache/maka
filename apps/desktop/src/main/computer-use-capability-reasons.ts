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

import { type CuBackendId } from '@maka/computer-use';
import type { CapabilityReasonCode } from '@maka/core/capabilities';

interface ComputerUseCapabilityReasonInput {
  backendId: CuBackendId | 'none';
  health: { reason: CapabilityReasonCode };
}

/**
 * What the Computer Use capability row says, kept out of the snapshot module's
 * Electron import graph so the projection that produces the copy is tested on
 * every CI OS.
 *
 * While no executor is selected both layers name the same cause: a bare
 * `cu_artifact_missing` made an unbound platform read as a failed integrity
 * check, which is the distinction the selection's reason exists to preserve.
 * `cu_artifact_missing` stays for a snapshot that never reached this capability
 * at all.
 */
export function computerUseCapabilityReasons(
  input: ComputerUseCapabilityReasonInput | undefined,
): { feature: CapabilityReasonCode; probe: CapabilityReasonCode } {
  if (!input) return { feature: 'cu_artifact_missing', probe: 'cu_backend_unavailable' };
  if (input.backendId === 'none') {
    return { feature: input.health.reason, probe: input.health.reason };
  }
  return { feature: 'cu_backend_status', probe: input.health.reason };
}
