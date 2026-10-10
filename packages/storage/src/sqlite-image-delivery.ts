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
import type { ImageDeliveryIdentity, ImageDeliveryAttempt } from '@maka/core/image-delivery';
import { isImageDeliveryMetadata, IMAGE_DELIVERY_FAILURES } from '@maka/core/image-delivery';
import { decodeArtifactRecordJsons } from './artifact-metadata-codec.js';

/** Shares the Artifact writer's transaction and lock; no payload files for attempts. */
export function migrateImageDeliveryAttempts(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS image_delivery_attempts (
    session_id TEXT NOT NULL, turn_id TEXT NOT NULL, message_id TEXT NOT NULL,
    source TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('pending', 'failed')),
    reason TEXT, created_at INTEGER NOT NULL CHECK (created_at >= 0),
    CHECK ((status = 'pending' AND reason IS NULL) OR (status = 'failed' AND reason IS NOT NULL)),
    PRIMARY KEY (session_id, turn_id, message_id, source)
  )`);
  const rows = db
    .prepare(`SELECT record_json FROM artifact_records
    WHERE json_valid(record_json) AND json_extract(record_json, '$.imageDelivery.status') IN ('pending', 'failed')
    ORDER BY CASE json_extract(record_json, '$.imageDelivery.status') WHEN 'pending' THEN 1 ELSE 0 END,
      created_at DESC, artifact_id DESC`)
    .all() as { record_json: string }[];
  for (const record of decodeArtifactRecordJsons(rows.map((row) => row.record_json))) {
    const metadata = record.imageDelivery!;
    const identity = { sessionId: record.sessionId, turnId: record.turnId, ...metadata };
    // An interrupted older capture can leave both a pending and a terminal row.
    if (!readImageDeliveryAttempt(db, identity)) {
      writeImageDeliveryAttempt(db, identity, metadata as ImageDeliveryAttempt, record.createdAt);
    }
    db.prepare('INSERT OR IGNORE INTO artifact_upgrade_orphan_paths VALUES (?)').run(
      record.relativePath,
    );
    db.prepare('DELETE FROM artifact_records WHERE artifact_id = ?').run(record.id);
  }
}

export function readImageDeliveryAttempt(
  db: DatabaseSync,
  identity: ImageDeliveryIdentity,
): ImageDeliveryAttempt | undefined {
  const row = db
    .prepare(`SELECT status, reason FROM image_delivery_attempts
    WHERE session_id = ? AND turn_id = ? AND message_id = ? AND source = ?`)
    .get(...identityValues(identity)) as { status: string; reason: unknown } | undefined;
  return row ? decodeAttempt(row) : undefined;
}

function decodeAttempt(row: { status: string; reason: unknown }): ImageDeliveryAttempt {
  if (row.status === 'pending' && row.reason === null) return { status: 'pending' };
  if (row.status === 'failed' && IMAGE_DELIVERY_FAILURES.includes(row.reason as never))
    return {
      status: 'failed',
      reason: row.reason as Extract<ImageDeliveryAttempt, { status: 'failed' }>['reason'],
    };
  throw new Error('Invalid image delivery attempt');
}

export function writeImageDeliveryAttempt(
  db: DatabaseSync,
  identity: ImageDeliveryIdentity,
  attempt: ImageDeliveryAttempt,
  now = Date.now(),
): void {
  if (
    !isImageDeliveryMetadata({
      messageId: identity.messageId,
      source: identity.source,
      ...attempt,
    }) ||
    (attempt.status !== 'pending' && attempt.status !== 'failed')
  )
    throw new Error('Invalid image delivery attempt');
  db.prepare(`INSERT INTO image_delivery_attempts VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(session_id, turn_id, message_id, source) DO UPDATE SET status = excluded.status, reason = excluded.reason`).run(
    ...identityValues(identity),
    attempt.status,
    attempt.status === 'failed' ? attempt.reason : null,
    now,
  );
}

export function removeImageDeliveryAttempt(
  db: DatabaseSync,
  identity: ImageDeliveryIdentity,
): void {
  db.prepare(
    'DELETE FROM image_delivery_attempts WHERE session_id = ? AND turn_id = ? AND message_id = ? AND source = ?',
  ).run(...identityValues(identity));
}

export interface StoredImageDeliveryAttempt {
  readonly identity: ImageDeliveryIdentity;
  readonly attempt: ImageDeliveryAttempt;
  readonly createdAt: number;
}

export function readImageDeliveryAttempts(
  db: DatabaseSync,
  sessionId: string,
  turnIds: readonly string[],
): StoredImageDeliveryAttempt[] {
  const query = db.prepare(
    'SELECT message_id, source, status, reason, created_at FROM image_delivery_attempts WHERE session_id = ? AND turn_id = ?',
  );
  return turnIds.flatMap((turnId) =>
    (
      query.all(sessionId, turnId) as {
        message_id: string;
        source: string;
        status: string;
        reason: unknown;
        created_at: number;
      }[]
    ).map((row) => {
      const identity = { sessionId, turnId, messageId: row.message_id, source: row.source };
      return {
        identity,
        attempt: decodeAttempt(row),
        createdAt: row.created_at,
      };
    }),
  );
}

function identityValues(identity: ImageDeliveryIdentity): [string, string, string, string] {
  return [identity.sessionId, identity.turnId, identity.messageId, identity.source];
}
