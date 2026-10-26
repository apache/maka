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
import type { DatabaseSync } from 'node:sqlite';
import {
  IMAGE_ARCHIVE_MAX_BYTES,
  isImageDeliveryRequest,
  IMAGE_DELIVERY_FAILURES,
  type ImageDeliveryIdentity,
  type ImageDeliveryFailure,
} from '@maka/core/image-delivery';
import { isCanonicalArtifactEntityId } from '@maka/core/artifacts';
import { writeImageDeliveryAttempt } from './sqlite-image-delivery.js';

/** Host-authorized capture intent. Payload is a bounded recovery spool, not message history. */
export interface ImageDeliveryJob extends ImageDeliveryIdentity {
  readonly id: string;
  readonly publicationId?: string;
  readonly publicationRunId?: string;
  readonly loadRemote: boolean;
  readonly attempts: number;
  readonly nextAttemptAt: number;
  readonly failure?: ImageDeliveryFailure;
}
export interface StagedImageDeliveryJob {
  readonly job: ImageDeliveryJob;
  readonly bytes?: Uint8Array;
}
export class ImageDeliveryCapacityError extends Error {
  readonly name = 'ImageDeliveryCapacityError';
}
const MAX_JOBS = 512;
const MAX_SPOOL_BYTES = 32 * 1024 * 1024;
const MAX_IMAGE_BYTES = IMAGE_ARCHIVE_MAX_BYTES;

