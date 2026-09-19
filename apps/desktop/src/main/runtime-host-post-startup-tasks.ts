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

export const runtimeHostPostStartupTaskPlan = [
  {
    name: 'restore-guest-session-mounts',
    phase: 'recovery',
    dependencies: [],
  },
  {
    name: 'recover-local-runtime-host-access',
    phase: 'recovery',
    dependencies: ['restore-guest-session-mounts'],
  },
  {
    name: 'start-enabled-runtime-host-profiles',
    phase: 'background',
    dependencies: ['recover-local-runtime-host-access'],
    execution: 'detached',
  },
  {
    name: 'offer-unavailable-default-runtime-host',
    phase: 'background',
    dependencies: ['recover-local-runtime-host-access'],
    execution: 'detached',
  },
  {
    name: 'start-desktop-background-services',
    phase: 'background',
    dependencies: ['recover-local-runtime-host-access'],
  },
  {
    name: 'start-mcp',
    phase: 'background',
    dependencies: ['recover-local-runtime-host-access'],
    execution: 'detached',
  },
  {
    name: 'resume-mcp-logins',
    phase: 'background',
    dependencies: ['recover-local-runtime-host-access'],
    execution: 'detached',
  },
  {
    name: 'refresh-client-settings',
    phase: 'background',
    dependencies: ['recover-local-runtime-host-access'],
    execution: 'detached',
  },
] as const satisfies readonly StartupTaskDefinition[];

export type RuntimeHostPostStartupTaskName =
  (typeof runtimeHostPostStartupTaskPlan)[number]['name'];

type RuntimeHostPostStartupTaskImplementations = Record<
  RuntimeHostPostStartupTaskName,
  () => unknown | Promise<unknown>
>;

export function createRuntimeHostPostStartupTaskRegistry(
  tasks: RuntimeHostPostStartupTaskImplementations,
) {
  return createStartupTaskRegistry(runtimeHostPostStartupTaskPlan, tasks);
}
