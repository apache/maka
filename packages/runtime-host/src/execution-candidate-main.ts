#!/usr/bin/env node
import { parseInteractiveRuntimeHostCandidateArguments } from './candidate-cli.js';
import {
  createDesktopE2eExecutionCandidateDependencies,
  DESKTOP_E2E_IDLE_GRACE_MS,
  watchDesktopE2eParentProcess,
} from './desktop-e2e-execution.js';
import { startExecutionRuntimeHostCandidate } from './server/execution-candidate.js';
import { runRuntimeHostProcessLifecycle } from './server/process-lifecycle.js';
import { installRuntimeHostLogCapture, runtimeHostLogBuffer } from './process-diagnostics.js';
import {
  candidateStartupFailureExitCode,
  classifyCandidateStartupFailure,
} from './candidate-startup-failure.js';
import { writeCandidateStartupDiagnostic } from './control/startup-diagnostic.js';

installRuntimeHostLogCapture();

let result: Awaited<ReturnType<typeof startExecutionRuntimeHostCandidate>>;
let desktopE2e: true | undefined;
let rootId: string | undefined;
let startupAttemptId: string | undefined;
try {
  const parsed = parseInteractiveRuntimeHostCandidateArguments(process.argv.slice(2));
  rootId = parsed.expectedRootId;
  const {
    desktopE2e: parsedDesktopE2e,
    startupAttemptId: parsedStartupAttemptId,
    ...parsedOptions
  } = parsed;
  startupAttemptId = parsedStartupAttemptId;
  desktopE2e = parsedDesktopE2e;
  const options = desktopE2e
    ? { ...parsedOptions, idleGraceMs: DESKTOP_E2E_IDLE_GRACE_MS }
    : parsedOptions;
  result = await startExecutionRuntimeHostCandidate(
    options,
    desktopE2e ? createDesktopE2eExecutionCandidateDependencies() : {},
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

const stopParentWatch = desktopE2e
  ? watchDesktopE2eParentProcess(() => result.host.close())
  : undefined;

try {
  await runRuntimeHostProcessLifecycle(result.host);
} catch {
  process.exitCode = 1;
} finally {
  stopParentWatch?.();
}
