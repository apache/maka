import type { InvocationResult } from '@maka/runtime';
import { createSessionStore } from '@maka/storage';
import { createMakaCliRuntimeContext } from './runtime-bootstrap.js';
import {
  invocationHasSandboxBoundaryFailure,
  invocationRecoveredSandboxBoundaryFailure,
} from './sandbox-boundary-failure.js';
import {
  runMakaTextCliCore,
  type MakaRunContextInput,
  type MakaRunDeps,
  type MakaRunOutcome,
} from './run-command-core.js';

export {
  parseMakaRunArgs,
  type MakaRunContext,
  type MakaRunContextInput,
  type MakaRunDeps,
  type MakaRunOptions,
  type MakaRunRuntime,
  type ParseMakaRunArgsResult,
} from './run-command-core.js';

export function runMakaTextCli(
  argv: readonly string[],
  overrides: Partial<MakaRunDeps> = {},
): Promise<number> {
  const {
    createContext = createEmbeddedRunContext,
    listSessions = (workspaceRoot: string) => createSessionStore(workspaceRoot).list(),
    ...environmentOverrides
  } = overrides;
  return runMakaTextCliCore(argv, { createContext, listSessions }, environmentOverrides);
}

async function createEmbeddedRunContext(input: MakaRunContextInput) {
  const { runOutcomeObserver, ...runtimeInput } = input;
  return createMakaCliRuntimeContext({
    ...runtimeInput,
    ...(runOutcomeObserver
      ? {
          runtimeInvocationObserver: (result) =>
            runOutcomeObserver({
              outcomeId: result.invocationId,
              status: result.status === 'completed' ? 'completed' : 'failed',
              ...(result.finalOutput !== undefined ? { finalOutput: result.finalOutput } : {}),
              ...(result.failure ? { failure: result.failure } : {}),
              sandboxBoundary: sandboxBoundaryOutcome(result),
            }),
        }
      : {}),
  });
}

function sandboxBoundaryOutcome(result: InvocationResult): MakaRunOutcome['sandboxBoundary'] {
  if (invocationRecoveredSandboxBoundaryFailure(result)) return 'recovered';
  return invocationHasSandboxBoundaryFailure(result) ? 'unresolved' : 'none';
}
