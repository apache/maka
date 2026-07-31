import {
  connectOrSpawnRuntimeHostWithDependencies,
  type ConnectOrSpawnRuntimeHostInput,
  type ConnectOrSpawnRuntimeHostResult,
} from './connect-or-spawn.js';
import { launchDetachedRuntimeHostCandidate } from './launcher.js';

/**
 * Starts the explicit execution composition used by vertical-slice harnesses.
 * Production clients must use connectOrSpawnRuntimeHost instead.
 */
export function connectOrSpawnExecutionRuntimeHostHarness(
  input: ConnectOrSpawnRuntimeHostInput,
): Promise<ConnectOrSpawnRuntimeHostResult> {
  return connectOrSpawnRuntimeHostWithDependencies(input, {
    launchCandidate: (candidate) =>
      launchDetachedRuntimeHostCandidate({
        ...candidate,
        entrypoint: new URL('../execution-candidate-main.js', import.meta.url),
      }),
    random: Math.random,
  });
}
