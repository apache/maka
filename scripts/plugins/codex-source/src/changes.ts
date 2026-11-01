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

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

export const fingerprint = (v: unknown) =>
  createHash('sha256').update(JSON.stringify(v)).digest('hex');

/** One adapter journal, multiple independent readers. No index coverage is modified. */
export class ChangeJournal {
  private scopeHash: string;
  constructor(
    private db: DatabaseSync,
    scope: unknown,
    private key: string,
  ) {
    this.scopeHash = fingerprint(scope);
    db.exec(`CREATE TABLE IF NOT EXISTS change_seen(scope TEXT,id TEXT,revision TEXT,PRIMARY KEY(scope,id));
      CREATE TABLE IF NOT EXISTS change_events(seq INTEGER PRIMARY KEY AUTOINCREMENT,scope TEXT,payload TEXT);
      CREATE TABLE IF NOT EXISTS change_meta(scope TEXT PRIMARY KEY,token TEXT);`);
  }
  token() {
    return this.db.prepare('SELECT token FROM change_meta WHERE scope=?').get(this.scopeHash)
      ?.token;
  }
  seen(id: string) {
    return this.db
      .prepare('SELECT revision FROM change_seen WHERE scope=? AND id=?')
      .get(this.scopeHash, id)?.revision;
  }
  capture(token: string, changes: any[], revisions: { id: string; revision: string }[]) {
    const initialized = this.token() !== undefined;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const event of changes)
        if (initialized)
          this.db
            .prepare('INSERT INTO change_events(scope,payload) VALUES(?,?)')
            .run(this.scopeHash, JSON.stringify(event));
      for (const o of revisions)
        this.db
          .prepare(
            'INSERT INTO change_seen VALUES(?,?,?) ON CONFLICT(scope,id) DO UPDATE SET revision=excluded.revision',
          )
          .run(this.scopeHash, o.id, o.revision);
      this.db
        .prepare(
          'INSERT INTO change_meta VALUES(?,?) ON CONFLICT(scope) DO UPDATE SET token=excluded.token',
        )
        .run(this.scopeHash, token);
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }
  private sign(body: string) {
    return createHmac('sha256', this.key).update(body).digest('base64url');
  }
  page(cursor: string | undefined, limit: number) {
    let after = Number(
      this.db.prepare('SELECT MAX(seq) n FROM change_events WHERE scope=?').get(this.scopeHash)
        ?.n ?? 0,
    );
    if (cursor) {
      const [body, mac, extra] = cursor.split('.'),
        expected = this.sign(body ?? '');
      if (
        !mac ||
        extra ||
        mac.length !== expected.length ||
        !timingSafeEqual(Buffer.from(mac), Buffer.from(expected))
      )
        throw Error('Invalid source changes cursor');
      const value = JSON.parse(Buffer.from(body, 'base64url').toString());
      if (value.scope !== this.scopeHash || !Number.isSafeInteger(value.after) || value.after < 0)
        throw Error('Source changes scope changed');
      after = value.after;
    }
    const rows = this.db
      .prepare('SELECT seq,payload FROM change_events WHERE scope=? AND seq>? ORDER BY seq LIMIT ?')
      .all(this.scopeHash, after, limit + 1);
    const page = cursor ? rows.slice(0, limit) : [];
    if (page.length) after = Number(page.at(-1)!.seq);
    const body = Buffer.from(JSON.stringify({ scope: this.scopeHash, after })).toString(
      'base64url',
    );
    return {
      items: page.map((r) => JSON.parse(String(r.payload))),
      cursor: body + '.' + this.sign(body),
      more: !!cursor && rows.length > limit,
    };
  }
}
