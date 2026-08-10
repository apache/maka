import type { JsonObject } from './experiment.js';
import type { NormalizedUsage } from './result.js';
import type { SubjectAdapter } from './runner.js';

export function createExternalSubjectAdapter(): SubjectAdapter {
  return {
    kind: 'external',
    validate: (cell) => decodeConfig(cell.subject.config),
    async execute({ cell, context }) {
      const config = decodeConfig(cell.subject.config);
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

function decodeConfig(value: JsonObject): { command: string; args: readonly string[] } {
  const config = exact(value, ['command', 'args'], 'external subject config');
  if (
    !Array.isArray(config.args) ||
    !config.args.every((argument) => typeof argument === 'string')
  ) {
    throw new Error('external subject args are invalid');
  }
  return { command: text(config.command, 'external subject command'), args: config.args };
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
