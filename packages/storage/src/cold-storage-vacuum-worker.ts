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
import { performance } from 'node:perf_hooks';
import { parentPort, workerData } from 'node:worker_threads';

const db = new DatabaseSync(workerData.databasePath);
let busy = false;
let rebuildMs = 0;
let verificationMs = 0;
let auxiliaryThreads = 0;
let failure: { message: string; code?: string; errcode?: number } | undefined;
const mode = () => {
  const value = db.prepare('PRAGMA auto_vacuum').get()?.auto_vacuum;
  if (value !== 0 && value !== 1 && value !== 2) throw new Error('Invalid SQLite auto-vacuum mode');
  return value;
};
const autoVacuumModeBefore = mode();
let autoVacuumModeAfter = autoVacuumModeBefore;
try {
  db.exec('PRAGMA busy_timeout = 0');
  db.exec('PRAGMA synchronous = FULL');
  db.exec(`PRAGMA threads = ${workerData.auxiliaryThreads ?? 0}`);
  auxiliaryThreads = Number(db.prepare('PRAGMA threads').get()?.threads ?? 0);
  // An already-converted database needs no rewrite or extra disk reservation.
  if (!workerData.enableIncrementalVacuum || autoVacuumModeBefore !== 2) {
    const checkpoint = db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
    if (checkpoint?.busy !== 0) busy = true;
    else {
      if (workerData.enableIncrementalVacuum) db.exec('PRAGMA auto_vacuum = INCREMENTAL');
      if (!workerData.enableIncrementalVacuum || autoVacuumModeBefore === 0) {
        parentPort!.postMessage({ phase: 'rebuilding' });
        const started = performance.now();
        db.exec('VACUUM');
        rebuildMs = performance.now() - started;
      }
      busy = db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get()?.busy !== 0;
    }
  }
  autoVacuumModeAfter = mode();
  if (!busy && workerData.enableIncrementalVacuum && autoVacuumModeAfter !== 2)
    throw new Error('SQLite did not enable incremental auto-vacuum');
  if (!busy) {
    parentPort!.postMessage({ phase: 'verifying' });
    const started = performance.now();
    const integrity = db.prepare('PRAGMA integrity_check').all();
    verificationMs = performance.now() - started;
    if (integrity.length !== 1 || integrity[0]?.integrity_check !== 'ok')
      throw Object.assign(new Error('SQLite integrity check failed after storage conversion'), {
        code: 'SQLITE_CORRUPT',
      });
  }
} catch (error) {
  if (error instanceof Error && (error as Error & { errcode?: number }).errcode === 5) busy = true;
  else {
    const native = error as { code?: string; errcode?: number };
    failure = {
      message: error instanceof Error ? error.message : 'SQLite storage conversion failed',
      ...(typeof native.code === 'string' ? { code: native.code } : {}),
      ...(typeof native.errcode === 'number' ? { errcode: native.errcode } : {}),
    };
  }
} finally {
  db.close();
}
parentPort!.postMessage(
  failure
    ? { error: failure }
    : {
        busy,
        autoVacuumModeBefore,
        autoVacuumModeAfter,
        auxiliaryThreads,
        rebuildMs,
        verificationMs,
      },
);
parentPort!.close();
