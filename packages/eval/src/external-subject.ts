import type { JsonObject } from './experiment.js';
import type { NormalizedUsage } from './result.js';
import type { SubjectAdapter } from './runner.js';

export function createExternalSubjectAdapter(): SubjectAdapter {
  return {
    kind: 'external',
    validate: (cell) => decodeConfig(cell.subject.config, cell.subject.credentials),
    async execute({ cell, context }) {
      const config = decodeConfig(cell.subject.config, cell.subject.credentials);
      const startedAt = Date.now();
      try {
        const execution = await context.execute({
          command: config.command,
          args: config.args.map((argument) =>
            argument
              .replaceAll('{{task.input}}', context.taskInput)
              .replaceAll('{{task.id}}', cell.task.id),
          ),
          credentialNames: cell.subject.credentials,
          ...(Object.keys(config.environment).length === 0
            ? {}
            : { environment: config.environment }),
          ...(Object.keys(config.credentialEnvironment).length === 0
            ? {}
            : { credentialEnvironment: config.credentialEnvironment }),
          ...(config.result === 'exit-code' ? { captureStdout: false } : {}),
        });
        if (execution.termination === 'cancelled') {
          return {
            usage: null,
            costUsd: null,
            durationMs: Date.now() - startedAt,
            status: 'indeterminate' as const,
            failureReason: 'external subject cancelled',
            artifacts: [{ kind: 'external_process', exitCode: execution.exitCode }],
          };
        }
        if (execution.termination === 'framework_timeout') {
          return {
            usage: null,
            costUsd: null,
            durationMs: Date.now() - startedAt,
            status: 'failed' as const,
            failureReason: 'external subject exceeded the framework timeout',
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
        if (config.result === 'exit-code') {
          return {
            usage: null,
            costUsd: null,
            durationMs: Date.now() - startedAt,
            status: 'completed' as const,
            failureReason: null,
            artifacts: [{ kind: 'external_process', exitCode: execution.exitCode }],
          };
        }
        const result = decodeResult(execution.stdout);
        return {
          ...(result.output === undefined ? {} : { output: result.output }),
          usage: result.usage,
          costUsd: result.costUsd,
          durationMs: Date.now() - startedAt,
          status: 'completed' as const,
          failureReason: null,
          artifacts: result.artifacts,
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
  const credentialEnvironment = stringMap(config.credentialEnvironment, 'credentialEnvironment');
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
  return {
    command: text(config.command, 'external subject command'),
    args: config.args,
    environment,
    credentialEnvironment,
    result,
  };
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
  artifacts: readonly JsonObject[];
} {
  const parsed = JSON.parse(stdout) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('external result must be an object');
  }
  const fields = ['schemaVersion', 'usage', 'costUsd', 'artifacts'];
  if (Object.hasOwn(parsed, 'output')) fields.push('output');
  const result = exact(parsed, fields, 'external result');
  if (result.schemaVersion !== 'maka.external_subject_result.v1')
    throw new Error('external result schema is invalid');
  if (result.output !== undefined && typeof result.output !== 'string')
    throw new Error('external result output is invalid');
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
