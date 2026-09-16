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

test('runs startup tasks in dependency order regardless of declaration order', async () => {
  const events: string[] = [];
  const registry = createStartupTaskRegistry([...runtimeHostStartupTaskPlan].reverse());

  for (const definition of runtimeHostStartupTaskPlan) {
    registry.register(definition.name, () => {
      events.push(definition.name);
    });
  }

  await registry.runAll();

  assert.equal(events.length, runtimeHostStartupTaskPlan.length);
  for (const definition of runtimeHostStartupTaskPlan) {
    const taskIndex = events.indexOf(definition.name);
    for (const dependency of definition.dependencies) {
      assert.ok(events.indexOf(dependency) < taskIndex, `${dependency} precedes ${definition.name}`);
    }
  }
});

test('defers shell-dependent profile startup without blocking UI preparation', () => {
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

  assert.equal(dependsOn('start-enabled-runtime-host-profiles', 'resolve-shell-env'), true);
  assert.equal(dependsOn('initialize-renderer', 'resolve-shell-env'), false);
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
