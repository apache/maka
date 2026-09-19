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
import { deferred } from '@maka/core/test-only/async-primitives';
import {
  createRuntimeHostPostStartupTaskRegistry,
  type RuntimeHostPostStartupTaskName,
} from '../runtime-host-post-startup-tasks.js';
import {
  createStartupTaskRegistry,
} from '../startup-task-registry.js';

const historicalSequence: readonly RuntimeHostPostStartupTaskName[] = [
  'restore-guest-session-mounts',
  'recover-local-runtime-host-access',
  'start-enabled-runtime-host-profiles',
  'offer-unavailable-default-runtime-host',
  'start-desktop-background-services',
  'start-mcp',
  'resume-mcp-logins',
  'refresh-client-settings',
];

test('production registration preserves the historical wait boundaries independently of implementation key order', async () => {
  const events: string[] = [];
  const guestSessionMountsStarted = deferred();
  const localRuntimeHostRecoveryStarted = deferred();
  const guestSessionMounts = deferred();
  const localRuntimeHostRecovery = deferred();
  const tasks = Object.fromEntries(
    [...historicalSequence].reverse().map((name) => [
      name,
      async () => {
        events.push(`${name}:start`);
        if (name === 'restore-guest-session-mounts') {
          guestSessionMountsStarted.resolve();
          await guestSessionMounts.promise;
          events.push(`${name}:done`);
        }
        if (name === 'recover-local-runtime-host-access') {
          localRuntimeHostRecoveryStarted.resolve();
          await localRuntimeHostRecovery.promise;
          events.push(`${name}:done`);
        }
      },
    ]),
  ) as unknown as Record<RuntimeHostPostStartupTaskName, () => Promise<void>>;

  const running = createRuntimeHostPostStartupTaskRegistry(tasks).runAll();
  await guestSessionMountsStarted.promise;
  assert.deepEqual(events, ['restore-guest-session-mounts:start']);

  guestSessionMounts.resolve();
  await localRuntimeHostRecoveryStarted.promise;
  assert.deepEqual(events, [
    'restore-guest-session-mounts:start',
    'restore-guest-session-mounts:done',
    'recover-local-runtime-host-access:start',
  ]);

  localRuntimeHostRecovery.resolve();
  await running;
  assert.deepEqual(events, [
    'restore-guest-session-mounts:start',
    'restore-guest-session-mounts:done',
    'recover-local-runtime-host-access:start',
    'recover-local-runtime-host-access:done',
    ...historicalSequence.slice(2).map((name) => `${name}:start`),
  ]);
});

test('uses definition order as the deterministic tiebreak for dependency peers', async () => {
  const events: string[] = [];
  const registry = createStartupTaskRegistry(
    [
      { name: 'root', phase: 'test', dependencies: [] },
      { name: 'defined-second', phase: 'test', dependencies: ['root'] },
      { name: 'defined-first', phase: 'test', dependencies: ['root'] },
      {
        name: 'last',
        phase: 'test',
        dependencies: ['defined-first', 'defined-second'],
      },
    ] as const,
    {
      'defined-first': () => events.push('defined-first'),
      root: () => events.push('root'),
      last: () => events.push('last'),
      'defined-second': () => events.push('defined-second'),
    },
  );

  await registry.runAll();

  assert.deepEqual(events, ['root', 'defined-second', 'defined-first', 'last']);
});

test('detached tasks do not block the graph', async () => {
  const events: string[] = [];
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
      foreground: () => events.push('foreground'),
      background: async () => {
        events.push('background:start');
        await background;
        events.push('background:done');
      },
      'after-start': () => events.push('after-start'),
    },
  );

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
});

test('validates the complete graph before executing any task', async () => {
  assert.throws(
    () =>
      createStartupTaskRegistry([
        { name: 'dependent', phase: 'test', dependencies: ['missing'] },
      ]),
    /unknown startup task dependency: missing/u,
  );

  assert.throws(
    () =>
      createStartupTaskRegistry([
        { name: 'first', phase: 'test', dependencies: ['second'] },
        { name: 'second', phase: 'test', dependencies: ['first'] },
      ] as const, {
        first: () => undefined,
        second: () => undefined,
      }),
    /startup task dependency cycle/u,
  );
  assert.throws(
    () =>
      createStartupTaskRegistry(
        [
          { name: 'registered', phase: 'test', dependencies: [] },
          { name: 'missing', phase: 'test', dependencies: ['registered'] },
        ] as const,
        { registered: () => undefined },
      ),
    /startup task is not implemented: missing/u,
  );
});
