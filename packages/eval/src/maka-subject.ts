/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import { randomUUID } from 'node:crypto';
import { isSessionToolProfile, type SessionToolProfile } from '@maka/core/session';
import {
  decodeHostedExecutionProjection,
  type HostedExecutionStartInput,
} from '@maka/runtime-host/protocol';
import type { JsonObject } from './experiment.js';
import {
  MAKA_RUNTIME_ARTIFACT_PATH,
  MAKA_SUBJECT_STDERR_PATH,
  MAKA_SUBJECT_STDOUT_PATH,
} from './maka-artifacts.js';
import { deepSeekCostUsd } from './provider-metering.js';
import type { NormalizedUsage } from './result.js';
import type { SubjectAdapter, SubjectExecutionContext } from './runner.js';

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
          workspace: { kind: 'host_path', path: context.cwd },
          modelTarget: {
            kind: 'explicit',
            connectionSlug: config.connectionSlug,
            model: config.model,
          },
          thinkingLevel: config.thinkingLevel,
          permissionMode: config.permissionMode,
          collaborationMode: config.collaborationMode,
          orchestrationMode: config.orchestrationMode,
          toolProfile: config.toolProfile,
        },
        content: { text: context.taskInput },
        maxSteps: positive(cell.budget.maxSteps, 'budget.maxSteps'),
      };
      const payload = Buffer.from(
        JSON.stringify({
          rootPath: `${config.runtimeHostsPath}/${executionId}`,
          artifactRoot: MAKA_RUNTIME_ARTIFACT_PATH,
          baseUrl: config.baseUrl,
          hostSettlementTimeoutMs: config.hostSettlementTimeoutMs,
          execution: input,
        }),
      ).toString('base64url');
      const startedAt = Date.now();
      let process: Awaited<ReturnType<typeof context.execute>>;
      try {
        process = await context.execute({
          command: config.nodePath,
          args: [config.shimPath, payload],
          credentialEnvironment: Object.fromEntries(
            cell.subject.credentials.map((name) => [name, name]),
          ),
        });
      } catch {
        return subjectFailure('relay-execute', startedAt, context.signal);
      }
      if (process.termination !== 'exited') {
        const projection = tryDecodeMatchingProjection(process.stdout, executionId);
        const settled = projection?.kind === 'settled' ? projection : undefined;
        return {
          usage: settled?.usage ?? null,
          costUsd: settled ? estimateDeepSeekCost(settled.usage, config.model) : null,
          durationMs: Date.now() - startedAt,
          status: 'failed' as const,
          failureReason: 'Maka subject exceeded the framework timeout',
          artifacts: makaArtifacts(executionId, process, settled?.costUsd),
        };
      }
      if (process.stdout.length === 0) {
        return subjectFailure('empty-output', startedAt, context.signal, process);
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(process.stdout) as unknown;
      } catch {
        return subjectFailure('json-parse', startedAt, context.signal, process);
      }
      let projection: ReturnType<typeof decodeHostedExecutionProjection>;
      try {
        projection = decodeHostedExecutionProjection(parsed);
      } catch {
        return subjectFailure('result-decode', startedAt, context.signal, process);
      }
      if (projection.executionId !== executionId) {
        return subjectFailure('identity-check', startedAt, context.signal, process);
      }
      if (projection.kind === 'indeterminate') {
        return {
          usage: null,
          costUsd: null,
          durationMs: Date.now() - startedAt,
          status: 'indeterminate' as const,
          failureReason: safeFailureReason(
            projection.failureReason,
            'Maka execution did not settle',
          ),
          artifacts: makaArtifacts(executionId, process),
        };
      }
      const result = (
        status: 'completed' | 'failed' | 'indeterminate',
        failureReason: string | null,
      ) => ({
        usage: projection.usage,
        // Eval prices what Eval compares. The subject reports a cost of its
        // own, from its own table, and taking it here would mean one arm
        // billed at the runtime's rates and the others at this package's --
        // a difference in the reported figure that no agent behaviour caused.
        // It is kept as evidence below rather than used as the authority.
        costUsd: estimateDeepSeekCost(projection.usage, config.model),
        durationMs: Date.now() - startedAt,
        status,
        failureReason,
        artifacts: makaArtifacts(executionId, process, projection.costUsd),
      });
      // The shim's exit code projects this same projection's status for the
      // relay's benefit, so reading it here would only ask the same question
      // twice and get a coarser answer. A shim that died without settling
      // leaves no decodable projection, and the branches above catch that.
      if (projection.status === 'cancelled') {
        return result('indeterminate', 'Maka subject cancelled');
      }
      return result(
        projection.status,
        projection.status === 'completed' || projection.failureReason == null
          ? null
          : safeFailureReason(projection.failureReason, 'Maka execution failed'),
      );
    },
  };
}

function tryDecodeMatchingProjection(
  stdout: string,
  executionId: string,
): ReturnType<typeof decodeHostedExecutionProjection> | undefined {
  if (stdout.length === 0) return undefined;
  try {
    const projection = decodeHostedExecutionProjection(JSON.parse(stdout) as unknown);
    return projection.executionId === executionId ? projection : undefined;
  } catch {
    return undefined;
  }
}

