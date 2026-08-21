import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { meteringCheckpointMacMatches, readBoundedRegularFile } from './metering-checkpoint.js';
import type { JsonObject } from './experiment.js';
import type { NormalizedUsage } from './result.js';
import type { SubjectAdapter } from './runner.js';
import { deriveMetering } from './provider-metering.js';
import {
  TOOLCHAIN_IDENTITIES,
  TOOLCHAIN_IDENTITY_ENV,
  type ExternalProfile,
  isExternalProfile,
  type ToolchainIdentity,
  verifyToolchainDirectory,
} from './toolchain-verification.js';

const BUNDLED_EXTERNAL_WRAPPER = '/opt/maka-agent/packages/eval/dist/harbor-external-subject.js';

export function createExternalSubjectAdapter(): SubjectAdapter {
  const verifiedToolchains = new Map<string, ToolchainIdentity>();
  return {
    kind: 'external',
    validate: (cell) => decodeConfig(cell.subject.config, cell.subject.credentials),
    prepare: async ({ cells }) => {
      verifiedToolchains.clear();
      for (const cell of uniqueSubjects(cells)) {
        const config = decodeConfig(cell.subject.config, cell.subject.credentials);
        const toolchain = wrapperToolchain(config, cell.executor.config);
        if (!toolchain) continue;
        const expected = TOOLCHAIN_IDENTITIES[toolchain.profile];
        const mounts = executorMounts(cell.executor.config);
        if (
          !mounts.some(
            (mount) => mount.sourceEnv === toolchain.sourceEnv && mount.target === expected.root,
          )
        ) {
          throw new Error(`${cell.subject.id} toolchain mount is invalid`);
        }
        const root = process.env[toolchain.sourceEnv];
        if (!root) throw new Error(`machine path ${toolchain.sourceEnv} is unavailable`);
        verifiedToolchains.set(
          cell.subject.id,
          await verifyToolchainDirectory(toolchain.profile, root),
        );
      }
    },
    canReuse: ({ cell, attempt }) => {
      const config = decodeConfig(cell.subject.config, cell.subject.credentials);
      const toolchain = wrapperToolchain(config, cell.executor.config);
      if (!toolchain) return true;
      const identity = verifiedToolchains.get(cell.subject.id);
      if (!identity) return false;
      const artifact = attempt.result.artifacts.find(
        (candidate) =>
          candidate.kind === 'toolchain' &&
          candidate.profile === toolchain.profile &&
          candidate.version === identity.version &&
          candidate.fingerprint === identity.fingerprint,
      );
      return artifact !== undefined;
    },
    async execute({ cell, context }) {
      const config = decodeConfig(cell.subject.config, cell.subject.credentials);
      const toolchain = wrapperToolchain(config, cell.executor.config);
      const profile = bundledProfile(config.args);
      const identity = toolchain ? verifiedToolchains.get(cell.subject.id) : undefined;
      if (toolchain && !identity) {
        throw new Error(`${cell.subject.id} toolchain was not verified before execution`);
      }
      const startedAt = Date.now();
      try {
        const execution = await context.execute({
          command: config.command,
          args: config.args.map((argument) =>
            argument
              .replaceAll('{{task.input}}', context.taskInput)
              .replaceAll('{{task.id}}', cell.task.id)
              .replaceAll('{{task.cwd}}', context.cwd),
          ),
          credentialEnvironment: config.credentialEnvironment,
          ...(Object.keys(config.environment).length === 0 && !identity
            ? {}
            : {
                environment: {
                  ...config.environment,
                  ...(identity ? { [TOOLCHAIN_IDENTITY_ENV]: JSON.stringify(identity) } : {}),
                },
              }),
          ...(config.result === 'exit-code' ? { captureStdout: false } : {}),
        });
        const decoded = execution.stdout.length === 0 ? undefined : decodeResult(execution.stdout);
        const recovered = await recoverExternalMetering(context.metadata, profile);
        const recoveryArtifacts = externalRecoveryArtifacts(profile, identity, recovered);
        if (execution.termination === 'framework_timeout') {
          return {
            usage: decoded?.usage ?? recovered?.usage ?? null,
            costUsd: decoded?.costUsd ?? recovered?.costUsd ?? null,
            durationMs: Date.now() - startedAt,
            status: 'failed' as const,
            failureReason: 'external subject exceeded the framework timeout',
            artifacts: [
              ...(decoded?.artifacts ?? recoveryArtifacts),
              ...(decoded?.usage == null && recovered && decoded ? [recovered.artifact] : []),
              { kind: 'external_process', exitCode: execution.exitCode },
            ],
          };
        }
        if (execution.diagnostic?.category === 'execution-scope-unavailable') {
          return {
            usage: recovered?.usage ?? null,
            costUsd: recovered?.costUsd ?? null,
            durationMs: Date.now() - startedAt,
            status: context.signal?.aborted
              ? ('indeterminate' as const)
              : ('infra_failed' as const),
            failureReason: 'external subject execution scope was unavailable',
            artifacts: [
              ...recoveryArtifacts,
              { kind: 'external_process', exitCode: execution.exitCode },
            ],
          };
        }
        if (config.result === 'exit-code') {
          return {
            usage: null,
            costUsd: null,
            durationMs: Date.now() - startedAt,
            status:
              execution.exitCode === 0
                ? ('completed' as const)
                : context.signal?.aborted
                  ? ('indeterminate' as const)
                  : ('failed' as const),
            failureReason:
              execution.exitCode === 0 ? null : `external subject exited ${execution.exitCode}`,
            artifacts: [{ kind: 'external_process', exitCode: execution.exitCode }],
          };
        }
        if (execution.diagnostic?.category.startsWith('result-frame-')) {
          return {
            usage: recovered?.usage ?? null,
            costUsd: recovered?.costUsd ?? null,
            durationMs: Date.now() - startedAt,
            status: context.signal?.aborted
              ? ('indeterminate' as const)
              : recovered && recovered.admittedRequests > 0
                ? ('failed' as const)
                : ('infra_failed' as const),
            failureReason: 'external subject result transport failed',
            artifacts: [
              ...recoveryArtifacts,
              { kind: 'external_process', exitCode: execution.exitCode },
            ],
          };
        }
        // The wrapper's exit code is a projection of the status in its result
        // frame, carried for the relay's benefit because the relay cannot read
        // the frame. Where the frame is readable it is the authority, so a
        // nonzero exit alongside a valid frame is not a second opinion. Only
        // when no frame arrived does the exit code decide anything.
        if (!decoded) {
          return {
            usage: recovered?.usage ?? null,
            costUsd: recovered?.costUsd ?? null,
            durationMs: Date.now() - startedAt,
            status: context.signal?.aborted
              ? ('indeterminate' as const)
              : recovered && recovered.admittedRequests > 0
                ? ('failed' as const)
                : ('infra_failed' as const),
            failureReason: 'external subject returned no result',
            artifacts: [
              ...recoveryArtifacts,
              { kind: 'external_process', exitCode: execution.exitCode },
            ],
          };
        }
        return {
          ...(decoded.output === undefined ? {} : { output: decoded.output }),
          usage: decoded.usage,
          costUsd: decoded.costUsd,
          durationMs: Date.now() - startedAt,
          status:
            decoded.status ??
            (execution.exitCode === 0 ? ('completed' as const) : ('failed' as const)),
          failureReason:
            decoded.failureReason ??
            (execution.exitCode === 0 ? null : `external subject exited ${execution.exitCode}`),
          artifacts: decoded.artifacts,
        };
      } catch {
        // Reaching here means `execute` itself threw: the relay transport, the
        // executor, or this process — not the subject, which may never have run
        // at all. Recovered usage is still worth keeping and attributing, but
        // admitted model work says nothing about whose failure this was, so it
        // does not turn an infrastructure failure into a recorded zero.
        const recovered = await recoverExternalMetering(context.metadata, profile);
        return {
          usage: recovered?.usage ?? null,
          costUsd: recovered?.costUsd ?? null,
          durationMs: Date.now() - startedAt,
          status: context.signal?.aborted ? ('indeterminate' as const) : ('infra_failed' as const),
          failureReason: context.signal?.aborted
            ? 'external subject cancelled'
            : 'external subject execution failed',
          artifacts: externalRecoveryArtifacts(profile, identity, recovered),
        };
      }
    },
  };
}

