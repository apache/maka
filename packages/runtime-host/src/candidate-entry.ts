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

import {
  candidateStartupFailureExitCode,
  classifyCandidateStartupFailure,
} from './candidate-startup-failure.js';
import { parseInteractiveRuntimeHostCandidateArguments } from './candidate-cli.js';
import { writeCandidateStartupDiagnostic } from './control/startup-diagnostic.js';
import { installRuntimeHostLogCapture, runtimeHostLogBuffer } from './process-diagnostics.js';
import {
  type ExecutionRuntimeHostCandidateDependencies,
  type ExecutionRuntimeHostCandidateOptions,
  startExecutionRuntimeHostCandidate,
} from './server/execution-candidate.js';
import type { RuntimeHostKernel } from './server/host-kernel.js';
import { runRuntimeHostProcessLifecycle } from './server/process-lifecycle.js';

export interface ExecutionCandidateEntryHooks {
  /** Applied to the parsed command line before the candidate starts. */
  readonly overrideOptions?: (
    options: ExecutionRuntimeHostCandidateOptions,
  ) => ExecutionRuntimeHostCandidateOptions;
  readonly dependencies?: ExecutionRuntimeHostCandidateDependencies;
  /** Runs once the candidate has won; the returned callback stops the watch. */
  readonly onWon?: (host: RuntimeHostKernel) => () => void;
}

/**
 * The bootstrap both candidate entry modules share. The entry file is the only
 * thing that differs between the production and Desktop E2E processes, so the
 * argument parsing, startup diagnostics, and lifecycle live here instead of
 * being copied — a copy is what silently drifts when either one gains a step.
 */
export async function runExecutionCandidateEntry(
  argv: readonly string[],
  hooks: ExecutionCandidateEntryHooks = {},
): Promise<never | void> {
  installRuntimeHostLogCapture();

  let result: Awaited<ReturnType<typeof startExecutionRuntimeHostCandidate>>;
  let rootId: string | undefined;
  let startupAttemptId: string | undefined;
  try {
    const parsed = parseInteractiveRuntimeHostCandidateArguments(argv);
    rootId = parsed.expectedRootId;
    const { startupAttemptId: parsedStartupAttemptId, ...options } = parsed;
    startupAttemptId = parsedStartupAttemptId;
    result = await startExecutionRuntimeHostCandidate(
      hooks.overrideOptions ? hooks.overrideOptions(options) : options,
      hooks.dependencies ?? {},
    );
  } catch (error) {
    const failure = classifyCandidateStartupFailure(error);
    const logs = runtimeHostLogBuffer.snapshot();
    console.error('[runtime-host] startup failed:', error);
    if (rootId && startupAttemptId) {
      await writeCandidateStartupDiagnostic({
        rootId,
        startupAttemptId,
        failure,
        error,
        logs,
      }).catch(() => undefined);
    }
    process.exit(candidateStartupFailureExitCode(failure));
  }
  if (result.kind === 'loser') process.exit(2);

  const stopWatch = hooks.onWon?.(result.host);
  try {
    await runRuntimeHostProcessLifecycle(result.host);
  } catch {
    process.exitCode = 1;
  } finally {
    stopWatch?.();
  }
}
