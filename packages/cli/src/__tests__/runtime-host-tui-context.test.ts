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
import { describe, test } from 'node:test';
import type { RuntimeHostConnection, RuntimeHostProfile } from '@maka/runtime-host/client';
import {
  createRuntimeHostExternalSessionSurface,
  resolveRuntimeHostTuiWorkspace,
} from '../runtime-host-tui-context.js';

const REMOTE_PROFILE: RuntimeHostProfile = {
  id: 'office',
  name: 'Office',
  kind: 'remote',
  transport: { kind: 'tls', url: 'wss://runtime.example.com/runtime-host' },
  rootId: 'a'.repeat(64),
};
const ENVIRONMENT_PROFILE: RuntimeHostProfile = {
  id: 'ubuntu',
  name: 'Ubuntu',
  kind: 'environment',
  provider: { kind: 'wsl', distribution: 'Ubuntu' },
  rootId: 'b'.repeat(64),
  operator: {
    kind: 'node',
    platform: 'posix',
    nodePath: '/usr/bin/node',
    modulePath: '/opt/maka/operator.mjs',
  },
};
const HOST_WORKSPACE_PROFILES = [REMOTE_PROFILE, ENVIRONMENT_PROFILE] as const;

describe('Runtime Host TUI workspace selection', () => {
  test('requires an existing Host Project for a new Host-workspace Session', async () => {
    for (const profile of HOST_WORKSPACE_PROFILES) {
      await assert.rejects(
        () => resolveRuntimeHostTuiWorkspace({} as RuntimeHostConnection, profile, {}),
        /requires --project/,
      );
    }
  });

  test('canonicalizes a Host Project alias without reading a Client path', async () => {
    const connection = {
      request: async (operation: string) => {
        assert.equal(operation, 'project.catalog.query');
        return {
          kind: 'page',
          view: 'summary',
          revision: `sha256:${'1'.repeat(64)}`,
          projectCount: 1,
          items: [
            {
              kind: 'project',
              projectIndex: 0,
              id: 'project-1',
              name: 'Project',
              aliasCount: 1,
              locationCount: 1,
              preferredLocationIndex: 0,
              archivedAt: null,
              available: true,
            },
            {
              kind: 'alias',
              projectIndex: 0,
              itemIndex: 0,
              alias: 'project-old',
            },
          ],
          nextCursor: null,
        };
      },
    } as unknown as RuntimeHostConnection;

    for (const profile of HOST_WORKSPACE_PROFILES) {
      assert.deepEqual(
        await resolveRuntimeHostTuiWorkspace(connection, profile, {
          projectId: 'project-old',
        }),
        { kind: 'project', projectId: 'project-1' },
      );
    }
  });
});

describe('Runtime Host external Session surface', () => {
  test('owns both available scopes and current-workspace request projection', async () => {
    const requests: Array<{ operation: string; input: unknown }> = [];
    const connection = {
      request: async (operation: string, input: unknown) => {
        requests.push({ operation, input });
        return { sessions: [], nextCursor: null };
      },
    } as unknown as RuntimeHostConnection;
    let workspace = undefined as { kind: 'host_path'; path: string } | undefined;
    const surface = createRuntimeHostExternalSessionSurface(connection, () => workspace);

    assert.deepEqual(surface.listScopes(), ['all']);
    await assert.rejects(
      () => surface.listSessions({ adapterId: 'codex', scope: 'current_workspace' }),
      /workspace is unavailable/,
    );
    assert.deepEqual(requests, []);

    workspace = { kind: 'host_path', path: '/repo' };
    assert.deepEqual(surface.listScopes(), ['current_workspace', 'all']);
    await surface.listSessions({
      adapterId: 'codex',
      scope: 'current_workspace',
      text: 'parser',
    });
    assert.deepEqual(requests, [
      {
        operation: 'external-session.catalog.query',
        input: { adapterId: 'codex', workspace, text: 'parser' },
      },
    ]);
  });
});
