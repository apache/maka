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

// Synthetic local SQLite workload. No user profile, provider or live model is used.
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { parseArgs } from 'node:util';
import { Notebook } from '../dist/assistant/index-initiative/notebook.js';

const { values } = parseArgs({ options: { entries: { type: 'string', default: '100000' } } });
const count = Number(values.entries);
if (!Number.isSafeInteger(count) || count < 100 || count > 1000000)
  throw Error('--entries must be between 100 and 1000000');
const root = mkdtempSync(join(tmpdir(), 'maka-discovery-memory-bench-'));
let book;
const round = (n) => Math.round(n * 100) / 100;
try {
  const file = join(root, 'notebook.sqlite');
  book = new Notebook(file);
  const start = performance.now();
  for (let base = 0; base < count; base += 1000) {
    book.transaction(() => {
      for (let i = base; i < Math.min(base + 1000, count); i++) {
        // Half the knowledge belongs to one hot topic; the rest spans 1,000 topics.
        const topicId = i % 2 ? `topic-${i % 2000}` : 'hot-topic';
        book.appendNote(
          {
            topicId,
            title: topicId,
            text: `合成观察 ${i}：等待验证版本与当前结果。`,
            kind: 'observation',
            occurredAt: null,
            sources: [`synthetic:${i}`],
            tags: [],
          },
          `synthetic-${i}`,
        );
      }
    });
  }
  const writeMs = performance.now() - start;
  const reads = [];
  let maxPageBytes = 0;
  let page;
  for (let i = 0; i < 100; i++) {
    const start = performance.now();
    page = book.readMemory({
      view: 'topic',
      topicId: 'hot-topic',
      limit: 20,
      ...(page?.nextCursor ? { cursor: page.nextCursor } : {}),
    });
    reads.push(performance.now() - start);
    maxPageBytes = Math.max(maxPageBytes, Buffer.byteLength(JSON.stringify(page)));
  }
  if (maxPageBytes >= 7500) throw Error('Read page exceeds the runtime archival threshold');
  const before = book.memory.current('synthetic-0');
  const startRebuild = performance.now();
  book.memory.rebuild();
  const rebuildMs = performance.now() - startRebuild;
  if (JSON.stringify(book.memory.current('synthetic-0')) !== JSON.stringify(before))
    throw Error('Rebuild changed the current entry');
  book.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  const databaseBytes = statSync(file).size;
  book.close();
  book = undefined;
  const startOpen = performance.now();
  book = new Notebook(file);
  const reopenMs = performance.now() - startOpen;
  reads.sort((a, b) => a - b);
  console.log(
    JSON.stringify(
      {
        entries: count,
        hotTopicEntries: Math.ceil(count / 2),
        writeMs: round(writeMs),
        readP50Ms: round(reads[49]),
        readP95Ms: round(reads[94]),
        maxPageBytes,
        rebuildMs: round(rebuildMs),
        reopenMs: round(reopenMs),
        databaseBytes,
        note: 'Synthetic persistence/read measurements; not a model-quality or notification-value evaluation.',
      },
      null,
      2,
    ),
  );
} finally {
  book?.close();
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}
