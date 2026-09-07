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

import {
  validateCompositionEntry,
  validatePluginRootId,
  type MakaCompositionApplyInput,
  type MakaCompositionEntry,
  type MakaCompositionEntryInspection,
  type MakaCompositionOperation,
  type MakaPluginRootId,
} from '@maka/runtime/plugin-runtime';
import {
  requireCount,
  requireEncodedByteLimit,
  requireExactRecord,
  requireId,
  requireRecord,
  requireShapedRecord,
  requireString,
} from './codec.js';
import { invalidProtocolFrame } from './errors.js';
import { defineHostPathOperation, defineOperation } from './operation-spec.js';

const QUERY_ERRORS = [
  'host_not_ready',
  'host_draining',
  'operation_unavailable',
  'invalid_request',
  'persistence_failed',
  'internal_failure',
  'stale_cursor',
] as const;
const MUTATE_ERRORS = [
  ...QUERY_ERRORS,
  'not_found',
  'operation_conflict',
  'commit_outcome_unknown',
] as const;
const MAX_FRAME_BYTES = 512 * 1024;
export const PLUGIN_PLATFORM_QUERY_RESULT_MAX_BYTES = 480 * 1024;

export type PluginPlatformPhase =
  | 'new'
  | 'recovering'
  | 'ready'
  | 'degraded'
  | 'fenced'
  | 'draining'
  | 'closed';

export type PluginPlatformConvergence = 'unknown' | 'converged' | 'diverged';

export interface PluginMutationReceipt {
  readonly authorityEpoch: number;
  readonly durability: 'committed';
  readonly convergence: Exclude<PluginPlatformConvergence, 'unknown'>;
  readonly cleanup: 'complete' | 'pending';
  readonly failures: readonly PluginPlatformFailureProjection[];
}

export interface PluginPackageProjection {
  readonly extensionId: string;
  readonly contentDigest: string;
  readonly displayName: string;
  readonly description?: string;
  readonly dependencies: readonly string[];
  readonly structuralDependencies: readonly string[];
  readonly requiredBy: readonly string[];
}

export interface PluginPlatformQueryInput {
  readonly view: 'status' | 'packages' | 'entries' | 'failures';
  readonly rootId?: MakaPluginRootId;
  readonly cursor?: string;
  readonly limit?: number;
}

export type PluginPlatformQueryResult =
  | {
      readonly view: 'status';
      readonly phase: PluginPlatformPhase;
      readonly authorityEpoch: number;
      readonly convergence: PluginPlatformConvergence;
      readonly installedPackageCount: number;
      readonly layeredPackageCount: number;
      readonly desiredEntryCount: number;
      readonly liveEntryCount: number;
      readonly failureCount: number;
      readonly fenceDiagnostic: string | null;
    }
  | {
      readonly view: 'packages';
      readonly items: readonly PluginPackageProjection[];
      readonly nextCursor: string | null;
    }
  | {
      readonly view: 'entries';
      readonly items: readonly MakaCompositionEntryInspection[];
      readonly nextCursor: string | null;
    }
  | {
      readonly view: 'failures';
      readonly items: readonly PluginPlatformFailureProjection[];
      readonly nextCursor: string | null;
    };

export interface PluginPlatformFailureProjection {
  readonly entryId?: string;
  readonly extensionId?: string;
  readonly diagnostic: string;
}

export interface PluginPackageInstallInput {
  readonly sourcePath: string;
}

export interface PluginPackageInstallResult extends PluginMutationReceipt {
  readonly extensionId: string;
}

export interface PluginPackageUninstallInput {
  readonly extensionId: string;
}

export interface PluginPackageExportInput extends PluginPackageUninstallInput {
  readonly targetPath: string;
}

export interface PluginPackageExportResult {
  readonly targetPath: string;
}

export type PluginPackageMutationResult = PluginMutationReceipt;
export type PluginCompositionApplyResult = PluginMutationReceipt;

