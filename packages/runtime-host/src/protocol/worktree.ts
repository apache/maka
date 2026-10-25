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

import type {
  WorktreeBranchWorkspace,
  WorktreePreparation,
  WorktreeBlocker,
  WorktreeInfo,
  WorktreeMutation,
  WorktreeMutationResult,
  WorktreeProjectConfig,
  WorktreeProject,
} from '@maka/core/worktree';
import {
  requireCount,
  requireEncodedByteLimit,
  requireEntityId,
  requireRecord,
  requireShapedRecord,
  requireUtf8String,
} from './codec.js';
import { invalidProtocolFrame } from './errors.js';
import { defineHostPathOperation, defineOperation } from './operation-spec.js';
import { decodeHostPath } from './workspace.js';

// Leave room for the response envelope below the 768 KiB transport limit.
export const WORKTREE_PAGE_MAX_BYTES = 512 * 1024;
export const WORKTREE_PAGE_MAX_ITEMS = 128;
export type WorktreeCatalogRevision = `sha256:${string}`;
export type WorktreeQueryInput = { projectId?: string } & (
  | { revision?: never; cursor?: never }
  | { revision: WorktreeCatalogRevision; cursor: string }
);
export type WorktreeCatalogItem =
  | { kind: 'config'; projectId: string; config: WorktreeProjectConfig }
  | { kind: 'project'; project: Omit<WorktreeProject, 'worktrees'> }
  | { kind: 'worktree'; worktree: WorktreeInfo };
export type WorktreeQueryResult =
  | {
      kind: 'page';
      revision: WorktreeCatalogRevision;
      rootDirectory: string;
      items: WorktreeCatalogItem[];
      nextCursor: string | null;
    }
  | { kind: 'revision_changed' };

const ERRORS = [
  'not_found',
  'host_not_ready',
  'host_draining',
  'operation_unavailable',
  'invalid_request',
  'operation_conflict',
  'internal_failure',
] as const;
export const WORKTREE_OPERATION_SPECS = {
  'worktree.preparation.query': defineOperation<
    { operationId: string },
    WorktreePreparation,
    (typeof ERRORS)[number]
  >({
    mode: 'query',
    availability: 'ready',
    errors: ERRORS,
    decodeInput(value) {
      const input = requireShapedRecord(value, 'Worktree preparation query', ['operationId'], []);
      return { operationId: requireEntityId(input.operationId, 'operationId') };
    },
    decodeOutput(value) {
      const record = requireRecord(value, 'Worktree preparation');
      if (record.phase === 'inactive' || record.phase === 'preparing') {
        requireShapedRecord(value, 'Worktree preparation', ['phase'], []);
        return { phase: record.phase };
      }
      const input = requireShapedRecord(value, 'Worktree preparation', ['phase', 'path'], []);
      if (
        input.phase !== 'checkout' &&
        input.phase !== 'initializing' &&
        input.phase !== 'finalizing' &&
        input.phase !== 'blocked'
      )
        throw invalidProtocolFrame('Invalid worktree preparation phase');
      return { phase: input.phase, path: decodeHostPath(input.path, 'Worktree path') };
    },
  }),
  'worktree.session.query': defineOperation<
    { sessionId: string },
    WorktreeBranchWorkspace,
    (typeof ERRORS)[number]
  >({
    mode: 'query',
    availability: 'ready',
    errors: ERRORS,
    decodeInput(value) {
      const input = requireShapedRecord(value, 'Session worktree query', ['sessionId'], []);
      return { sessionId: requireEntityId(input.sessionId, 'sessionId') };
    },
    decodeOutput(value) {
      const output = requireShapedRecord(
        value,
        'Session worktree capability',
        ['path', 'canCreate'],
        [],
      );
      return {
        path: decodeHostPath(output.path, 'Session worktree path'),
        canCreate: boolean(output.canCreate),
      };
    },
  }),
  'worktree.query': defineOperation<
    WorktreeQueryInput,
    WorktreeQueryResult,
    (typeof ERRORS)[number]
  >({
    mode: 'query',
    availability: 'ready',
    errors: ERRORS,
    decodeInput(value) {
      const input = requireShapedRecord(
        value,
        'Worktree query',
        [],
        ['projectId', 'revision', 'cursor'],
      );
      const scope =
        input.projectId === undefined
          ? {}
          : { projectId: requireEntityId(input.projectId, 'projectId') };
      if (input.revision === undefined && input.cursor === undefined) return scope;
      return {
        ...scope,
        revision: decodeRevision(input.revision),
        cursor: decodeCursor(input.cursor),
      };
    },
    decodeOutput: decodeWorktreeQueryResult,
  }),
  'worktree.mutate': defineHostPathOperation<
    WorktreeMutation,
    WorktreeMutationResult,
    (typeof ERRORS)[number]
  >(
    {
      mode: 'command',
      availability: 'ready',
      errors: ERRORS,
      decodeInput: decodeWorktreeMutation,
      decodeOutput: decodeWorktreeMutationResult,
    },
    // Checkout paths are validated against the project; custom roots are arbitrary
    // Host paths. An empty project override only restores the configured Host root.
    (input) => input.kind === 'configure' && Boolean(input.config.rootDirectory),
  ),
} as const;

