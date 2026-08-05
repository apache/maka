#!/usr/bin/env node
import { parseRuntimeHostCandidateArguments } from './candidate-cli.js';
import { startExecutionRuntimeHostCandidate } from './server/execution-candidate.js';
import { runRuntimeHostProcessLifecycle } from './server/process-lifecycle.js';

const options = parseRuntimeHostCandidateArguments(process.argv.slice(2));
const result = await startExecutionRuntimeHostCandidate(options);
if (result.kind === 'loser') process.exit(2);

try {
  await runRuntimeHostProcessLifecycle(result.host);
} catch {
  process.exitCode = 1;
}