export const PLUGIN_PLATFORM_OPERATION_SPECS = {
  'plugin.platform.query': defineOperation<
    PluginPlatformQueryInput,
    PluginPlatformQueryResult,
    (typeof QUERY_ERRORS)[number]
  >({
    mode: 'query',
    availability: 'ready',
    errors: QUERY_ERRORS,
    decodeInput: decodePluginPlatformQueryInput,
    decodeOutput: decodePluginPlatformQueryResult,
  }),
  'plugin.package.install': defineHostPathOperation<
    PluginPackageInstallInput,
    PluginPackageInstallResult,
    (typeof MUTATE_ERRORS)[number]
  >({
    mode: 'command',
    availability: 'ready',
    errors: MUTATE_ERRORS,
    decodeInput: (value) => {
      const input = requireExactRecord(value, 'Plugin package install input', ['sourcePath']);
      return { sourcePath: requireString(input.sourcePath, 'Plugin package source path', 4096) };
    },
    decodeOutput: decodePluginPackageInstallResult,
  }),
  'plugin.package.uninstall': defineOperation<
    PluginPackageUninstallInput,
    PluginPackageMutationResult,
    (typeof MUTATE_ERRORS)[number]
  >({
    mode: 'command',
    availability: 'ready',
    errors: MUTATE_ERRORS,
    decodeInput: decodePluginPackageUninstallInput,
    decodeOutput: decodePluginMutationReceipt,
  }),
  'plugin.package.reload': defineOperation<
    PluginPackageUninstallInput,
    PluginPackageMutationResult,
    (typeof MUTATE_ERRORS)[number]
  >({
    mode: 'command',
    availability: 'ready',
    errors: MUTATE_ERRORS,
    decodeInput: decodePluginPackageUninstallInput,
    decodeOutput: decodePluginMutationReceipt,
  }),
  'plugin.package.export': defineHostPathOperation<
    PluginPackageExportInput,
    PluginPackageExportResult,
    (typeof MUTATE_ERRORS)[number]
  >({
    mode: 'command',
    availability: 'ready',
    errors: MUTATE_ERRORS,
    decodeInput: (value) => {
      const input = requireExactRecord(value, 'Plugin package export input', [
        'extensionId',
        'targetPath',
      ]);
      return {
        extensionId: requireId(input.extensionId, 'Plugin package identity'),
        targetPath: requireString(input.targetPath, 'Plugin package export path', 4096),
      };
    },
    decodeOutput: (value) => {
      const output = requireExactRecord(value, 'Plugin package export result', ['targetPath']);
      return { targetPath: requireString(output.targetPath, 'Plugin package export path', 4096) };
    },
  }),
  'plugin.composition.apply': defineOperation<
    MakaCompositionApplyInput,
    PluginCompositionApplyResult,
    (typeof MUTATE_ERRORS)[number]
  >({
    mode: 'command',
    availability: 'ready',
    errors: MUTATE_ERRORS,
    decodeInput: decodePluginCompositionApplyInput,
    decodeOutput: decodePluginMutationReceipt,
  }),
  'plugin.platform.reconcile': defineOperation<
    Record<string, never>,
    PluginMutationReceipt,
    (typeof MUTATE_ERRORS)[number]
  >({
    mode: 'command',
    availability: 'ready',
    errors: MUTATE_ERRORS,
    decodeInput: (value) => {
      requireExactRecord(value, 'Plugin Platform reconcile input', []);
      return {};
    },
    decodeOutput: decodePluginMutationReceipt,
  }),
} as const;

function decodePluginPlatformQueryInput(value: unknown): PluginPlatformQueryInput {
  const input = requireShapedRecord(
    value,
    'Plugin Platform query input',
    ['view'],
    ['rootId', 'cursor', 'limit'],
  );
  if (!['status', 'packages', 'entries', 'failures'].includes(input.view as string)) {
    throw invalidProtocolFrame('Invalid Plugin Platform query view');
  }
  const view = input.view as PluginPlatformQueryInput['view'];
  const cursor =
    input.cursor === undefined
      ? undefined
      : requireString(input.cursor, 'Plugin Platform query cursor', 4096);
  const limit =
    input.limit === undefined
      ? undefined
      : requireCount(input.limit, 'Plugin Platform query limit');
  if (limit !== undefined && (limit < 1 || limit > 64)) {
    throw invalidProtocolFrame('Invalid Plugin Platform query limit');
  }
  if (
    view === 'status' &&
    (input.rootId !== undefined || cursor !== undefined || limit !== undefined)
  ) {
    throw invalidProtocolFrame('Plugin Platform status query does not accept paging');
  }
  if (input.rootId !== undefined && view !== 'entries') {
    throw invalidProtocolFrame('Plugin root identity is only valid for Entry queries');
  }
  let rootId: MakaPluginRootId | undefined;
  if (input.rootId !== undefined) {
    const decoded = requireString(input.rootId, 'Plugin root identity', 256);
    try {
      validatePluginRootId(decoded);
      rootId = decoded;
    } catch {
      throw invalidProtocolFrame('Invalid Plugin root identity');
    }
  }
  return {
    view,
    ...(rootId ? { rootId } : {}),
    ...(cursor === undefined ? {} : { cursor }),
    ...(limit === undefined ? {} : { limit }),
  };
}

