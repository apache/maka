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

import { z } from 'zod';
import { PROJECT_DIRECTORY_MAX_ROOTS } from '../protocol/project-catalog.js';
import {
  compareProductReleaseVersions,
  isProductReleaseVersion,
  isSha512PackageIntegrity,
} from './update-package-evidence.js';

export const RUNTIME_HOST_SERVICE_MANAGEMENT_FRAME_PREFIX =
  'MAKA_RUNTIME_HOST_SERVICE_MANAGEMENT_V1 ';
export const RUNTIME_HOST_SERVICE_LOG_MAX_BYTES = 48 * 1024;
export const RUNTIME_HOST_SERVICE_ERROR_CODE_MAX_BYTES = 128;
export const RUNTIME_HOST_SERVICE_ERROR_MESSAGE_MAX_BYTES = 2 * 1024;
export const RUNTIME_HOST_OPERATOR_ACCESS_MANAGEMENT_CAPABILITY = 'access-management-v1';
export const RUNTIME_HOST_OPERATOR_PROJECT_DIRECTORY_CONFIGURATION_REQUEST_ENV =
  'MAKA_RUNTIME_HOST_OPERATOR_PROJECT_DIRECTORY_CONFIGURATION_REQUEST';
export const RUNTIME_HOST_OPERATOR_PROCESS_LIFETIME_LOCK_CAPABILITY = 'process-lifetime-lock-v1';
export const RUNTIME_HOST_OPERATOR_PEER_MANAGEMENT_CAPABILITY = 'peer-management-v1';
export const RUNTIME_HOST_OPERATOR_UPDATE_SCHEDULER_CAPABILITY = 'update-scheduler-v1';
export const RUNTIME_HOST_OPERATOR_CAPABILITY_REQUEST_ENV =
  'MAKA_RUNTIME_HOST_OPERATOR_CAPABILITY_REQUEST';

const FRAME_MAX_BYTES = 96 * 1024;
const PATH_MAX_BYTES = 4 * 1024;
const FIELD_MAX_BYTES = 512;
const SERVICE_ACTIONS = [
  'install',
  'configure',
  'status',
  'start',
  'stop',
  'restart',
  'retire',
  'check_update',
  'update',
  'update_policy',
  'reconcile_update',
  'logs',
  'uninstall',
] as const;
const NON_RETIRE_SERVICE_ACTIONS = [
  'install',
  'status',
  'start',
  'stop',
  'restart',
  'logs',
] as const;
const NON_UPDATE_SERVICE_ACTIONS = [
  'install',
  'configure',
  'status',
  'start',
  'stop',
  'restart',
  'retire',
  'check_update',
  'logs',
  'uninstall',
] as const;
const UPDATE_PHASES = ['checking', 'staging', 'retiring', 'replacing'] as const;
const UPDATE_CHANNELS = ['latest', 'next'] as const;
const UPDATE_SCHEDULER_STATES = ['ready', 'inactive', 'needs_repair'] as const;
const MANUAL_ACTION_REASONS = [
  'target_not_newer',
  'current_compatibility_unknown',
  'target_compatibility_unknown',
  'compatibility_mismatch',
] as const;
const INSTALLED_SERVICE_STATES = ['stopped', 'starting', 'running', 'failed'] as const;
const SERVICE_STATES = ['not_installed', ...INSTALLED_SERVICE_STATES] as const;
const OPERATOR_CAPABILITIES = [
  RUNTIME_HOST_OPERATOR_ACCESS_MANAGEMENT_CAPABILITY,
  RUNTIME_HOST_OPERATOR_PEER_MANAGEMENT_CAPABILITY,
  RUNTIME_HOST_OPERATOR_PROCESS_LIFETIME_LOCK_CAPABILITY,
  RUNTIME_HOST_OPERATOR_UPDATE_SCHEDULER_CAPABILITY,
] as const;

const boundedString = (maxBytes: number) =>
  z.string().refine((value) => Buffer.byteLength(value, 'utf8') <= maxBytes);
const boundedNonEmptyString = (maxBytes: number) =>
  z
    .string()
    .min(1)
    .refine((value) => Buffer.byteLength(value, 'utf8') <= maxBytes);
