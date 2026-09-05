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
 * Handoff projection over the shared external-session source catalog.
 *
 * Source discovery, identity selection, bounded reads, and native parsing live
 * in the Claude and Codex adapters. This module owns only the untrusted digest
 * projection and its source enable flags.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  FOREIGN_SESSION_SCAN_MAX_AGE_MS,
  FOREIGN_SESSION_SCAN_MAX_SESSIONS,
  sanitizeForeignMessage,
  sanitizeForeignTitle,
  type ForeignSessionDigest,
  type ForeignSessionSource,
  type ForeignSessionSummary,
} from '@maka/core/foreign-session';
import { ClaudeCodeSessionAdapter } from './claude-code-session-adapter.js';
import { CodexSessionAdapter } from './codex-session-adapter.js';
import {
  normalizeSourcePath,
  type ExternalSourceCatalogEntry,
  type ExternalSourceCatalogQuery,
} from './external-source-catalog.js';

export interface ForeignSessionScanOptions {
  /** Only sessions whose recorded cwd matches this path. */
  cwd?: string;
}

export interface ForeignSessionStore {
  /** Which sources are enabled AND present on this machine. */
  availableSources(): Promise<ForeignSessionSource[]>;
  listSessions(options?: ForeignSessionScanOptions): Promise<ForeignSessionSummary[]>;
  readDigest(summary: ForeignSessionSummary): Promise<ForeignSessionDigest>;
}

export interface ForeignSessionStoreOptions {
  /** Overridable for tests. Defaults to os.homedir(). */
  homeDir?: string;
  /** Env for per-source enable flags. Defaults to process.env. */
  env?: Record<string, string | undefined>;
}

/** Default on; set to '0' to disable (cloak-flag convention). */
export function isClaudeCodeImportEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env.MAKA_IMPORT_CLAUDE_CODE !== '0';
}

export function isCodexImportEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env.MAKA_IMPORT_CODEX !== '0';
}

export function createForeignSessionStore(
  options: ForeignSessionStoreOptions = {},
): ForeignSessionStore {
  return new FileForeignSessionStore(options.homeDir ?? homedir(), options.env ?? process.env);
}

interface CatalogReader {
  readonly id: ForeignSessionSource;
  detect(): Promise<boolean>;
  listCatalogEntries(
    query: ExternalSourceCatalogQuery,
  ): Promise<readonly ExternalSourceCatalogEntry[]>;
  readDigest(summary: ForeignSessionSummary): Promise<ForeignSessionDigest>;
}

class FileForeignSessionStore implements ForeignSessionStore {
  private readonly readers: readonly CatalogReader[];

  constructor(
    private readonly homeDir: string,
    private readonly env: Record<string, string | undefined>,
  ) {
    this.readers = [
      new ClaudeCodeSessionAdapter({ claudeHome: join(homeDir, '.claude') }),
      new CodexSessionAdapter({ codexHome: join(homeDir, '.codex') }),
    ];
  }

  async availableSources(): Promise<ForeignSessionSource[]> {
    const available: ForeignSessionSource[] = [];
    for (const reader of this.readers) {
      if (!sourceEnabled(reader.id, this.env)) continue;
      if (await reader.detect()) available.push(reader.id);
    }
    return available;
  }

  async listSessions(options: ForeignSessionScanOptions = {}): Promise<ForeignSessionSummary[]> {
    const nowMs = Date.now();
    const query: ExternalSourceCatalogQuery = {
      cwd: options.cwd,
      maxAgeMs: FOREIGN_SESSION_SCAN_MAX_AGE_MS,
      nowMs,
      limit: FOREIGN_SESSION_SCAN_MAX_SESSIONS,
    };
    const results: ForeignSessionSummary[] = [];
    for (const reader of this.readers) {
      if (!sourceEnabled(reader.id, this.env) || !(await reader.detect())) continue;
      const entries = await reader.listCatalogEntries(query);
      results.push(...entries.map(toForeignSummary));
    }
    results.sort((a, b) => b.updatedAtMs - a.updatedAtMs);
    return results.slice(0, FOREIGN_SESSION_SCAN_MAX_SESSIONS).map((summary) => ({
      ...summary,
      cwd: sanitizeForeignMessage(summary.cwd),
      ...(summary.gitBranch !== undefined
        ? { gitBranch: sanitizeForeignTitle(summary.gitBranch) }
        : {}),
    }));
  }

  async readDigest(summary: ForeignSessionSummary): Promise<ForeignSessionDigest> {
    const reader = this.readers.find((candidate) => candidate.id === summary.source);
    if (!reader) throw new Error(`Unsupported foreign session source: ${summary.source}`);
    return reader.readDigest(summary);
  }
}

function toForeignSummary(entry: ExternalSourceCatalogEntry): ForeignSessionSummary {
  return {
    source: entry.source,
    id: entry.id,
    title: entry.title,
    cwd: entry.cwd,
    updatedAtMs: entry.updatedAtMs,
    ...(entry.gitBranch !== undefined ? { gitBranch: entry.gitBranch } : {}),
    transcriptPath: entry.transcriptPath,
  };
}

function sourceEnabled(
  source: ForeignSessionSource,
  env: Record<string, string | undefined>,
): boolean {
  return source === 'claude-code' ? isClaudeCodeImportEnabled(env) : isCodexImportEnabled(env);
}

/** SQL pre-filter variants for native Windows paths stored by Codex. */
export function codexCwdSqlVariants(cwd: string): string[] {
  const variants = new Set<string>();
  for (const candidate of [cwd, normalizeSourcePath(cwd)]) {
    for (const separatorForm of [
      candidate,
      candidate.replaceAll('\\', '/'),
      candidate.replaceAll('/', '\\'),
    ]) {
      const withoutTrailingSeparator = separatorForm.replace(/[\\/]+$/, '') || separatorForm;
      variants.add(withoutTrailingSeparator);
      variants.add(`${withoutTrailingSeparator}/`);
      variants.add(`${withoutTrailingSeparator}\\`);
    }
  }
  return [...variants];
}