function decodePluginPlatformQueryResult(value: unknown): PluginPlatformQueryResult {
  const record = requireRecord(value, 'Plugin Platform query result');
  const view = record.view;
  let decoded: PluginPlatformQueryResult;
  if (view === 'status') {
    const output = requireExactRecord(record, 'Plugin Platform status result', [
      'view',
      'phase',
      'authorityEpoch',
      'convergence',
      'installedPackageCount',
      'layeredPackageCount',
      'desiredEntryCount',
      'liveEntryCount',
      'failureCount',
      'fenceDiagnostic',
    ]);
    if (
      !['new', 'recovering', 'ready', 'degraded', 'fenced', 'draining', 'closed'].includes(
        output.phase as string,
      ) ||
      !['unknown', 'converged', 'diverged'].includes(output.convergence as string)
    ) {
      throw invalidProtocolFrame('Invalid Plugin Platform status');
    }
    decoded = {
      view,
      phase: output.phase as PluginPlatformPhase,
      authorityEpoch: requireCount(output.authorityEpoch, 'Plugin authority epoch'),
      convergence: output.convergence as PluginPlatformConvergence,
      installedPackageCount: requireCount(
        output.installedPackageCount,
        'Installed Plugin package count',
      ),
      layeredPackageCount: requireCount(output.layeredPackageCount, 'Layered Plugin package count'),
      desiredEntryCount: requireCount(output.desiredEntryCount, 'Desired Plugin Entry count'),
      liveEntryCount: requireCount(output.liveEntryCount, 'Live Plugin Entry count'),
      failureCount: requireCount(output.failureCount, 'Plugin failure count'),
      fenceDiagnostic:
        output.fenceDiagnostic === null
          ? null
          : requireString(output.fenceDiagnostic, 'Plugin fence diagnostic', 4096),
    };
  } else {
    const output = requireExactRecord(record, 'Plugin Platform page result', [
      'view',
      'items',
      'nextCursor',
    ]);
    if (
      !Array.isArray(output.items) ||
      output.items.length > 64 ||
      !['packages', 'entries', 'failures'].includes(view as string)
    ) {
      throw invalidProtocolFrame('Invalid Plugin Platform page');
    }
    const nextCursor =
      output.nextCursor === null
        ? null
        : requireString(output.nextCursor, 'Plugin Platform next cursor', 4096);
    decoded =
      view === 'packages'
        ? { view, items: output.items.map(decodePackageProjection), nextCursor }
        : view === 'entries'
          ? { view, items: decodeInspections(output.items), nextCursor }
          : { view: 'failures', items: output.items.map(decodePlatformFailure), nextCursor };
  }
  requireEncodedByteLimit(
    decoded,
    'Plugin Platform query result',
    PLUGIN_PLATFORM_QUERY_RESULT_MAX_BYTES,
  );
  return decoded;
}

function decodePlatformFailure(value: unknown): PluginPlatformFailureProjection {
  const failure = requireShapedRecord(
    value,
    'Plugin Platform failure',
    ['diagnostic'],
    ['entryId', 'extensionId'],
  );
  if (failure.entryId === undefined && failure.extensionId === undefined) {
    throw invalidProtocolFrame('Plugin Platform failure has no identity');
  }
  return {
    ...(failure.entryId === undefined
      ? {}
      : { entryId: requireId(failure.entryId, 'Plugin Entry identity') }),
    ...(failure.extensionId === undefined
      ? {}
      : { extensionId: requireId(failure.extensionId, 'Plugin package identity') }),
    diagnostic: requireString(failure.diagnostic, 'Plugin Platform diagnostic', 4096),
  };
}

