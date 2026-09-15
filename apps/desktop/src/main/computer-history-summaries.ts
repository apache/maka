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
import { constants, type BigIntStats } from 'node:fs';
import { lstat, mkdir, open, opendir, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type {
  ComputerHistorySummaryContent,
  ComputerHistorySummaryInput,
  ComputerHistorySummaryLevel,
} from '@maka/core/computer-history';
import { isUiLocale, type UiLocale } from '@maka/core/ui-locale';
import {
  decodeComputerHistorySummaryContent,
  decodeComputerHistorySummaryInput,
} from '@maka/runtime-host/protocol';

export interface ComputerHistorySummaryEvent {
  readonly timestamp: string;
  readonly kind: string;
  /** Opaque main-owned source identity; never passed to the model as a path. */
  readonly sourceKey?: string;
  /** Caller-validated, consent-gated text, including only self-contained AX snapshots. */
  readonly content?: string;
  readonly app?: { readonly name?: string; readonly bundleIdentifier?: string };
  readonly window?: { readonly title?: string; readonly urlDomain?: string };
}

export interface StoredComputerHistorySummary {
  readonly id: string;
  /** Main-owned basename chosen once; absent on legacy ID-named documents. */
  readonly filename?: string;
  /** Read-time file version, excluded from persisted documents and model inputs. */
  readonly documentRevision?: string;
  readonly level: ComputerHistorySummaryLevel;
  readonly start: string;
  readonly end: string;
  readonly applications: readonly string[];
  /** Number of valid raw events, including events beyond the bounded evidence sample. */
  readonly eventCount: number;
  readonly content: ComputerHistorySummaryContent;
  readonly sourceIds: readonly string[];
  readonly generation?: {
    readonly version: number;
    readonly locale?: UiLocale;
    readonly sourceRevision: string;
    readonly includesText: boolean;
    readonly scopeKey?: string;
    /** Required from v3; absent in older generations whose prior dependencies are unknown. */
    readonly priorContextIds?: readonly string[];
    /** Required from v4: immutable transitive raw-window coverage, including this summary's inputs. */
    readonly rawEvidenceRanges?: readonly EvidenceRange[];
  };
}

type EvidenceRange = readonly [start: number, end: number];

export interface ComputerHistorySummaryFailure {
  readonly id: string;
  readonly nextRetryAt: number;
}

/** Generated windows are saved even when other windows are waiting for retry. */
export class ComputerHistorySummaryRunError extends Error {
  readonly attempted: number;
  readonly generated: number;
  readonly failures: readonly ComputerHistorySummaryFailure[];
  readonly nextRetryAt: number;
  readonly providerUnavailable: boolean;

  constructor(input: {
    attempted: number;
    generated: number;
    failures: readonly ComputerHistorySummaryFailure[];
    providerUnavailable?: boolean;
    nextRetryAt?: number;
  }) {
    super('Computer History summary generation is waiting for retry');
    this.name = 'ComputerHistorySummaryRunError';
    this.attempted = input.attempted;
    this.generated = input.generated;
    this.failures = input.failures;
    this.nextRetryAt = input.nextRetryAt ?? Math.min(...input.failures.map(({ nextRetryAt }) => nextRetryAt));
    this.providerUnavailable = input.providerUnavailable ?? false;
  }
}

/** The caller marks connection-wide failures; malformed output remains a window-local failure. */
export class ComputerHistorySummaryProviderError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ComputerHistorySummaryProviderError';
  }
}

/** A model read overlapped archive publication or maintenance; retry the whole query. */
export class ComputerHistorySummarySnapshotError extends Error {
  readonly code = 'history_archive_changed';

  constructor() {
    super('Computer History changed during the read. Search again.');
    this.name = 'ComputerHistorySummarySnapshotError';
  }
}

const TEN_MINUTES = 10 * 60_000;
const SIX_HOURS = 6 * 60 * 60_000;
const RAW_HORIZON = 48 * 60 * 60_000;
const MAX_PER_RUN = 6;
const MAX_EVIDENCE = 256;
const MAX_EVIDENCE_BYTES = 224 * 1024;
const MAX_ITEM_BYTES = 32 * 1024;
const GENERATION_VERSION = 5;
const MAX_EVIDENCE_RANGES = 256;
// The earliest representable timestamp denotes unknown ancestry in pre-v4 generations.
const EARLIEST_TIME = -8_640_000_000_000_000;
const SAMPLE_TIME_BINS = 16;
const SAMPLE_SOURCES = 16;
// Full-content candidates share one pool. Slot references retain metadata only.
const MAX_RETAINED_OBSERVATIONS = MAX_EVIDENCE - SAMPLE_TIME_BINS * 3 - SAMPLE_SOURCES - 3;
const MAX_RETRY_WINDOWS = 512;
const MAX_FILE_BYTES = 128 * 1024;
const MAX_APPLICATIONS = 64;

type Evidence = ComputerHistorySummaryInput['evidence'][number];
type SummaryEvents = Iterable<ComputerHistorySummaryEvent> | AsyncIterable<ComputerHistorySummaryEvent>;
type RunOptions = { locale?: UiLocale; includeText?: boolean; scopeKey?: string; retryFailed?: boolean };
type Observation = {
  id: string;
  timestamp: string;
  source: string;
  signature: string;
  metadata: string;
  content?: string;
  contentBytes: number;
};
type Window = {
  start: number;
  eventCount: number;
  applications: Set<string>;
  revision: bigint;
  timeSamples: Map<number, { first: Observation; last: Observation }>;
  sourceSamples: Map<string, Observation>;
  contentSamples: Map<number, Observation>;
  observations: Map<string, Observation>;
  observationBytes: number;
  observationCutoff?: Pick<Observation, 'signature' | 'contentBytes'>;
  first?: Observation;
  last?: Observation;
  richest?: Observation;
};
type PendingSummary = Omit<StoredComputerHistorySummary, 'content'> & {
  evidence: readonly Evidence[];
  priorContext?: readonly Evidence[];
};

