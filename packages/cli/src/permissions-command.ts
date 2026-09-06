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
  normalizePermissionRules,
  samePermissionPath,
  type PermissionPathRule,
  type PermissionRules,
  type RuntimePolicySnapshot,
} from '@maka/core/runtime-policy';
import {
  connectRuntimeHostCli,
  type RuntimeHostCliConnectionContext,
} from './runtime-host-cli-context.js';

export type PermissionCliAction =
  | { readonly kind: 'list' }
  | { readonly kind: 'deny-command'; readonly pattern: string }
  | {
      readonly kind: 'deny-path';
      readonly path: string;
      readonly scope: 'exact' | 'subtree';
    }
  | { readonly kind: 'remove-command'; readonly pattern: string }
  | {
      readonly kind: 'remove-path';
      readonly path: string;
      readonly scope: 'exact' | 'subtree';
    };

export interface PermissionCliCommand {
  readonly kind: 'permissions';
  readonly action: PermissionCliAction;
  readonly rootPath?: string;
  readonly hostProfileId?: string;
}

export interface PermissionCliDeps {
  readonly connect: (input: {
    readonly rootPath: string;
    readonly profileId?: string;
    readonly clientDataRoot: string;
  }) => Promise<RuntimeHostCliConnectionContext>;
  readonly write: (value: string) => void;
}

export interface PermissionCliOptions {
  readonly defaultRootPath: string;
  readonly clientDataRoot: string;
}

export async function runPermissionsCli(
  command: PermissionCliCommand,
  options: PermissionCliOptions,
  overrides: Partial<PermissionCliDeps> = {},
): Promise<number> {
  const deps = { ...defaultDeps(), ...overrides };
  const context = await deps.connect({
    rootPath: command.rootPath ?? options.defaultRootPath,
    clientDataRoot: options.clientDataRoot,
    ...(command.hostProfileId ? { profileId: command.hostProfileId } : {}),
  });
  try {
    const snapshot = await context.connection.request('runtime.policy.query', {});
    if (command.action.kind === 'list') {
      deps.write(`${JSON.stringify(projectPermissionRules(snapshot), null, 2)}\n`);
      return 0;
    }

    const nextRules = updatePermissionRules(snapshot.policy.permissionRules, command.action);
    const result = await context.connection.request('runtime.policy.mutate', {
      expectedRevision: snapshot.revision,
      operation: { kind: 'set_permission_rules', value: nextRules },
    });
    if (result.kind === 'revision_conflict') {
      throw new Error(
        `Runtime Policy changed while updating permissions (expected revision ${result.expectedRevision}, actual ${result.actualRevision}); re-run the command`,
      );
    }
    deps.write(`${JSON.stringify({ revision: result.revision, ...nextRules }, null, 2)}\n`);
    return 0;
  } finally {
    await context.close();
  }
}

export function updatePermissionRules(
  current: PermissionRules,
  action: Exclude<PermissionCliAction, { readonly kind: 'list' }>,
): PermissionRules {
  const next = {
    denyCommands: [...current.denyCommands],
    denyPaths: current.denyPaths.map((rule) => ({ ...rule })),
  };
  const canonicalAction = canonicalizePermissionAction(action);
  switch (action.kind) {
    case 'deny-command':
      next.denyCommands.push(canonicalAction.pattern);
      break;
    case 'deny-path':
      next.denyPaths.push(canonicalAction.rule);
      break;
    case 'remove-command':
      next.denyCommands = next.denyCommands.filter(
        (pattern) => pattern !== canonicalAction.pattern,
      );
      break;
    case 'remove-path':
      next.denyPaths = next.denyPaths.filter(
        (rule) =>
          !samePermissionPath(rule.path, canonicalAction.rule.path) ||
          rule.scope !== canonicalAction.rule.scope,
      );
      break;
  }
  return normalizePermissionRules(next);
}

export function canonicalizePermissionPathRule(
  path: string,
  scope: 'exact' | 'subtree',
): PermissionPathRule {
  const globSuffix = /[\\/]\*\*$/.test(path);
  if (globSuffix) {
    if (scope !== 'subtree') {
      throw new Error('A path ending in /** must use --scope subtree');
    }
    path = path.slice(0, -2);
  }
  return normalizePermissionRules({
    denyCommands: [],
    denyPaths: [{ path, scope }],
  }).denyPaths[0]!;
}

function canonicalizePermissionAction(
  action: Exclude<PermissionCliAction, { readonly kind: 'list' }>,
): { readonly pattern: string; readonly rule: PermissionPathRule } {
  if (action.kind === 'deny-command' || action.kind === 'remove-command') {
    return {
      pattern: normalizePermissionRules({ denyCommands: [action.pattern], denyPaths: [] })
        .denyCommands[0]!,
      rule: { path: '/', scope: 'exact' },
    };
  }
  return {
    pattern: '',
    rule: canonicalizePermissionPathRule(action.path, action.scope),
  };
}

function projectPermissionRules(snapshot: RuntimePolicySnapshot) {
  return {
    revision: snapshot.revision,
    ...snapshot.policy.permissionRules,
  };
}

function defaultDeps(): PermissionCliDeps {
  return {
    connect: (input) => connectRuntimeHostCli(input),
    write: (value) => process.stdout.write(value),
  };
}
