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
  readonly abortPolicy?: 'cancel' | 'preserve_environment';
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
  const initial = await dependencies.connectOwnedRuntimeHost({
    rootPath: input.rootPath,
    surface: 'run',
    protocol: {
      min: RUNTIME_HOST_PROTOCOL_VERSION,
      max: RUNTIME_HOST_PROTOCOL_VERSION,
    },
    compositionId: INTERACTIVE_RUNTIME_HOST_COMPOSITION_ID,
    ...(input.signal ? { signal: input.signal } : {}),
  });
  if (initial.kind !== 'connected') {
    if (input.signal?.aborted) {
      return indeterminate(input.execution.executionId, 'Hosted execution was cancelled');
    }
    const cause = initial.kind === 'failed' ? initial.reason : initial.kind;
    return indeterminate(input.execution.executionId, `Runtime Host did not start: ${cause}`);
  }
  let connected: Extract<
    Awaited<ReturnType<typeof connectOwnedRuntimeHost>>,
    { kind: 'connected' }
  > = initial;
  let projection: HostedExecutionProjection;
  let detached = false;
  try {
    input.signal?.throwIfAborted();
    const target = input.execution.session.modelTarget;
    if (target.kind === 'explicit') {
      if (!input.baseUrl) throw new Error('Explicit model target requires baseUrl');
      const changed = await configureHostedExecutionTarget(
        connected.connection,
        {
          connectionSlug: target.connectionSlug,
          model: target.model,
          baseUrl: input.baseUrl,
        },
        input.signal,
      );
      if (changed) {
        await connected.connection.close().catch(() => undefined);
        if (!(await connected.host.settle(input.hostSettlementTimeoutMs ?? 15_000))) {
          return indeterminate(input.execution.executionId, 'Runtime Host did not exit cleanly');
        }
        const reconnected = await dependencies.connectOwnedRuntimeHost({
          rootPath: input.rootPath,
          surface: 'run',
          protocol: {
            min: RUNTIME_HOST_PROTOCOL_VERSION,
            max: RUNTIME_HOST_PROTOCOL_VERSION,
          },
          compositionId: INTERACTIVE_RUNTIME_HOST_COMPOSITION_ID,
          ...(input.signal ? { signal: input.signal } : {}),
        });
        if (reconnected.kind !== 'connected') {
          if (input.signal?.aborted) {
            return indeterminate(input.execution.executionId, 'Hosted execution was cancelled');
          }
          const cause = reconnected.kind === 'failed' ? reconnected.reason : reconnected.kind;
          return indeterminate(input.execution.executionId, `Runtime Host did not start: ${cause}`);
        }
        connected = reconnected;
      }
    }
    const execution = await executeHostedExecution(
      connected.connection,
      connected.host,
      input.execution,
      input.signal,
      input.abortPolicy ?? 'cancel',
    );
    projection = execution.projection;
    detached = execution.detached;
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

  if (detached) return projection;
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
  connection: Pick<RuntimeHostConnection, 'request' | 'close'>,
  host: { releaseToEnvironment(): void },
  execution: HostedExecutionStartInput,
  signal: AbortSignal | undefined,
  abortPolicy: NonNullable<RunHostedExecutionInput['abortPolicy']>,
): Promise<{ readonly projection: HostedExecutionProjection; readonly detached: boolean }> {
  let detached = false;
  let closeForDetach: Promise<void> | undefined;
  const detach = () => {
    if (abortPolicy !== 'preserve_environment' || detached) return;
    detached = true;
    host.releaseToEnvironment();
    closeForDetach = connection.close().catch(() => undefined);
  };
  const cancel = () => {
    if (abortPolicy === 'preserve_environment') {
      detach();
      return;
    }
    void connection
      .request('hosted.execution.cancel', { executionId: execution.executionId })
      .catch(() => undefined);
  };
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) cancel();
  try {
    const projection = await connection.request('hosted.execution.start', execution);
    return {
      projection:
        detached && !preservesHostedExecutionEnvironment(projection)
          ? indeterminate(
              execution.executionId,
              'Hosted execution continues for environment verification',
            )
          : projection,
      detached,
    };
  } catch (error) {
    if (detached) {
      return {
        projection: indeterminate(
          execution.executionId,
          'Hosted execution continues for environment verification',
        ),
        detached: true,
      };
    }
    throw error;
  } finally {
    signal?.removeEventListener('abort', cancel);
    await closeForDetach;
  }
}

function indeterminate(executionId: string, failureReason: string): HostedExecutionProjection {
  return { executionId, kind: 'indeterminate', failureReason };
}