/** One main-process owner per home. The caller owns scheduling and consent; retries are window-local. */
export class ComputerHistorySummaries {
  readonly #home: string;
  readonly #directory: string;
  readonly #generate: (
    input: ComputerHistorySummaryInput,
    signal: AbortSignal,
  ) => Promise<ComputerHistorySummaryContent>;
  readonly #now: () => number;
  readonly #filenames = new Map<string, string>();
  readonly #failures = new Map<string, {
    revision: string;
    attempts: number;
    nextRetryAt: number;
  }>();
  #providerFailure?: { optionsKey: string; failure: ComputerHistorySummaryFailure };
  #epoch = 0;
  #archiveRevision = 0;
  #publishing = false;
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
  run(
    events: SummaryEvents,
    options: RunOptions = {},
  ): Promise<void> {
    if (this.#closed) return Promise.resolve();
    if (this.#maintenance) return this.#maintenance;
    if (this.#active) return this.#active.promise;
    const controller = new AbortController();
    const promise = this.#run(events, controller.signal, this.#epoch, options).finally(() => {
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

  /**
   * Stream validated documents without retaining their bodies. Consumers must finish
   * scanning before publishing results: a later file can violate archive uniqueness.
   */
  async *scan(): AsyncGenerator<StoredComputerHistorySummary> {
    await this.#maintenance;
    yield* this.#scan();
  }

  /**
   * Guard a complete read, including all scan passes and final access checks.
   * No locking or retry: reject if this owner's publication or maintenance overlaps.
   * Callers must not publish partial results from the callback.
   */
  async withReadSnapshot<T>(read: () => Promise<T>): Promise<T> {
    const revision = this.#archiveRevision;
    const epoch = this.#epoch;
    const assertCurrent = () => {
      if (this.#publishing || this.#maintenance ||
          revision !== this.#archiveRevision || epoch !== this.#epoch) {
        throw new ComputerHistorySummarySnapshotError();
      }
    };
    assertCurrent();
    const result = await read();
    assertCurrent();
    return result;
  }

  /** Canonical document lookup, independent of visibility and unrelated corrupt summaries. */
  async get(id: string): Promise<StoredComputerHistorySummary | null> {
    validateSummaryId(id);
    await this.#maintenance;
    if (!(await this.#directoryExists())) return null;
    const known = this.#filenames.get(id);
    if (known) {
      try {
        return await this.#readFile(known, undefined, id);
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
    }
    // The timeline normally warms this map. A cold direct lookup must also find
    // a readable archive when an unrelated document is corrupt.
    let found: StoredComputerHistorySummary | null = null;
    for (const name of await readdir(this.#directory)) {
      if (name !== `${id}.md` && !isReadableSummaryFilename(name)) continue;
      let candidate: StoredComputerHistorySummary;
      try {
        candidate = await this.#readFile(name);
      } catch (error) {
        if (name === `${id}.md` && !isMissing(error)) throw error;
        continue;
      }
      if (candidate.id !== id) continue;
      if (found) throw invalidSummary();
      found = candidate;
    }
    if (found) this.#filenames.set(id, found.filename ?? `${id}.md`);
    return found;
  }

  /** Main-only reveal of a validated persisted document, independent of timeline filtering. */
  async reveal(id: string, showItemInFolder: (path: string) => void): Promise<void> {
    const summary = await this.get(id);
    if (!summary) throw invalidSummary();
    await this.#readFile(summary.filename ?? `${id}.md`, showItemInFolder, id);
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
          await removeIfPresent(join(this.#directory, summary.filename ?? `${summary.id}.md`));
          this.#filenames.delete(summary.id);
        }
      }
    });
  }

  /**
   * Delete overlapping summaries and their transitive dependants, including for a single point.
   * Pre-v4 generations lack immutable ancestry: conservatively delete later ones regardless of scope.
   */
  clearInterval(start: number, end: number): Promise<void> {
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
      return Promise.reject(new Error('Invalid history clear interval'));
    }
    return this.#interrupt(async () => {
      const summaries = await this.#read();
      const filenames = new Map(summaries.map((summary) => [summary.id, summary.filename ?? `${summary.id}.md`]));
      for (const id of deletionIds(summaries, start, end).reverse()) {
        // Delete consumers before their persisted inputs, including when an unlink fails partway.
        await removeIfPresent(join(this.#directory, filenames.get(id)!));
        this.#filenames.delete(id);
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
    this.#failures.clear();
    this.#providerFailure = undefined;
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
    events: SummaryEvents,
    signal: AbortSignal,
    epoch: number,
    options: RunOptions,
  ): Promise<void> {
    const now = this.#now();
    if (!Number.isFinite(now) || !Number.isFinite(new Date(now).getTime())) {
      throw new Error('Invalid history summary clock');
    }
    const { locale, includeText = false, scopeKey } = options;
    if (locale !== undefined && !isUiLocale(locale)) throw invalidSummary();
    if (scopeKey !== undefined) validText(scopeKey, 256);
    const current = () => !signal.aborted && epoch === this.#epoch;
    const windows = await rawWindows(events, now, includeText, current);
    if (!current()) return;
    let stored: Map<string, StoredComputerHistorySummary>;
    try {
      stored = new Map((await this.#read()).map((summary) => [summary.id, summary]));
    } catch (error) {
      if (!current()) return;
      throw error;
    }
    if (!current()) return;
    const optionsKey = JSON.stringify([locale, includeText, scopeKey]);
    if (this.#providerFailure?.optionsKey === optionsKey &&
        this.#providerFailure.failure.nextRetryAt > now && !options.retryFailed) {
      throw new ComputerHistorySummaryRunError({
        attempted: 0, generated: 0, failures: [this.#providerFailure.failure], providerUnavailable: true,
      });
    }
    this.#providerFailure = undefined;
    for (const [id, failure] of this.#failures) {
      if (failure.nextRetryAt + RAW_HORIZON < now) this.#failures.delete(id);
    }
    let attempted = 0;
    let generated = 0;
    const failures = new Map<string, ComputerHistorySummaryFailure>();
    const failedThisRun = new Set<string>();
    const eligible = (candidate: PendingSummary) => {
      if (failedThisRun.has(candidate.id)) return false;
      const failed = this.#failures.get(candidate.id);
      if (!failed) return true;
      if (failed.revision !== JSON.stringify(candidate.generation)) {
        this.#failures.delete(candidate.id);
        failures.delete(candidate.id);
        return true;
      }
      failures.set(candidate.id, { id: candidate.id, nextRetryAt: failed.nextRetryAt });
      return Boolean(options.retryFailed) || failed.nextRetryAt <= now;
    };
    while (attempted < MAX_PER_RUN && current()) {
      const pending = nextSummary(windows, stored, now, { locale, includeText, scopeKey }, eligible);
      if (!pending) break;
      const input = decodeComputerHistorySummaryInput({
        level: pending.level,
        start: pending.start,
        end: pending.end,
        evidence: pending.evidence.map(({ id, text }) => ({ id, text })),
        ...(locale ? { locale } : {}),
        ...(pending.priorContext ? { priorContext: pending.priorContext } : {}),
      });
      let content: ComputerHistorySummaryContent;
      attempted++;
      let validatingOutput = false;
      try {
        const output = await this.#generate(input, signal);
        if (!current()) return;
        validatingOutput = true;
        content = decodeComputerHistorySummaryContent(output);
      } catch (error) {
        if (!current()) return;
        if (error instanceof ComputerHistorySummaryProviderError) {
          const failure = { id: pending.id, nextRetryAt: now + TEN_MINUTES };
          this.#providerFailure = { optionsKey, failure };
          failures.set(pending.id, failure);
          throw new ComputerHistorySummaryRunError({
            attempted, generated, failures: [...failures.values()],
            providerUnavailable: true, nextRetryAt: failure.nextRetryAt,
          });
        }
        if (!validatingOutput &&
            !(error && typeof error === 'object' && 'code' in error && error.code === 'invalid_summary')) {
          throw error;
        }
        const attempts = Math.min((this.#failures.get(pending.id)?.attempts ?? 0) + 1, 7);
        const nextRetryAt = now + Math.min(TEN_MINUTES * 2 ** (attempts - 1), SIX_HOURS);
        this.#failures.set(pending.id, {
          revision: JSON.stringify(pending.generation), attempts, nextRetryAt,
        });
        while (this.#failures.size > MAX_RETRY_WINDOWS) {
          this.#failures.delete(this.#failures.keys().next().value!);
        }
        failures.set(pending.id, { id: pending.id, nextRetryAt });
        failedThisRun.add(pending.id);
        continue;
      }
      if (!current()) return;
      const { evidence: _evidence, priorContext: _priorContext, ...provenance } = pending;
      const existing = stored.get(provenance.id);
      const filename = existing
        ? existing.filename
        : this.#filenames.get(provenance.id) ?? await this.#availableFilename(provenance, content.title);
      const summary: StoredComputerHistorySummary = {
        ...provenance,
        content,
        ...(filename && isReadableSummaryFilename(filename) ? { filename } : {}),
      };
      const parentId = summary.level === '10min'
        ? summaryId('6h', Math.floor(Date.parse(summary.start) / SIX_HOURS) * SIX_HOURS)
        : undefined;
      const parent = parentId ? stored.get(parentId) : undefined;
      // Preserve policy-ineligible archives for reading; they remain excluded from model requests.
      const invalidatedParent = parent && parent.generation?.scopeKey === scopeKey &&
        (includeText || !parent.generation?.includesText)
        ? parent.id : undefined;
      await this.#write(summary, current, invalidatedParent);
      if (!current()) return;
      if (invalidatedParent) stored.delete(invalidatedParent);
      stored.set(summary.id, summary);
      this.#failures.delete(summary.id);
      failures.delete(summary.id);
      generated++;
    }
    if (current() && failures.size) {
      throw new ComputerHistorySummaryRunError({ attempted, generated, failures: [...failures.values()] });
    }
  }

  async #availableFilename(summary: Pick<StoredComputerHistorySummary, 'id' | 'start' | 'level'>, title: string): Promise<string> {
    const preferred = readableSummaryFilename(summary, title);
    const alternatives = [preferred, preferred.replace(/\.md$/u, `-${Date.parse(summary.start)}.md`)];
    for (const name of alternatives) {
      try {
        // Filesystem occupancy also covers case-insensitive aliases and symlinks.
        await lstat(join(this.#directory, name));
      } catch (error) {
        if (isMissing(error)) return name;
        throw error;
      }
    }
    throw invalidSummary();
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
    this.#filenames.clear();
  }

  async #read(): Promise<StoredComputerHistorySummary[]> {
    const summaries: StoredComputerHistorySummary[] = [];
    for await (const summary of this.#scan()) summaries.push(summary);
    return summaries.sort(compareSummaries);
  }

  async *#scan(): AsyncGenerator<StoredComputerHistorySummary> {
    if (!(await this.#directoryExists())) return;
    const epoch = this.#epoch;
    let directory;
    try {
      directory = await opendir(this.#directory);
    } catch (error) {
      if (isMissing(error)) return;
      throw error;
    }
    const filenames = new Map<string, string>();
    for await (const entry of directory) {
      if (epoch !== this.#epoch) throw invalidSummary();
      if (entry.isSymbolicLink()) throw invalidSummary();
      if (!entry.name.endsWith('.md')) continue;
      if (!entry.isFile()) throw invalidSummary();
      try {
        const summary = await this.#readFile(entry.name);
        if (filenames.has(summary.id)) {
          this.#filenames.delete(summary.id);
          throw invalidSummary();
        }
        if (epoch !== this.#epoch) throw invalidSummary();
        filenames.set(summary.id, summary.filename ?? `${summary.id}.md`);
        yield summary;
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
    }
    if (epoch !== this.#epoch) throw invalidSummary();
    // Only publish lookups after the complete archive passes uniqueness checks.
    for (const [id, filename] of filenames) this.#filenames.set(id, filename);
  }

  async #readFile(
    filename: string,
    showItemInFolder?: (path: string) => void,
    expectedId?: string,
  ): Promise<StoredComputerHistorySummary> {
    const path = join(this.#directory, filename);
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = await file.stat({ bigint: true });
      if (!info.isFile() || info.size > BigInt(MAX_FILE_BYTES)) throw invalidSummary();
      const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
      let size = 0;
      while (size < buffer.length) {
        const { bytesRead } = await file.read(buffer, size, buffer.length - size, null);
        if (bytesRead === 0) break;
        size += bytesRead;
      }
      if (size > MAX_FILE_BYTES) throw invalidSummary();
      const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, size));
      const summary = decodeSummary(text, filename);
      if (expectedId !== undefined && summary.id !== expectedId) throw invalidSummary();
      const documentRevision = summaryFileRevision(info);
      if (summaryFileRevision(await file.stat({ bigint: true })) !== documentRevision) throw invalidSummary();
      if (showItemInFolder) {
        if (!(await this.#directoryExists())) throw invalidSummary();
        const current = await lstat(path, { bigint: true });
        if (!current.isFile() || current.isSymbolicLink() ||
            summaryFileRevision(current) !== documentRevision) throw invalidSummary();
        showItemInFolder(path);
      }
      return { ...summary, documentRevision };
    } finally {
      await file.close();
    }
  }

  async #write(summary: StoredComputerHistorySummary, current: () => boolean, parentId?: string): Promise<void> {
    const text = serializeComputerHistorySummary(summary);
    // Mark pending publication before its first await, including invalidation and cleanup.
    this.#publishing = true;
    this.#archiveRevision++;
    try {
      await this.#directoryExists(true);
      if (!current()) return;
      const filename = summary.filename ?? `${summary.id}.md`;
      const target = join(this.#directory, filename);
      const temporary = join(this.#directory, `.${summary.id}.${randomUUID()}.tmp`);
      try {
        await writeFile(temporary, text, { flag: 'wx', mode: 0o600 });
        if (!current()) return;
        try {
          const info = await lstat(target);
          if (!info.isFile() || info.isSymbolicLink()) throw invalidSummary();
          await this.#readFile(filename, undefined, summary.id);
        } catch (error) {
          if (!isMissing(error)) throw error;
        }
        if (!current()) return;
        // Invalidate before publishing a child so restart cannot reuse a stale same-ID rollup.
        if (parentId) await removeIfPresent(join(this.#directory, this.#filenames.get(parentId) ?? `${parentId}.md`));
        if (!current()) return;
        await rename(temporary, target);
        this.#filenames.set(summary.id, filename);
        if (!current()) await removeIfPresent(target);
      } finally {
        await removeIfPresent(temporary);
      }
    } finally {
      this.#archiveRevision++;
      this.#publishing = false;
    }
  }
}

function summaryFileRevision(info: BigIntStats): string {
  // Inode identity covers atomic replacements; ctime also detects writes that restore mtime.
  return [info.dev, info.ino, info.birthtimeNs, info.size, info.mtimeNs, info.ctimeNs].join(':');
}

/** Canonical on-disk document for a validated summary; never includes local storage paths. */
export function serializeComputerHistorySummary(summary: StoredComputerHistorySummary): string {
  const { body, ...content } = summary.content;
  const header = {
    version: 1,
    id: summary.id,
    ...(summary.filename ? { filename: summary.filename } : {}),
    level: summary.level,
    start: summary.start,
    end: summary.end,
    applications: summary.applications,
    eventCount: summary.eventCount,
    sourceIds: summary.sourceIds,
    ...(summary.generation ? { generation: summary.generation } : {}),
    content,
  };
  const text = `---\n${JSON.stringify(header)}\n---\n${body}\n`;
  if (Buffer.byteLength(text) > MAX_FILE_BYTES) throw invalidSummary();
  return text;
}

async function rawWindows(
  events: SummaryEvents,
  now: number,
  includeText: boolean,
  current: () => boolean,
): Promise<Window[]> {
  const windows = new Map<number, Window>();
  for await (const event of events) {
    if (!current()) break;
    const time = Date.parse(event.timestamp);
    if (!Number.isFinite(time) || time < now - RAW_HORIZON || time >= now) continue;
    const start = Math.floor(time / TEN_MINUTES) * TEN_MINUTES;
    if (start + TEN_MINUTES > now) continue;
    const observation = projectObservation(event, includeText);
    if (!observation) continue;
    const name = observedText(event.app?.name, 128);
    const bundleIdentifier = observedText(event.app?.bundleIdentifier, 128);
    const { id, source, content, ...withoutContent } = observation;
    let window = windows.get(start);
    if (!window) {
      window = {
        start, eventCount: 0, applications: new Set(), revision: 0n,
        timeSamples: new Map(), sourceSamples: new Map(), contentSamples: new Map(),
        observations: new Map(), observationBytes: 0,
      };
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
    // An order-independent digest includes even unsampled input without retaining its content.
    window.revision = (window.revision + BigInt(`0x${id.slice(6)}`)) % (1n << 256n);
    const metadataOnly = { ...withoutContent, id, source };
    if (!window.first || compareEvidence(observation, window.first) < 0) window.first = observation;
    if (!window.last || compareEvidence(observation, window.last) > 0) window.last = observation;
    if (preferObservation(observation, window.richest)) window.richest = observation;
    retainObservation(window, observation);
    const slot = Math.floor((time - start) / (TEN_MINUTES / SAMPLE_TIME_BINS));
    const endpoints = window.timeSamples.get(slot);
    window.timeSamples.set(slot, {
      first: !endpoints || compareEvidence(metadataOnly, endpoints.first) < 0 ? metadataOnly : endpoints.first,
      last: !endpoints || compareEvidence(metadataOnly, endpoints.last) > 0 ? metadataOnly : endpoints.last,
    });
    if (content && preferObservation(metadataOnly, window.contentSamples.get(slot))) {
      window.contentSamples.set(slot, metadataOnly);
    }
    if (preferObservation(metadataOnly, window.sourceSamples.get(source))) {
      window.sourceSamples.set(source, metadataOnly);
      if (window.sourceSamples.size > SAMPLE_SOURCES) {
        window.sourceSamples.delete([...window.sourceSamples.keys()].sort().at(-1)!);
      }
    }
  }
  return [...windows.values()].sort((a, b) => a.start - b.start);
}

function observationSize(item: Observation): number {
  return Buffer.byteLength(item.metadata) + Buffer.byteLength(item.content ?? '');
}

function compareRetainedObservations(
  a: Pick<Observation, 'signature' | 'contentBytes'>,
  b: Pick<Observation, 'signature' | 'contentBytes'>,
): number {
  // Short observed changes survive alongside long documents instead of losing to metadata noise.
  return Number(b.contentBytes > 0) - Number(a.contentBytes > 0) ||
    a.contentBytes - b.contentBytes || a.signature.localeCompare(b.signature);
}

function retainObservation(window: Window, item: Observation): void {
  if (window.observationCutoff && compareRetainedObservations(item, window.observationCutoff) >= 0) return;
  const previous = window.observations.get(item.signature);
  if (previous && compareEvidence(previous, item) >= 0) return;
  window.observations.set(item.signature, item);
  window.observationBytes += observationSize(item) - (previous ? observationSize(previous) : 0);
  // Retain a prefix of a fixed ordering. Remembering the cutoff prevents later small
  // arrivals filling holes differently when the same event stream is read backwards.
  while (window.observations.size > MAX_RETAINED_OBSERVATIONS || window.observationBytes > MAX_EVIDENCE_BYTES) {
    const rejected = [...window.observations.values()].sort(compareRetainedObservations).at(-1)!;
    window.observations.delete(rejected.signature);
    window.observationBytes -= observationSize(rejected);
    window.observationCutoff = { signature: rejected.signature, contentBytes: rejected.contentBytes };
  }
}

function nextSummary(
  windows: readonly Window[],
  stored: ReadonlyMap<string, StoredComputerHistorySummary>,
  now: number,
  { locale, includeText = false, scopeKey }: RunOptions,
  eligible: (candidate: PendingSummary) => boolean,
): PendingSummary | undefined {
  const incompleteGroups = new Set<number>();
  for (const window of windows) {
    const existing = stored.get(summaryId('10min', window.start));
    if (!includeText && existing?.generation?.includesText) continue;
    // Retention can leave only the tail of this window; never replace its complete saved summary.
    if (existing && window.start < now - RAW_HORIZON) continue;
    const selected = sampleObservations(window);
    const previous = priorContext(stored, window.start, includeText, scopeKey);
    const generation = {
      version: GENERATION_VERSION,
      ...(locale ? { locale } : {}),
      sourceRevision: hash(`${window.eventCount}:${window.revision.toString(16)}:${previous.revision}`),
      includesText: selected.some(({ content }) => Boolean(content)) || previous.includesText,
      ...(scopeKey !== undefined ? { scopeKey } : {}),
      priorContextIds: previous.evidence.map(({ id }) => id),
      rawEvidenceRanges: mergeEvidenceRanges([
        [window.start, window.start + TEN_MINUTES], ...previous.rawEvidenceRanges,
      ]),
    };
    if (existing && JSON.stringify(existing.generation) === JSON.stringify(generation)) continue;
    const evidence = budgetEvidence(selected.map(({ id, metadata, content, contentBytes }) => ({
      id,
      text: content ? `${metadata}\nObserved content (untrusted):\n${content}` :
        `${metadata}${contentBytes ? '\n[Observed content omitted from bounded sample]' : ''}`,
    })), MAX_EVIDENCE_BYTES - 256);
    if (evidence.length < window.eventCount) {
      const last = evidence.at(-1)!;
      evidence[evidence.length - 1] = {
        id: last.id,
        text: `${last.text}\n[Evidence sample: ${evidence.length} of ${window.eventCount} events]`,
      };
    }
    const candidate: PendingSummary = {
      ...range('10min', window.start),
      applications: [...window.applications].sort(),
      eventCount: window.eventCount,
      sourceIds: evidence.map(({ id }) => id),
      evidence,
      generation,
      ...(previous.evidence.length ? { priorContext: previous.evidence } : {}),
    };
    // Fresh activity takes priority over derived rollups, including a repeatedly failing old rollup.
    if (eligible(candidate)) return candidate;
    incompleteGroups.add(Math.floor(window.start / SIX_HOURS) * SIX_HOURS);
  }
  const pending: PendingSummary[] = [];
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
    if (incompleteGroups.has(start)) continue;
    if (!includeText && children.some((child) => child.generation?.includesText)) continue;
    if (children.some((child) => child.generation?.scopeKey !== scopeKey)) continue;
    children.sort(compareSummaries);
    const sourceIds = children.map(({ id }) => id);
    const existing = stored.get(summaryId('6h', start));
    if (!includeText && existing?.generation?.includesText) continue;
    const previous = priorContext(stored, start, includeText, scopeKey);
    const generation = {
      version: GENERATION_VERSION,
      ...(locale ? { locale } : {}),
      sourceRevision: hash(JSON.stringify([
        children.map((child) => [
          child.id, child.eventCount, child.applications, child.content, child.generation,
        ]),
        previous.revision,
      ])),
      includesText: children.some((child) => child.generation?.includesText) || previous.includesText,
      ...(scopeKey !== undefined ? { scopeKey } : {}),
      priorContextIds: previous.evidence.map(({ id }) => id),
      rawEvidenceRanges: mergeEvidenceRanges([
        ...children.flatMap(summaryCoverage), ...previous.rawEvidenceRanges,
      ]),
    };
    if (existing && (
      JSON.stringify(existing.generation) === JSON.stringify(generation) ||
      (start < now - RAW_HORIZON && existing.generation?.scopeKey === scopeKey &&
        JSON.stringify(existing.sourceIds) === JSON.stringify(sourceIds))
    )) continue;
    const candidate: PendingSummary = {
      ...range('6h', start),
      applications: [...new Set(children.flatMap((child) => child.applications))]
        .sort()
        .slice(0, MAX_APPLICATIONS),
      eventCount: children.reduce((count, child) => count + child.eventCount, 0),
      sourceIds,
      generation,
      ...(previous.evidence.length ? { priorContext: previous.evidence } : {}),
      evidence: budgetEvidence(children.map((child) => ({
        id: child.id,
        text: summaryEvidence(child),
      })), MAX_EVIDENCE_BYTES),
    };
    if (eligible(candidate)) pending.push(candidate);
  }
  return pending.sort(
    (a, b) => Date.parse(a.end) - Date.parse(b.end) || compareSummaries(a, b),
  )[0];
}

function preferObservation(candidate: Observation, previous?: Observation): boolean {
  if (!previous) return true;
  const contentSize = candidate.contentBytes - previous.contentBytes;
  return contentSize > 0 || (contentSize === 0 && compareEvidence(candidate, previous) > 0);
}

function sampleObservations(window: Window): Observation[] {
  const candidates = new Map<string, Observation>();
  for (const item of [
    ...[...window.timeSamples.values()].flatMap(({ first, last }) => [first, last]),
    ...window.sourceSamples.values(), ...window.contentSamples.values(),
    ...window.observations.values(), window.first!, window.last!, window.richest!,
  ]) {
    const retained = window.observations.get(item.signature);
    const enriched = !item.content && retained?.content ? { ...item, content: retained.content } : item;
    const previous = candidates.get(item.id);
    if (!previous || enriched.content || !previous.content) candidates.set(item.id, enriched);
  }
  const chronological = [...candidates.values()].sort(compareEvidence);
  const selected = new Map<string, Observation>();
  // Collapse repeated metadata/content while keeping both observed time endpoints.
  for (const item of chronological) {
    const previous = selected.get(item.signature);
    if (!previous || (item.content && !previous.content) ||
        (Boolean(item.content) === Boolean(previous.content) && preferObservation(item, previous))) {
      selected.set(item.signature, item);
    }
  }
  const result = new Map([...selected.values()].map((item) => [item.id, item]));
  result.set(chronological[0]!.id, chronological[0]!);
  result.set(chronological.at(-1)!.id, chronological.at(-1)!);
  return [...result.values()].sort(compareEvidence);
}

/** Share encoded-byte space fairly; short items release their unused share to richer items. */
function budgetEvidence(items: readonly Evidence[], budget: number): Evidence[] {
  budget -= 2; // JSON array delimiters are part of the encoded budget.
  const result = new Map<string, Evidence>();
  const bySize = [...items].sort((a, b) => encodedSize(a) - encodedSize(b) || a.id.localeCompare(b.id));
  for (const [index, item] of bySize.entries()) {
    const allowance = Math.floor(budget / (items.length - index));
    let text = clipText(item.text, MAX_ITEM_BYTES - 128);
    if (encodedSize({ id: item.id, text }) > allowance) {
      let low = 0;
      let high = Buffer.byteLength(text);
      while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        if (encodedSize({ id: item.id, text: clipText(text, middle) }) <= allowance) low = middle;
        else high = middle - 1;
      }
      text = clipText(text, low);
    }
    const evidence = { id: item.id, text };
    budget -= encodedSize(evidence);
    result.set(item.id, evidence);
  }
  return items.map(({ id }) => result.get(id)!);
}

function encodedSize(item: Evidence): number {
  return Buffer.byteLength(JSON.stringify(item)) + 1;
}

function summaryEvidence(summary: StoredComputerHistorySummary): string {
  return `Summary interval: ${summary.start} to ${summary.end}; ${summary.eventCount} events\n` +
    `Title: ${summary.content.title}\nDescription: ${summary.content.description}\n` +
    (summary.content.keywords?.length ? `Keywords: ${summary.content.keywords.join(', ')}\n` : '') +
    `Body:\n${summary.content.body}`;
}

function priorContext(
  stored: ReadonlyMap<string, StoredComputerHistorySummary>,
  start: number,
  includeText: boolean,
  scopeKey?: string,
): { evidence: readonly Evidence[]; includesText: boolean; revision: string; rawEvidenceRanges: readonly EvidenceRange[] } {
  const previous = [...stored.values()]
    .filter((summary) => Date.parse(summary.end) <= start && Date.parse(summary.end) > start - SIX_HOURS &&
      (includeText || !summary.generation?.includesText))
    .filter((summary) => summary.generation?.scopeKey === scopeKey)
    .sort((a, b) => Date.parse(b.end) - Date.parse(a.end) || Date.parse(b.start) - Date.parse(a.start));
  const selected: StoredComputerHistorySummary[] = [];
  for (const summary of previous) {
    if (selected.some((other) => Date.parse(summary.end) > Date.parse(other.start))) continue;
    selected.push(summary);
    if (selected.length === 2) break;
  }
  return {
    includesText: selected.some((summary) => summary.generation?.includesText),
    rawEvidenceRanges: mergeEvidenceRanges(selected.flatMap(summaryCoverage)),
    revision: hash(JSON.stringify(selected.map((summary) => [
      summary.id, summary.eventCount, summary.content, summary.generation,
    ]))),
    evidence: budgetEvidence(selected.reverse().map((summary) => ({
      id: summary.id,
      text: summaryEvidence(summary),
    })), 8 * 1024),
  };
}

function hash(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** Match persisted sample IDs using the same gated projection; invalid events have no identity. */
export function summaryEventId(
  event: ComputerHistorySummaryEvent,
  { includeText = false }: { includeText?: boolean } = {},
): string | null {
  return projectObservation(event, includeText)?.id ?? null;
}

function projectObservation(event: ComputerHistorySummaryEvent, includeText: boolean): Observation | null {
  const time = Date.parse(event.timestamp);
  const kind = observedText(event.kind, 64);
  if (!Number.isFinite(time) || !kind) return null;
  const timestamp = new Date(time).toISOString();
  const name = observedText(event.app?.name, 128);
  const bundleIdentifier = observedText(event.app?.bundleIdentifier, 128);
  const title = observedText(event.window?.title, 256);
  const urlDomain = observedText(event.window?.urlDomain, 256);
  // Content is an explicit caller projection, never a traversal of raw keyboard/AX objects.
  const context = {
    kind,
    ...(name || bundleIdentifier ? { app: { name, bundleIdentifier } } : {}),
    ...(title || urlDomain ? { window: { ...(title ? { title } : {}), ...(urlDomain ? { urlDomain } : {}) } } : {}),
  };
  const metadata = JSON.stringify({ timestamp, ...context });
  const source = hash(event.sourceKey ?? JSON.stringify([
    event.app?.bundleIdentifier || event.app?.name, event.window?.title, event.window?.urlDomain,
  ]));
  const content = includeText && event.content?.trim() ? event.content : undefined;
  const signature = hash(JSON.stringify([source, context, content]));
  const id = `event-${hash(JSON.stringify([timestamp, signature, metadata]))}`;
  return {
    id, timestamp, source, signature, metadata,
    ...(content ? { content: clipText(content, MAX_ITEM_BYTES) } : {}),
    contentBytes: Buffer.byteLength(content ?? ''),
  };
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

function summaryRange(id: string) {
  validateSummaryId(id);
  const level = id.startsWith('10min-') ? '10min' : '6h';
  return range(level, Number(id.slice(level.length + 1)));
}

function summaryCoverage(summary: StoredComputerHistorySummary): readonly EvidenceRange[] {
  return summary.generation?.rawEvidenceRanges ?? [
    // Old dependency IDs cannot recover overwritten input versions. Nongeneration records predate prior context.
    [summary.generation ? EARLIEST_TIME : Date.parse(summary.start), Date.parse(summary.end)],
  ];
}

function mergeEvidenceRanges(ranges: readonly EvidenceRange[]): EvidenceRange[] {
  const merged: EvidenceRange[] = [];
  for (const [start, end] of [...ranges].sort((a, b) => a[0] - b[0] || a[1] - b[1])) {
    const previous = merged.at(-1);
    if (previous && start <= previous[1]) {
      merged[merged.length - 1] = [previous[0], Math.max(previous[1], end)];
    } else {
      merged.push([start, end]);
    }
  }
  if (merged.length > MAX_EVIDENCE_RANGES) {
    // Bound storage without losing ancestry: only the oldest excess gaps become conservative coverage.
    const excess = merged.length - MAX_EVIDENCE_RANGES;
    merged.splice(0, excess + 1, [merged[0]![0], merged[excess]![1]]);
  }
  return merged;
}

function deletionIds(summaries: readonly StoredComputerHistorySummary[], start: number, end: number): string[] {
  const overlaps = ([from, to]: EvidenceRange) => to > start && (start === end ? from <= start : from < end);
  // Preserve consumer-first unlink order without following IDs whose content may have been replaced.
  return [...summaries]
    .sort((a, b) => Date.parse(a.end) - Date.parse(b.end) || Date.parse(b.start) - Date.parse(a.start))
    .filter((summary) => overlaps([Date.parse(summary.start), Date.parse(summary.end)]) ||
      summaryCoverage(summary).some(overlaps))
    .map(({ id }) => id);
}

function isOwnedSummaryFilename(name: string): boolean {
  if (isReadableSummaryFilename(name)) return true;
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

function validateSummaryId(id: string): void {
  if (typeof id !== 'string' || id.length > 23 || !/^(10min|6h)--?\d+$/u.test(id) ||
      !isOwnedSummaryFilename(`${id}.md`)) throw invalidSummary();
}

function isReadableSummaryFilename(name: string): boolean {
  if (Buffer.byteLength(name) > 200) return false;
  const match = /^(\d{4}-\d{2}-\d{2})_(\d{2})-(\d{2})__(10min|6h)__([\p{L}\p{N}][\p{L}\p{N}-]*)\.md$/u.exec(name);
  if (!match) return false;
  const stamp = `${match[1]}T${match[2]}:${match[3]}:00.000Z`;
  const date = new Date(stamp);
  return Number.isFinite(date.getTime()) && date.toISOString() === stamp;
}

function readableSummaryFilename(summary: Pick<StoredComputerHistorySummary, 'id' | 'start' | 'level'>, title: string): string {
  const date = new Date(summary.start);
  const pad = (value: number) => String(value).padStart(2, '0');
  const stamp = `${String(date.getFullYear()).padStart(4, '0')}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_${pad(date.getHours())}-${pad(date.getMinutes())}`;
  const words = title.normalize('NFKC').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/gu, '');
  let topic = '';
  for (const char of words) {
    if (Buffer.byteLength(topic + char) > 108 || [...topic].length >= 48) break;
    topic += char;
  }
  const name = `${stamp}__${summary.level}__${topic.replace(/-$/u, '') || 'Activity-summary'}.md`;
  return isReadableSummaryFilename(name) ? name : `${summary.id}.md`;
}

function compareSummaries(
  a: Pick<StoredComputerHistorySummary, 'start' | 'id'>,
  b: Pick<StoredComputerHistorySummary, 'start' | 'id'>,
): number {
  return a.start.localeCompare(b.start) || a.id.localeCompare(b.id);
}

function compareEvidence(
  a: { id: string; timestamp: string },
  b: { id: string; timestamp: string },
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
    'filename',
    'level',
    'start',
    'end',
    'applications',
    'eventCount',
    'sourceIds',
    'generation',
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
    (data.filename === undefined
      ? filename !== `${expected.id}.md`
      : data.filename !== filename || !isReadableSummaryFilename(filename) ||
        !filename.includes(`__${data.level}__`))
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
  const headerContent = record(data.content, ['title', 'description', 'keywords', 'suggestion']);
  let generation: StoredComputerHistorySummary['generation'];
  if (data.generation !== undefined) {
    const value = record(data.generation, ['version', 'locale', 'sourceRevision', 'includesText', 'scopeKey', 'priorContextIds', 'rawEvidenceRanges']);
    if (!Number.isSafeInteger(value.version) || (value.version as number) < 1 ||
        (value.locale !== undefined && !isUiLocale(value.locale)) ||
        typeof value.includesText !== 'boolean' ||
        typeof value.sourceRevision !== 'string' || !/^[a-f0-9]{64}$/u.test(value.sourceRevision)) throw invalidSummary();
    let priorContextIds: string[] | undefined;
    if ((value.version as number) >= 3 || value.priorContextIds !== undefined) {
      priorContextIds = stringArray(value.priorContextIds, 2, 23);
      for (const id of priorContextIds) {
        const priorEnd = Date.parse(summaryRange(id).end);
        if (priorEnd > start || priorEnd <= start - SIX_HOURS) throw invalidSummary();
      }
    }
    let rawEvidenceRanges: EvidenceRange[] | undefined;
    if ((value.version as number) >= 4) {
      if (!Array.isArray(value.rawEvidenceRanges) || value.rawEvidenceRanges.length === 0 ||
          value.rawEvidenceRanges.length > MAX_EVIDENCE_RANGES) throw invalidSummary();
      rawEvidenceRanges = [];
      for (const item of value.rawEvidenceRanges) {
        if (!Array.isArray(item) || item.length !== 2) throw invalidSummary();
        const [from, to] = item;
        if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < EARLIEST_TIME ||
            from % TEN_MINUTES !== 0 || to % TEN_MINUTES !== 0 || from >= to ||
            to > start + duration || (rawEvidenceRanges.length > 0 && from <= rawEvidenceRanges.at(-1)![1])) {
          throw invalidSummary();
        }
        rawEvidenceRanges.push([from, to]);
      }
      const ownRanges: EvidenceRange[] = data.level === '10min'
        ? [[start, start + duration]]
        : sourceIds.map((id) => {
          const child = summaryRange(id);
          return [Date.parse(child.start), Date.parse(child.end)];
        });
      if (ownRanges.some(([from, to]) => !rawEvidenceRanges!.some(([a, b]) => a <= from && b >= to))) {
        throw invalidSummary();
      }
    } else if (value.rawEvidenceRanges !== undefined) {
      throw invalidSummary();
    }
    generation = {
      version: value.version as number,
      ...(value.locale !== undefined ? { locale: value.locale as UiLocale } : {}),
      sourceRevision: value.sourceRevision,
      includesText: value.includesText === true,
      ...(value.scopeKey !== undefined ? { scopeKey: validText(value.scopeKey, 256) } : {}),
      ...(priorContextIds !== undefined ? { priorContextIds } : {}),
      ...(rawEvidenceRanges !== undefined ? { rawEvidenceRanges } : {}),
    };
  }
  return {
    ...expected,
    ...(data.filename === undefined ? {} : { filename }),
    applications,
    eventCount: data.eventCount as number,
    sourceIds,
    ...(generation ? { generation } : {}),
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
