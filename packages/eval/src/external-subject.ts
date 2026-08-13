import type { JsonObject } from './experiment.js';
import type { NormalizedUsage } from './result.js';
import type { SubjectAdapter } from './runner.js';
import {
  TOOLCHAIN_IDENTITIES,
  TOOLCHAIN_IDENTITY_ENV,
  type ExternalProfile,
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
        if (execution.termination === 'framework_timeout') {
          return {
            usage: decoded?.usage ?? null,
            costUsd: decoded?.costUsd ?? null,
            durationMs: Date.now() - startedAt,
            status: 'failed' as const,
            failureReason: 'external subject exceeded the framework timeout',
            artifacts: [
              ...(decoded?.artifacts ?? []),
              { kind: 'external_process', exitCode: execution.exitCode },
            ],
          };
        }
        if (execution.diagnostic?.category === 'execution-scope-unavailable') {
          return {
            usage: null,
            costUsd: null,
            durationMs: Date.now() - startedAt,
            status: context.signal?.aborted
              ? ('indeterminate' as const)
              : ('infra_failed' as const),
            failureReason: 'external subject execution scope was unavailable',
            artifacts: [{ kind: 'external_process', exitCode: execution.exitCode }],
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
            usage: null,
            costUsd: null,
            durationMs: Date.now() - startedAt,
            status: context.signal?.aborted
              ? ('indeterminate' as const)
              : ('infra_failed' as const),
            failureReason: 'external subject result transport failed',
            artifacts: [{ kind: 'external_process', exitCode: execution.exitCode }],
          };
        }
        if (execution.exitCode !== 0) {
          return {
            usage: null,
            costUsd: null,
            durationMs: Date.now() - startedAt,
            status: context.signal?.aborted ? ('indeterminate' as const) : ('failed' as const),
            failureReason: `external subject exited ${execution.exitCode}`,
            artifacts: [{ kind: 'external_process', exitCode: execution.exitCode }],
          };
        }
        if (!decoded) {
          return {
            usage: null,
            costUsd: null,
            durationMs: Date.now() - startedAt,
            status: context.signal?.aborted
              ? ('indeterminate' as const)
              : ('infra_failed' as const),
            failureReason: 'external subject returned no result',
            artifacts: [{ kind: 'external_process', exitCode: execution.exitCode }],
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
        return {
          usage: null,
          costUsd: null,
          durationMs: Date.now() - startedAt,
          status: context.signal?.aborted ? ('indeterminate' as const) : ('infra_failed' as const),
          failureReason: context.signal?.aborted
            ? 'external subject cancelled'
            : 'external subject failed',
          artifacts: [],
        };
      }
    },
  };
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
  const profile = args[1];
  if (
    profile !== 'codex' &&
    profile !== 'claude-code' &&
    profile !== 'reasonix' &&
    profile !== 'opencode' &&
    profile !== 'kimi-code' &&
    profile !== 'zcode' &&
    profile !== 'pi'
  ) {
    return undefined;
  }
  return profile;
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