export function createImageDeliveryJobTable(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS image_delivery_jobs (
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL,
    job_json TEXT NOT NULL, next_attempt_at INTEGER NOT NULL,
    failed INTEGER NOT NULL CHECK (failed IN (0, 1)), payload BLOB, payload_sha256 TEXT,
    CHECK (payload IS NULL OR length(payload) <= ${MAX_IMAGE_BYTES})
  );
  CREATE INDEX IF NOT EXISTS image_delivery_jobs_due
    ON image_delivery_jobs(failed, next_attempt_at, id);
  CREATE INDEX IF NOT EXISTS image_delivery_jobs_session ON image_delivery_jobs(session_id);`);
}

export function putImageDeliveryJob(db: DatabaseSync, input: StagedImageDeliveryJob): void {
  const { job, bytes } = input;
  if (
    !isCanonicalArtifactEntityId(job.id) ||
    !isCanonicalArtifactEntityId(job.sessionId) ||
    !isImageDeliveryRequest({ turnId: job.turnId, messageId: job.messageId, source: job.source }) ||
    typeof job.loadRemote !== 'boolean' ||
    (job.failure !== undefined && !IMAGE_DELIVERY_FAILURES.includes(job.failure)) ||
    !Number.isSafeInteger(job.attempts) ||
    job.attempts < 0 ||
    !Number.isSafeInteger(job.nextAttemptAt) ||
    job.nextAttemptAt < 0 ||
    (job.publicationRunId !== undefined &&
      !isImageDeliveryRequest({
        turnId: job.publicationRunId,
        messageId: job.messageId,
        source: job.source,
      })) ||
    (job.publicationId !== undefined && !isCanonicalArtifactEntityId(job.publicationId)) ||
    (bytes !== undefined && (!(bytes instanceof Uint8Array) || bytes.byteLength > MAX_IMAGE_BYTES))
  )
    throw new TypeError('Invalid image delivery job');
  const existing = readImageDeliveryJob(db, job.id);
  if (
    existing &&
    [
      'sessionId',
      'turnId',
      'messageId',
      'source',
      'publicationId',
      'publicationRunId',
      'loadRemote',
    ].some(
      (key) => existing.job[key as keyof ImageDeliveryJob] !== job[key as keyof ImageDeliveryJob],
    )
  )
    throw new Error('Image delivery job identity conflict');
  if (existing?.bytes && bytes && !Buffer.from(existing.bytes).equals(Buffer.from(bytes)))
    throw new Error('Image delivery staged bytes are immutable');
  // Terminal failures without useful bytes only need an attempt record. Invalid
  // bytes must never consume the recovery spool. Quota failures retain validated
  // bytes for manual retry, but are reclaimable under pressure from new work.
  if (job.failure && ((!existing?.bytes && !bytes) || job.failure !== 'quota_exceeded')) {
    writeImageDeliveryAttempt(db, job, { status: 'failed', reason: job.failure });
    db.prepare('DELETE FROM image_delivery_jobs WHERE id = ?').run(job.id);
    return;
  }
  let usage = db
    .prepare(
      'SELECT count(*) AS count, coalesce(sum(length(payload)), 0) AS bytes FROM image_delivery_jobs',
    )
    .get() as { count: number; bytes: number };
  const exceedsCapacity = () =>
    (!existing && usage.count >= MAX_JOBS) ||
    usage.bytes -
      (existing?.bytes?.byteLength ?? 0) +
      (bytes?.byteLength ?? existing?.bytes?.byteLength ?? 0) >
      MAX_SPOOL_BYTES;
  if (exceedsCapacity()) {
    // Keep failure metadata visible, while allowing healthy sessions to make
    // progress. Never evict a pending job or the bytes currently being retried.
    const retired = db
      .prepare(
        'SELECT id, length(payload) AS bytes FROM image_delivery_jobs WHERE failed = 1 AND id != ? ORDER BY rowid',
      )
      .all(job.id) as Array<{ id: string; bytes: number }>;
    for (const entry of retired) {
      if (!exceedsCapacity()) break;
      db.prepare('DELETE FROM image_delivery_jobs WHERE id = ?').run(entry.id);
      usage = { count: usage.count - 1, bytes: usage.bytes - (entry.bytes ?? 0) };
    }
  }
  if (
    (!existing && usage.count >= MAX_JOBS) ||
    usage.bytes -
      (existing?.bytes?.byteLength ?? 0) +
      (bytes?.byteLength ?? existing?.bytes?.byteLength ?? 0) >
      MAX_SPOOL_BYTES
  )
    throw new ImageDeliveryCapacityError('Image reception capacity reached');
  db.prepare(`INSERT INTO image_delivery_jobs VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET job_json = excluded.job_json,
      next_attempt_at = excluded.next_attempt_at, failed = excluded.failed,
      payload = coalesce(image_delivery_jobs.payload, excluded.payload),
      payload_sha256 = coalesce(image_delivery_jobs.payload_sha256, excluded.payload_sha256)`).run(
    job.id,
    job.sessionId,
    JSON.stringify(job),
    job.nextAttemptAt,
    job.failure ? 1 : 0,
    bytes ?? null,
    bytes ? createHash('sha256').update(bytes).digest('hex') : null,
  );
  writeImageDeliveryAttempt(
    db,
    job,
    job.failure ? { status: 'failed', reason: job.failure } : { status: 'pending' },
  );
}

export function readImageDeliveryJob(
  db: DatabaseSync,
  id: string,
): StagedImageDeliveryJob | undefined {
  const row = db
    .prepare('SELECT job_json, payload, payload_sha256 FROM image_delivery_jobs WHERE id = ?')
    .get(id) as
    | { job_json: string; payload: Uint8Array | null; payload_sha256: string | null }
    | undefined;
  if (row?.payload && createHash('sha256').update(row.payload).digest('hex') !== row.payload_sha256)
    throw new Error('Image reception spool checksum mismatch');
  return row
    ? {
        job: JSON.parse(row.job_json) as ImageDeliveryJob,
        ...(row.payload ? { bytes: row.payload } : {}),
      }
    : undefined;
}

export function listImageDeliveryJobs(db: DatabaseSync, now: number): ImageDeliveryJob[] {
  if (!Number.isSafeInteger(now) || now < 0) throw new TypeError('Invalid recovery time');
  return (
    db
      .prepare(`SELECT job_json FROM image_delivery_jobs WHERE failed = 0 AND next_attempt_at <= ?
    ORDER BY next_attempt_at, id LIMIT ${MAX_JOBS}`)
      .all(now) as Array<{ job_json: string }>
  ).map((row) => JSON.parse(row.job_json) as ImageDeliveryJob);
}
