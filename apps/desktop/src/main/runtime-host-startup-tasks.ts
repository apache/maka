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

import type { StartupTaskDefinition } from './startup-task-registry.js';

export const runtimeHostStartupTaskPlan = [
  { name: 'resolve-shell-env', phase: 'environment', dependencies: [] },
  {
    name: 'configure-runtime-host-peer',
    phase: 'runtime-host',
    dependencies: ['resolve-shell-env'],
  },
  {
    name: 'open-runtime-host-peer',
    phase: 'runtime-host',
    dependencies: ['configure-runtime-host-peer'],
  },
  {
    name: 'load-runtime-host-client-instance',
    phase: 'runtime-host',
    dependencies: ['open-runtime-host-peer'],
  },
  {
    name: 'resolve-runtime-host-startup',
    phase: 'runtime-host',
    dependencies: ['load-runtime-host-client-instance'],
  },
  {
    name: 'seed-e2e-fixture',
    phase: 'storage',
    dependencies: ['resolve-runtime-host-startup'],
  },
  {
    name: 'resolve-storage-root',
    phase: 'storage',
    dependencies: ['seed-e2e-fixture'],
  },
  {
    name: 'register-persistent-client-ipc',
    phase: 'ipc',
    dependencies: ['resolve-storage-root'],
  },
  {
    name: 'register-pet-pack-ipc',
    phase: 'ipc',
    dependencies: ['register-persistent-client-ipc'],
  },
  {
    name: 'register-notifications-ipc',
    phase: 'ipc',
    dependencies: ['register-pet-pack-ipc'],
  },
  {
    name: 'connect-runtime-host',
    phase: 'connect',
    dependencies: ['register-notifications-ipc'],
  },
  {
    name: 'initialize-renderer',
    phase: 'renderer',
    dependencies: ['connect-runtime-host'],
  },
  {
    name: 'restore-guest-session-mounts',
    phase: 'renderer',
    dependencies: ['initialize-renderer'],
  },
  {
    name: 'recover-local-runtime-host-access',
    phase: 'renderer',
    dependencies: ['restore-guest-session-mounts'],
  },
  {
    name: 'start-enabled-runtime-host-profiles',
    phase: 'background',
    dependencies: ['recover-local-runtime-host-access'],
  },
  {
    name: 'offer-unavailable-default-runtime-host',
    phase: 'background',
    dependencies: ['start-enabled-runtime-host-profiles'],
  },
  {
    name: 'start-desktop-background-services',
    phase: 'background',
    dependencies: ['offer-unavailable-default-runtime-host'],
  },
  {
    name: 'start-mcp',
    phase: 'background',
    dependencies: ['start-desktop-background-services'],
  },
  {
    name: 'resume-mcp-logins',
    phase: 'background',
    dependencies: ['start-mcp'],
  },
  {
    name: 'refresh-client-settings',
    phase: 'background',
    dependencies: ['resume-mcp-logins'],
  },
] as const satisfies readonly StartupTaskDefinition[];