function externalRecoveryArtifacts(
  profile: ExternalProfile | undefined,
  identity: ToolchainIdentity | undefined,
  recovered: Awaited<ReturnType<typeof recoverExternalMetering>>,
): JsonObject[] {
  return [
    ...(profile && identity ? [{ kind: 'toolchain', profile, ...identity }] : []),
    ...(recovered ? [recovered.artifact] : []),
  ];
}

export async function recoverExternalMetering(
  metadata: JsonObject,
  profile: ExternalProfile | undefined,
): Promise<
  | {
      readonly usage: NormalizedUsage | null;
      readonly costUsd: number | null;
      readonly admittedRequests: number;
      readonly artifact: JsonObject;
    }
  | undefined
> {
  if (!profile || typeof metadata.trialPath !== 'string') return undefined;
  if (typeof metadata.meteringSecret !== 'string') return undefined;
  const path = join(metadata.trialPath, 'agent', `${profile}.provider-usage.json`);
  const bytes = await readBoundedRegularFile(path);
  if (!bytes) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch {
    return undefined;
  }
  try {
    // The checkpoint carries only what the proxy observed. Completeness, cost
    // and the missing-usage count are worked out here through the same function
    // the wrapper uses, so there is no second definition of them to disagree
    // with — and nothing to validate a stored copy against.
    const checkpoint = exact(
      value,
      [
        'schemaVersion',
        'profile',
        'usage',
        'settled',
        'requests',
        'inFlightRequests',
        'admittedRequests',
        'usageRequests',
        'removedWebTools',
        'models',
        'toolNames',
        'mac',
      ],
      'external metering checkpoint',
    );
    if (
      checkpoint.schemaVersion !== 'maka.external_provider_usage.v2' ||
      checkpoint.profile !== profile ||
      !meteringCheckpointMacMatches(checkpoint, metadata.meteringSecret)
    ) {
      return undefined;
    }
    const usage = checkpoint.usage === null ? null : decodeUsage(checkpoint.usage);
    const counts = {
      usage,
      settled: boolean(checkpoint.settled, 'external metering settlement'),
      requests: count(checkpoint.requests, 'external metering requests'),
      inFlightRequests: count(checkpoint.inFlightRequests, 'external metering in-flight requests'),
      admittedRequests: count(checkpoint.admittedRequests, 'external metering admitted requests'),
      usageRequests: count(checkpoint.usageRequests, 'external metering usage requests'),
      removedWebTools: count(checkpoint.removedWebTools, 'external metering removed web tools'),
      models: stringList(checkpoint.models, 'external metering models'),
      toolNames: stringList(checkpoint.toolNames, 'external metering tool names'),
    };
    // A request may be admitted while still in flight, so admission is bounded
    // by the requests made rather than by the requests settled. Settlement is
    // the one claim the counts can contradict: nothing is in flight once the
    // proxy has stopped.
    if (
      (counts.settled && counts.inFlightRequests > 0) ||
      counts.inFlightRequests > counts.requests ||
      counts.admittedRequests > counts.requests ||
      counts.usageRequests > counts.admittedRequests ||
      (counts.usageRequests > 0 && usage === null)
    ) {
      return undefined;
    }
    const derived = deriveMetering(counts);
    return {
      usage,
      costUsd: derived.costUsd,
      admittedRequests: counts.admittedRequests,
      artifact: {
        kind: 'provider-metering-recovery',
        profile,
        path: `agent/${profile}.provider-usage.json`,
        bytes: bytes.byteLength,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        requests: counts.requests,
        settledRequests: derived.settledRequests,
        inFlightRequests: counts.inFlightRequests,
        admittedRequests: counts.admittedRequests,
        usageRequests: counts.usageRequests,
        missingUsageRequests: derived.missingUsageRequests,
        usageComplete: derived.usageComplete,
        tokenBasis: derived.tokenBasis,
        removedWebTools: counts.removedWebTools,
        models: counts.models,
        toolNames: counts.toolNames,
      },
    };
  } catch {
    return undefined;
  }
}

