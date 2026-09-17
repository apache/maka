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
  createRuntimeHostStartupTaskRegistry,
} from './runtime-host-startup-tasks.js';
import { resolveShellEnv } from './shell-env.js';

type RuntimeHostPostStartupTasks =
  (typeof import('./runtime-host-legacy-boot.js'))['runtimeHostPostStartupTasks'];
type RuntimeHostPostStartupTaskName = keyof RuntimeHostPostStartupTasks;

let postStartupTasks: RuntimeHostPostStartupTasks;

function runPostStartupTask(
  name: RuntimeHostPostStartupTaskName,
): () => unknown | Promise<unknown> {
  return () => postStartupTasks[name]();
}

const startupTasks = createRuntimeHostStartupTaskRegistry({
  'legacy-runtime-host-sequence': async () => {
    const legacyBoot = await import('./runtime-host-legacy-boot.js');
    postStartupTasks = legacyBoot.runtimeHostPostStartupTasks;
  },
  'offer-unavailable-default-runtime-host': runPostStartupTask(
    'offer-unavailable-default-runtime-host',
  ),
  'recover-local-runtime-host-access': runPostStartupTask('recover-local-runtime-host-access'),
  'refresh-client-settings': runPostStartupTask('refresh-client-settings'),
  'resolve-shell-env': resolveShellEnv,
  'restore-guest-session-mounts': runPostStartupTask('restore-guest-session-mounts'),
  'resume-mcp-logins': runPostStartupTask('resume-mcp-logins'),
  'start-desktop-background-services': runPostStartupTask(
    'start-desktop-background-services',
  ),
  'start-enabled-runtime-host-profiles': runPostStartupTask(
    'start-enabled-runtime-host-profiles',
  ),
  'start-mcp': runPostStartupTask('start-mcp'),
});

await startupTasks.runAll();