function decodePackageProjection(value: unknown): PluginPackageProjection {
  const item = requireShapedRecord(
    value,
    'Plugin package projection',
    [
      'extensionId',
      'contentDigest',
      'displayName',
      'dependencies',
      'structuralDependencies',
      'requiredBy',
    ],
    ['description'],
  );
  if (
    !Array.isArray(item.dependencies) ||
    !Array.isArray(item.structuralDependencies) ||
    !Array.isArray(item.requiredBy)
  ) {
    throw invalidProtocolFrame('Invalid Plugin dependencies');
  }
  return {
    extensionId: requireId(item.extensionId, 'Plugin package identity'),
    contentDigest: requireDigest(item.contentDigest, 'Plugin package content digest'),
    displayName: requireString(item.displayName, 'Plugin display name', 512),
    ...(item.description === undefined
      ? {}
      : { description: requireString(item.description, 'Plugin description', 4096) }),
    dependencies: item.dependencies.map((dependency) =>
      requireId(dependency, 'Plugin dependency identity'),
    ),
    structuralDependencies: item.structuralDependencies.map((dependency) =>
      requireId(dependency, 'Plugin structural dependency identity'),
    ),
    requiredBy: item.requiredBy.map((dependency) =>
      requireId(dependency, 'Plugin dependent identity'),
    ),
  };
}

function decodePluginPackageInstallResult(value: unknown): PluginPackageInstallResult {
  const output = requireExactRecord(value, 'Plugin package install result', [
    'extensionId',
    'authorityEpoch',
    'durability',
    'convergence',
    'cleanup',
    'failures',
  ]);
  const receipt = decodePluginMutationReceipt({
    authorityEpoch: output.authorityEpoch,
    durability: output.durability,
    convergence: output.convergence,
    cleanup: output.cleanup,
    failures: output.failures,
  });
  return {
    extensionId: requireId(output.extensionId, 'Plugin package identity'),
    ...receipt,
  };
}

function decodePluginMutationReceipt(value: unknown): PluginMutationReceipt {
  const output = requireExactRecord(value, 'Plugin mutation receipt', [
    'authorityEpoch',
    'durability',
    'convergence',
    'cleanup',
    'failures',
  ]);
  if (
    output.durability !== 'committed' ||
    !['converged', 'diverged'].includes(output.convergence as string) ||
    !['complete', 'pending'].includes(output.cleanup as string) ||
    !Array.isArray(output.failures)
  ) {
    throw invalidProtocolFrame('Invalid Plugin mutation receipt');
  }
  return {
    authorityEpoch: requireCount(output.authorityEpoch, 'Plugin authority epoch'),
    durability: 'committed',
    convergence: output.convergence as PluginMutationReceipt['convergence'],
    cleanup: output.cleanup as PluginMutationReceipt['cleanup'],
    failures: output.failures.map(decodePlatformFailure),
  };
}

function decodePluginPackageUninstallInput(value: unknown): PluginPackageUninstallInput {
  const input = requireExactRecord(value, 'Plugin package uninstall input', ['extensionId']);
  return { extensionId: requireId(input.extensionId, 'Plugin package identity') };
}

export function decodePluginCompositionApplyInput(
  value: unknown,
  maxBytes = MAX_FRAME_BYTES,
): MakaCompositionApplyInput {
  const input = requireShapedRecord(
    value,
    'Plugin composition apply input',
    ['operations'],
    ['baseGeneration'],
  );
  if (!Array.isArray(input.operations) || input.operations.length === 0) {
    throw invalidProtocolFrame('Invalid Plugin composition operations');
  }
  const decoded = {
    ...(input.baseGeneration === undefined
      ? {}
      : { baseGeneration: requireCount(input.baseGeneration, 'Plugin composition generation') }),
    operations: input.operations.map(decodeCompositionOperation),
  };
  requireEncodedByteLimit(decoded, 'Plugin composition apply input', maxBytes);
  return decoded;
}