interface ExternalSubjectConfig {
  readonly command: string;
  readonly args: readonly string[];
  readonly environment: Readonly<Record<string, string>>;
  readonly credentialEnvironment: Readonly<Record<string, string>>;
  readonly result: 'protocol-v1' | 'exit-code';
}

function decodeConfig(
  value: JsonObject,
  declaredCredentials: readonly string[],
): ExternalSubjectConfig {
  const fields = ['command', 'args'];
  for (const optional of ['environment', 'credentialEnvironment', 'result']) {
    if (Object.hasOwn(value, optional)) fields.push(optional);
  }
  const config = exact(value, fields, 'external subject config');
  if (
    !Array.isArray(config.args) ||
    !config.args.every((argument) => typeof argument === 'string')
  ) {
    throw new Error('external subject args are invalid');
  }
  const environment = stringMap(config.environment, 'environment');
  if (Object.hasOwn(environment, TOOLCHAIN_IDENTITY_ENV)) {
    throw new Error(`environment contains reserved ${TOOLCHAIN_IDENTITY_ENV}`);
  }
  const credentialEnvironment = Object.hasOwn(config, 'credentialEnvironment')
    ? stringMap(config.credentialEnvironment, 'credentialEnvironment')
    : Object.freeze(Object.fromEntries(declaredCredentials.map((name) => [name, name])));
  for (const [target, source] of Object.entries(credentialEnvironment)) {
    if (!declaredCredentials.includes(source)) {
      throw new Error(`credentialEnvironment.${target} must reference a declared credential`);
    }
    if (Object.hasOwn(environment, target)) {
      throw new Error(`environment and credentialEnvironment overlap at ${target}`);
    }
  }
  const result = config.result ?? 'protocol-v1';
  if (result !== 'protocol-v1' && result !== 'exit-code') {
    throw new Error('external subject result is invalid');
  }
  if (result === 'protocol-v1' && !bundledProfile(config.args)) {
    throw new Error('external subject protocol-v1 requires the bundled result wrapper');
  }
  return {
    command: text(config.command, 'external subject command'),
    args: config.args,
    environment,
    credentialEnvironment,
    result,
  };
}

