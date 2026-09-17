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
  type StartupTaskEvent,
  type StartupTaskRegistryOptions,
} from './startup-task-registry.js';

export const runtimeHostStartupTaskPlan = [
  { name: 'resolve-shell-env', phase: 'environment', dependencies: [] },
  {
    name: 'legacy-runtime-host-sequence',
    phase: 'runtime-host',
    dependencies: ['resolve-shell-env'],
  },
  {
    name: 'restore-guest-session-mounts',
    phase: 'background',
    dependencies: ['legacy-runtime-host-sequence'],
    execution: 'detached',
  },
  {
    name: 'recover-local-runtime-host-access',
    phase: 'background',
    dependencies: ['legacy-runtime-host-sequence'],
    execution: 'detached',
  },
  {
    name: 'start-enabled-runtime-host-profiles',
    phase: 'background',
    dependencies: ['legacy-runtime-host-sequence'],
    execution: 'detached',
  },
  {
    name: 'offer-unavailable-default-runtime-host',
    phase: 'background',
    dependencies: ['legacy-runtime-host-sequence'],
    execution: 'detached',
  },
  {
    name: 'start-desktop-background-services',
    phase: 'background',
    dependencies: ['legacy-runtime-host-sequence'],
  },
  {
    name: 'start-mcp',
    phase: 'background',
    dependencies: ['legacy-runtime-host-sequence'],
    execution: 'detached',
  },
  {
    name: 'resume-mcp-logins',
    phase: 'background',
    dependencies: ['legacy-runtime-host-sequence'],
    execution: 'detached',
  },
  {
    name: 'refresh-client-settings',
    phase: 'background',
    dependencies: ['legacy-runtime-host-sequence'],
    execution: 'detached',
  },
] as const satisfies readonly StartupTaskDefinition[];

export type RuntimeHostStartupTaskName =
  (typeof runtimeHostStartupTaskPlan)[number]['name'];

type RuntimeHostStartupTaskImplementations = Record<
  RuntimeHostStartupTaskName,
  () => unknown | Promise<unknown>
>;

function logStartupTaskEvent(event: StartupTaskEvent<RuntimeHostStartupTaskName>): void {
  if (event.status === 'started') {
    console.info(
      `[startup] task=${event.name} phase=${event.phase} execution=${event.execution} startedAt=${new Date(event.at).toISOString()}`,
    );
    return;
  }
  const detail =
    event.status === 'failed'
      ? ` error=${event.error instanceof Error ? event.error.message : String(event.error)}`
      : '';
  const message = `[startup] task=${event.name} phase=${event.phase} execution=${event.execution} status=${event.status} startedAt=${new Date(event.startedAt).toISOString()} completedAt=${new Date(event.completedAt).toISOString()} durationMs=${event.durationMs}${detail}`;
  if (event.status === 'failed') console.error(message);
  else console.info(message);
}

export function createRuntimeHostStartupTaskRegistry(
  tasks: RuntimeHostStartupTaskImplementations,
  options: StartupTaskRegistryOptions<RuntimeHostStartupTaskName> = {},
) {
  const registry = createStartupTaskRegistry(runtimeHostStartupTaskPlan, {
    ...options,
    observe: options.observe ?? logStartupTaskEvent,
  });
  for (const definition of runtimeHostStartupTaskPlan) {
    registry.register(definition.name, tasks[definition.name]);
  }
  return registry;
}
