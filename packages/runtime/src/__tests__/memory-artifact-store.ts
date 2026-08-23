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

import { Buffer } from 'node:buffer';
import type { ArtifactRecord } from '@maka/core/artifacts';
import type { HistoryCompactArtifactStore } from '../history-compact-artifacts.js';

// Shared in-memory HistoryCompactArtifactStore for tests. Not a test file
// itself (no .test. suffix), so the runner glob skips it.
export function memoryArtifactStore(): HistoryCompactArtifactStore {
  const records = new Map<string, { record: ArtifactRecord; content: string }>();
  return {
    async create(input) {
      const id = input.id ?? `artifact-${records.size + 1}`;
      const record: ArtifactRecord = {
        id,
        sessionId: input.sessionId,
        turnId: input.turnId,
        createdAt: input.now ?? 0,
        name: input.name,
        kind: input.kind,
        relativePath: input.name,
        sizeBytes: Buffer.byteLength(input.content, 'utf8'),
        mimeType: input.mimeType,
        source: input.source,
        summary: input.summary,
        status: 'live',
      };
      records.set(id, { record, content: input.content });
      return record;
    },
    async delete(artifactId) {
      const entry = records.get(artifactId);
      if (entry) entry.record.status = 'deleted';
    },
    async purge(artifactIds) {
      for (const artifactId of artifactIds) records.delete(artifactId);
    },
    async list() {
      return [...records.values()].map((entry) => entry.record);
    },
    async readText(artifactId) {
      const entry = records.get(artifactId);
      if (!entry) return { ok: false, reason: 'not_found' };
      return { ok: true, text: entry.content };
    },
  };
}