function wrapperToolchain(
  config: ExternalSubjectConfig,
  executorConfig: JsonObject,
): { profile: ExternalProfile; sourceEnv: string } | undefined {
  const profile = bundledProfile(config.args);
  if (!profile) return undefined;
  const target = TOOLCHAIN_IDENTITIES[profile].root;
  const mount = executorMounts(executorConfig).find((candidate) => candidate.target === target);
  if (!mount) throw new Error(`${profile} toolchain mount is missing`);
  return { profile, sourceEnv: mount.sourceEnv };
}

function bundledProfile(args: readonly string[]): ExternalProfile | undefined {
  if (args[0] !== BUNDLED_EXTERNAL_WRAPPER) return undefined;
  return isExternalProfile(args[1]) ? args[1] : undefined;
}

function uniqueSubjects(cells: readonly import('./experiment.js').ExperimentCell[]) {
  return [...new Map(cells.map((cell) => [cell.subject.id, cell] as const)).values()];
}

function executorMounts(value: JsonObject): Array<{ sourceEnv: string; target: string }> {
  const raw = value.mounts;
  if (!Array.isArray(raw)) throw new Error('executor.config.mounts must be an array');
  return raw.map((item, index) => {
    const mount = exact(item, ['sourceEnv', 'target', 'readOnly'], `executor mount ${index}`);
    if (
      typeof mount.sourceEnv !== 'string' ||
      typeof mount.target !== 'string' ||
      mount.readOnly !== true
    ) {
      throw new Error(`executor mount ${index} is invalid`);
    }
    return { sourceEnv: mount.sourceEnv, target: mount.target };
  });
}

