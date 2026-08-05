#!/usr/bin/env node
import { startRuntimeHostCandidate } from './server/candidate.js';
import { runRuntimeHostProcessLifecycle } from './server/process-lifecycle.js';
import { parseRuntimeHostCandidateArguments } from './candidate-cli.js';

const options = parseRuntimeHostCandidateArguments(process.argv.slice(2));
const result = await startRuntimeHostCandidate(options);
if (result.kind === 'loser') process.exit(2);

try {
  await runRuntimeHostProcessLifecycle(result.host);
} catch {
  process.exitCode = 1;
}
