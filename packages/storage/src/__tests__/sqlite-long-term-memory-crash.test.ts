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
import { spawn } from 'node:child_process';
import { writeSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { MemoryItemWrite } from '@maka/core/long-term-memory';
import {
  SqliteMemoryItemStore,
  type SqliteMemoryItemStoreFailpoint,
} from '../sqlite-long-term-memory-store.js';

const childMode = process.env.MAKA_LONG_TERM_MEMORY_CRASH_CHILD;

if (childMode) {
  await runCrashChild(childMode);
} else {
  test('retains one committed Item and its receipt when killed between COMMIT and return', {
    timeout: 30_000,
  }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-long-term-memory-crash-'));
    const databasePath = join(root, 'memory.sqlite');
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url)], {
      env: {
        ...process.env,
        MAKA_LONG_TERM_MEMORY_CRASH_CHILD: 'after_commit',
        MAKA_LONG_TERM_MEMORY_CRASH_DB: databasePath,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    try {
      await waitForReady(child);
      child.kill('SIGKILL');
      await new Promise<void>((resolve, reject) => {
        child.once('exit', () => resolve());
        child.once('error', reject);
      });

      const store = new SqliteMemoryItemStore(databasePath, { now: () => 1_000 });
      try {
        const record = await store.readItem('crash-item');
        assert.equal(record?.item.content, memoryWrite().content);
        assert.ok(await store.readOperation('crash-create'));

        const replayed = await store.applyMutations({
          operationId: 'crash-create',
          mutations: [{ type: 'create', item: memoryWrite() }],
        });
        assert.equal(replayed.replayed, true);
        assert.equal(replayed.results[0]?.itemId, 'crash-item');
        assert.equal((await store.searchByKeys({ terms: ['crash'], match: 'exact' })).length, 1);
      } finally {
        store.close();
      }
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await rm(root, { recursive: true, force: true });
    }
  });
}

async function runCrashChild(mode: string): Promise<void> {
  if (mode !== 'after_commit') throw new Error(`Unknown long-term memory crash mode ${mode}`);
  const databasePath = requiredEnv('MAKA_LONG_TERM_MEMORY_CRASH_DB');
  const failpoint = (point: SqliteMemoryItemStoreFailpoint): void => {
    if (point === 'after_commit') blockUntilKilled();
  };
  const store = new SqliteMemoryItemStore(databasePath, {
    now: () => 1_000,
    idFactory: () => 'crash-item',
    failpoint,
  });
  await store.applyMutations({
    operationId: 'crash-create',
    mutations: [{ type: 'create', item: memoryWrite() }],
  });
  throw new Error('Long-term memory crash mode missed its failpoint');
}

function waitForReady(child: ReturnType<typeof spawn>): Promise<void> {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk);
      if (stdout.includes('READY\n')) resolve();
    });
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.once('exit', (code, signal) => {
      reject(
        new Error(
          `long-term memory crash child exited before READY: code=${code} signal=${signal} ${stderr}`,
        ),
      );
    });
    child.once('error', reject);
  });
}

function memoryWrite(): MemoryItemWrite {
  return {
    content: 'Committed before the process was killed.',
    kind: 'knowledge',
    statementType: 'fact',
    temporalType: 'undated',
    scopeType: 'global',
    observedAt: 900,
    origin: 'agent_extracted',
    keys: [{ key: 'crash', keyType: 'exact', keyOrigin: 'deterministic' }],
    sources: [
      {
        sessionId: 'session-crash',
        runId: 'run-crash',
        turnId: 'turn-crash',
        eventId: 'event-crash',
      },
    ],
  };
}

function blockUntilKilled(): never {
  writeSync(1, 'READY\n');
  Atomics.wait(new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT)), 0, 0);
  throw new Error('unreachable');
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}
