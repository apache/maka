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
import { mkdir, chmod } from 'node:fs/promises';
import { dirname } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { MessageContent } from '@maka/core/events';

export class WorkHubInboxConflict extends Error {}

export interface WorkHubInboxMessage {
  id: string;
  input: unknown;
  content: MessageContent;
}

/** Durable ingress only. Execution and task ownership stay in the native runtime. */
export class WorkHubInbox {
  private serial: Promise<unknown> = Promise.resolve();
  constructor(private readonly path: string) {}
  private run<T>(work: (db: DatabaseSync) => T): Promise<T> {
    const result = this.serial
      .catch(() => {})
      .then(async () => {
        await mkdir(dirname(this.path), { recursive: true });
        const db = new DatabaseSync(this.path);
        try {
          await chmod(this.path, 0o600);
          db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
          CREATE TABLE IF NOT EXISTS inbox (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL,
            input TEXT NOT NULL, content TEXT NOT NULL, delivered INTEGER NOT NULL DEFAULT 0, receipt TEXT, error TEXT);
          BEGIN IMMEDIATE;`);
          const value = work(db);
          db.exec('COMMIT');
          return value;
        } catch (error) {
          try {
            db.exec('ROLLBACK');
          } catch {}
          throw error;
        } finally {
          db.close();
        }
      });
    this.serial = result;
    return result;
  }
  receive(message: WorkHubInboxMessage): Promise<void> {
    return this.run((db) => {
      const previous = db.prepare('SELECT input FROM inbox WHERE id=?').get(message.id);
      if (previous) {
        if (!isDeepStrictEqual(JSON.parse(String(previous.input)), message.input))
          throw new WorkHubInboxConflict('WorkHub message identity belongs to different input');
        return;
      }
      db.prepare('INSERT INTO inbox(id,input,content) VALUES(?,?,?)').run(
        message.id,
        JSON.stringify(message.input),
        JSON.stringify(message.content),
      );
    });
  }
  read(
    id: string,
  ): Promise<(WorkHubInboxMessage & { receipt?: { turnId: string; queued?: true } }) | undefined> {
    return this.run((db) => {
      const row = db.prepare('SELECT * FROM inbox WHERE id=?').get(id);
      return row
        ? {
            id,
            input: JSON.parse(String(row.input)),
            content: JSON.parse(String(row.content)),
            ...(row.receipt ? { receipt: JSON.parse(String(row.receipt)) } : {}),
          }
        : undefined;
    });
  }
  pending(): Promise<WorkHubInboxMessage[]> {
    return this.run((db) =>
      db
        .prepare('SELECT * FROM inbox WHERE delivered=0 ORDER BY seq')
        .all()
        .map((row) => ({
          id: String(row.id),
          input: JSON.parse(String(row.input)),
          content: JSON.parse(String(row.content)),
        })),
    );
  }
  delivered(id: string, receipt: { turnId: string; queued?: true }): Promise<void> {
    return this.run((db) => {
      db.prepare('UPDATE inbox SET delivered=1,receipt=?,error=NULL WHERE id=?').run(
        JSON.stringify(receipt),
        id,
      );
    });
  }
  failed(id: string, error: string): Promise<void> {
    return this.run((db) => {
      db.prepare('UPDATE inbox SET error=? WHERE id=?').run(error, id);
    });
  }
}
