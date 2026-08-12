import {
  INTERACTIVE_RUNTIME_HOST_COMPOSITION_ID,
  preservesHostedExecutionEnvironment,
  RUNTIME_HOST_PROTOCOL_VERSION,
  type HostedExecutionProjection,
  type HostedExecutionStartInput,
} from '../protocol/index.js';
import { connectOwnedRuntimeHost } from './connect-or-spawn.js';
import type { RuntimeHostConnection } from './connection.js';
import { configureHostedExecutionTarget } from './hosted-execution-target.js';

export interface RunHostedExecutionInput {
  readonly rootPath: string;
  readonly execution: HostedExecutionStartInput;
  readonly baseUrl?: string;
  readonly signal?: AbortSignal;
  readonly hostSettlementTimeoutMs?: number;
}

interface RunHostedExecutionDependencies {
  readonly connectOwnedRuntimeHost: typeof connectOwnedRuntimeHost;
}

const defaultDependencies: RunHostedExecutionDependencies = { connectOwnedRuntimeHost };

export async function runHostedExecution(
  input: RunHostedExecutionInput,
): Promise<HostedExecutionProjection> {
  return runHostedExecutionWithDependencies(input, defaultDependencies);
}

export async function runHostedExecutionWithDependencies(
  input: RunHostedExecutionInput,
  dependencies: RunHostedExecutionDependencies,
): Promise<HostedExecutionProjection> {
  if (input.signal?.aborted) {
    return indeterminate(input.execution.executionId, 'Hosted execution was cancelled');
  }
  const connected = await dependencies.connectOwnedRuntimeHost({
    rootPath: input.rootPath,
    surface: 'run',
    protocol: {
      min: RUNTIME_HOST_PROTOCOL_VERSION,
      max: RUNTIME_HOST_PROTOCOL_VERSION,
    },
    compositionId: INTERACTIVE_RUNTIME_HOST_COMPOSITION_ID,
    ...(input.signal ? { signal: input.signal } : {}),
  });
  if (connected.kind !== 'connected') {
    if (input.signal?.aborted) {
      return indeterminate(input.execution.executionId, 'Hosted execution was cancelled');
    }
    const cause = connected.kind === 'failed' ? connected.reason : connected.kind;
    return indeterminate(input.execution.executionId, `Runtime Host did not start: ${cause}`);
  }
  let projection: HostedExecutionProjection;
  try {
    input.signal?.throwIfAborted();
    const target = input.execution.session.modelTarget;
    if (target.kind === 'explicit') {
      if (!input.baseUrl) throw new Error('Explicit model target requires baseUrl');
      await configureHostedExecutionTarget(
        connected.connection,
        {
          connectionSlug: target.connectionSlug,
          model: target.model,
          baseUrl: input.baseUrl,
        },
        input.signal,
      );
    }
    projection = await executeHostedExecution(connected.connection, input.execution, input.signal);
  } catch {
    projection = input.signal?.aborted
      ? indeterminate(input.execution.executionId, 'Hosted execution was cancelled')
      : indeterminate(
          input.execution.executionId,
          'Runtime Host connection failed before execution settlement',
        );
  } finally {
    await connected.connection.close().catch(() => undefined);
  }

  if (preservesHostedExecutionEnvironment(projection)) {
    connected.host.releaseToEnvironment();
    return projection;
  }
  const clean = await connected.host.settle(input.hostSettlementTimeoutMs ?? 15_000);
  return clean
    ? projection
    : indeterminate(input.execution.executionId, 'Runtime Host did not exit cleanly');
}

async function executeHostedExecution(
  connection: Pick<RuntimeHostConnection, 'request'>,
  execution: HostedExecutionStartInput,
  signal: AbortSignal | undefined,
): Promise<HostedExecutionProjection> {
  const cancel = () => {
    void connection
      .request('hosted.execution.cancel', { executionId: execution.executionId })
      .catch(() => undefined);
  };
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) cancel();
  try {
    return await connection.request('hosted.execution.start', execution);
  } finally {
    signal?.removeEventListener('abort', cancel);
  }
}

function indeterminate(executionId: string, failureReason: string): HostedExecutionProjection {
  return { executionId, kind: 'indeterminate', failureReason };
}
