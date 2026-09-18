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
  createStartupTaskRegistry,
  type StartupTaskDefinition,
} from './startup-task-registry.js';

export const runtimeHostStartupTaskPlan = [
  {
    name: 'start-desktop-background-services',
    phase: 'module-eval-immediate',
    dependencies: [],
  },
  {
    name: 'start-mcp',
    phase: 'module-eval-immediate',
    dependencies: [],
    execution: 'detached',
  },
  {
    name: 'resume-mcp-logins',
    phase: 'module-eval-immediate',
    dependencies: [],
    execution: 'detached',
  },
  {
    name: 'refresh-client-settings',
    phase: 'module-eval-immediate',
    dependencies: [],
    execution: 'detached',
  },
  {
    name: 'start-enabled-runtime-host-profiles',
    phase: 'shell-env-ready',
    dependencies: [],
    execution: 'detached',
  },
  {
    name: 'restore-guest-session-mounts',
    phase: 'runtime-host-ready',
    dependencies: [],
  },
  {
    name: 'recover-local-runtime-host-access',
    phase: 'runtime-host-ready',
    dependencies: ['restore-guest-session-mounts'],
  },
  {
    name: 'offer-unavailable-default-runtime-host',
    phase: 'runtime-host-ready',
    dependencies: ['recover-local-runtime-host-access'],
    execution: 'detached',
  },
] as const satisfies readonly StartupTaskDefinition[];

export const runtimeHostStartupTaskPhases = {
  immediate: 'module-eval-immediate',
  shellEnvReady: 'shell-env-ready',
  runtimeHostReady: 'runtime-host-ready',
} as const;

export type RuntimeHostStartupTaskName =
  (typeof runtimeHostStartupTaskPlan)[number]['name'];

type RuntimeHostStartupTaskImplementations = Record<
  RuntimeHostStartupTaskName,
  () => unknown | Promise<unknown>
>;

export function createRuntimeHostStartupTaskRegistry(
  tasks: RuntimeHostStartupTaskImplementations,
) {
  return createStartupTaskRegistry(runtimeHostStartupTaskPlan, tasks);
}
