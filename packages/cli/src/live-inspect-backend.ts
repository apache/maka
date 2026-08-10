import {
  connectExistingRuntimeHost,
  type ConnectRuntimeHostResult,
  type RuntimeHostConnection,
} from '@maka/runtime-host/client';
import {
  RUNTIME_HOST_COMPATIBILITY_EPOCH,
  RUNTIME_HOST_PROTOCOL_VERSION,
  type ExecutionInspectResolveInput,
} from '@maka/runtime-host/protocol';
import type { InspectCandidate, InspectCommandBackend } from './inspect-backend.js';
import { inspectResolutionFailure } from './inspect-backend.js';

export interface InspectCommandDependencies {
  connectExistingHost: typeof connectExistingRuntimeHost;
}

export const defaultInspectCommandDependencies: InspectCommandDependencies = {
  connectExistingHost: connectExistingRuntimeHost,
};

export class LiveInspectError extends Error {
  readonly name = 'LiveInspectError';
}

export async function connectLiveInspectBackend(
  storageRoot: string,
  dependencies: InspectCommandDependencies,
): Promise<{ backend: InspectCommandBackend; close(): Promise<void> }> {
  let connected: ConnectRuntimeHostResult;
  try {
    connected = await dependencies.connectExistingHost({
      rootPath: storageRoot,
      surface: 'inspect',
      protocol: {
        min: RUNTIME_HOST_PROTOCOL_VERSION,
        max: RUNTIME_HOST_PROTOCOL_VERSION,
      },
    });
  } catch (error) {
    throw new LiveInspectError(
      `Interactive storage is locked and the existing Runtime Host control plane could not be validated: ${errorMessage(error)}`,
    );
  }
  if (connected.kind !== 'connected') {
    throw new LiveInspectError(liveHostUnavailableMessage(connected));
  }
  return {
    backend: hostInspectBackend(connected.connection),
    close: () => connected.connection.close().catch(() => undefined),
  };
}

function hostInspectBackend(connection: RuntimeHostConnection): InspectCommandBackend {
  const request = async <T>(operation: () => Promise<T>): Promise<T> => {
    try {
      return await operation();
    } catch (error) {
      throw new LiveInspectError(`Live Runtime Host inspection failed: ${errorMessage(error)}`);
    }
  };
  return {
    resolve: async (query) => {
      if (query.requestedKind === 'task-run') {
        return inspectResolutionFailure(query, 'not_found', []);
      }
      const input: ExecutionInspectResolveInput = {
        id: query.id,
        ...(query.requestedKind
          ? { requestedKind: query.requestedKind === 'agent-run' ? 'agent_run' : 'session' }
          : {}),
        ...(query.sessionId ? { sessionId: query.sessionId } : {}),
      };
      const result = await request(() => connection.request('execution.inspect.resolve', input));
      const candidates: InspectCandidate[] = result.candidates.map((candidate) =>
        candidate.kind === 'agent_run'
          ? {
              kind: 'agent-run',
              id: candidate.id,
              sessionId: candidate.sessionId,
            }
          : { kind: 'session', id: candidate.id },
      );
      if (result.status === 'resolved') {
        return { status: 'resolved', candidate: candidates[0]! };
      }
      return inspectResolutionFailure(query, result.status, candidates, result.truncated);
    },
    inspect: async (candidate) => {
      if (candidate.kind === 'task-run') {
        throw new LiveInspectError('TaskRun inspection requires a Headless storage root');
      }
      const result = await request(() =>
        connection.request(
          'execution.inspect.query',
          candidate.kind === 'session'
            ? { kind: 'session', sessionId: candidate.id }
            : {
                kind: 'agent_run',
                sessionId: candidate.sessionId,
                agentRunId: candidate.id,
              },
        ),
      );
      if (result.kind !== 'session' && result.kind !== 'agent_run') {
        throw new LiveInspectError('Runtime Host returned a paginated trace to a document query');
      }
      if (candidate.kind === 'session' ? result.kind !== 'session' : result.kind !== 'agent_run') {
        throw new LiveInspectError('Runtime Host returned a different inspect document kind');
      }
      return result.document;
    },
  };
}

function liveHostUnavailableMessage(
  result: Exclude<ConnectRuntimeHostResult, { kind: 'connected' }>,
): string {
  if (result.kind === 'incompatible') {
    if (result.handshake.compatibilityEpoch < RUNTIME_HOST_COMPATIBILITY_EPOCH) {
      return 'Interactive storage is locked by an older Runtime Host. Stop its owning Maka process, then try again.';
    }
    return 'Interactive storage is locked by an incompatible Runtime Host';
  }
  if (result.kind === 'draining') {
    return 'Interactive storage is locked by a draining Runtime Host';
  }
  return `Interactive storage is locked but its Runtime Host is unavailable (${result.reason})`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
