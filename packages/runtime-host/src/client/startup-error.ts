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

import type { CandidateStartupFailureReason } from '../candidate-startup-failure.js';
import type { RuntimeHostElectionDiagnostic } from './connect-or-spawn.js';
import { RuntimeHostPermanentReconnectError } from './reconnect-lifecycle.js';

export type RuntimeHostStartupFailureReason =
  | CandidateStartupFailureReason
  | 'composition_mismatch'
  | 'startup_timeout'
  | 'host_unresponsive';

export class RuntimeHostStartupError extends RuntimeHostPermanentReconnectError {
  readonly name = 'RuntimeHostStartupError';

  constructor(
    readonly reason:
      | 'stored_data_incompatible'
      | 'operational_state_migration_blocked'
      | 'composition_mismatch',
    message: string,
  ) {
    super(message);
  }
}

export function runtimeHostStartupError(
  reason: RuntimeHostStartupFailureReason,
  diagnostic?: RuntimeHostElectionDiagnostic,
): Error {
  switch (reason) {
    case 'stored_data_incompatible':
      return new RuntimeHostStartupError(
        reason,
        'Maka cannot read part of this workspace’s stored data. The workspace was left in place. Update Maka or report diagnostic code STORED_DATA_INCOMPATIBLE.',
      );
    case 'operational_state_migration_blocked':
      return new RuntimeHostStartupError(
        reason,
        'Maka could not safely upgrade this workspace and left it unchanged. Reopen it with the previous Maka release to export or remove incompatible data, then try again. Diagnostic code: OPERATIONAL_STATE_MIGRATION_BLOCKED.',
      );
    case 'internal_startup_failure':
      return new Error(
        'Runtime Host failed while recovering this workspace. Try again; if the problem persists, report diagnostic code INTERNAL_STARTUP_FAILURE.',
      );
    case 'local_ipc_security_failed':
      return new Error(
        'Runtime Host could not secure its Local IPC endpoint. Try again; if the problem persists, report diagnostic code LOCAL_IPC_SECURITY_FAILED.',
      );
    case 'composition_mismatch':
      return new RuntimeHostStartupError(
        reason,
        'This workspace belongs to a different Runtime Host composition. Diagnostic code: COMPOSITION_MISMATCH.',
      );
    case 'startup_timeout':
      return new Error(
        `Runtime Host did not become ready before the startup deadline${electionDiagnosticSuffix(diagnostic)}`,
      );
    case 'host_unresponsive':
      return new Error(
        `Runtime Host stopped responding during startup${electionDiagnosticSuffix(diagnostic)}`,
      );
  }
}

function electionDiagnosticSuffix(diagnostic: RuntimeHostElectionDiagnostic | undefined): string {
  return diagnostic ? `; election diagnostic: ${JSON.stringify(diagnostic)}` : '';
}
