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

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
export const defaultLockFile = 'scripts/rust/migrations.lock.json';

/**
 * Each ledger shares one SQLite `_sqlx_migrations` version namespace.
 * `platform/event-log` root migrations and `plugins/agent/state` migrations
 * share the RootStore database, so version uniqueness spans both directories.
 */
export const defaultLedgers = {
  root: ['platform/event-log/migrations', 'plugins/agent/state/migrations'],
  'checkpoint-repository': ['platform/event-log/migrations/repository'],
  settings: ['plugins/settings/store/migrations'],
  deployment: ['products/maka/cli/migrations/deployment'],
};

const migrationNamePattern = /^(\d+)_.+\.sql$/;

export function sha384Hex(bytes) {
  return createHash('sha384').update(bytes).digest('hex');
}

export function discoverMigrations(root, ledgers = defaultLedgers) {
  const discovered = {};
  const errors = [];
  for (const [ledger, dirs] of Object.entries(ledgers)) {
    const entries = new Map();
    const byVersion = new Map();
    for (const dir of dirs) {
      const fullDir = join(root, dir);
      if (!existsSync(fullDir)) continue;
      for (const entry of readdirSync(fullDir, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith('.sql')) continue;
        const relPath = posix.join(dir, entry.name);
        const match = migrationNamePattern.exec(entry.name);
        if (!match) {
          errors.push(
            `[${ledger}] malformed migration filename (expected NNNN_name.sql): ${relPath}`,
          );
          continue;
        }
        const version = Number.parseInt(match[1], 10);
        if (!Number.isSafeInteger(version) || version <= 0) {
          errors.push(`[${ledger}] invalid migration version in ${relPath}`);
          continue;
        }
        if (byVersion.has(version)) {
          errors.push(
            `[${ledger}] duplicate migration version ${version}: ${byVersion.get(version)} and ${relPath}`,
          );
          continue;
        }
        byVersion.set(version, relPath);
        const sha384 = sha384Hex(readFileSync(join(fullDir, entry.name)));
        entries.set(relPath, { version, sha384 });
      }
    }
    discovered[ledger] = Object.fromEntries(
      [...entries.entries()].sort(([a], [b]) => a.localeCompare(b)),
    );
  }
  return { discovered, errors };
}

export function checkMigrations({
  root = repoRoot,
  lockPath = join(root, defaultLockFile),
  ledgers = defaultLedgers,
} = {}) {
  const { discovered, errors } = discoverMigrations(root, ledgers);
  if (!existsSync(lockPath)) {
    errors.push(
      `Missing migration lock file: ${lockPath}. Run \`node scripts/rust/migration-lock.mjs seal\`.`,
    );
    return { ok: false, errors, discovered, lockedCount: 0, pendingCount: 0 };
  }
  const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
  if (lock?.formatVersion !== 1 || typeof lock.ledgers !== 'object' || lock.ledgers === null) {
    errors.push(`Invalid migration lock format in ${lockPath}`);
    return { ok: false, errors, discovered, lockedCount: 0, pendingCount: 0 };
  }

  let lockedCount = 0;
  let pendingCount = 0;
  for (const [ledger, lockedEntries] of Object.entries(lock.ledgers)) {
    if (!(ledger in discovered)) {
      errors.push(`Unknown locked migration ledger: ${ledger}`);
      continue;
    }
    const currentEntries = discovered[ledger];
    let maxLockedVersion = 0;
    for (const [relPath, expected] of Object.entries(lockedEntries)) {
      lockedCount += 1;
      if (expected.version > maxLockedVersion) maxLockedVersion = expected.version;
      const actual = currentEntries[relPath];
      if (!actual) {
        errors.push(
          `[${ledger}] locked migration was deleted or moved: ${relPath} (append a new migration instead)`,
        );
        continue;
      }
      if (actual.version !== expected.version) {
        errors.push(
          `[${ledger}] locked migration version changed for ${relPath}: expected ${expected.version}, got ${actual.version}`,
        );
      }
      if (actual.sha384 !== expected.sha384) {
        errors.push(
          `[${ledger}] locked migration was modified: ${relPath} (SHA-384 mismatch; existing databases reject checksum changes — append a new higher-numbered migration instead)`,
        );
      }
    }
    for (const [relPath, actual] of Object.entries(currentEntries)) {
      if (relPath in lockedEntries) continue;
      pendingCount += 1;
      if (actual.version <= maxLockedVersion) {
        errors.push(
          `[${ledger}] new migration ${relPath} (v${actual.version}) must use a version strictly greater than highest locked version v${maxLockedVersion}`,
        );
      }
    }
  }
  for (const ledger of Object.keys(discovered)) {
    if (!(ledger in lock.ledgers)) {
      pendingCount += Object.keys(discovered[ledger]).length;
    }
  }
  return { ok: errors.length === 0, errors, discovered, lockedCount, pendingCount };
}

export function sealMigrations({
  root = repoRoot,
  lockPath = join(root, defaultLockFile),
  ledgers = defaultLedgers,
} = {}) {
  if (existsSync(lockPath)) {
    const existing = checkMigrations({ root, lockPath, ledgers });
    if (!existing.ok) {
      throw new Error(
        `Refusing to seal over invalid migration history:\n${existing.errors.join('\n')}`,
      );
    }
  }
  const { discovered, errors } = discoverMigrations(root, ledgers);
  if (errors.length) {
    throw new Error(`Cannot seal invalid migrations:\n${errors.join('\n')}`);
  }
  const lock = {
    formatVersion: 1,
    ledgers: discovered,
  };
  writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`, 'utf8');
  return lock;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [command] = process.argv.slice(2);
  if (command === 'check') {
    const result = checkMigrations();
    if (!result.ok) {
      for (const error of result.errors) console.error(error);
      process.exit(1);
    }
    console.log(
      `migrations ok (${result.lockedCount} locked, ${result.pendingCount} pending forward migration(s))`,
    );
  } else if (command === 'seal') {
    const lock = sealMigrations();
    const total = Object.values(lock.ledgers).reduce(
      (sum, entries) => sum + Object.keys(entries).length,
      0,
    );
    console.log(`Sealed ${total} migrations into ${defaultLockFile}`);
  } else {
    console.error('Usage: migration-lock.mjs check|seal');
    process.exit(2);
  }
}
