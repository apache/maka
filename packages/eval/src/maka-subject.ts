import { randomUUID } from 'node:crypto';
import type {
  HostedExecutionProjection,
  HostedExecutionStartInput,
} from '@maka/runtime-host/protocol';
import type { JsonObject } from './experiment.js';
import type { SubjectAdapter } from './runner.js';

export function createMakaSubjectAdapter(): SubjectAdapter {
  return {
    kind: 'maka',
    validate: (cell) => decodeConfig(cell.subject.config),
    async execute({ cell, context }) {
      const config = decodeConfig(cell.subject.config);
      const executionId = randomUUID();
      const input: HostedExecutionStartInput = {
        executionId,
        session: {
          cwd: context.cwd,
          modelTarget: {
            kind: 'explicit',
            connectionSlug: config.connectionSlug,
            model: config.model,
          },
          thinkingLevel: config.thinkingLevel,
          permissionMode: config.permissionMode,
          collaborationMode: config.collaborationMode,
          orchestrationMode: config.orchestrationMode,
        },
        content: { text: context.taskInput },
        maxSteps: positive(cell.budget.maxSteps, 'budget.maxSteps'),
      };
      const payload = Buffer.from(
        JSON.stringify({
          rootPath: `${config.runtimeHostsPath}/${executionId}`,
          baseUrl: config.baseUrl,
          execution: input,
        }),
      ).toString('base64url');
      const startedAt = Date.now();
      try {
        const process = await context.execute({
          command: config.nodePath,
          args: [config.shimPath, payload],
          credentialNames: cell.subject.credentials,
        });
        const projection = JSON.parse(process.stdout) as HostedExecutionProjection;
        if (projection.kind === 'indeterminate') {
          return {
            usage: null,
            costUsd: null,
            durationMs: Date.now() - startedAt,
            status: 'indeterminate' as const,
            failureReason: projection.failureReason,
            artifacts: [{ kind: 'runtime_host_execution', executionId }],
          };
        }
        if (process.exitCode !== 0) {
          return {
            usage: projection.usage,
            costUsd: projection.costUsd,
            durationMs: Date.now() - startedAt,
            status: 'indeterminate' as const,
            failureReason: 'Maka execution shim did not settle cleanly',
            artifacts: [{ kind: 'runtime_host_execution', executionId }],
          };
        }
        return {
          usage: projection.usage,
          costUsd: projection.costUsd,
          durationMs: Date.now() - startedAt,
          status: projection.status === 'completed' ? ('completed' as const) : ('failed' as const),
          failureReason: projection.failureReason ?? null,
          artifacts: [{ kind: 'runtime_host_execution', executionId }],
        };
      } catch {
        return {
          usage: null,
          costUsd: null,
          durationMs: Date.now() - startedAt,
          status: context.signal?.aborted ? ('indeterminate' as const) : ('infra_failed' as const),
          failureReason: context.signal?.aborted ? 'Maka subject cancelled' : 'Maka subject failed',
          artifacts: [{ kind: 'runtime_host_execution', executionId }],
        };
      }
    },
  };
}

interface MakaConfig {
  readonly nodePath: string;
  readonly shimPath: string;
  readonly runtimeHostsPath: string;
  readonly baseUrl: string;
  readonly connectionSlug: string;
  readonly model: string;
  readonly thinkingLevel: HostedExecutionStartInput['session']['thinkingLevel'];
  readonly permissionMode: HostedExecutionStartInput['session']['permissionMode'];
  readonly collaborationMode: HostedExecutionStartInput['session']['collaborationMode'];
  readonly orchestrationMode: HostedExecutionStartInput['session']['orchestrationMode'];
}

function decodeConfig(value: JsonObject): MakaConfig {
  const fields = [
    'nodePath',
    'shimPath',
    'runtimeHostsPath',
    'baseUrl',
    'connectionSlug',
    'model',
    'thinkingLevel',
    'permissionMode',
    'collaborationMode',
    'orchestrationMode',
  ];
  const config = exact(value, fields);
  if (!URL.canParse(String(config.baseUrl))) throw new Error('Maka baseUrl is invalid');
  return config as unknown as MakaConfig;
}

function exact(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Maka config must be an object');
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).length !== fields.length ||
    fields.some((field) => !Object.hasOwn(record, field))
  )
    throw new Error('Maka config fields are invalid');
  for (const field of fields)
    if (typeof record[field] !== 'string' || record[field] === '')
      throw new Error(`Maka config.${field} is invalid`);
  return record;
}

function positive(value: unknown, where: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new Error(`${where} is invalid`);
  return value as number;
}
