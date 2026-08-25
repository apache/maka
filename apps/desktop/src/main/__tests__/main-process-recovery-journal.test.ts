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

import { DiagnosticLogBuffer } from '@maka/core/diagnostic-log';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  appendUncaughtMainProcessError,
  createMainProcessRecoveryJournal,
  MAIN_PROCESS_RECOVERY_FLUSH_DEBOUNCE_MS,
  MAIN_PROCESS_RECOVERY_FLUSH_INTERVAL_MS,
  MAIN_PROCESS_RECOVERY_LOG_MAX_BYTES,
  MAIN_PROCESS_RECOVERY_MAX_AGE_MS,
} from '../main-process-recovery-journal.js';

test('recovers one bounded redacted snapshot after an unclean exit', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'maka-main-recovery-'));
  try {
    const buffer = new DiagnosticLogBuffer({ maxBytes: 256 * 1024 });
    buffer.append(
      'error',
      `failed under ${homedir()} with api_key=sk-secretvalue123`,
      new Date('2026-08-20T00:00:01Z'),
    );
    const first = createJournal(directory, buffer, new Date('2026-08-20T00:00:00Z'));
    first.markDirty();
    first.flushNow();

    const second = createJournal(
      directory,
      new DiagnosticLogBuffer(),
      new Date('2026-08-20T01:00:00Z'),
    );

    assert.equal(second.pending?.run.startedAt, '2026-08-20T00:00:00.000Z');
    assert.equal(second.pending?.snapshotAt, '2026-08-20T00:00:00.000Z');
    assert.match(second.pending?.logs.join('\n') ?? '', /failed under ~/);
    assert.doesNotMatch(second.pending?.logs.join('\n') ?? '', /sk-secretvalue123/);
    if (process.platform !== 'win32') {
      assert.equal(statSync(directory).mode & 0o777, 0o700);
      assert.equal(statSync(join(directory, 'active.json')).mode & 0o777, 0o600);
      assert.equal(statSync(join(directory, 'pending.json')).mode & 0o777, 0o600);
    }

    second.discardPending();
    second.markClean();
    second.markClean();
    assert.equal(existsSync(join(directory, 'active.json')), false);
    const third = createJournal(
      directory,
      new DiagnosticLogBuffer(),
      new Date('2026-08-20T02:00:00Z'),
    );
    assert.equal(third.pending, undefined);
    third.markClean();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('debounces the first snapshot and rate-limits a continuing log stream', async (context) => {
  context.mock.timers.enable({
    apis: ['Date', 'setTimeout'],
    now: new Date('2026-08-20T00:00:00Z').getTime(),
  });
  const directory = await mkdtemp(join(tmpdir(), 'maka-main-recovery-rate-'));
  try {
    const buffer = new DiagnosticLogBuffer();
    const journal = createJournal(directory, buffer);
    const snapshotPath = join(directory, 'active.json');

    buffer.append('info', 'first');
    journal.markDirty();
    context.mock.timers.tick(MAIN_PROCESS_RECOVERY_FLUSH_DEBOUNCE_MS - 1);
    assert.doesNotMatch(readFileSync(snapshotPath, 'utf8'), /first/);
    context.mock.timers.tick(1);
    assert.match(readFileSync(snapshotPath, 'utf8'), /first/);

    buffer.append('info', 'second');
    journal.markDirty();
    context.mock.timers.tick(MAIN_PROCESS_RECOVERY_FLUSH_INTERVAL_MS - 1);
    assert.doesNotMatch(readFileSync(snapshotPath, 'utf8'), /second/);
    context.mock.timers.tick(1);
    assert.match(readFileSync(snapshotPath, 'utf8'), /second/);
    journal.markClean();
  } finally {
    context.mock.timers.reset();
    await rm(directory, { recursive: true, force: true });
  }
});

test('flushes an uncaught JavaScript failure without intercepting process exit', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'maka-main-recovery-fatal-'));
  try {
    const buffer = new DiagnosticLogBuffer();
    const first = createJournal(directory, buffer, new Date('2026-08-20T00:00:00Z'));
    appendUncaughtMainProcessError(
      buffer,
      first,
      new Error('Authorization: Bearer very-secret-token'),
      'uncaughtException',
    );

    const second = createJournal(
      directory,
      new DiagnosticLogBuffer(),
      new Date('2026-08-20T00:01:00Z'),
    );
    const logs = second.pending?.logs.join('\n') ?? '';
    assert.match(logs, /uncaughtException/);
    assert.doesNotMatch(logs, /very-secret-token/);
    second.markClean();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('persists only the bounded newest log tail', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'maka-main-recovery-bound-'));
  try {
    const buffer = new DiagnosticLogBuffer({ maxBytes: 512 * 1024 });
    for (let index = 0; index < 400; index += 1) {
      buffer.append('info', `entry ${index} ${'x'.repeat(1_024)}`);
    }
    const journal = createJournal(directory, buffer, new Date('2026-08-20T00:00:00Z'));
    journal.markDirty();
    journal.flushNow();
    const snapshot = JSON.parse(readFileSync(join(directory, 'active.json'), 'utf8')) as {
      logs: string[];
    };

    assert.ok(Buffer.byteLength(JSON.stringify(snapshot.logs)) <= MAIN_PROCESS_RECOVERY_LOG_MAX_BYTES);
    assert.match(snapshot.logs.at(-1) ?? '', /entry 399/);
    assert.doesNotMatch(snapshot.logs[0] ?? '', /entry 0 /);
    journal.markClean();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('retains a newly discovered interruption and expires pending evidence after seven days', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'maka-main-recovery-expiry-'));
  try {
    createJournal(directory, new DiagnosticLogBuffer(), new Date('2026-08-01T00:00:00Z'));
    const discovered = createJournal(
      directory,
      new DiagnosticLogBuffer(),
      new Date('2026-08-20T00:00:00Z'),
    );
    assert.equal(discovered.pending?.run.startedAt, '2026-08-01T00:00:00.000Z');
    discovered.markClean();

    const afterExpiry = createJournal(
      directory,
      new DiagnosticLogBuffer(),
      new Date(
        new Date('2026-08-20T00:00:00Z').getTime() +
          MAIN_PROCESS_RECOVERY_MAX_AGE_MS +
          2_000,
      ),
    );
    assert.equal(afterExpiry.pending, undefined);
    afterExpiry.markClean();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('ignores corrupt pending records without amplifying invalid log arrays', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'maka-main-recovery-corrupt-'));
  const errors: unknown[] = [];
  try {
    writeFileSync(join(directory, 'pending.json'), '{not json', { mode: 0o600 });
    const afterCorruption = createJournal(
      directory,
      new DiagnosticLogBuffer(),
      new Date('2026-08-20T00:00:00Z'),
      errors,
    );
    assert.equal(afterCorruption.pending, undefined);
    assert.equal(errors.length, 1);
    afterCorruption.markClean();

    writeFileSync(
      join(directory, 'pending.json'),
      JSON.stringify({ logs: Array.from({ length: 50_000 }, () => 0) }),
      { mode: 0o600 },
    );
    const afterInvalidLogs = createJournal(
      directory,
      new DiagnosticLogBuffer(),
      new Date('2026-08-20T00:00:00Z'),
      errors,
    );
    assert.equal(afterInvalidLogs.pending, undefined);
    assert.equal(errors.length, 2);
    assert.equal((errors[1] as Error).message, 'Main-process recovery logs are invalid');
    afterInvalidLogs.markClean();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('refuses to read a symlinked recovery record', async (context) => {
  if (process.platform === 'win32') context.skip('Creating symlinks requires optional privileges on Windows');
  const directory = await mkdtemp(join(tmpdir(), 'maka-main-recovery-symlink-'));
  const errors: unknown[] = [];
  try {
    const target = join(directory, 'outside.json');
    writeFileSync(target, '{}', { mode: 0o600 });
    symlinkSync(target, join(directory, 'pending.json'));

    const journal = createJournal(
      directory,
      new DiagnosticLogBuffer(),
      new Date('2026-08-20T00:00:00Z'),
      errors,
    );
    assert.equal(journal.pending, undefined);
    assert.equal(errors.length, 1);
    journal.markClean();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function createJournal(
  root: string,
  buffer: DiagnosticLogBuffer,
  currentTime?: Date,
  errors: unknown[] = [],
) {
  return createMainProcessRecoveryJournal({
    root,
    appVersion: '0.1.11',
    buildMode: 'packaged',
    buildCommit: 'a'.repeat(40),
    logs: () => buffer.snapshot(),
    onError: (error) => errors.push(error),
    ...(currentTime ? { now: () => currentTime } : {}),
  });
}
