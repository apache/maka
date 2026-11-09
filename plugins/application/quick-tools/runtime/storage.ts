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

import { host } from 'nsh';
import fs from 'fs/promises';
import { join } from 'path';
import process from 'process';

/** Client-local data; never reads or modifies the Electron profile implicitly. */
export function directory(): string {
  if (!process.dataDir) throw Error('Quick Tools requires a persistent native client directory');
  return join(process.dataDir, 'quick-tools');
}
let rootReady: Promise<void> | undefined;
export function prepare(): Promise<void> {
  return (rootReady ??= (async () => {
    const root = directory();
    await fs.mkdir(root, { recursive: true });
    if (process.platform !== 'windows') {
      const result = await process.run('/bin/chmod', ['700', root], { timeoutMs: 5000 });
      if (result.code !== 0) throw Error(result.stderr || 'Cannot protect Quick Tools storage');
    }
  })().catch((error) => {
    rootReady = undefined;
    throw error;
  }));
}
const queues = new Map<string, Promise<unknown>>();
export async function read<T>(key: string, fallback: T): Promise<T> {
  if (!/^[a-z0-9.-]+$/i.test(key)) throw Error('Invalid storage key');
  await queues.get(key);
  return (await host.call('quickTools.storage.read', { key, fallback })) as T;
}
export function write(key: string, value: unknown): Promise<void> {
  if (!/^[a-z0-9.-]+$/i.test(key)) return Promise.reject(Error('Invalid storage key'));
  const snapshot = JSON.parse(JSON.stringify(value));
  const task = (queues.get(key) ?? Promise.resolve())
    .catch(() => {})
    .then(() => host.call('quickTools.storage.write', { key, value: snapshot }))
    .then(() => {});
  queues.set(key, task);
  void task
    .finally(() => {
      if (queues.get(key) === task) queues.delete(key);
    })
    .catch(() => {});
  return task;
}

/** Read/modify/write shares the same per-key queue as writes, within this panel runtime. */
export function update<T>(key: string, fallback: T, change: (value: T) => T): Promise<T> {
  const task = (queues.get(key) ?? Promise.resolve())
    .catch(() => {})
    .then(async () => {
      const value = (await host.call('quickTools.storage.read', { key, fallback })) as T;
      const next = change(value);
      await host.call('quickTools.storage.write', { key, value: next });
      return next;
    });
  queues.set(key, task);
  void task
    .finally(() => {
      if (queues.get(key) === task) queues.delete(key);
    })
    .catch(() => {});
  return task;
}

/** Bounded local trace: identifiers and outcome only, no queries, clipboard or URLs. */
let pendingTraces = 0;
let traceQueue: Promise<void> = Promise.resolve();
export async function trace(
  event: string,
  plugin: string,
  action: string,
  ok: boolean,
): Promise<void> {
  if (pendingTraces >= 256) return;
  pendingTraces++;
  const key = 'trace';
  const task = traceQueue
    .catch(() => {})
    .then(async () => {
      const events = await read<unknown[]>(key, []);
      const next = [
        ...events.slice(-999),
        { time: new Date().toISOString(), event, plugin, action, ok },
      ];
      await write(key, next);
    });
  traceQueue = task;
  try {
    await task;
  } finally {
    pendingTraces--;
  }
}
