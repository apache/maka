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
  type RuntimeHostStartupTaskImplementations,
  type RuntimeHostStartupTaskName,
} from './runtime-host-startup-tasks.js';
import { resolveShellEnv } from './shell-env.js';

type RuntimeHostPostStartupTaskName = Exclude<
  RuntimeHostStartupTaskName,
  'resolve-shell-env' | 'legacy-runtime-host-sequence'
>;

let postStartupTasks: Pick<
  RuntimeHostStartupTaskImplementations,
  RuntimeHostPostStartupTaskName
>;

function runPostStartupTask(
  name: RuntimeHostPostStartupTaskName,
): () => unknown | Promise<unknown> {
  return () => {
    const task = postStartupTasks?.[name];
    if (!task) throw new Error(`startup task is unavailable before legacy boot: ${name}`);
    return task();
  };
}

const startupTasks = createRuntimeHostStartupTaskRegistry({
  'resolve-shell-env': resolveShellEnv,
  'legacy-runtime-host-sequence': async () => {
    const legacyBoot = await import('./runtime-host-legacy-boot.js');
    postStartupTasks = legacyBoot.runtimeHostPostStartupTasks;
  },
  'restore-guest-session-mounts': runPostStartupTask('restore-guest-session-mounts'),
  'recover-local-runtime-host-access': runPostStartupTask('recover-local-runtime-host-access'),
  'start-enabled-runtime-host-profiles': runPostStartupTask(
    'start-enabled-runtime-host-profiles',
  ),
  'offer-unavailable-default-runtime-host': runPostStartupTask(
    'offer-unavailable-default-runtime-host',
  ),
  'start-desktop-background-services': runPostStartupTask(
    'start-desktop-background-services',
  ),
  'start-mcp': runPostStartupTask('start-mcp'),
  'resume-mcp-logins': runPostStartupTask('resume-mcp-logins'),
  'refresh-client-settings': runPostStartupTask('refresh-client-settings'),
});

await startupTasks.runAll();