function safeFailureReason(value: string, fallback: string): string {
  if (SAFE_RUNTIME_FAILURE_REASONS.has(value)) return value;
  if (
    /^Runtime Host did not start: (?:composition_mismatch|existing_host|host_unresponsive|incompatible|startup_timeout|upgrade_required)$/u.test(
      value,
    ) ||
    /^Runtime Host usage did not settle: (?:missing_attempt_usage|partial_attempt_usage|pending_usage_repair|unreadable_usage_record)$/u.test(
      value,
    )
  )
    return value;
  return fallback;
}

const SAFE_RUNTIME_FAILURE_REASONS = new Set([
  'Hosted execution is not active',
  'Hosted execution was cancelled',
  'Hosted execution was cancelled before admission',
  'Runtime Host connection failed before execution settlement',
  'Runtime Host could not settle execution',
  'Runtime Host did not exit cleanly',
]);

type SubjectFailureStage =
  | 'relay-execute'
  | 'empty-output'
  | 'json-parse'
  | 'result-decode'
  | 'identity-check';

function subjectFailure(
  stage: SubjectFailureStage,
  startedAt: number,
  signal?: AbortSignal,
  process?: Awaited<ReturnType<SubjectExecutionContext['execute']>>,
) {
  const cancelled = signal?.aborted === true;
  return {
    usage: null,
    costUsd: null,
    durationMs: Date.now() - startedAt,
    status: cancelled ? ('indeterminate' as const) : ('infra_failed' as const),
    failureReason: cancelled ? 'Maka subject cancelled' : `Maka subject failed during ${stage}`,
    artifacts: [
      ...makaArtifacts(undefined, process),
      {
        kind: 'subject-failure',
        stage,
        ...(process
          ? {
              termination: process.termination,
              exitCode: process.exitCode,
              stdoutBytes: Buffer.byteLength(process.stdout),
              ...(process.diagnostic ? { diagnostic: process.diagnostic } : {}),
            }
          : {}),
      },
    ],
  };
}

function makaArtifacts(
  executionId: string | undefined,
  process?: Awaited<ReturnType<SubjectExecutionContext['execute']>>,
  // What the subject billed itself, when it said. Recording it is what makes a
  // disagreement with Eval's own figure visible instead of silent -- the two
  // are computed from the same usage, so they should differ only when a price
  // table has drifted.
  subjectReportedCostUsd?: number | null,
): JsonObject[] {
  return [
    ...(subjectReportedCostUsd === undefined || subjectReportedCostUsd === null
      ? []
      : [{ kind: 'subject-reported-cost', costUsd: subjectReportedCostUsd }]),
    {
      kind: 'maka-runtime-state',
      path: MAKA_RUNTIME_ARTIFACT_PATH,
      ...(executionId ? { executionId } : {}),
    },
    {
      kind: 'subject-stdout',
      path: MAKA_SUBJECT_STDOUT_PATH,
      ...(process ? { bytes: Buffer.byteLength(process.stdout) } : {}),
    },
    {
      kind: 'subject-stderr',
      path: MAKA_SUBJECT_STDERR_PATH,
    },
  ];
}

interface MakaConfig {
  readonly nodePath: string;
  readonly shimPath: string;
  readonly runtimeHostsPath: string;
  readonly hostSettlementTimeoutMs: number;
  readonly baseUrl: string;
  readonly connectionSlug: string;
  readonly model: string;
  readonly thinkingLevel: HostedExecutionStartInput['session']['thinkingLevel'];
  readonly permissionMode: HostedExecutionStartInput['session']['permissionMode'];
  readonly collaborationMode: HostedExecutionStartInput['session']['collaborationMode'];
  readonly orchestrationMode: HostedExecutionStartInput['session']['orchestrationMode'];
  readonly toolProfile: SessionToolProfile;
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
    'hostSettlementTimeoutMs',
    'toolProfile',
  ];
  const config = exact(value, fields);
  if (!URL.canParse(String(config.baseUrl))) throw new Error('Maka baseUrl is invalid');
  const hostSettlementTimeoutMs = positiveInteger(
    config.hostSettlementTimeoutMs,
    'Maka config.hostSettlementTimeoutMs',
  );
  if (!isSessionToolProfile(config.toolProfile)) {
    throw new Error('Maka config.toolProfile is invalid');
  }
  return { ...config, hostSettlementTimeoutMs } as unknown as MakaConfig;
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
  for (const field of fields) {
    if (field === 'hostSettlementTimeoutMs') continue;
    if (typeof record[field] !== 'string' || record[field] === '')
      throw new Error(`Maka config.${field} is invalid`);
  }
  return record;
}

function positiveInteger(value: unknown, where: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${where} is invalid`);
  }
  return value;
}

function positive(value: unknown, where: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new Error(`${where} is invalid`);
  return value as number;
}

function estimateDeepSeekCost(usage: NormalizedUsage, model: string): number | null {
  if (model !== 'deepseek-v4-flash') return null;
  return deepSeekCostUsd(usage);
}
