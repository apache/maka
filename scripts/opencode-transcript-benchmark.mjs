#!/usr/bin/env node
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

/**
 * Measures the OpenCode import bounds against a real database.
 *
 * `OPENCODE_TRANSCRIPT_MAX_RAW_BYTES` and `OPENCODE_TRANSCRIPT_MAX_ROWS` refuse
 * a Session rather than convert it, so they have to be chosen from what a
 * conversion actually costs rather than from a round number. This script
 * reports the two things that decision needs:
 *
 *   - the counting convention, measured on a real source: one `message` row and
 *     one `part` row each count as a row, and `raw_bytes` is the sum of the id,
 *     foreign key and `data` columns the preflight reads;
 *   - a conversion's elapsed time and peak resident memory at a chosen size.
 *
 * A development machine usually holds only a few small sessions, so `--scale`
 * replicates the largest real transcript into a temporary database until it
 * reaches a target row or byte count. The replicated rows are the source's own,
 * so bytes-per-row and the conversion path stay realistic.
 *
 * Usage:
 *   node scripts/opencode-transcript-benchmark.mjs
 *   node scripts/opencode-transcript-benchmark.mjs --db ~/.local/share/opencode/opencode.db
 *   node scripts/opencode-transcript-benchmark.mjs --scale 250000
 *   node scripts/opencode-transcript-benchmark.mjs --scale-bytes 67108864
 *   node scripts/opencode-transcript-benchmark.mjs --json
 *
 * Requires a built workspace (`npm run build`): the conversion under
 * measurement is the adapter itself.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  OPENCODE_TRANSCRIPT_MAX_RAW_BYTES,
  OPENCODE_TRANSCRIPT_MAX_ROWS,
  OpenCodeSessionAdapter,
} from '../packages/storage/dist/opencode-session-adapter.js';

/** The preflight's own formula, so the report and the guard cannot disagree. */
const COUNT_SQL = `
  SELECT count(*) AS rows, coalesce(sum(raw_bytes), 0) AS raw_bytes
    FROM (
      SELECT length(CAST(id AS BLOB)) + length(CAST(data AS BLOB)) AS raw_bytes
        FROM message
       WHERE session_id = ?
      UNION ALL
      SELECT length(CAST(id AS BLOB)) + length(CAST(message_id AS BLOB)) + length(CAST(data AS BLOB)) AS raw_bytes
        FROM part
       WHERE session_id = ?
    )`;

const options = parseArguments(process.argv.slice(2));
const databasePath = options.db ?? join(homedir(), '.local', 'share', 'opencode', 'opencode.db');
const report = { databasePath, sessions: [], scaled: undefined };

const source = new DatabaseSync(databasePath, { readOnly: true });
try {
  for (const { id } of source.prepare('SELECT id FROM session ORDER BY id').all()) {
    const stats = countSession(source, id);
    report.sessions.push({ id, rows: stats.rows, rawBytes: stats.rawBytes });
  }
} finally {
  source.close();
}

const adapter = new OpenCodeSessionAdapter({ opencodeHome: dirname(databasePath) });
for (const session of report.sessions) {
  session.measurement = await measureSession(adapter, session.id);
}

if (options.scale !== undefined || options.scaleBytes !== undefined) {
  report.scaled = await measureScaledSource(databasePath, options);
}

if (options.json) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else {
  printReport(report);
}

/**
 * Reads one Session the way an import does, and reports the process's peak
 * resident memory across the read.
 *
 * The peak is what an import has to fit in, so a start/end pair would answer
 * the wrong question — a conversion allocates and releases before it returns,
 * and the allocation is one synchronous block, so a sampler never gets to run
 * while it happens. `resourceUsage().maxRSS` is the kernel's own high-water
 * mark and survives that.
 */
async function measureSession(target, sessionId) {
  const beforePeak = currentPeakRss();
  const startedAt = process.hrtime.bigint();
  let outcome;
  try {
    const session = await target.readSession(sessionId);
    outcome = { messages: session.messages.length };
  } catch (error) {
    outcome = { error: error instanceof Error ? error.message : String(error) };
  }
  const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
  return {
    elapsedMs,
    peakRssBytes: currentPeakRss(),
    peakGrowthBytes: currentPeakRss() - beforePeak,
    ...outcome,
  };
}

/**
 * `resourceUsage().maxRSS` is bytes on darwin and kibibytes elsewhere, and the
 * kernel's high-water mark is never below the current set — which is what tells
 * the two apart.
 */
function currentPeakRss() {
  const maxRss = process.resourceUsage().maxRSS;
  return maxRss >= process.memoryUsage().rss ? maxRss : maxRss * 1024;
}

/**
 * Replicates the largest real transcript into a temporary database until it
 * reaches the requested size, then measures a conversion of it.
 *
 * The adapter's own limits are lifted for the measurement: the question is what
 * the size costs, and the default would refuse the very size being priced.
 */
