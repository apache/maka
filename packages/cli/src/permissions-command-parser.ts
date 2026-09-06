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

import { isAbsolute } from 'node:path';
import {
  canonicalizePermissionPathRule,
  type PermissionCliAction,
  type PermissionCliCommand,
} from './permissions-command.js';

export type { PermissionCliCommand } from './permissions-command.js';

export type PermissionCliParseResult =
  | PermissionCliCommand
  | { readonly kind: 'error'; readonly message: string; readonly exitCode: 2 };

export function parsePermissionsCommand(argv: string[]): PermissionCliParseResult {
  const actionName = argv[0];
  if (
    actionName !== 'list' &&
    actionName !== 'deny-command' &&
    actionName !== 'deny-path' &&
    actionName !== 'remove-command' &&
    actionName !== 'remove-path'
  ) {
    return error(
      actionName
        ? `Unexpected permissions command: ${actionName}`
        : 'permissions requires list, deny-command, deny-path, remove-command, or remove-path',
    );
  }

  let rootPath: string | undefined;
  let hostProfileId: string | undefined;
  let positional: string | undefined;
  let scope: 'exact' | 'subtree' | undefined;
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--root' || argument === '--host' || argument === '--scope') {
      const value = argv[index + 1];
      if (!value || value.startsWith('-')) return error(`${argument} requires a value`);
      index += 1;
      if (argument === '--root') {
        if (rootPath !== undefined) return error('Duplicate --root');
        if (!isAbsolute(value) || /[\u0000-\u001f\u007f]/u.test(value)) {
          return error('--root must be an absolute path');
        }
        rootPath = value;
      } else if (argument === '--host') {
        if (hostProfileId !== undefined) return error('Duplicate --host');
        hostProfileId = value;
      } else {
        if (scope !== undefined) return error('Duplicate --scope');
        if (value !== 'exact' && value !== 'subtree') {
          return error('--scope must be exact or subtree');
        }
        scope = value;
      }
      continue;
    }
    if (argument?.startsWith('-')) return error(`Unexpected permissions option: ${argument}`);
    if (positional !== undefined) return error(`Unexpected argument: ${argument ?? ''}`);
    positional = argument;
  }

  const pathAction = actionName === 'deny-path' || actionName === 'remove-path';
  if (actionName === 'list') {
    if (positional !== undefined || scope !== undefined) {
      return error('permissions list does not accept a path or --scope');
    }
    return {
      kind: 'permissions',
      action: { kind: 'list' },
      ...locationOptions(rootPath, hostProfileId),
    };
  }
  if (positional === undefined || positional.length === 0) {
    return error(`permissions ${actionName} requires a value`);
  }
  if (pathAction) {
    if (
      (!isAbsolute(positional) && !/^[A-Za-z]:\\/u.test(positional)) ||
      /[\u0000-\u001f\u007f]/u.test(positional)
    ) {
      return error(`permissions ${actionName} requires an absolute path`);
    }
    if (!scope) return error(`permissions ${actionName} requires --scope <exact|subtree>`);
  } else if (scope !== undefined) {
    return error(`permissions ${actionName} does not accept --scope`);
  }

  let action: PermissionCliAction;
  if (pathAction) {
    try {
      const rule = canonicalizePermissionPathRule(positional, scope!);
      action = { kind: actionName, path: rule.path, scope: rule.scope };
    } catch (cause) {
      return error(cause instanceof Error ? cause.message : String(cause));
    }
  } else {
    action = { kind: actionName, pattern: positional };
  }
  return { kind: 'permissions', action, ...locationOptions(rootPath, hostProfileId) };
}

function locationOptions(rootPath: string | undefined, hostProfileId: string | undefined) {
  return {
    ...(rootPath === undefined ? {} : { rootPath }),
    ...(hostProfileId === undefined ? {} : { hostProfileId }),
  };
}

function error(message: string): PermissionCliParseResult {
  return { kind: 'error', message, exitCode: 2 };
}
