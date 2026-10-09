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

import { DatabaseSync } from 'node:sqlite';
import { cpSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

const MiB = 1024 * 1024;
const sizes = (process.argv.slice(2).length ? process.argv.slice(2) : ['100', '1024', '3072']).map(
  Number,
);
const root = mkdtempSync(join(tmpdir(), 'maka-vacuum-bench-'));

try {
  for (const targetMiB of sizes) {
    const source = join(root, `runtime-${targetMiB}.sqlite`);
    const db = new DatabaseSync(source);
    db.exec('PRAGMA page_size=4096; PRAGMA auto_vacuum=NONE; PRAGMA journal_mode=WAL;');
    db.exec('CREATE TABLE runtime_events (event_id INTEGER PRIMARY KEY, event_json BLOB NOT NULL)');
    const insert = db.prepare('INSERT INTO runtime_events(event_json) VALUES (?)');
    const payload = Buffer.alloc(32 * 1024);
    for (let i = 0; i < payload.length; i += 1) payload[i] = (i * 37 + 19) & 0xff;
    const started = performance.now();
    db.exec('BEGIN');
    let inserted = 0;
    while (inserted * payload.length < targetMiB * MiB) {
      insert.run(payload);
      inserted += 1;
    }
    db.exec('COMMIT');
    const populatedMs = performance.now() - started;
    const before = statSync(source).size;

    // Leave realistic free pages for the one-time conversion to incremental vacuum.
    db.exec('DELETE FROM runtime_events WHERE event_id % 3 = 0');
    db.close();
    const copy = join(root, `runtime-${targetMiB}-conversion.sqlite`);
    cpSync(source, copy);
    const conversion = new DatabaseSync(copy);
    conversion.exec('PRAGMA busy_timeout=5000; PRAGMA auto_vacuum=INCREMENTAL;');

    const vacuumStart = performance.now();
    conversion.exec('VACUUM');
    const vacuumMs = performance.now() - vacuumStart;
    conversion.close();
    console.log(
      JSON.stringify({
        platform: `${process.platform}-${process.arch}`,
        node: process.version,
        sqlite: process.versions.sqlite,
        targetMiB,
        sourceBytesBeforeDelete: before,
        insertedRows: inserted,
        populationMs: Math.round(populatedMs),
        conversionVacuumMs: Math.round(vacuumMs),
      }),
    );
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}