const PRODUCT_RELEASE_VERSION_SCHEMA = z.string().refine(isProductReleaseVersion);
const PACKAGE_INTEGRITY_SCHEMA = z.string().refine(isSha512PackageIntegrity);
const UPDATE_POLICY_SCHEMA = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('manual') }).strict(),
  z
    .object({
      kind: z.literal('fixed'),
      version: PRODUCT_RELEASE_VERSION_SCHEMA,
    })
    .strict(),
  z.object({ kind: z.literal('channel'), channel: z.enum(UPDATE_CHANNELS) }).strict(),
]);
const MANAGED_SERVICE_TARGET_SCHEMA = z
  .object({
    serviceId: z.string().regex(/^[a-f0-9]{64}$/u),
    rootPath: boundedNonEmptyString(PATH_MAX_BYTES),
    rootId: z.string().regex(/^[a-f0-9]{64}$/u),
    deploymentId: z.string().uuid().optional(),
  })
  .strict();

const UPDATE_CHECK_SCHEMA = z
  .object({
    selector: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('channel'), channel: z.enum(UPDATE_CHANNELS) }).strict(),
      z
        .object({
          kind: z.literal('exact'),
          version: PRODUCT_RELEASE_VERSION_SCHEMA,
        })
        .strict(),
    ]),
    candidate: z
      .object({
        version: PRODUCT_RELEASE_VERSION_SCHEMA,
        integrity: PACKAGE_INTEGRITY_SCHEMA,
      })
      .strict(),
    outcome: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('current') }).strict(),
      z
        .object({
          kind: z.literal('unattended_update'),
          compatibility: z.number().int().positive(),
        })
        .strict(),
      z
        .object({
          kind: z.literal('manual_action'),
          reason: z.enum(MANUAL_ACTION_REASONS),
        })
        .strict(),
    ]),
  })
  .strict()
  .superRefine((check, context) => {
    if (check.selector.kind === 'exact' && check.selector.version !== check.candidate.version) {
      context.addIssue({
        code: 'custom',
        path: ['candidate', 'version'],
        message: 'Exact update selector and candidate version must match',
      });
    }
  });

const RETIREMENT_RESULT_SCHEMA = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('active_tasks') }).strict(),
  z
    .object({
      kind: z.literal('retired'),
      hostEpoch: boundedNonEmptyString(FIELD_MAX_BYTES),
      pid: z.number().int().positive(),
    })
    .strict(),
  z.object({ kind: z.literal('stopped') }).strict(),
]);

const UPDATE_RESULT_SCHEMA = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('already_current'),
      version: boundedNonEmptyString(FIELD_MAX_BYTES),
    })
    .strict(),
  z
    .object({
      kind: z.literal('active_tasks'),
      currentVersion: boundedNonEmptyString(FIELD_MAX_BYTES),
      targetVersion: boundedNonEmptyString(FIELD_MAX_BYTES),
    })
    .strict(),
  z
    .object({
      kind: z.literal('updated'),
      previousVersion: boundedNonEmptyString(FIELD_MAX_BYTES),
      targetVersion: boundedNonEmptyString(FIELD_MAX_BYTES),
    })
    .strict(),
  z
    .object({
      kind: z.literal('repaired'),
      version: boundedNonEmptyString(FIELD_MAX_BYTES),
    })
    .strict(),
]);

const UPDATE_POLICY_RESULT_SCHEMA = z
  .object({
    policy: UPDATE_POLICY_SCHEMA,
    target: MANAGED_SERVICE_TARGET_SCHEMA.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.policy.kind === 'manual') !== (value.target === undefined)) {
      context.addIssue({
        code: 'custom',
        path: ['target'],
        message: 'Only an automatic update policy has a managed service target',
      });
    }
  });

const SERVICE_SUMMARY_SCHEMA = z
  .object({
    platform: boundedNonEmptyString(FIELD_MAX_BYTES),
    arch: boundedNonEmptyString(FIELD_MAX_BYTES),
    osRelease: boundedNonEmptyString(FIELD_MAX_BYTES),
    state: z.enum(SERVICE_STATES),
    pid: z.number().int().positive().nullable(),
    lastExitCode: z.number().int().nonnegative().nullable(),
    installedVersion: boundedString(FIELD_MAX_BYTES).nullable(),
    lifecycle: z
      .object({
        mode: z.enum(['on_demand', 'supervised']),
        availability: z.enum(['activation', 'session', 'environment', 'machine']),
        provider: z
          .enum(['systemd_user', 'launch_agent', 'openrc_user', 'openrc_system'])
          .optional(),
      })
      .strict()
      .optional(),
    reconciliation: z
      .object({
        trigger: z.enum(['manual', 'activation', 'scheduled']),
        provider: z
          .enum(['systemd_timer', 'launch_agent_timer', 'openrc_supervised_loop'])
          .optional(),
      })
      .strict()
      .optional(),
    stateRoot: boundedString(PATH_MAX_BYTES).optional(),
    configurationFingerprint: z
      .string()
      .regex(/^sha256:[a-f0-9]{64}$/u)
      .optional(),
    projectDirectoryRoots: z
      .array(
        z
          .object({
            label: boundedString(FIELD_MAX_BYTES),
            path: boundedString(PATH_MAX_BYTES),
          })
          .strict(),
      )
      .max(PROJECT_DIRECTORY_MAX_ROOTS),
  })
  .strict();
