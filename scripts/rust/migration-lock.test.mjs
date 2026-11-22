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
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { checkMigrations, sealMigrations } from './migration-lock.mjs';

const testLedgers = {
  root: ['event-log/migrations', 'agent-state/migrations'],
  settings: ['settings/migrations'],
};

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), 'maka-migration-lock-'));
  const lockPath = join(root, 'migrations.lock.json');
  const write = (rel, sql) => {
    const full = join(root, rel);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, sql, 'utf8');
  };
  write('event-log/migrations/0001_runtime.sql', 'CREATE TABLE runtime(id INTEGER PRIMARY KEY);\n');
  write('agent-state/migrations/0002_agent.sql', 'CREATE TABLE agent(id INTEGER PRIMARY KEY);\n');
  write('settings/migrations/0001_config.sql', 'CREATE TABLE config(id INTEGER PRIMARY KEY);\n');
  sealMigrations({ root, lockPath, ledgers: testLedgers });
  return { root, lockPath, write, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('unsealed appended migration fails check until sealed, then passes', () => {
  const fx = createFixture();
  try {
    assert.equal(
      checkMigrations({ root: fx.root, lockPath: fx.lockPath, ledgers: testLedgers }).ok,
      true,
    );
    fx.write('agent-state/migrations/0003_rooms.sql', 'CREATE TABLE rooms(id TEXT PRIMARY KEY);\n');
    const unsealed = checkMigrations({
      root: fx.root,
      lockPath: fx.lockPath,
      ledgers: testLedgers,
    });
    assert.equal(unsealed.ok, false);
    assert.equal(unsealed.lockedCount, 3);
    assert.equal(unsealed.pendingCount, 1);
    assert.ok(unsealed.errors.some((e) => /unsealed migration/.test(e)));

    sealMigrations({ root: fx.root, lockPath: fx.lockPath, ledgers: testLedgers });
    const sealed = checkMigrations({ root: fx.root, lockPath: fx.lockPath, ledgers: testLedgers });
    assert.equal(sealed.ok, true, sealed.errors.join('\n'));
    assert.equal(sealed.lockedCount, 4);
    assert.equal(sealed.pendingCount, 0);
  } finally {
    fx.cleanup();
  }
});

test('modifying or deleting a locked migration fails check and refuses seal', () => {
  const fx = createFixture();
  try {
    fx.write(
      'agent-state/migrations/0002_agent.sql',
      'CREATE TABLE agent(id INTEGER PRIMARY KEY, x TEXT);\n',
    );
    const modified = checkMigrations({
      root: fx.root,
      lockPath: fx.lockPath,
      ledgers: testLedgers,
    });
    assert.equal(modified.ok, false);
    assert.match(modified.errors[0], /SHA-384 mismatch/);
    assert.throws(() =>
      sealMigrations({ root: fx.root, lockPath: fx.lockPath, ledgers: testLedgers }),
    );

    unlinkSync(join(fx.root, 'event-log/migrations/0001_runtime.sql'));
    const deleted = checkMigrations({ root: fx.root, lockPath: fx.lockPath, ledgers: testLedgers });
    assert.equal(deleted.ok, false);
    assert.ok(deleted.errors.some((e) => /deleted or moved/.test(e)));
  } finally {
    fx.cleanup();
  }
});

test('duplicate version across shared root ledger and backdated versions are rejected', () => {
  const fx = createFixture();
  try {
    fx.write('event-log/migrations/0003_dup.sql', '-- a\n');
    fx.write('agent-state/migrations/0003_collision.sql', '-- b\n');
    const dup = checkMigrations({ root: fx.root, lockPath: fx.lockPath, ledgers: testLedgers });
    assert.equal(dup.ok, false);
    assert.ok(dup.errors.some((e) => /duplicate migration version 3/.test(e)));

    unlinkSync(join(fx.root, 'event-log/migrations/0003_dup.sql'));
    unlinkSync(join(fx.root, 'agent-state/migrations/0003_collision.sql'));

    fx.write('agent-state/migrations/0005_later.sql', '-- later\n');
    sealMigrations({ root: fx.root, lockPath: fx.lockPath, ledgers: testLedgers });
    fx.write('agent-state/migrations/0004_backdated.sql', '-- backdated\n');
    const backdated = checkMigrations({
      root: fx.root,
      lockPath: fx.lockPath,
      ledgers: testLedgers,
    });
    assert.equal(backdated.ok, false);
    assert.ok(
      backdated.errors.some((e) => /strictly greater than highest locked version v5/.test(e)),
    );
  } finally {
    fx.cleanup();
  }
});
