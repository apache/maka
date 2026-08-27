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
import test from 'node:test';
import { runtimeHostLocalSetupCommand } from '../runtime-host-local-operator.js';

test('local setup installs one managed service for the Desktop root with Direct peer enabled', () => {
  assert.deepEqual(
    runtimeHostLocalSetupCommand({
      packageSpecifier: 'maka-agent@0.2.0',
      clientDataRoot: '/Users/ada/Library/Application Support/Maka',
      rootPath: '/Users/ada/Library/Application Support/Maka/workspaces/default',
      principalId: 'desktop-owner:pairing',
      coordinationRelays: ['/dns4/discovery.example/udp/443/quic-v1'],
      expectedTarget: {
        serviceId: 'b'.repeat(64),
        rootPath: '/Users/ada/Library/Application Support/Maka/workspaces/default',
        rootId: 'a'.repeat(64),
      },
    }),
    {
      executable: 'npm',
      args: [
        'exec', '--yes', '--package', 'maka-agent@0.2.0', '--',
        'maka', 'runtime-host', 'setup',
        '--client-data-root', '/Users/ada/Library/Application Support/Maka',
        '--root', '/Users/ada/Library/Application Support/Maka/workspaces/default',
        '--principal', 'desktop-owner:pairing',
        '--preset', 'desktop-client',
        '--defer-pairing-commit',
        '--bind-pairing-to-client',
        '--enable-direct-peer',
        '--expected-service-id', 'b'.repeat(64),
        '--expected-root-path', '/Users/ada/Library/Application Support/Maka/workspaces/default',
        '--expected-root-id', 'a'.repeat(64),
        '--coordination-relay', '/dns4/discovery.example/udp/443/quic-v1',
        '--json',
      ],
    },
  );
});