function stringMap(value: unknown, where: string): Readonly<Record<string, string>> {
  if (value === undefined) return Object.freeze({});
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${where} must be an object`);
  }
  const entries = Object.entries(value);
  for (const [name, item] of entries) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name) || typeof item !== 'string') {
      throw new Error(`${where}.${name} is invalid`);
    }
  }
  return Object.freeze(Object.fromEntries(entries));
}

function decodeResult(stdout: string): {
  output?: string;
  usage: NormalizedUsage | null;
  costUsd: number | null;
  status?: 'completed' | 'failed' | 'infra_failed' | 'indeterminate';
  failureReason?: string | null;
  artifacts: readonly JsonObject[];
} {
  const parsed = JSON.parse(stdout) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('external result must be an object');
  }
  const fields = ['schemaVersion', 'usage', 'costUsd', 'artifacts'];
  if (Object.hasOwn(parsed, 'output')) fields.push('output');
  if (Object.hasOwn(parsed, 'status')) fields.push('status');
  if (Object.hasOwn(parsed, 'failureReason')) fields.push('failureReason');
  const result = exact(parsed, fields, 'external result');
  if (
    result.schemaVersion !== 'maka.external_subject_result.v1' &&
    result.schemaVersion !== 'maka.external_subject_result.v2'
  )
    throw new Error('external result schema is invalid');
  if (
    result.schemaVersion === 'maka.external_subject_result.v2' &&
    (!Object.hasOwn(result, 'status') || !Object.hasOwn(result, 'failureReason'))
  )
    throw new Error('external result v2 fields are invalid');
  if (result.output !== undefined && typeof result.output !== 'string')
    throw new Error('external result output is invalid');
  if (
    result.status !== undefined &&
    result.status !== 'completed' &&
    result.status !== 'failed' &&
    result.status !== 'infra_failed' &&
    result.status !== 'indeterminate'
  )
    throw new Error('external result status is invalid');
  if (
    result.failureReason !== undefined &&
    result.failureReason !== null &&
    typeof result.failureReason !== 'string'
  )
    throw new Error('external result failureReason is invalid');
  if (
    !Array.isArray(result.artifacts) ||
    !result.artifacts.every(
      (artifact) => artifact && typeof artifact === 'object' && !Array.isArray(artifact),
    )
  ) {
    throw new Error('external result artifacts are invalid');
  }
  return {
    ...(result.output === undefined ? {} : { output: result.output }),
    usage: result.usage === null ? null : decodeUsage(result.usage),
    costUsd: result.costUsd === null ? null : nonnegative(result.costUsd, 'external result cost'),
    ...(result.status === undefined
      ? {}
      : {
          status: result.status as 'completed' | 'failed' | 'infra_failed' | 'indeterminate',
        }),
    ...(result.failureReason === undefined
      ? {}
      : { failureReason: result.failureReason as string | null }),
    artifacts: result.artifacts as JsonObject[],
  };
}

function decodeUsage(value: unknown): NormalizedUsage {
  const usage = exact(
    value,
    [
      'inputTokens',
      'outputTokens',
      'cacheReadTokens',
      'cacheWriteTokens',
      'reasoningTokens',
      'totalTokens',
    ],
    'external usage',
  );
  return Object.fromEntries(
    Object.entries(usage).map(([key, item]) => [key, nonnegative(item, key)]),
  ) as unknown as NormalizedUsage;
}

function exact(value: unknown, fields: readonly string[], where: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`${where} must be an object`);
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).length !== fields.length ||
    fields.some((field) => !Object.hasOwn(record, field))
  )
    throw new Error(`${where} fields are invalid`);
  return record;
}

function text(value: unknown, where: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${where} is required`);
  return value;
}

function nonnegative(value: unknown, where: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0)
    throw new Error(`${where} is invalid`);
  return value;
}

function count(value: unknown, where: string): number {
  const decoded = nonnegative(value, where);
  if (!Number.isSafeInteger(decoded)) throw new Error(`${where} is invalid`);
  return decoded;
}

function boolean(value: unknown, where: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${where} is invalid`);
  return value;
}

function stringList(value: unknown, where: string): readonly string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    throw new Error(`${where} is invalid`);
  }
  return value;
}
