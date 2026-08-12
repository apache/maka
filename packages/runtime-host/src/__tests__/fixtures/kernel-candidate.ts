#!/usr/bin/env node
import { parseInteractiveRuntimeHostCandidateArguments } from '../../candidate-cli.js';
import { defineInteractiveRuntimeHostComposition } from '../../server/host-composition.js';
import { createUnavailableDomainOperationHandlers } from '../../server/operation-dispatcher.js';
import { startInteractiveRuntimeHostCandidate } from '../../server/candidate.js';
import { runRuntimeHostProcessLifecycle } from '../../server/process-lifecycle.js';
import {
  candidateStartupFailureExitCode,
  classifyCandidateStartupFailure,
} from '../../candidate-startup-failure.js';

const composition = defineInteractiveRuntimeHostComposition(async () => ({
  handlers: createUnavailableDomainOperationHandlers(),
  beginDrain() {},
  async recover() {
    const code = process.env.MAKA_TEST_STARTUP_ERROR_CODE;
    if (!code) return;
    throw Object.assign(new Error('forced candidate startup failure'), { code });
  },
  async close() {},
}));
const options = parseInteractiveRuntimeHostCandidateArguments(process.argv.slice(2));
let result: Awaited<ReturnType<typeof startInteractiveRuntimeHostCandidate>>;
try {
  result = await startInteractiveRuntimeHostCandidate(options, composition);
} catch (error) {
  process.exit(candidateStartupFailureExitCode(classifyCandidateStartupFailure(error)));
}
if (result.kind === 'loser') process.exit(2);

try {
  await runRuntimeHostProcessLifecycle(result.host);
} catch {
  process.exitCode = 1;
}
