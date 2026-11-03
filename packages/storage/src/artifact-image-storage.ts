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

import type { ArtifactRecord } from '@maka/core/artifacts';
import {
  DEFAULT_IMAGE_ARCHIVE_LIMITS,
  type ImageArchiveLimits,
  type ImageDeliveryMetadata,
} from '@maka/core/image-delivery';

export class ImageArchiveQuotaError extends Error {
  readonly name = 'ImageArchiveQuotaError';
  constructor() {
    super('Image archive quota exceeded');
  }
}

/** Pure policy, evaluated by ArtifactStore while holding its writer lock.
 * Budgets count unique archived content; the store shares payloads with hard links. */
export function planImageArchive(
  records: readonly ArtifactRecord[],
  input: {
    sessionId: string;
    content: string | Uint8Array;
    imageDelivery?: ImageDeliveryMetadata;
    imageArchiveLimits?: ImageArchiveLimits;
  },
) {
  const digest =
    input.imageDelivery?.status === 'ready' ? input.imageDelivery.contentSha256 : undefined;
  const size = Buffer.byteLength(input.content);
  assertImageArchiveQuota(records, { ...input, sizeBytes: size });
  const sameContent = digest
    ? records.find(
        (r) =>
          r.imageDelivery?.status === 'ready' &&
          r.imageDelivery.contentSha256 === digest &&
          r.sizeBytes === size,
      )
    : undefined;
  return { digest, sameContent };
}

/** Checked under the Artifact writer lock before publishing captured or copied images. */
export function assertImageArchiveQuota(
  records: readonly ArtifactRecord[],
  input: {
    sessionId: string;
    sizeBytes: number;
    imageDelivery?: ImageDeliveryMetadata;
    imageArchiveLimits?: ImageArchiveLimits;
  },
): void {
  const digest =
    input.imageDelivery?.status === 'ready' ? input.imageDelivery.contentSha256 : undefined;
  const size = input.sizeBytes;
  const limits = input.imageArchiveLimits ?? DEFAULT_IMAGE_ARCHIVE_LIMITS;
  if (digest) {
    if (
      ![limits.sessionBytes, limits.workspaceBytes].every((v) => Number.isSafeInteger(v) && v >= 0)
    )
      throw new Error('Invalid image archive limits');
    const unique = new Map<string, number>();
    const sessionUnique = new Map<string, number>();
    for (const record of records) {
      const hash = record.imageDelivery?.contentSha256;
      if (record.imageDelivery?.status !== 'ready' || !hash) continue;
      unique.set(hash, record.sizeBytes);
      if (record.sessionId === input.sessionId) sessionUnique.set(hash, record.sizeBytes);
    }
    const sum = (values: Map<string, number>) => [...values.values()].reduce((a, b) => a + b, 0);
    if (
      sum(unique) + (unique.has(digest) ? 0 : size) > limits.workspaceBytes ||
      sum(sessionUnique) + (sessionUnique.has(digest) ? 0 : size) > limits.sessionBytes
    )
      throw new ImageArchiveQuotaError();
  }
}
