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

import { DiagnosticLogBuffer } from '@maka/core/diagnostic-log';
import { installConsoleDiagnosticLogCapture } from '@maka/core/node-diagnostic-log';
import {
  HOST_DIAGNOSTIC_LOG_MAX_ENTRIES,
  HOST_DIAGNOSTIC_LOG_MAX_ENTRY_BYTES,
} from './protocol/host-status.js';

export const RUNTIME_HOST_DIAGNOSTIC_LOG_MAX_BYTES = 64 * 1024;
export const RUNTIME_HOST_STDERR_PIPE_ENV = 'MAKA_RUNTIME_HOST_STDERR_PIPE';

export const runtimeHostLogBuffer = new DiagnosticLogBuffer({
  maxBytes: RUNTIME_HOST_DIAGNOSTIC_LOG_MAX_BYTES,
  maxEntries: HOST_DIAGNOSTIC_LOG_MAX_ENTRIES,
  maxEntryUtf8Bytes: HOST_DIAGNOSTIC_LOG_MAX_ENTRY_BYTES,
});

let logCaptureInstalled = false;
let stderrPipeGuardInstalled = false;

export function installRuntimeHostLogCapture(buffer = runtimeHostLogBuffer): void {
  installRuntimeHostStderrPipeGuard();
  if (logCaptureInstalled) return;
  logCaptureInstalled = true;
  installConsoleDiagnosticLogCapture(buffer);
}

function installRuntimeHostStderrPipeGuard(): void {
  if (stderrPipeGuardInstalled || process.env[RUNTIME_HOST_STDERR_PIPE_ENV] !== '1') {
    return;
  }
  stderrPipeGuardInstalled = true;
  process.stderr.on('error', (error: NodeJS.ErrnoException) => {
    // A detached Host intentionally outlives the Client that owns this pipe.
    // Once that Client exits, later diagnostics must be dropped rather than
    // turning the expected pipe closure into a fatal Host error.
    if (error.code === 'EPIPE') return;
    throw error;
  });
}
