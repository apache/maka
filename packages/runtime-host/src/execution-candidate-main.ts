#!/usr/bin/env node
import { parseInteractiveRuntimeHostCandidateArguments } from './candidate-cli.js';
import { startExecutionRuntimeHostCandidate } from './server/execution-candidate.js';
import { runRuntimeHostProcessLifecycle } from './server/process-lifecycle.js';
import { installRuntimeHostLogCapture } from './process-diagnostics.js';
import {
  candidateStartupFailureExitCode,
  classifyCandidateStartupFailure,
} from './candidate-startup-failure.js';

installRuntimeHostLogCapture();

let result: Awaited<ReturnType<typeof startExecutionRuntimeHostCandidate>>;
try {
  const options = parseInteractiveRuntimeHostCandidateArguments(process.argv.slice(2));
  result = await startExecutionRuntimeHostCandidate(options);
} catch (error) {
  console.error('[runtime-host] startup failed:', error);
  process.exit(candidateStartupFailureExitCode(classifyCandidateStartupFailure(error)));
}
if (result.kind === 'loser') process.exit(2);

try {
  await runRuntimeHostProcessLifecycle(result.host);
} catch {
  process.exitCode = 1;
}