const INSTALLED_SERVICE_SUMMARY_SCHEMA = SERVICE_SUMMARY_SCHEMA.extend({
  state: z.enum(INSTALLED_SERVICE_STATES),
  installedVersion: PRODUCT_RELEASE_VERSION_SCHEMA,
});

const SERVICE_RESULT_COMMON = {
  schemaVersion: z.literal(1),
  kind: z.literal('result'),
  service: SERVICE_SUMMARY_SCHEMA,
  // Unknown tokens are ignored by callers. Keeping the wire field open lets
  // older Clients decode status from a newer operator.
  operatorCapabilities: z.array(boundedNonEmptyString(FIELD_MAX_BYTES)).max(16).optional(),
  retainedStateRoot: boundedString(PATH_MAX_BYTES).optional(),
  logs: boundedString(RUNTIME_HOST_SERVICE_LOG_MAX_BYTES).optional(),
} as const;
const SERVICE_ERROR_SCHEMA = z
  .object({
    code: boundedNonEmptyString(RUNTIME_HOST_SERVICE_ERROR_CODE_MAX_BYTES),
    message: boundedNonEmptyString(RUNTIME_HOST_SERVICE_ERROR_MESSAGE_MAX_BYTES),
  })
  .strict();

const SERVICE_MANAGEMENT_FRAME_SCHEMA = z.union([
  z
    .object({
      schemaVersion: z.literal(1),
      kind: z.literal('progress'),
      action: z.literal('update'),
      phase: z.enum(UPDATE_PHASES),
      currentVersion: boundedNonEmptyString(FIELD_MAX_BYTES),
      targetVersion: boundedNonEmptyString(FIELD_MAX_BYTES),
    })
    .strict(),
  z
    .object({
      schemaVersion: z.literal(1),
      kind: z.literal('progress'),
      action: z.literal('reconcile_update'),
      phase: z.enum(UPDATE_PHASES),
      currentVersion: boundedNonEmptyString(FIELD_MAX_BYTES),
      targetVersion: boundedNonEmptyString(FIELD_MAX_BYTES),
    })
    .strict(),
  z
    .object({
      ...SERVICE_RESULT_COMMON,
      action: z.literal('check_update'),
      service: INSTALLED_SERVICE_SUMMARY_SCHEMA,
      updateCheck: UPDATE_CHECK_SCHEMA,
    })
    .strict()
    .superRefine((frame, context) => {
      const relation = compareProductReleaseVersions(
        frame.updateCheck.candidate.version,
        frame.service.installedVersion,
      );
      const outcome = frame.updateCheck.outcome;
      const consistent =
        outcome.kind === 'current'
          ? relation === 0
          : outcome.kind === 'unattended_update'
            ? relation >= 0
            : outcome.reason === 'target_not_newer'
              ? relation < 0
              : relation >= 0;
      if (!consistent) {
        context.addIssue({
          code: 'custom',
          path: ['updateCheck', 'outcome'],
          message: 'Update outcome must match the installed and candidate versions',
        });
      }
    }),
  z
    .object({
      ...SERVICE_RESULT_COMMON,
      action: z.literal('update'),
      update: UPDATE_RESULT_SCHEMA,
    })
    .strict(),
  z
    .object({
      schemaVersion: z.literal(1),
      kind: z.literal('result'),
      action: z.literal('update_policy'),
      updatePolicy: UPDATE_POLICY_RESULT_SCHEMA,
      updateSchedulerState: z.enum(UPDATE_SCHEDULER_STATES).optional(),
    })
    .strict(),
  z
    .object({
      schemaVersion: z.literal(1),
      kind: z.literal('result'),
      action: z.literal('reconcile_update'),
      updatePolicy: UPDATE_POLICY_RESULT_SCHEMA,
      updateSchedulerState: z.enum(UPDATE_SCHEDULER_STATES).optional(),
      service: SERVICE_SUMMARY_SCHEMA.optional(),
      reconciliation: z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('disabled') }).strict(),
        z
          .object({
            kind: z.literal('manual_action'),
            candidate: z
              .object({
                version: PRODUCT_RELEASE_VERSION_SCHEMA,
                integrity: PACKAGE_INTEGRITY_SCHEMA,
              })
              .strict(),
            reason: z.enum(MANUAL_ACTION_REASONS),
          })
          .strict(),
        ...UPDATE_RESULT_SCHEMA.options,
      ]),
    })
    .strict()
    .superRefine((frame, context) => {
      if ((frame.reconciliation.kind === 'disabled') !== (frame.service === undefined)) {
        context.addIssue({
          code: 'custom',
          path: ['service'],
          message: 'Only disabled reconciliation omits the managed service summary',
        });
      }
    }),
  z
    .object({
      ...SERVICE_RESULT_COMMON,
      action: z.literal('configure'),
      configuration: z
        .object({ kind: z.enum(['unchanged', 'configured', 'active_tasks']) })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...SERVICE_RESULT_COMMON,
      action: z.enum(['retire', 'uninstall']),
      retirement: RETIREMENT_RESULT_SCHEMA,
    })
    .strict(),
  z
    .object({
      ...SERVICE_RESULT_COMMON,
      action: z.enum(NON_RETIRE_SERVICE_ACTIONS),
    })
    .strict(),
  z
    .object({
      schemaVersion: z.literal(1),
      kind: z.literal('error'),
      action: z.literal('update'),
      error: SERVICE_ERROR_SCHEMA,
    })
    .strict(),
  z
    .object({
      schemaVersion: z.literal(1),
      kind: z.literal('error'),
      action: z.literal('reconcile_update'),
      error: SERVICE_ERROR_SCHEMA,
    })
    .strict(),
  z
    .object({
      schemaVersion: z.literal(1),
      kind: z.literal('error'),
      action: z.literal('update_policy'),
      error: SERVICE_ERROR_SCHEMA,
    })
    .strict(),
  z
    .object({
      schemaVersion: z.literal(1),
      kind: z.literal('error'),
      action: z.enum(NON_UPDATE_SERVICE_ACTIONS),
      error: SERVICE_ERROR_SCHEMA,
    })
    .strict(),
]);

