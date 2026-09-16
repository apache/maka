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
import { runtimeHostStartupTaskPlan } from '../runtime-host-startup-tasks.js';
import { createStartupTaskRegistry } from '../startup-task-registry.js';

const historicalSequence = [
  'resolve-shell-env',
  'configure-runtime-host-peer',
  'open-runtime-host-peer',
  'load-runtime-host-client-instance',
  'resolve-runtime-host-startup',
  'seed-e2e-fixture',
  'resolve-storage-root',
  'register-persistent-client-ipc',
  'register-pet-pack-ipc',
  'register-notifications-ipc',
  'connect-runtime-host',
  'initialize-renderer',
  'restore-guest-session-mounts',
  'recover-local-runtime-host-access',
  'start-enabled-runtime-host-profiles',
  'offer-unavailable-default-runtime-host',
  'start-desktop-background-services',
  'start-mcp',
  'resume-mcp-logins',
  'refresh-client-settings',
] as const;

test('derives the historical startup sequence from dependencies', async () => {
  const events: string[] = [];
  const registry = createStartupTaskRegistry([...runtimeHostStartupTaskPlan].reverse());

  for (const definition of runtimeHostStartupTaskPlan) {
    registry.register(definition.name, () => {
      events.push(definition.name);
    });
  }

  await registry.runAll();

  assert.deepEqual(events, historicalSequence);
});

test('declares the login-shell PATH edge before every later startup task', () => {
  const tasks = new Map(runtimeHostStartupTaskPlan.map((task) => [task.name, task]));

  const dependsOn = (name: string, dependency: string, seen = new Set<string>()): boolean => {
    if (seen.has(name)) return false;
    seen.add(name);
    const task = tasks.get(name as (typeof runtimeHostStartupTaskPlan)[number]['name']);
    if (!task) return false;
    return task.dependencies.some(
      (candidate) => candidate === dependency || dependsOn(candidate, dependency, seen),
    );
  };

  for (const task of runtimeHostStartupTaskPlan.slice(1)) {
    assert.equal(
      dependsOn(task.name, 'resolve-shell-env'),
      true,
      `${task.name} must transitively depend on resolve-shell-env`,
    );
  }
});

test('keeps background startup tasks fire-and-forget', async () => {
  const events: string[] = [];
  let finishBackground: (() => void) | undefined;
  const background = new Promise<void>((resolve) => {
    finishBackground = resolve;
  });
  const registry = createStartupTaskRegistry([
    { name: 'foreground', phase: 'renderer', dependencies: [] },
    { name: 'background', phase: 'background', dependencies: ['foreground'] },
    {
      name: 'after-background-start',
      phase: 'background',
      dependencies: ['background'],
    },
  ] as const);

  registry.register('foreground', () => {
    events.push('foreground');
  });
  registry.register('background', () => {
    events.push('background:start');
    void background.then(() => events.push('background:done'));
  });
  registry.register('after-background-start', () => {
    events.push('after-background-start');
  });

  await registry.runAll();
  assert.deepEqual(events, ['foreground', 'background:start', 'after-background-start']);

  finishBackground?.();
  await background;
  assert.deepEqual(events, [
    'foreground',
    'background:start',
    'after-background-start',
    'background:done',
  ]);
});

test('runs synchronous tasks inline and preserves thrown errors', () => {
  const registry = createStartupTaskRegistry([
    { name: 'first', phase: 'test', dependencies: [] },
    { name: 'second', phase: 'test', dependencies: ['first'] },
  ] as const);
  const events: string[] = [];

  registry.runTaskSync('first', () => {
    events.push('first');
  });
  assert.deepEqual(events, ['first']);

  assert.throws(
    () =>
      registry.runTaskSync('second', () => {
        events.push('second');
        throw new Error('failed synchronously');
      }),
    /failed synchronously/u,
  );
  assert.deepEqual(events, ['first', 'second']);
});

test('rejects missing dependencies and dependency cycles', async () => {
  assert.throws(
    () =>
      createStartupTaskRegistry([
        { name: 'dependent', phase: 'test', dependencies: ['missing'] },
      ]),
    /unknown startup task dependency: missing/u,
  );

  const cyclic = createStartupTaskRegistry([
    { name: 'first', phase: 'test', dependencies: ['second'] },
    { name: 'second', phase: 'test', dependencies: ['first'] },
  ] as const);
  cyclic.register('first', () => {});
  cyclic.register('second', () => {});
  await assert.rejects(cyclic.runAll(), /startup task dependency cycle: first -> second -> first/u);

  const incomplete = createStartupTaskRegistry([
    { name: 'missing', phase: 'test', dependencies: [] },
  ] as const);
  await assert.rejects(incomplete.runAll(), /startup task is not registered: missing/u);
});