function decodeCompositionOperation(value: unknown): MakaCompositionOperation {
  const operation = requireRecord(value, 'Plugin composition operation');
  switch (operation.type) {
    case 'insert': {
      const input = requireShapedRecord(
        operation,
        'Plugin insert operation',
        ['type', 'entry'],
        ['rootId', 'parentId', 'position'],
      );
      return {
        type: 'insert',
        ...(input.rootId === undefined ? {} : { rootId: decodeRootId(input.rootId) }),
        ...(input.parentId === undefined
          ? {}
          : { parentId: requireId(input.parentId, 'Plugin parent Entry identity') }),
        entry: decodeCompositionEntry(input.entry),
        ...(input.position === undefined
          ? {}
          : { position: requireCount(input.position, 'Plugin Entry position') }),
      };
    }
    case 'update': {
      const input = requireExactRecord(operation, 'Plugin update operation', [
        'type',
        'entryId',
        'patch',
      ]);
      return {
        type: 'update',
        entryId: requireId(input.entryId, 'Plugin Entry identity'),
        patch: decodeEntryPatch(input.patch),
      };
    }
    case 'move': {
      const input = requireShapedRecord(
        operation,
        'Plugin move operation',
        ['type', 'entryId'],
        ['parentId', 'position'],
      );
      return {
        type: 'move',
        entryId: requireId(input.entryId, 'Plugin Entry identity'),
        ...(input.parentId === undefined
          ? {}
          : { parentId: requireId(input.parentId, 'Plugin parent Entry identity') }),
        ...(input.position === undefined
          ? {}
          : { position: requireCount(input.position, 'Plugin Entry position') }),
      };
    }
    case 'remove': {
      const input = requireExactRecord(operation, 'Plugin remove operation', ['type', 'entryId']);
      return { type: 'remove', entryId: requireId(input.entryId, 'Plugin Entry identity') };
    }
    default:
      throw invalidProtocolFrame('Invalid Plugin composition operation type');
  }
}

function decodeCompositionEntry(value: unknown): MakaCompositionEntry {
  const entry = requireShapedRecord(
    value,
    'Plugin composition Entry',
    ['id'],
    ['packageId', 'config', 'disabled', 'inject', 'isolate', 'intercept', 'children'],
  );
  const decoded: MakaCompositionEntry = {
    id: requireId(entry.id, 'Plugin Entry identity'),
    ...(entry.packageId === undefined
      ? {}
      : { packageId: requireId(entry.packageId, 'Plugin package identity') }),
    ...(entry.config === undefined ? {} : { config: decodeScalarRecord(entry.config, 'config') }),
    ...(entry.disabled === undefined ? {} : { disabled: requireBoolean(entry.disabled) }),
    ...(entry.inject === undefined ? {} : { inject: decodeInject(entry.inject) }),
    ...(entry.isolate === undefined ? {} : { isolate: decodeIsolate(entry.isolate) }),
    ...(entry.intercept === undefined
      ? {}
      : { intercept: decodeJsonRecord(entry.intercept, 'intercept') }),
    ...(entry.children === undefined ? {} : { children: decodeEntries(entry.children) }),
  };
  try {
    validateCompositionEntry(decoded);
  } catch {
    throw invalidProtocolFrame('Invalid Plugin composition Entry');
  }
  return decoded;
}

function decodeEntryPatch(value: unknown): Partial<Omit<MakaCompositionEntry, 'id' | 'children'>> {
  const patch = requireShapedRecord(
    value,
    'Plugin Entry patch',
    [],
    ['packageId', 'config', 'disabled', 'inject', 'isolate', 'intercept'],
  );
  return {
    ...(patch.packageId === undefined
      ? {}
      : { packageId: requireId(patch.packageId, 'Plugin package identity') }),
    ...(patch.config === undefined ? {} : { config: decodeScalarRecord(patch.config, 'config') }),
    ...(patch.disabled === undefined ? {} : { disabled: requireBoolean(patch.disabled) }),
    ...(patch.inject === undefined ? {} : { inject: decodeInject(patch.inject) }),
    ...(patch.isolate === undefined ? {} : { isolate: decodeIsolate(patch.isolate) }),
    ...(patch.intercept === undefined
      ? {}
      : { intercept: decodeJsonRecord(patch.intercept, 'intercept') }),
  };
}

