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

import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const SESSION_NAME = 'Released State Root qualification';
const MESSAGE_ID = 'released-state-root-message';
const TASK_TITLE = 'Released State Root durable task';
const FUTURE_FIRE_DELAY_MS = 24 * 60 * 60 * 1_000;

const input = parseFixtureArgs(process.argv.slice(2));
const storageRootAuthority = await loadInstalled(
  input.packageRoot,
  'node_modules/@maka/storage/dist/root-authority.js',
);
const capability = await storageRootAuthority.resolveStorageRoot({
  path: input.rootPath,
  kind: 'interactive',
});
const owner = await storageRootAuthority.tryAcquireInteractiveRootOwner(capability);

if (!owner) {
  writeResult({ kind: 'writer_busy' });
  process.exit(0);
}

try {
  if (input.action === 'seed') {
    writeResult(await seedFixture(input.packageRoot, input.rootPath, owner, capability.rootId));
  } else if (input.action === 'inspect') {
    writeResult(await inspectFixture(input.packageRoot, input.rootPath, owner, capability.rootId));
  } else {
    writeResult(await probeWriterFence(input.targetPackageRoot, input.rootPath, capability.rootId));
  }
} finally {
  await owner.close();
}

async function seedFixture(packageRoot, rootPath, rootOwner, rootId) {
  const sessionsModule = await loadInstalled(
    packageRoot,
    'node_modules/@maka/storage/dist/session-store.js',
  );
  const scheduledTasksModule = await loadInstalled(
    packageRoot,
    'node_modules/@maka/storage/dist/scheduled-task-store.js',
  );
  const sessions = sessionsModule.createSessionStore(rootPath);
  const scheduledTasks = await scheduledTasksModule.openInteractiveScheduledTaskStoreForWrite(
    rootOwner.lease,
  );
  try {
    const session = await sessions.create({
      cwd: rootPath,
      backend: 'ai-sdk',
      llmConnectionSlug: 'released-state-root-qualification',
      model: 'qualification-model',
      permissionMode: 'ask',
      name: SESSION_NAME,
      labels: ['release-qualification'],
    });
    await sessions.appendMessage(session.id, {
      type: 'user',
      id: MESSAGE_ID,
      turnId: 'released-state-root-turn',
      ts: Date.now(),
      text: 'Preserve this released State Root fact.',
    });
    const now = Date.now();
    const task = await scheduledTasks.create(
      {
        title: TASK_TITLE,
        intentBody: '',
        schedule: { kind: 'once', runAt: now + FUTURE_FIRE_DELAY_MS },
        effect: { kind: 'notify', channel: 'local' },
        createdBy: { kind: 'user' },
      },
      now,
    );
    return {
      kind: 'facts',
      rootId,
      session: {
        id: session.id,
        name: session.name,
        message: {
          id: MESSAGE_ID,
          type: 'user',
          text: 'Preserve this released State Root fact.',
        },
      },
      scheduledTask: {
        id: task.id,
        title: task.title,
        status: task.status,
        schedule: task.schedule,
        effect: task.effect,
      },
    };
  } finally {
    scheduledTasks.close();
    await sessions.close?.();
  }
}

async function inspectFixture(packageRoot, rootPath, rootOwner, rootId) {
  const sessionsModule = await loadInstalled(
    packageRoot,
    'node_modules/@maka/storage/dist/session-store.js',
  );
  const scheduledTasksModule = await loadInstalled(
    packageRoot,
    'node_modules/@maka/storage/dist/scheduled-task-store.js',
  );
  const sessions = sessionsModule.createSessionStore(rootPath);
  const scheduledTasks = await scheduledTasksModule.openInteractiveScheduledTaskStoreForWrite(
    rootOwner.lease,
  );
  try {
    const session = (await sessions.listHeaders()).find(
      (candidate) => candidate.name === SESSION_NAME,
    );
    if (!session) throw new Error('The released Session fact is missing');
    const messages = await sessions.readMessages(session.id);
    const message = messages.find((candidate) => candidate.id === MESSAGE_ID);
    if (!message) throw new Error('The released Session message is missing');
    const task = (await scheduledTasks.list()).find((candidate) => candidate.title === TASK_TITLE);
    if (!task) throw new Error('The released Scheduled Task fact is missing');
    return {
      kind: 'facts',
      rootId,
      session: {
        id: session.id,
        name: session.name,
        message: { id: message.id, type: message.type, text: message.text },
      },
      scheduledTask: {
        id: task.id,
        title: task.title,
        status: task.status,
        schedule: task.schedule,
        effect: task.effect,
      },
    };
  } finally {
    scheduledTasks.close();
    await sessions.close?.();
  }
}

function parseFixtureArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith('--') || value === undefined) {
      throw new Error('Fixture arguments must be --name value pairs');
    }
    if (values.has(name)) throw new Error(`Duplicate fixture argument: ${name}`);
    values.set(name, value);
  }
  const action = values.get('--action');
  const packageRoot = values.get('--package-root');
  const rootPath = values.get('--root');
  if (!['seed', 'inspect', 'fence'].includes(action)) {
    throw new Error('Fixture action must be seed, inspect, or fence');
  }
  if (!packageRoot || !isAbsolute(packageRoot)) {
    throw new Error('Fixture package root must be absolute');
  }
  if (!rootPath || !isAbsolute(rootPath)) {
    throw new Error('Fixture State Root must be absolute');
  }
  const targetPackageRoot = values.get('--target-package-root');
  if (action === 'fence' && (!targetPackageRoot || !isAbsolute(targetPackageRoot))) {
    throw new Error('Fence fixture target package root must be absolute');
  }
  const expectedNames = action === 'fence' ? 4 : 3;
  if (values.size !== expectedNames) throw new Error('Unknown fixture argument');
  return { action, packageRoot, rootPath, targetPackageRoot };
}

async function loadInstalled(packageRoot, relativePath) {
  return import(pathToFileURL(join(packageRoot, relativePath)).href);
}

function writeResult(result) {
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

async function probeWriterFence(targetPackageRoot, rootPath, rootId) {
  const targetAuthority = await loadInstalled(
    targetPackageRoot,
    'node_modules/@maka/storage/dist/root-authority.js',
  );
  const targetCapability = await targetAuthority.resolveStorageRoot({
    path: rootPath,
    kind: 'interactive',
  });
  const targetOwner = await targetAuthority.tryAcquireInteractiveRootOwner(targetCapability);
  if (targetOwner) {
    await targetOwner.close();
    return { kind: 'writer_acquired', rootId };
  }
  return { kind: 'writer_fenced', rootId };
}