async function measureScaledSource(realDatabasePath, settings) {
  const directory = await mkdtemp(join(tmpdir(), 'maka-opencode-benchmark-'));
  const scaledPath = join(directory, 'opencode.db');
  try {
    const real = new DatabaseSync(realDatabasePath, { readOnly: true });
    const scaled = new DatabaseSync(scaledPath);
    try {
      scaled.exec(`
        CREATE TABLE session (id TEXT PRIMARY KEY, title TEXT, directory TEXT, parent_id TEXT,
          time_created INTEGER, time_updated INTEGER, time_archived INTEGER);
        CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT);
        CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT);
      `);
      const largest = listSessions(real).at(-1);
      const rows = real
        .prepare('SELECT id, time_created, data FROM message WHERE session_id = ?')
        .all(largest.id);
      const parts = real
        .prepare('SELECT id, message_id, time_created, data FROM part WHERE session_id = ?')
        .all(largest.id);
      const perCopy = largest.rows;
      const copies = Math.max(
        1,
        Math.ceil(
          Math.min(
            (settings.scale ?? Number.POSITIVE_INFINITY) / Math.max(perCopy, 1),
            (settings.scaleBytes ?? Number.POSITIVE_INFINITY) / Math.max(largest.rawBytes, 1),
          ),
        ),
      );

      const sessionId = 'benchmark-scaled';
      scaled
        .prepare(
          'INSERT INTO session (id, title, directory, parent_id, time_created) VALUES (?, ?, ?, NULL, 0)',
        )
        .run(sessionId, 'Scaled transcript', '/benchmark');
      const insertMessage = scaled.prepare(
        'INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)',
      );
      const insertPart = scaled.prepare(
        'INSERT INTO part (id, message_id, session_id, time_created, data) VALUES (?, ?, ?, ?, ?)',
      );
      scaled.exec('BEGIN');
      for (let copy = 0; copy < copies; copy += 1) {
        const offset = copy * 1_000_000_000;
        for (const row of rows) {
          insertMessage.run(`${row.id}#${copy}`, sessionId, offset + row.time_created, row.data);
        }
        for (const part of parts) {
          insertPart.run(
            `${part.id}#${copy}`,
            `${part.message_id}#${copy}`,
            sessionId,
            offset + part.time_created,
            part.data,
          );
        }
      }
      scaled.exec('COMMIT');

      const stats = countSession(scaled, sessionId);
      const unbounded = new OpenCodeSessionAdapter({
        opencodeHome: directory,
        maxRawBytes: Number.MAX_SAFE_INTEGER,
        maxRows: Number.MAX_SAFE_INTEGER,
      });
      return {
        copies,
        rows: stats.rows,
        rawBytes: stats.rawBytes,
        measurement: await measureSession(unbounded, sessionId),
      };
    } finally {
      scaled.close();
      real.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function countSession(db, sessionId) {
  const stats = db.prepare(COUNT_SQL).get(sessionId, sessionId);
  return { rows: stats.rows, rawBytes: stats.raw_bytes };
}

function listSessions(db) {
  return db
    .prepare('SELECT id FROM session')
    .all()
    .map(({ id }) => ({ id, ...countSession(db, id) }))
    .sort((left, right) => left.rows - right.rows);
}

function parseArguments(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--json') parsed.json = true;
    else if (argument === '--db') parsed.db = argv[++index];
    else if (argument === '--scale') parsed.scale = Number(argv[++index]);
    else if (argument === '--scale-bytes') parsed.scaleBytes = Number(argv[++index]);
    else throw new Error(`Unknown argument: ${argument}`);
  }
  return parsed;
}

function printReport(value) {
  const largest = value.sessions.reduce(
    (best, session) => (best === undefined || session.rows > best.rows ? session : best),
    undefined,
  );
  process.stdout.write(`source: ${value.databasePath}\n`);
  process.stdout.write(`sessions: ${value.sessions.length}\n\n`);
  for (const session of value.sessions) {
    const measured = session.measurement;
    process.stdout.write(
      `  ${session.id}  rows=${session.rows} raw=${formatBytes(session.rawBytes)}` +
        `  elapsed=${measured.elapsedMs.toFixed(1)}ms` +
        `  peakRss=${formatBytes(measured.peakRssBytes)}` +
        ` (+${formatBytes(measured.peakGrowthBytes)})` +
        `${measured.error ? `  REFUSED: ${measured.error}` : ''}\n`,
    );
  }
  if (largest) {
    const bytesPerRow = largest.rawBytes / Math.max(largest.rows, 1);
    process.stdout.write(
      `\nlargest real session: ${largest.rows} rows, ${formatBytes(largest.rawBytes)}` +
        ` (${bytesPerRow.toFixed(0)} bytes/row)\n`,
    );
    process.stdout.write(
      `current caps: ${OPENCODE_TRANSCRIPT_MAX_ROWS} rows / ` +
        `${formatBytes(OPENCODE_TRANSCRIPT_MAX_RAW_BYTES)}\n`,
    );
    process.stdout.write(
      `at the real corpus's bytes/row the row cap implies ` +
        `${formatBytes(OPENCODE_TRANSCRIPT_MAX_ROWS * bytesPerRow)}, and the byte cap is reached at ` +
        `${Math.round(OPENCODE_TRANSCRIPT_MAX_RAW_BYTES / bytesPerRow)} rows\n`,
    );
  }
  if (value.scaled) {
    const measured = value.scaled.measurement;
    process.stdout.write(
      `\nscaled (${value.scaled.copies}x the largest): rows=${value.scaled.rows}` +
        ` raw=${formatBytes(value.scaled.rawBytes)}` +
        ` elapsed=${measured.elapsedMs.toFixed(1)}ms` +
        ` peakRss=${formatBytes(measured.peakRssBytes)}` +
        ` (+${formatBytes(measured.peakGrowthBytes)})` +
        ` messages=${measured.messages ?? '-'}` +
        `${measured.error ? ` REFUSED: ${measured.error}` : ''}\n`,
    );
  }
}

function formatBytes(bytes) {
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
}
