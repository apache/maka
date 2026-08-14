import {
  INTERACTIVE_RUNTIME_HOST_COMPOSITION_ID,
  preservesHostedExecutionEnvironment,
  RUNTIME_HOST_PROTOCOL_VERSION,
  type HostedExecutionProjection,
  type HostedExecutionStartInput,
} from '../protocol/index.js';
import { join } from 'node:path';
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
const HEADLESS_LIVENESS = {
  livenessIntervalMs: 0,
  livenessTimeoutMs: 30_000,
} as const;

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
  const liveness =
    input.execution.session.toolProfile === 'headless-coding-v1'
      ? {
          ...HEADLESS_LIVENESS,
          candidateStderrPath: join(input.rootPath, 'runtime-host-candidate.log'),
        }
      : {};
  const initial = await dependencies.connectOwnedRuntimeHost({
    rootPath: input.rootPath,
    surface: 'run',
    protocol: {
      min: RUNTIME_HOST_PROTOCOL_VERSION,
      max: RUNTIME_HOST_PROTOCOL_VERSION,
    },
    compositionId: INTERACTIVE_RUNTIME_HOST_COMPOSITION_ID,
    ...liveness,
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
          ...liveness,
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
    projection = await executeHostedExecution(connected.connection, input.execution, input.signal);
  } catch (error) {
    connected.host.recordDiagnostic?.(runtimeHostClientErrorMarker(error));
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
  if (clean || projection.kind === 'indeterminate') return projection;
  return indeterminate(input.execution.executionId, 'Runtime Host did not exit cleanly');
}

function runtimeHostClientErrorMarker(error: unknown): string {
  const failure = error instanceof Error ? error : new Error(String(error));
  const details = failure as Error & {
    readonly operation?: unknown;
    readonly mode?: unknown;
    readonly dispatch?: unknown;
    readonly reason?: unknown;
    readonly retryable?: unknown;
  };
  const cause = failure.cause instanceof Error ? failure.cause : undefined;
  const code =
    typeof (failure as NodeJS.ErrnoException).code === 'string'
      ? (failure as NodeJS.ErrnoException).code
      : null;
  return `MAKA_RUNTIME_HOST_CLIENT_ERROR_V1 ${JSON.stringify({
    name: failure.name,
    code,
    message: failure.message,
    operation: stringField(details.operation),
    mode: stringField(details.mode),
    dispatch: stringField(details.dispatch),
    reason: stringField(details.reason),
    retryable: typeof details.retryable === 'boolean' ? details.retryable : null,
    cause: cause
      ? {
          name: cause.name,
          code:
            typeof (cause as NodeJS.ErrnoException).code === 'string'
              ? (cause as NodeJS.ErrnoException).code
              : null,
          message: cause.message,
        }
      : null,
  })}`;
}

function stringField(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
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
