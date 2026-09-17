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
import {
  createRuntimeHostStartupTaskRegistry,
  runtimeHostStartupTaskPlan,
  type RuntimeHostStartupTaskName,
} from '../runtime-host-startup-tasks.js';
import {
  createStartupTaskRegistry,
  type StartupTaskEvent,
} from '../startup-task-registry.js';

const historicalSequence: readonly RuntimeHostStartupTaskName[] = [
  'resolve-shell-env',
  'legacy-runtime-host-sequence',
  'restore-guest-session-mounts',
  'recover-local-runtime-host-access',
  'start-enabled-runtime-host-profiles',
  'offer-unavailable-default-runtime-host',
  'start-desktop-background-services',
  'start-mcp',
  'resume-mcp-logins',
  'refresh-client-settings',
];

test('production registration derives the historical sequence independently of implementation key order', async () => {
  const events: RuntimeHostStartupTaskName[] = [];
  const tasks = Object.fromEntries(
    [...historicalSequence].reverse().map((name) => [name, () => void events.push(name)]),
  ) as unknown as Record<RuntimeHostStartupTaskName, () => void>;

  await createRuntimeHostStartupTaskRegistry(tasks, { observe: () => {} }).runAll();

  assert.deepEqual(events, historicalSequence);
});

test('declares the login-shell PATH edge before every later production task', () => {
  const tasks = new Map(runtimeHostStartupTaskPlan.map((task) => [task.name, task]));

  const dependsOn = (
    name: RuntimeHostStartupTaskName,
    dependency: RuntimeHostStartupTaskName,
    seen = new Set<RuntimeHostStartupTaskName>(),
  ): boolean => {
    if (seen.has(name)) return false;
    seen.add(name);
    const task = tasks.get(name);
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

test('uses registration order as the deterministic tiebreak for dependency peers', async () => {
  const events: string[] = [];
  const registry = createStartupTaskRegistry([
    { name: 'root', phase: 'test', dependencies: [] },
    { name: 'registered-second', phase: 'test', dependencies: ['root'] },
    { name: 'registered-first', phase: 'test', dependencies: ['root'] },
    {
      name: 'last',
      phase: 'test',
      dependencies: ['registered-first', 'registered-second'],
    },
  ] as const);

  registry.register('registered-first', () => events.push('registered-first'));
  registry.register('root', () => events.push('root'));
  registry.register('last', () => events.push('last'));
  registry.register('registered-second', () => events.push('registered-second'));

  await registry.runAll();

  assert.deepEqual(events, ['root', 'registered-first', 'registered-second', 'last']);
});

test('detached tasks do not block the graph and still report their settled duration', async () => {
  const events: string[] = [];
  const measurements: StartupTaskEvent<string>[] = [];
  const timestamps = [100, 105, 106, 110, 125, 130];
  let finishBackground: (() => void) | undefined;
  const background = new Promise<void>((resolve) => {
    finishBackground = resolve;
  });
  const registry = createStartupTaskRegistry(
    [
      { name: 'foreground', phase: 'test', dependencies: [] },
      {
        name: 'background',
        phase: 'test',
        dependencies: ['foreground'],
        execution: 'detached',
      },
      { name: 'after-start', phase: 'test', dependencies: ['background'] },
    ] as const,
    {
      now: () => timestamps.shift()!,
      observe: (event) => measurements.push(event),
    },
  );

  registry.register('foreground', () => events.push('foreground'));
  registry.register('background', async () => {
    events.push('background:start');
    await background;
    events.push('background:done');
  });
  registry.register('after-start', () => events.push('after-start'));

  await registry.runAll();
  assert.deepEqual(events, ['foreground', 'background:start', 'after-start']);

  finishBackground?.();
  await background;
  await Promise.resolve();

  assert.deepEqual(events, [
    'foreground',
    'background:start',
    'after-start',
    'background:done',
  ]);
  assert.deepEqual(measurements, [
    { status: 'started', name: 'foreground', phase: 'test', execution: 'foreground', at: 100 },
    {
      status: 'completed',
      name: 'foreground',
      phase: 'test',
      execution: 'foreground',
      startedAt: 100,
      completedAt: 105,
      durationMs: 5,
    },
    { status: 'started', name: 'background', phase: 'test', execution: 'detached', at: 106 },
    { status: 'started', name: 'after-start', phase: 'test', execution: 'foreground', at: 110 },
    {
      status: 'completed',
      name: 'after-start',
      phase: 'test',
      execution: 'foreground',
      startedAt: 110,
      completedAt: 125,
      durationMs: 15,
    },
    {
      status: 'completed',
      name: 'background',
      phase: 'test',
      execution: 'detached',
      startedAt: 106,
      completedAt: 130,
      durationMs: 24,
    },
  ]);
});

test('validates the complete graph before executing any task', async () => {
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
  const cyclicEvents: string[] = [];
  cyclic.register('first', () => cyclicEvents.push('first'));
  cyclic.register('second', () => cyclicEvents.push('second'));
  await assert.rejects(cyclic.runAll(), /startup task dependency cycle/u);
  assert.deepEqual(cyclicEvents, []);

  const incomplete = createStartupTaskRegistry([
    { name: 'registered', phase: 'test', dependencies: [] },
    { name: 'missing', phase: 'test', dependencies: ['registered'] },
  ] as const);
  const incompleteEvents: string[] = [];
  incomplete.register('registered', () => incompleteEvents.push('registered'));
  await assert.rejects(incomplete.runAll(), /startup task is not registered: missing/u);
  assert.deepEqual(incompleteEvents, []);
});
