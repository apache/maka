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

import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type {
  ComputerHistorySummaryContent,
  ComputerHistorySummaryInput,
  ComputerHistorySummaryLevel,
} from '@maka/core/computer-history';
import {
  decodeComputerHistorySummaryContent,
  decodeComputerHistorySummaryInput,
} from '@maka/runtime-host/protocol';

export interface ComputerHistorySummaryEvent {
  readonly timestamp: string;
  readonly kind: string;
  readonly app?: { readonly name?: string; readonly bundleIdentifier?: string };
  readonly window?: { readonly title?: string };
}

export interface StoredComputerHistorySummary {
  readonly id: string;
  readonly level: ComputerHistorySummaryLevel;
  readonly start: string;
  readonly end: string;
  readonly applications: readonly string[];
  /** Number of valid raw events, including events beyond the bounded evidence sample. */
  readonly eventCount: number;
  readonly content: ComputerHistorySummaryContent;
  readonly sourceIds: readonly string[];
}

const TEN_MINUTES = 10 * 60_000;
const SIX_HOURS = 6 * 60 * 60_000;
const RAW_HORIZON = 48 * 60 * 60_000;
const MAX_PER_RUN = 6;
const MAX_EVIDENCE = 96;
const MAX_EVIDENCE_BYTES = 56 * 1024;
const MAX_FILE_BYTES = 128 * 1024;
const MAX_APPLICATIONS = 64;

type Evidence = ComputerHistorySummaryInput['evidence'][number];
type Window = {
  start: number;
  eventCount: number;
  applications: Set<string>;
  evidence: Map<string, Evidence & { timestamp: string }>;
};
type PendingSummary = Omit<StoredComputerHistorySummary, 'content'> & {
  evidence: readonly Evidence[];
};

