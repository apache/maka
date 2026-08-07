#!/usr/bin/env node
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { parseRuntimeHostCandidateArguments } from './candidate-cli.js';
import { startExecutionRuntimeHostCandidate } from './server/execution-candidate.js';
import { runRuntimeHostProcessLifecycle } from './server/process-lifecycle.js';

const options = parseRuntimeHostCandidateArguments(process.argv.slice(2));
const result = await startExecutionRuntimeHostCandidate({
  ...options,
  ...(isIsolatedDesktopE2eRoot(options.rootPath) ? { executionMode: 'desktop_e2e' } : {}),
});
if (result.kind === 'loser') process.exit(2);

try {
  await runRuntimeHostProcessLifecycle(result.host);
} catch {
  process.exitCode = 1;
}

function isIsolatedDesktopE2eRoot(rootPath: string): boolean {
  if (process.env.MAKA_E2E !== '1') return false;
  const profilePath = process.env.MAKA_E2E_USER_DATA_DIR;
  if (!profilePath) return false;
  const child = relative(resolve(profilePath), resolve(rootPath));
  return child.length > 0 && child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}