export type RuntimeHostServiceManagementAction = (typeof SERVICE_ACTIONS)[number];
export type RuntimeHostServiceManagementFrame = z.infer<typeof SERVICE_MANAGEMENT_FRAME_SCHEMA>;
export type RuntimeHostServiceUpdatePhase = (typeof UPDATE_PHASES)[number];
export type RuntimeHostManagedUpdatePolicy = z.infer<typeof UPDATE_POLICY_SCHEMA>;
export type RuntimeHostOperatorCapability = (typeof OPERATOR_CAPABILITIES)[number];
export type RuntimeHostUpdateSchedulerState = (typeof UPDATE_SCHEDULER_STATES)[number];
export type RuntimeHostServiceSummary = z.infer<typeof SERVICE_SUMMARY_SCHEMA>;

export function encodeRuntimeHostServiceManagementFrame(
  frame: RuntimeHostServiceManagementFrame,
): string {
  const encoded = Buffer.from(
    JSON.stringify(SERVICE_MANAGEMENT_FRAME_SCHEMA.parse(frame)),
  ).toString('base64url');
  if (Buffer.byteLength(encoded, 'utf8') > FRAME_MAX_BYTES) {
    throw new RangeError('Runtime Host service management frame exceeds the encoded size limit');
  }
  return `${RUNTIME_HOST_SERVICE_MANAGEMENT_FRAME_PREFIX}${encoded}\n`;
}

export function decodeRuntimeHostServiceManagementFrame(
  line: string,
): RuntimeHostServiceManagementFrame | undefined {
  const marker = line.indexOf(RUNTIME_HOST_SERVICE_MANAGEMENT_FRAME_PREFIX);
  if (marker === -1) return undefined;
  try {
    const encoded = line.slice(marker + RUNTIME_HOST_SERVICE_MANAGEMENT_FRAME_PREFIX.length).trim();
    if (encoded.length === 0 || Buffer.byteLength(encoded, 'utf8') > FRAME_MAX_BYTES) {
      return undefined;
    }
    const value: unknown = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    const decoded = SERVICE_MANAGEMENT_FRAME_SCHEMA.safeParse(value);
    return decoded.success ? decoded.data : undefined;
  } catch {
    return undefined;
  }
}