/** One main-process owner per home. Scheduling, consent and retry policy belong to the caller. */
export class ComputerHistorySummaries {
  readonly #home: string;
  readonly #directory: string;
  readonly #generate: (
    input: ComputerHistorySummaryInput,
    signal: AbortSignal,
  ) => Promise<ComputerHistorySummaryContent>;
  readonly #now: () => number;
  #epoch = 0;
  #closed = false;
  #active?: { controller: AbortController; promise: Promise<void> };
  #maintenance?: Promise<void>;

  constructor(input: {
    home: string;
    generate: (
      input: ComputerHistorySummaryInput,
      signal: AbortSignal,
    ) => Promise<ComputerHistorySummaryContent>;
    now?: () => number;
  }) {
    this.#home = resolve(input.home);
    this.#directory = join(this.#home, 'summaries');
    this.#generate = input.generate;
    this.#now = input.now ?? Date.now;
  }

  /** Concurrent calls join the active run; inputs arriving during maintenance are not queued. */
  run(events: readonly ComputerHistorySummaryEvent[]): Promise<void> {
    if (this.#closed) return Promise.resolve();
    if (this.#maintenance) return this.#maintenance;
    if (this.#active) return this.#active.promise;
    const controller = new AbortController();
    const promise = this.#run(events, controller.signal, this.#epoch).finally(() => {
      if (this.#active?.promise === promise) this.#active = undefined;
    });
    this.#active = { controller, promise };
    return promise;
  }

  /** Persisted summaries, oldest first. No local file paths cross this boundary. */
  async list(): Promise<readonly StoredComputerHistorySummary[]> {
    await this.#maintenance;
    return this.#read();
  }

  /** Abort and drain, then delete overlapping summaries. -Infinity also removes corrupt owned files. */
  clear(fromMs: number): Promise<void> {
    if (typeof fromMs !== 'number' || Number.isNaN(fromMs)) {
      return Promise.reject(new Error('Invalid history clear cutoff'));
    }
    return this.#interrupt(async () => {
      if (fromMs === Number.NEGATIVE_INFINITY) return this.#clearAll();
      for (const summary of await this.#read()) {
        if (Date.parse(summary.end) > fromMs) {
          await removeIfPresent(join(this.#directory, `${summary.id}.md`));
        }
      }
    });
  }

  /** Delete summaries overlapping [start, end), or containing a single point when equal. */
  clearInterval(start: number, end: number): Promise<void> {
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
      return Promise.reject(new Error('Invalid history clear interval'));
    }
    return this.#interrupt(async () => {
      for (const summary of await this.#read()) {
        const from = Date.parse(summary.start);
        const to = Date.parse(summary.end);
        if (to > start && (start === end ? from <= start : from < end)) {
          await removeIfPresent(join(this.#directory, `${summary.id}.md`));
        }
      }
    });
  }

  /** Waits for the generator to settle, even when it ignores its abort signal. Later runs are allowed. */
  cancel(): Promise<void> {
    return this.#interrupt();
  }

  /** Idempotently cancel; subsequent run calls are no-ops. Reads and clearing remain available. */
  close(): Promise<void> {
    this.#closed = true;
    return this.cancel();
  }

  #interrupt(action: () => Promise<void> = async () => {}): Promise<void> {
    this.#epoch++;
    this.#active?.controller.abort();
    const previous = this.#maintenance ?? this.#active?.promise ?? Promise.resolve();
    const promise = previous
      .then(action, async (error) => {
        await action();
        throw error;
      })
      .finally(() => {
        if (this.#maintenance === promise) this.#maintenance = undefined;
      });
    this.#maintenance = promise;
    return promise;
  }

  async #run(
    events: readonly ComputerHistorySummaryEvent[],
    signal: AbortSignal,
    epoch: number,
  ): Promise<void> {
    const now = this.#now();
    if (!Number.isFinite(now) || !Number.isFinite(new Date(now).getTime())) {
      throw new Error('Invalid history summary clock');
    }
    const windows = rawWindows(events, now);
    const stored = new Map((await this.#read()).map((summary) => [summary.id, summary]));
    const current = () => !signal.aborted && epoch === this.#epoch;
    for (let count = 0; count < MAX_PER_RUN && current(); count++) {
      const pending = nextSummary(windows, stored, now);
      if (!pending) return;
      const input = decodeComputerHistorySummaryInput({
        level: pending.level,
        start: pending.start,
        end: pending.end,
        evidence: pending.evidence.map(({ id, text }) => ({ id, text })),
      });
      let generated: unknown;
      try {
        generated = await this.#generate(input, signal);
      } catch (error) {
        if (signal.aborted) return;
        throw error;
      }
      if (!current()) return;
      const { evidence: _evidence, ...provenance } = pending;
      const summary = { ...provenance, content: decodeComputerHistorySummaryContent(generated) };
      await this.#write(summary, current);
      stored.set(summary.id, summary);
    }
  }

  async #directoryExists(create = false): Promise<boolean> {
    for (const directory of [this.#home, this.#directory]) {
      try {
        const info = await lstat(directory);
        if (!info.isDirectory() || info.isSymbolicLink()) throw invalidSummary();
      } catch (error) {
        if (!isMissing(error)) throw error;
        if (!create) return false;
        await mkdir(directory, { recursive: true, mode: 0o700 });
        const info = await lstat(directory);
        if (!info.isDirectory() || info.isSymbolicLink()) throw invalidSummary();
      }
    }
    return true;
  }

  async #clearAll(): Promise<void> {
    if (!(await this.#directoryExists())) return;
    let names: string[];
    try {
      names = await readdir(this.#directory);
    } catch (error) {
      if (isMissing(error)) return;
      throw error;
    }
    for (const name of names) {
      if (isOwnedSummaryFilename(name)) {
        // unlink removes a symlink itself, never its target; directories are not recursively removed.
        await removeIfPresent(join(this.#directory, name));
      }
    }
  }

  async #read(): Promise<StoredComputerHistorySummary[]> {
    if (!(await this.#directoryExists())) return [];
    let entries;
    try {
      entries = await readdir(this.#directory, { withFileTypes: true });
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }
    const summaries: StoredComputerHistorySummary[] = [];
    for (const entry of entries) {
      if (entry.isSymbolicLink()) throw invalidSummary();
      if (!entry.name.endsWith('.md')) continue;
      if (!entry.isFile()) throw invalidSummary();
      try {
        const file = await open(
          join(this.#directory, entry.name),
          constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        );
        try {
          const info = await file.stat();
          if (!info.isFile() || info.size > MAX_FILE_BYTES) throw invalidSummary();
          const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
          let size = 0;
          while (size < buffer.length) {
            const { bytesRead } = await file.read(buffer, size, buffer.length - size, null);
            if (bytesRead === 0) break;
            size += bytesRead;
          }
          if (size > MAX_FILE_BYTES) throw invalidSummary();
          const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, size));
          summaries.push(decodeSummary(text, entry.name));
        } finally {
          await file.close();
        }
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
    }
    return summaries.sort(compareSummaries);
  }

  async #write(summary: StoredComputerHistorySummary, current: () => boolean): Promise<void> {
    const text = serializeComputerHistorySummary(summary);
    await this.#directoryExists(true);
    if (!current()) return;
    const target = join(this.#directory, `${summary.id}.md`);
    const temporary = join(this.#directory, `.${summary.id}.${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, text, { flag: 'wx', mode: 0o600 });
      if (!current()) return;
      try {
        const info = await lstat(target);
        if (!info.isFile() || info.isSymbolicLink()) throw invalidSummary();
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
      if (!current()) return;
      await rename(temporary, target);
      if (!current()) await removeIfPresent(target);
    } finally {
      await removeIfPresent(temporary);
    }
  }
}

/** Canonical on-disk document for a validated summary; never includes local storage paths. */
export function serializeComputerHistorySummary(summary: StoredComputerHistorySummary): string {
  const { body, ...content } = summary.content;
  const header = {
    version: 1,
    id: summary.id,
    level: summary.level,
    start: summary.start,
    end: summary.end,
    applications: summary.applications,
    eventCount: summary.eventCount,
    sourceIds: summary.sourceIds,
    content,
  };
  const text = `---\n${JSON.stringify(header)}\n---\n${body}\n`;
  if (Buffer.byteLength(text) > MAX_FILE_BYTES) throw invalidSummary();
  return text;
}

function rawWindows(events: readonly ComputerHistorySummaryEvent[], now: number): Window[] {
  const windows = new Map<number, Window>();
  for (const event of events) {
    const time = Date.parse(event.timestamp);
    if (!Number.isFinite(time) || time < now - RAW_HORIZON || time >= now) continue;
    const start = Math.floor(time / TEN_MINUTES) * TEN_MINUTES;
    if (start + TEN_MINUTES > now) continue;
    const kind = observedText(event.kind, 64);
    if (!kind) continue;
    const name = observedText(event.app?.name, 128);
    const bundleIdentifier = observedText(event.app?.bundleIdentifier, 128);
    const title = observedText(event.window?.title, 256);
    const timestamp = new Date(time).toISOString();
    // Never serialize the collector object: it may also contain keyboard text, AX or file paths.
    const text = JSON.stringify({
      timestamp,
      kind,
      ...(name || bundleIdentifier ? { app: { name, bundleIdentifier } } : {}),
      ...(title ? { window: { title } } : {}),
    });
    const id = `event-${createHash('sha256').update(text).digest('hex')}`;
    let window = windows.get(start);
    if (!window) {
      window = { start, eventCount: 0, applications: new Set(), evidence: new Map() };
      windows.set(start, window);
    }
    window.eventCount++;
    const app = bundleIdentifier || name;
    if (app) {
      window.applications.add(app);
      if (window.applications.size > MAX_APPLICATIONS) {
        window.applications.delete([...window.applications].sort().at(-1)!);
      }
    }
    window.evidence.set(id, { id, text, timestamp });
    if (window.evidence.size > MAX_EVIDENCE) {
      const latest = [...window.evidence.values()].sort(compareEvidence).at(-1)!;
      window.evidence.delete(latest.id);
    }
  }
  return [...windows.values()].sort((a, b) => a.start - b.start);
}

function nextSummary(
  windows: readonly Window[],
  stored: ReadonlyMap<string, StoredComputerHistorySummary>,
  now: number,
): PendingSummary | undefined {
  const pending: PendingSummary[] = [];
  for (const window of windows) {
    if (stored.has(summaryId('10min', window.start))) continue;
    const evidence = boundEvidence([...window.evidence.values()].sort(compareEvidence));
    if (evidence.length < window.eventCount) {
      const last = evidence.at(-1)!;
      evidence[evidence.length - 1] = {
        id: last.id,
        text: `${last.text}\n[Evidence sample: ${evidence.length} of ${window.eventCount} events]`,
      };
    }
    pending.push({
      ...range('10min', window.start),
      applications: [...window.applications].sort(),
      eventCount: window.eventCount,
      sourceIds: evidence.map(({ id }) => id),
      evidence,
    });
  }
  const groups = new Map<number, StoredComputerHistorySummary[]>();
  for (const summary of stored.values()) {
    if (summary.level !== '10min') continue;
    const start = Math.floor(Date.parse(summary.start) / SIX_HOURS) * SIX_HOURS;
    if (start + SIX_HOURS > now) continue;
    const children = groups.get(start) ?? [];
    children.push(summary);
    groups.set(start, children);
  }
  for (const [start, children] of groups) {
    // A bounded catch-up must not finalize a rollup before its known raw windows are processed.
    if (
      pending.some(
        (summary) =>
          summary.level === '10min' &&
          Date.parse(summary.start) >= start &&
          Date.parse(summary.start) < start + SIX_HOURS,
      )
    ) {
      continue;
    }
    children.sort(compareSummaries);
    const sourceIds = children.map(({ id }) => id);
    const existing = stored.get(summaryId('6h', start));
    if (existing && JSON.stringify(existing.sourceIds) === JSON.stringify(sourceIds)) continue;
    pending.push({
      ...range('6h', start),
      applications: [...new Set(children.flatMap((child) => child.applications))]
        .sort()
        .slice(0, MAX_APPLICATIONS),
      eventCount: children.reduce((count, child) => count + child.eventCount, 0),
      sourceIds,
      evidence: children.map((child) => ({
        id: child.id,
        text:
          `${child.start} to ${child.end}; ${child.eventCount} events\n` +
          observedText(
            `${child.content.title}\n${child.content.description}\n${child.content.body}`,
            650,
          ),
      })),
    });
  }
  return pending.sort(
    (a, b) => Date.parse(a.end) - Date.parse(b.end) || compareSummaries(a, b),
  )[0];
}

function boundEvidence(items: readonly Evidence[]): Evidence[] {
  const result: Evidence[] = [];
  let size = 0;
  for (const { id, text } of items) {
    size += Buffer.byteLength(JSON.stringify({ id, text })) + 1;
    if (size > MAX_EVIDENCE_BYTES || result.length === MAX_EVIDENCE) break;
    result.push({ id, text });
  }
  return result;
}

function range(level: ComputerHistorySummaryLevel, start: number) {
  return {
    id: summaryId(level, start),
    level,
    start: new Date(start).toISOString(),
    end: new Date(start + (level === '10min' ? TEN_MINUTES : SIX_HOURS)).toISOString(),
  };
}

function summaryId(level: ComputerHistorySummaryLevel, start: number): string {
  return `${level}-${start}`;
}

function isOwnedSummaryFilename(name: string): boolean {
  const match = /^(10min|6h)-(-?\d+)\.md$/u.exec(name);
  if (!match) return false;
  const level = match[1] as ComputerHistorySummaryLevel;
  const start = Number(match[2]);
  return (
    Number.isFinite(new Date(start).getTime()) &&
    start % (level === '10min' ? TEN_MINUTES : SIX_HOURS) === 0 &&
    name === `${summaryId(level, start)}.md`
  );
}

function compareSummaries(
  a: Pick<StoredComputerHistorySummary, 'start' | 'id'>,
  b: Pick<StoredComputerHistorySummary, 'start' | 'id'>,
): number {
  return a.start.localeCompare(b.start) || a.id.localeCompare(b.id);
}

function compareEvidence(
  a: Evidence & { timestamp: string },
  b: Evidence & { timestamp: string },
): number {
  return a.timestamp.localeCompare(b.timestamp) || a.id.localeCompare(b.id);
}

function observedText(value: unknown, limit: number): string {
  return typeof value === 'string'
    ? clipText(value, limit).replace(/[\u0000-\u001f\u007f]/gu, ' ').trim()
    : '';
}

function clipText(value: string, maxBytes: number): string {
  if (value.length <= maxBytes && Buffer.byteLength(value) <= maxBytes) return value;
  const suffix = ' [truncated]';
  let prefix = '';
  let size = suffix.length;
  for (const char of value) {
    size += Buffer.byteLength(char);
    if (size > maxBytes) break;
    prefix += char;
  }
  return prefix + suffix;
}

function decodeSummary(text: string, filename: string): StoredComputerHistorySummary {
  if (!text.startsWith('---\n') || !text.endsWith('\n')) throw invalidSummary();
  const delimiter = text.indexOf('\n---\n', 4);
  if (delimiter < 0) throw invalidSummary();
  const data = record(JSON.parse(text.slice(4, delimiter)), [
    'version',
    'id',
    'level',
    'start',
    'end',
    'applications',
    'eventCount',
    'sourceIds',
    'content',
  ]);
  if (data.version !== 1 || (data.level !== '10min' && data.level !== '6h')) throw invalidSummary();
  const start = Date.parse(validText(data.start, 24));
  const duration = data.level === '10min' ? TEN_MINUTES : SIX_HOURS;
  if (!Number.isFinite(start) || start % duration !== 0) throw invalidSummary();
  const expected = range(data.level, start);
  if (
    data.id !== expected.id ||
    data.start !== expected.start ||
    data.end !== expected.end ||
    filename !== `${expected.id}.md`
  ) {
    throw invalidSummary();
  }
  const applications = stringArray(data.applications, MAX_APPLICATIONS, 128);
  const sourceIds = stringArray(data.sourceIds, data.level === '10min' ? MAX_EVIDENCE : 36, 80);
  if (
    sourceIds.length === 0 ||
    !Number.isSafeInteger(data.eventCount) ||
    (data.eventCount as number) < sourceIds.length
  ) {
    throw invalidSummary();
  }
  for (const id of sourceIds) {
    if (data.level === '10min') {
      if (!/^event-[a-f0-9]{64}$/u.test(id)) throw invalidSummary();
    } else {
      const childStart = Number(id.slice('10min-'.length));
      if (
        !Number.isFinite(childStart) ||
        id !== summaryId('10min', childStart) ||
        childStart % TEN_MINUTES !== 0 ||
        childStart < start ||
        childStart >= start + SIX_HOURS
      ) {
        throw invalidSummary();
      }
    }
  }
  const headerContent = record(data.content, ['title', 'description', 'suggestion']);
  return {
    ...expected,
    applications,
    eventCount: data.eventCount as number,
    sourceIds,
    content: decodeComputerHistorySummaryContent({
      ...headerContent,
      body: text.slice(delimiter + 5, -1),
    }),
  };
}

function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
    Object.keys(value).some((key) => !keys.includes(key))
  ) {
    throw invalidSummary();
  }
  return value as Record<string, unknown>;
}

function validText(value: unknown, max: number): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > max ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw invalidSummary();
  }
  return value;
}

function stringArray(value: unknown, max: number, textMax: number): string[] {
  if (!Array.isArray(value) || value.length > max) throw invalidSummary();
  const strings = value.map((item) => validText(item, textMax));
  if (new Set(strings).size !== strings.length) throw invalidSummary();
  return strings;
}

function invalidSummary(): Error {
  return new Error('Invalid computer history summary');
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === 'ENOENT';
}

async function removeIfPresent(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
}
