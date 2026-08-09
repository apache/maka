#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { parseInteractiveRuntimeHostCandidateArguments } from './candidate-cli.js';
import { startExecutionRuntimeHostCandidate } from './server/execution-candidate.js';
import { resolveExecutionBundledResourcesRoot } from './server/execution-bundled-resources.js';
import { runRuntimeHostProcessLifecycle } from './server/process-lifecycle.js';
import { installRuntimeHostLogCapture } from './process-diagnostics.js';
import {
  candidateStartupFailureExitCode,
  classifyCandidateStartupFailure,
} from './candidate-startup-failure.js';
import { readPackagedCandidateBootstrap } from './candidate-bootstrap.js';

installRuntimeHostLogCapture();

let result: Awaited<ReturnType<typeof startExecutionRuntimeHostCandidate>>;
try {
  const options = parseInteractiveRuntimeHostCandidateArguments(process.argv.slice(2));
  const packagedBootstrap = readPackagedCandidateBootstrap();
  const electronProcess = process as NodeJS.Process & {
    readonly defaultApp?: boolean;
    readonly resourcesPath?: string;
  };
  const resourcesRoot = resolveExecutionBundledResourcesRoot(
    {
      electronVersion: process.versions.electron,
      defaultApp: electronProcess.defaultApp,
      resourcesPath: electronProcess.resourcesPath
        ? realpathSync(electronProcess.resourcesPath)
        : undefined,
      parentPid: process.ppid,
    },
    packagedBootstrap,
  );
  result = await startExecutionRuntimeHostCandidate({
    ...options,
    ...(resourcesRoot
      ? {
          bundledGitResourcesRoot: resourcesRoot,
          bundledNpmResourcesRoot: resourcesRoot,
        }
      : {}),
  });
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
