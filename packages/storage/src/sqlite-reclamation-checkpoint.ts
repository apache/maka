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

import type { DatabaseSync } from 'node:sqlite';

/** Retains an unfinished reclamation checkpoint across idle maintenance ticks. */
export class SqliteReclamationCheckpoint {
  #pending = false;

  run(database: DatabaseSync, reclaimedPages: number): void {
    if (reclaimedPages > 0) this.#pending = true;
    if (!this.#pending) return;
    // Call outside transactions. PASSIVE never waits for a reader or writer;
    // completion affects the next idle tick, not the maintenance lane's hasMore.
    const row = database.prepare('PRAGMA wal_checkpoint(PASSIVE)').get();
    if (
      typeof row?.busy !== 'number' ||
      typeof row.log !== 'number' ||
      typeof row.checkpointed !== 'number'
    ) {
      throw new Error('Invalid SQLite wal_checkpoint result');
    }
    this.#pending = row.busy !== 0 || row.checkpointed < row.log;
  }
}