function decodeInspections(value: unknown): readonly MakaCompositionEntryInspection[] {
  if (!Array.isArray(value)) throw invalidProtocolFrame('Invalid Plugin Entry inspections');
  return value.map((item) => {
    const inspection = requireShapedRecord(
      item,
      'Plugin Entry inspection',
      ['id', 'rootId', 'disabled', 'status', 'waitingFor', 'effects', 'children'],
      ['parentId', 'packageId', 'config', 'generation', 'diagnostic'],
    );
    const statuses = [
      'disabled',
      'pending',
      'loading',
      'active',
      'failed',
      'unloading',
      'disposed',
    ];
    if (!statuses.includes(inspection.status as string)) {
      throw invalidProtocolFrame('Invalid Plugin Entry status');
    }
    if (!Array.isArray(inspection.waitingFor) || !Array.isArray(inspection.effects)) {
      throw invalidProtocolFrame('Invalid Plugin Entry inspection details');
    }
    return {
      id: requireId(inspection.id, 'Plugin Entry identity'),
      rootId: decodeRootId(inspection.rootId),
      ...(inspection.parentId === undefined
        ? {}
        : { parentId: requireId(inspection.parentId, 'Plugin parent Entry identity') }),
      ...(inspection.packageId === undefined
        ? {}
        : { packageId: requireId(inspection.packageId, 'Plugin package identity') }),
      ...(inspection.config === undefined
        ? {}
        : { config: decodeScalarRecord(inspection.config, 'config') }),
      disabled: requireBoolean(inspection.disabled),
      status: inspection.status as MakaCompositionEntryInspection['status'],
      ...(inspection.generation === undefined
        ? {}
        : { generation: requireCount(inspection.generation, 'Plugin Fiber generation') }),
      waitingFor: inspection.waitingFor.map((item) => requireId(item, 'Plugin dependency')),
      effects: inspection.effects.map((item) => requireString(item, 'Plugin Effect label', 512)),
      children: decodeInspections(inspection.children),
      ...(inspection.diagnostic === undefined
        ? {}
        : { diagnostic: requireString(inspection.diagnostic, 'Plugin diagnostic', 4096) }),
    };
  });
}

function decodeEntries(value: unknown): readonly MakaCompositionEntry[] {
  if (!Array.isArray(value)) throw invalidProtocolFrame('Invalid Plugin Entry list');
  return value.map(decodeCompositionEntry);
}

function decodeRootId(value: unknown): MakaPluginRootId {
  const rootId = requireString(value, 'Plugin root identity', 256);
  try {
    validatePluginRootId(rootId);
    return rootId;
  } catch {
    throw invalidProtocolFrame('Invalid Plugin root identity');
  }
}

function decodeInject(value: unknown): readonly string[] | Readonly<Record<string, unknown>> {
  if (Array.isArray(value)) return value.map((item) => requireId(item, 'Plugin injection'));
  return decodeJsonRecord(value, 'inject');
}

function decodeIsolate(value: unknown): Readonly<Record<string, true | string>> {
  const record = requireRecord(value, 'Plugin Entry isolate');
  const output: Array<readonly [string, true | string]> = [];
  for (const [key, item] of Object.entries(record)) {
    requireId(key, 'Plugin Entry isolate key');
    if (item !== true && (typeof item !== 'string' || !item)) {
      throw invalidProtocolFrame('Invalid Plugin Entry isolate value');
    }
    output.push([key, item]);
  }
  return Object.fromEntries(output);
}

function decodeJsonRecord(value: unknown, label: string): Readonly<Record<string, unknown>> {
  const record = requireRecord(value, `Plugin Entry ${label}`);
  requireEncodedByteLimit(record, `Plugin Entry ${label}`, 64 * 1024);
  try {
    return structuredClone(record);
  } catch {
    throw invalidProtocolFrame(`Invalid Plugin Entry ${label}`);
  }
}

function decodeScalarRecord(
  value: unknown,
  label: string,
): Readonly<Record<string, string | number | boolean>> {
  const record = requireRecord(value, `Plugin Entry ${label}`);
  const output: Array<readonly [string, string | number | boolean]> = [];
  for (const [key, item] of Object.entries(record)) {
    requireId(key, `Plugin Entry ${label} key`);
    if (
      typeof item === 'string' ||
      typeof item === 'boolean' ||
      (typeof item === 'number' && Number.isFinite(item))
    )
      output.push([key, item]);
    else throw invalidProtocolFrame(`Invalid Plugin Entry ${label} value`);
  }
  return Object.fromEntries(output);
}

function requireBoolean(value: unknown): boolean {
  if (typeof value !== 'boolean') throw invalidProtocolFrame('Invalid Plugin Entry disabled flag');
  return value;
}

function requireDigest(value: unknown, label: string): string {
  const digest = requireString(value, label, 80);
  if (!/^sha256-[a-f0-9]{64}$/u.test(digest)) throw invalidProtocolFrame(`Invalid ${label}`);
  return digest;
}