export function decodeWorktreeProjectConfig(value: unknown): WorktreeProjectConfig {
  const config = requireShapedRecord(
    value,
    'Worktree configuration',
    [],
    ['rootDirectory', 'defaultMode', 'setupScript', 'cleanupScript'],
  );
  if (
    config.defaultMode !== undefined &&
    config.defaultMode !== 'main' &&
    config.defaultMode !== 'new'
  )
    throw invalidProtocolFrame('Invalid worktree default mode');
  return {
    ...(config.rootDirectory !== undefined
      ? {
          rootDirectory:
            config.rootDirectory === ''
              ? ''
              : decodeHostPath(config.rootDirectory, 'Worktree root'),
        }
      : {}),
    ...(config.defaultMode !== undefined ? { defaultMode: config.defaultMode } : {}),
    ...(config.setupScript !== undefined
      ? { setupScript: string(config.setupScript, 'Setup script', 32_000) }
      : {}),
    ...(config.cleanupScript !== undefined
      ? { cleanupScript: string(config.cleanupScript, 'Cleanup script', 32_000) }
      : {}),
  };
}
export function decodeWorktreeMutation(value: unknown): WorktreeMutation {
  const record = requireRecord(value, 'Worktree mutation');
  switch (record.kind) {
    case 'configure': {
      const input = requireShapedRecord(
        value,
        'Configure worktrees',
        ['kind', 'config'],
        ['projectId'],
      );
      return {
        kind: 'configure',
        config: decodeWorktreeProjectConfig(input.config),
        ...(input.projectId !== undefined
          ? { projectId: requireEntityId(input.projectId, 'projectId') }
          : {}),
      };
    }
    case 'create': {
      const input = requireShapedRecord(
        value,
        'Create worktree',
        ['kind', 'projectId', 'operationId', 'description'],
        ['sourcePath'],
      );
      return {
        kind: 'create',
        projectId: requireEntityId(input.projectId, 'projectId'),
        operationId: requireEntityId(input.operationId, 'operationId'),
        description: string(input.description, 'Task description', 32_000),
        ...(input.sourcePath !== undefined
          ? { sourcePath: decodeHostPath(input.sourcePath, 'Source worktree') }
          : {}),
      };
    }
    case 'resolve_preparation': {
      const input = requireShapedRecord(
        value,
        'Resolve worktree preparation',
        ['kind', 'projectId', 'operationId', 'decision'],
        [],
      );
      if (input.decision !== 'main' && input.decision !== 'cancel')
        throw invalidProtocolFrame('Invalid worktree preparation decision');
      return {
        kind: 'resolve_preparation',
        projectId: requireEntityId(input.projectId, 'projectId'),
        operationId: requireEntityId(input.operationId, 'operationId'),
        decision: input.decision,
      };
    }
    case 'initialize': {
      const input = requireShapedRecord(
        value,
        'Initialize worktree',
        ['kind', 'projectId', 'path'],
        ['skip'],
      );
      return {
        kind: 'initialize',
        projectId: requireEntityId(input.projectId, 'projectId'),
        path: decodeHostPath(input.path, 'Worktree path'),
        ...(input.skip === undefined ? {} : { skip: boolean(input.skip) }),
      };
    }
    case 'remove': {
      const input = requireShapedRecord(
        value,
        'Remove worktree',
        ['kind', 'projectId', 'path'],
        ['confirmation'],
      );
      return {
        kind: 'remove',
        projectId: requireEntityId(input.projectId, 'projectId'),
        path: decodeHostPath(input.path, 'Worktree path'),
        ...(input.confirmation === undefined
          ? {}
          : { confirmation: requireEntityId(input.confirmation, 'Cleanup confirmation') }),
      };
    }
    default:
      throw invalidProtocolFrame('Invalid worktree mutation kind');
  }
}
function decodeInfo(value: unknown): WorktreeInfo {
  const item = requireShapedRecord(
    value,
    'Worktree',
    [
      'projectId',
      'path',
      'name',
      'head',
      'isMain',
      'managed',
      'available',
      'locked',
      'sessionCount',
    ],
    ['branch', 'initialization', 'log', 'operationId'],
  );
  if (
    item.initialization !== undefined &&
    !['pending', 'running', 'ready', 'failed', 'skipped'].includes(String(item.initialization))
  )
    throw invalidProtocolFrame('Invalid worktree initialization state');
  return {
    projectId: requireEntityId(item.projectId, 'projectId'),
    path: decodeHostPath(item.path, 'Worktree path'),
    name: string(item.name, 'Worktree name', 512),
    head: string(item.head, 'Worktree HEAD', 128),
    isMain: boolean(item.isMain),
    managed: boolean(item.managed),
    available: boolean(item.available),
    locked: boolean(item.locked),
    sessionCount: requireCount(item.sessionCount, 'Worktree session count'),
    ...(item.operationId !== undefined
      ? { operationId: requireEntityId(item.operationId, 'operationId') }
      : {}),
    ...(item.branch !== undefined ? { branch: string(item.branch, 'Worktree branch', 1024) } : {}),
    ...(item.initialization !== undefined
      ? { initialization: item.initialization as WorktreeInfo['initialization'] }
      : {}),
    ...(item.log !== undefined ? { log: string(item.log, 'Worktree log', 128_000) } : {}),
  };
}
export function decodeWorktreeQueryResult(value: unknown): WorktreeQueryResult {
  const record = requireRecord(value, 'Worktree query result');
  if (record.kind === 'revision_changed') {
    requireShapedRecord(value, 'Changed worktree catalog', ['kind'], []);
    return { kind: 'revision_changed' };
  }
  const page = requireShapedRecord(
    value,
    'Worktree catalog page',
    ['kind', 'revision', 'rootDirectory', 'items', 'nextCursor'],
    [],
  );
  if (
    page.kind !== 'page' ||
    !Array.isArray(page.items) ||
    page.items.length > WORKTREE_PAGE_MAX_ITEMS
  )
    throw invalidProtocolFrame('Invalid worktree catalog page');
  const decoded: WorktreeQueryResult = {
    kind: 'page',
    revision: decodeRevision(page.revision),
    rootDirectory: decodeHostPath(page.rootDirectory, 'Host worktree root'),
    items: page.items.map(decodeCatalogItem),
    nextCursor: page.nextCursor === null ? null : decodeCursor(page.nextCursor),
  };
  requireEncodedByteLimit(decoded, 'Worktree catalog page', WORKTREE_PAGE_MAX_BYTES);
  return decoded;
}
function decodeCatalogItem(value: unknown): WorktreeCatalogItem {
  const item = requireRecord(value, 'Worktree catalog item');
  switch (item.kind) {
    case 'config': {
      requireShapedRecord(
        value,
        'Project worktree configuration',
        ['kind', 'projectId', 'config'],
        [],
      );
      return {
        kind: 'config',
        projectId: requireEntityId(item.projectId, 'projectId'),
        config: decodeWorktreeProjectConfig(item.config),
      };
    }
    case 'project': {
      requireShapedRecord(value, 'Worktree project item', ['kind', 'project'], []);
      const project = requireShapedRecord(
        item.project,
        'Worktree project',
        ['id', 'name', 'mainPath', 'config'],
        [],
      );
      return {
        kind: 'project',
        project: {
          id: requireEntityId(project.id, 'projectId'),
          name: string(project.name, 'Project name', 1024),
          mainPath: decodeHostPath(project.mainPath, 'Main worktree'),
          config: decodeWorktreeProjectConfig(project.config),
        },
      };
    }
    case 'worktree':
      requireShapedRecord(value, 'Worktree catalog entry', ['kind', 'worktree'], []);
      return { kind: 'worktree', worktree: decodeInfo(item.worktree) };
    default:
      throw invalidProtocolFrame('Invalid worktree catalog item');
  }
}
function decodeRevision(value: unknown): WorktreeCatalogRevision {
  if (typeof value !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(value))
    throw invalidProtocolFrame('Invalid worktree catalog revision');
  return value as WorktreeCatalogRevision;
}
function decodeCursor(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^[1-9][0-9]{0,15}$/.test(value) ||
    !Number.isSafeInteger(Number(value))
  )
    throw invalidProtocolFrame('Invalid worktree catalog cursor');
  return value;
}
function decodeWorktreeMutationResult(value: unknown): WorktreeMutationResult {
  const input = requireRecord(value, 'Worktree result');
  if (input.kind === 'preparation_resolved') {
    requireShapedRecord(value, 'Resolved preparation result', ['kind'], []);
    return { kind: 'preparation_resolved' };
  }
  if (input.kind === 'configured') {
    requireShapedRecord(value, 'Configured worktree result', ['kind'], []);
    return { kind: 'configured' };
  }
  if (input.kind === 'worktree') {
    requireShapedRecord(value, 'Created worktree result', ['kind', 'worktree'], []);
    return { kind: 'worktree', worktree: decodeInfo(input.worktree) };
  }
  if (input.kind === 'removed') {
    requireShapedRecord(value, 'Removed worktree result', ['kind', 'path'], []);
    return { kind: 'removed', path: decodeHostPath(input.path, 'Removed worktree') };
  }
  if (input.kind === 'cleanup_failed') {
    requireShapedRecord(
      value,
      'Failed cleanup result',
      ['kind', 'path', 'log', 'confirmation'],
      [],
    );
    return {
      kind: 'cleanup_failed',
      path: decodeHostPath(input.path, 'Worktree path'),
      log: string(input.log, 'Cleanup log', 128_000),
      confirmation: requireEntityId(input.confirmation, 'Cleanup confirmation'),
    };
  }
  throw invalidProtocolFrame('Invalid worktree result kind');
}
function boolean(value: unknown): boolean {
  if (typeof value !== 'boolean') throw invalidProtocolFrame('Invalid worktree flag');
  return value;
}
function string(value: unknown, label: string, maxBytes: number): string {
  if (value === '') return '';
  return requireUtf8String(value, label, maxBytes);
}

export function decodeWorktreeBlocker(value: unknown): WorktreeBlocker {
  const input = requireShapedRecord(value, 'Worktree blocker', ['kind', 'path'], []);
  if (input.kind !== 'worktree_initialization')
    throw invalidProtocolFrame('Invalid worktree blocker');
  return { kind: input.kind, path: decodeHostPath(input.path, 'Worktree path') };
}
