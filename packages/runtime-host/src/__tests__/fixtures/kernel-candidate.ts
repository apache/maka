#!/usr/bin/env node
import { parseInteractiveRuntimeHostCandidateArguments } from '../../candidate-cli.js';
import { defineInteractiveRuntimeHostComposition } from '../../server/host-composition.js';
import { createUnavailableDomainOperationHandlers } from '../../server/operation-dispatcher.js';
import { startInteractiveRuntimeHostCandidate } from '../../server/candidate.js';
import { runRuntimeHostProcessLifecycle } from '../../server/process-lifecycle.js';

const composition = defineInteractiveRuntimeHostComposition(async () => ({
  handlers: createUnavailableDomainOperationHandlers(),
  beginDrain() {},
  async recover() {},
  async close() {},
}));
const options = parseInteractiveRuntimeHostCandidateArguments(process.argv.slice(2));
const result = await startInteractiveRuntimeHostCandidate(options, composition);
if (result.kind === 'loser') process.exit(2);

try {
  await runRuntimeHostProcessLifecycle(result.host);
} catch {
  process.exitCode = 1;
}
