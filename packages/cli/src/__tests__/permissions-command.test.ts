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

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDefaultRuntimePolicy, type RuntimePolicySnapshot } from '@maka/core/runtime-policy';
import type { RuntimeHostCliConnectionContext } from '../runtime-host-cli-context.js';
import { parsePermissionsCommand } from '../permissions-command-parser.js';
import { runPermissionsCli, updatePermissionRules } from '../permissions-command.js';

test('parses permission list and mutation commands', () => {
  assert.deepEqual(
    parsePermissionsCommand([
      'deny-command',
      'git push *',
      '--root',
      '/srv/maka',
      '--host',
      'office',
    ]),
    {
      kind: 'permissions',
      action: { kind: 'deny-command', pattern: 'git push *' },
      rootPath: '/srv/maka',
      hostProfileId: 'office',
    },
  );
  assert.deepEqual(parsePermissionsCommand(['deny-path', '/mnt/**', '--scope', 'subtree']), {
    kind: 'permissions',
    action: { kind: 'deny-path', path: '/mnt', scope: 'subtree' },
  });
  assert.deepEqual(parsePermissionsCommand(['list', '--scope', 'exact']), {
    kind: 'error',
    message: 'permissions list does not accept a path or --scope',
    exitCode: 2,
  });
  assert.deepEqual(parsePermissionsCommand(['remove-path', 'relative', '--scope', 'exact']), {
    kind: 'error',
    message: 'permissions remove-path requires an absolute path',
    exitCode: 2,
  });
});

test('updates permission rules canonically and removes normalized paths', () => {
  const current = updatePermissionRules(
    { denyCommands: [], denyPaths: [] },
    { kind: 'deny-path', path: '/mnt/', scope: 'subtree' },
  );
  assert.deepEqual(current, {
    denyCommands: [],
    denyPaths: [{ path: '/mnt', scope: 'subtree' }],
  });
  assert.deepEqual(
    updatePermissionRules(current, { kind: 'remove-path', path: '/mnt/', scope: 'subtree' }),
    { denyCommands: [], denyPaths: [] },
  );
});

test('queries and CAS-mutates the Host-owned permission rules', async () => {
  const requests: { operation: string; input: unknown }[] = [];
  const initial: RuntimePolicySnapshot = {
    revision: 7,
    policy: createDefaultRuntimePolicy(),
  };
  const context = {
    connection: {
      request: async (operation: string, input: unknown) => {
        requests.push({ operation, input });
        if (operation === 'runtime.policy.query') return initial;
        return { kind: 'committed', revision: 8 };
      },
    },
    close: async () => {},
  } as unknown as RuntimeHostCliConnectionContext;
  let output = '';
  const exitCode = await runPermissionsCli(
    {
      kind: 'permissions',
      action: { kind: 'deny-command', pattern: 'git commit *' },
    },
    { defaultRootPath: '/state', clientDataRoot: '/client' },
    {
      connect: async (input) => {
        assert.deepEqual(input, {
          rootPath: '/state',
          clientDataRoot: '/client',
        });
        return context;
      },
      write: (value) => {
        output += value;
      },
    },
  );
  assert.equal(exitCode, 0);
  assert.deepEqual(requests, [
    { operation: 'runtime.policy.query', input: {} },
    {
      operation: 'runtime.policy.mutate',
      input: {
        expectedRevision: 7,
        operation: {
          kind: 'set_permission_rules',
          value: { denyCommands: ['git commit *'], denyPaths: [] },
        },
      },
    },
  ]);
  assert.deepEqual(JSON.parse(output), {
    revision: 8,
    denyCommands: ['git commit *'],
    denyPaths: [],
  });
});
