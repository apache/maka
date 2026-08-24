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

import { lstat, readdir, readFile, realpath, stat } from 'node:fs/promises';
import { basename, extname, join, resolve } from 'node:path';
import { z } from 'zod';
import { isPathInside, toRelative } from './path-containment.js';
import type { MakaTool } from './tool-runtime.js';

export const EXPLORE_AGENT_TOOL_NAME = 'ExploreAgent';

const DEFAULT_MAX_FILES = 30;
const DEFAULT_MAX_MATCHES = 60;
const MAX_ROOTS = 5;
const MAX_QUERIES = 8;
const MAX_IGNORE_PATHS = 20;
const MAX_DISCOVERED_FILES = 250;
const MAX_FILE_BYTES = 512 * 1024;
const MAX_TOTAL_BYTES = 2 * 1024 * 1024;
const MATCH_CONTEXT_CHARS = 220;

const PROJECT_MANIFEST_FILES = new Set([
  'package.json',
  'pnpm-workspace.yaml',
  'turbo.json',
  'vite.config.ts',
  'vite.config.js',
  'tsconfig.json',
  'Cargo.toml',
  'go.mod',
  'pyproject.toml',
  'Package.swift',
]);

const DOCUMENTATION_FILES = new Set([
  'README.md',
  'AGENTS.md',
  'CLAUDE.md',
  'GEMINI.md',
  'CONTRIBUTING.md',
  'ARCHITECTURE.md',
]);

const ENTRYPOINT_NAMES = new Set([
  'main.ts',
  'main.tsx',
  'main.js',
  'main.jsx',
  'index.ts',
  'index.tsx',
  'index.js',
  'index.jsx',
  'server.ts',
  'server.js',
  'app.ts',
  'app.tsx',
  'app.js',
  'app.jsx',
]);

const IGNORED_DIRS = new Set([
  '.git',
  '.hg',
  '.svn',
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.next',
  '.turbo',
  '.vite',
  '.cache',
  '.svelte-kit',
  'DerivedData',
]);

const TEXT_EXTENSIONS = new Set([
  '',
  '.c',
  '.cc',
  '.conf',
  '.cpp',
  '.css',
  '.csv',
  '.env',
  '.go',
  '.h',
  '.hpp',
  '.html',
  '.java',
  '.js',
  '.json',
  '.jsx',
  '.lock',
  '.log',
  '.mjs',
  '.md',
  '.mdx',
  '.py',
  '.rb',
  '.rs',
  '.sh',
  '.sql',
  '.swift',
  '.toml',
  '.ts',
  '.tsx',
  '.txt',
  '.vue',
  '.xml',
  '.yaml',
  '.yml',
]);

const SENSITIVE_TEXT_FILE_NAMES = new Set([
  '.env',
  '.env.local',
  '.env.development',
  '.env.production',
  '.env.test',
  '.npmrc',
  '.pypirc',
  '.netrc',
  'credentials.json',
  'secrets.json',
  'id_rsa',
  'id_dsa',
  'id_ecdsa',
  'id_ed25519',
]);

export interface ExploreAgentResult {
  kind: 'explore_agent';
  ok: boolean;
  partial: boolean;
  terminalStatus: ExploreAgentTerminalStatus;
  mode: 'read_only';
  objective: string;
  roots: string[];
  queries: string[];
  ignoredPaths: string[];
  stoppingCondition: string;
  limitReasons: ExploreAgentLimitReason[];
  filesDiscovered: number;
  filesInspected: number;
  filesSkipped: number;
  sensitiveFilesSkipped: number;
  bytesRead: number;
  startedAt: number;
  completedAt: number;
  durationMs: number;
  progress: string[];
  recentEvents: ExploreAgentEvent[];
  evidence: Array<{
    type: 'match' | 'candidate';
    path: string;
    line?: number;
    label: string;
    score?: number;
  }>;
  summary: string;
  report: string;
  candidateFiles: Array<{ path: string; score: number; reasons: string[] }>;
  matches: Array<{ path: string; line: number; query: string; snippet: string }>;
  notes: string[];
  reason?: 'invalid_objective' | 'invalid_root' | 'no_readable_roots' | 'aborted';
  message?: string;
}

type ExploreAgentTerminalStatus =
  | 'completed'
  | 'completed_empty'
  | 'failed'
  | 'canceled'
  | 'canceled_partial';
type ExploreAgentLimitReason = 'candidate_budget' | 'file_budget' | 'match_budget' | 'byte_budget';

export interface ExploreAgentEvent {
  type:
    | 'started'
    | 'scope_resolved'
    | 'scan'
    | 'read'
    | 'checkpoint'
    | 'completed'
    | 'failed'
    | 'aborted'
    | 'progress';
  at: number;
  message: string;
}

interface ProgressState {
  messages: string[];
  recentEvents: ExploreAgentEvent[];
}

export function buildExploreAgentTool(): MakaTool<
  {
    objective: string;
    roots?: string[];
    queries?: string[];
    ignorePaths?: string[];
    stoppingCondition?: string;
    maxFiles?: number;
    maxMatches?: number;
  },
  ExploreAgentResult
> {
  return {
    name: EXPLORE_AGENT_TOOL_NAME,
    displayName: '只读探索',
    description:
      'Run a bounded read-only local exploration worker for a self-contained research question. ' +
      'It inspects filenames and text snippets under the session cwd only, returns candidate files and source-grounded matches, ' +
      'and never writes files, starts services, installs packages, or uses the network. Use it when a separate investigation saves main-thread work. ' +
      'Do not use it for one known file, a specific symbol, package scripts, test setup, config, or 1-3 obvious files; inspect those directly.',
    parameters: z.object({
      objective: z
        .string()
        .min(4)
        .max(600)
        .describe('Specific research objective for the read-only worker.'),
      roots: z
        .array(z.string().min(1).max(240))
        .max(MAX_ROOTS)
        .optional()
        .describe('Optional relative roots under the session cwd. Defaults to the session cwd.'),
      queries: z
        .array(z.string().min(1).max(120))
        .max(MAX_QUERIES)
        .optional()
        .describe('Optional search terms. If omitted, terms are derived from the objective.'),
      ignorePaths: z
        .array(z.string().min(1).max(240))
        .max(MAX_IGNORE_PATHS)
        .optional()
        .describe(
          'Optional relative files or directories to skip, such as generated output, vendors, or build artifacts.',
        ),
      stoppingCondition: z
        .string()
        .min(1)
        .max(240)
        .optional()
        .describe(
          'Optional plain-language condition that tells the worker when this investigation is sufficiently answered.',
        ),
      maxFiles: z.number().int().min(1).max(80).optional(),
      maxMatches: z.number().int().min(1).max(120).optional(),
    }),
    categoryHint: 'subagent',
    impl: async (
      { objective, roots, queries, ignorePaths, stoppingCondition, maxFiles, maxMatches },
      { cwd, abortSignal, emitOutput },
    ) => {
      return runReadOnlyExplore({
        cwd,
        objective,
        roots,
        queries,
        ignorePaths,
        stoppingCondition,
        maxFiles,
        maxMatches,
        abortSignal,
        onProgress: (message) => emitOutput('stdout', `${message}\n`),
      });
    },
  };
}

export async function runReadOnlyExplore(input: {
  cwd: string;
  objective: string;
  roots?: string[];
  queries?: string[];
  ignorePaths?: string[];
  stoppingCondition?: string;
  maxFiles?: number;
  maxMatches?: number;
  abortSignal?: AbortSignal;
  onProgress?: (message: string) => void;
}): Promise<ExploreAgentResult> {
  const startedAt = Date.now();
  const objective = normalizeText(input.objective).slice(0, 600);
  if (objective.length < 4) {
    return failure(
      'invalid_objective',
      objective,
      [],
      [],
      [],
      '',
      '只读探索需要一个明确的研究目标。',
      [],
      startedAt,
    );
  }

  const roots = normalizeRoots(input.roots);
  const queryTerms = normalizeQueries(input.queries, objective);
  const ignoredPaths = normalizeIgnorePaths(input.ignorePaths);
  const stoppingCondition = normalizeText(input.stoppingCondition).slice(0, 240);
  let workspaceRoot: string;
  try {
    workspaceRoot = await realpath(input.cwd);
  } catch {
    return failure(
      'invalid_root',
      objective,
      roots,
      queryTerms,
      ignoredPaths,
      stoppingCondition,
      '会话工作目录不可读取。',
      [],
      startedAt,
    );
  }
  const maxFiles = clampInteger(input.maxFiles, 1, 80, DEFAULT_MAX_FILES);
  const maxMatches = clampInteger(input.maxMatches, 1, 120, DEFAULT_MAX_MATCHES);
  const discoveryBudget = Math.min(MAX_DISCOVERED_FILES, Math.max(maxFiles * 4, maxFiles));
  const progress = createProgressReporter(input.onProgress);
  if (input.abortSignal?.aborted) {
    return abortFailure(
      objective,
      roots,
      queryTerms,
      ignoredPaths,
      stoppingCondition,
      progress,
      startedAt,
    );
  }
  progress.report(
    'started',
    `只读探索：准备范围（${roots.length} 个 root，${queryTerms.length} 个查询词）`,
  );

  const resolvedRoots: Array<{ abs: string; rel: string }> = [];
  for (const root of roots) {
    if (input.abortSignal?.aborted) {
      return abortFailure(
        objective,
        roots,
        queryTerms,
        ignoredPaths,
        stoppingCondition,
        progress,
        startedAt,
      );
    }
    const resolved = resolve(workspaceRoot, root);
    if (!isPathInside(workspaceRoot, resolved)) {
      return failure(
        'invalid_root',
        objective,
        roots,
        queryTerms,
        ignoredPaths,
        stoppingCondition,
        `root 必须位于会话工作目录内：${root}`,
        progress,
        startedAt,
      );
    }
    try {
      const actual = await realpath(resolved);
      if (!isPathInside(workspaceRoot, actual)) {
        return failure(
          'invalid_root',
          objective,
          roots,
          queryTerms,
          ignoredPaths,
          stoppingCondition,
          `root 不能穿过符号链接离开工作目录：${root}`,
          progress,
          startedAt,
        );
      }
      const rootStat = await stat(actual);
      if (!rootStat.isDirectory() && !rootStat.isFile()) continue;
      resolvedRoots.push({ abs: actual, rel: toRelative(workspaceRoot, actual) });
    } catch {
      // Missing roots are reported through notes instead of failing the whole worker.
    }
  }
  if (resolvedRoots.length === 0) {
    return failure(
      'no_readable_roots',
      objective,
      roots,
      queryTerms,
      ignoredPaths,
      stoppingCondition,
      '没有可读取的研究范围。',
      progress,
      startedAt,
    );
  }
  progress.report(
    'scope_resolved',
    `只读探索：确认 ${resolvedRoots.length} 个可读范围：${resolvedRoots.map((root) => root.rel).join(', ')}`,
  );

  const files: string[] = [];
  const notes: string[] = [
    '只读探索边界：不写文件、不联网、不启动进程。',
    `搜索预算：最多读取 ${maxFiles} 个文件、返回 ${maxMatches} 处命中、读取 ${Math.round(MAX_TOTAL_BYTES / 1024)} KiB 文本。`,
  ];
  if (ignoredPaths.length > 0) {
    notes.push(`已按请求忽略：${ignoredPaths.join(', ')}`);
  }
  if (stoppingCondition) {
    notes.push(`停止条件：${stoppingCondition}`);
  }
  let filesSkipped = 0;
  let sensitiveFilesSkipped = 0;
  const limitReasons: ExploreAgentLimitReason[] = [];
  for (const root of resolvedRoots) {
    if (input.abortSignal?.aborted) {
      return abortFailure(
        objective,
        roots,
        queryTerms,
        ignoredPaths,
        stoppingCondition,
        progress,
        startedAt,
      );
    }
    const before = files.length;
    const skippedBefore = filesSkipped;
    const sensitiveBefore = sensitiveFilesSkipped;
    const listed = await listTextFiles(
      root.abs,
      workspaceRoot,
      discoveryBudget - files.length,
      ignoredPaths,
      input.abortSignal,
    );
    if (listed.aborted) {
      return abortFailure(
        objective,
        roots,
        queryTerms,
        ignoredPaths,
        stoppingCondition,
        progress,
        startedAt,
      );
    }
    files.push(...listed.files);
    filesSkipped += listed.skipped;
    sensitiveFilesSkipped += listed.sensitiveSkipped;
    if (listed.truncated) {
      addLimitReason(limitReasons, 'candidate_budget');
      notes.push(`范围 ${root.rel} 已到达候选文件预算，后续文件未继续扫描。`);
    }
    if (files.length === before) notes.push(`范围 ${root.rel} 在预算内没有可读取文本文件。`);
    const found = files.length - before;
    const skipped = filesSkipped - skippedBefore;
    const sensitive = sensitiveFilesSkipped - sensitiveBefore;
    progress.report(
      'scan',
      `只读探索：扫描 ${root.rel}，找到 ${found} 个文本候选，跳过 ${skipped} 项${sensitive > 0 ? `（含 ${sensitive} 个敏感文件）` : ''}`,
    );
    if (files.length >= discoveryBudget) break;
  }
  files.sort((left, right) => {
    const leftRel = toRelative(workspaceRoot, left);
    const rightRel = toRelative(workspaceRoot, right);
    const leftScore = scorePath(leftRel, queryTerms).score;
    const rightScore = scorePath(rightRel, queryTerms).score;
    return rightScore - leftScore || leftRel.localeCompare(rightRel);
  });
  if (
    files.some((file) =>
      scorePath(toRelative(workspaceRoot, file), queryTerms).reasons.some((reason) =>
        reason.startsWith('project '),
      ),
    )
  ) {
    notes.push('广泛研究会优先读取项目配置、文档、入口和测试线索。');
  }
  const filesToInspect = files.slice(0, maxFiles);
  if (files.length > filesToInspect.length) {
    addLimitReason(limitReasons, 'file_budget');
    notes.push(
      `已发现 ${files.length} 个文本候选；按查询命中和项目结构分读取前 ${filesToInspect.length} 个。`,
    );
  }

  const candidates = new Map<string, { path: string; score: number; reasons: Set<string> }>();
  const matches: ExploreAgentResult['matches'] = [];
  let bytesRead = 0;
  let inspected = 0;

  progress.report('read', `只读探索：开始读取 ${filesToInspect.length} 个候选文件`);
  for (const file of filesToInspect) {
    if (input.abortSignal?.aborted) {
      return partialAbortFailure({
        objective,
        roots: resolvedRoots.map((root) => root.rel),
        queryTerms,
        ignoredPaths,
        stoppingCondition,
        limitReasons,
        filesDiscovered: files.length,
        filesInspected: inspected,
        filesSkipped,
        sensitiveFilesSkipped,
        bytesRead,
        candidates,
        matches,
        notes,
        progress,
        startedAt,
      });
    }
    const rel = toRelative(workspaceRoot, file);
    const filenameScore = scorePath(rel, queryTerms);
    if (filenameScore.score > 0) {
      candidates.set(rel, {
        path: rel,
        score: filenameScore.score,
        reasons: new Set(filenameScore.reasons),
      });
    }

    let fileStat;
    try {
      fileStat = await stat(file);
    } catch {
      filesSkipped++;
      continue;
    }
    if (fileStat.size > MAX_FILE_BYTES || bytesRead >= MAX_TOTAL_BYTES) {
      filesSkipped++;
      continue;
    }
    let text: string;
    try {
      text = await readFile(file, 'utf8');
    } catch {
      filesSkipped++;
      continue;
    }
    if (input.abortSignal?.aborted) {
      return partialAbortFailure({
        objective,
        roots: resolvedRoots.map((root) => root.rel),
        queryTerms,
        ignoredPaths,
        stoppingCondition,
        limitReasons,
        filesDiscovered: files.length,
        filesInspected: inspected,
        filesSkipped,
        sensitiveFilesSkipped,
        bytesRead,
        candidates,
        matches,
        notes,
        progress,
        startedAt,
      });
    }
    if (looksBinary(text)) {
      filesSkipped++;
      continue;
    }
    inspected++;
    bytesRead += Buffer.byteLength(text, 'utf8');
    const fileMatches = findMatches(rel, text, queryTerms, maxMatches - matches.length);
    if (fileMatches.length > 0) {
      matches.push(...fileMatches);
      const current = candidates.get(rel) ?? { path: rel, score: 0, reasons: new Set<string>() };
      current.score += fileMatches.length * 3;
      current.reasons.add('content match');
      candidates.set(rel, current);
    }
    if (matches.length >= maxMatches || bytesRead >= MAX_TOTAL_BYTES) break;
    if (inspected > 0 && inspected % 10 === 0) {
      progress.report(
        'checkpoint',
        `只读探索：已读取 ${inspected} 个文件，命中 ${matches.length} 处`,
      );
    }
  }

  const candidateFiles = Array.from(candidates.values())
    .map((candidate) => ({
      path: candidate.path,
      score: candidate.score,
      reasons: Array.from(candidate.reasons).sort(),
    }))
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
    .slice(0, 20);

  const evidence = buildEvidenceAnchors(matches, candidateFiles);
  const terminalStatus: ExploreAgentTerminalStatus =
    evidence.length > 0 ? 'completed' : 'completed_empty';
  if (matches.length === 0) notes.push('没有找到内容命中；候选文件可作为下一步阅读清单。');
  if (sensitiveFilesSkipped > 0)
    notes.push(`已跳过 ${sensitiveFilesSkipped} 个疑似本地凭据/密钥文件，只报告数量不读取内容。`);
  if (matches.length >= maxMatches) {
    addLimitReason(limitReasons, 'match_budget');
    notes.push(`命中预算已用尽；只返回前 ${maxMatches} 处内容命中。`);
  }
  if (bytesRead >= MAX_TOTAL_BYTES) {
    addLimitReason(limitReasons, 'byte_budget');
    notes.push('总读取预算已用尽，部分候选文件未继续读取。');
  }
  progress.report(
    'completed',
    `只读探索：完成，读取 ${inspected} 个文件，命中 ${matches.length} 处，候选 ${candidateFiles.length} 个`,
  );
  const completedAt = Date.now();
  const durationMs = Math.max(0, completedAt - startedAt);
  const summary = buildResultSummary({
    filesDiscovered: files.length,
    filesInspected: inspected,
    matches: matches.length,
    evidence: evidence.length,
    candidateFiles: candidateFiles.length,
    durationMs,
  });
  const report = buildResearchReport({
    statusLine: presentExploreAgentTerminalStatus(terminalStatus),
    objective,
    roots: resolvedRoots.map((root) => root.rel),
    queryTerms,
    stoppingCondition,
    limitReasons,
    filesDiscovered: files.length,
    filesInspected: inspected,
    filesSkipped,
    sensitiveFilesSkipped,
    bytesRead,
    evidence,
    candidateFiles,
    matches,
    notes,
    durationMs,
  });

  return {
    kind: 'explore_agent',
    ok: true,
    partial: false,
    terminalStatus,
    mode: 'read_only',
    objective,
    roots: resolvedRoots.map((root) => root.rel),
    queries: queryTerms,
    ignoredPaths,
    stoppingCondition,
    limitReasons,
    filesDiscovered: files.length,
    filesInspected: inspected,
    filesSkipped,
    sensitiveFilesSkipped,
    bytesRead,
    startedAt,
    completedAt,
    durationMs,
    progress: progress.messages,
    recentEvents: progress.recentEvents,
    evidence,
    summary,
    report,
    candidateFiles,
    matches,
    notes,
  };
}

function createProgressReporter(onProgress: ((message: string) => void) | undefined): {
  messages: string[];
  recentEvents: ExploreAgentEvent[];
  report(type: ExploreAgentEvent['type'], message: string): void;
} {
  let emitted = 0;
  const messages: string[] = [];
  const recentEvents: ExploreAgentEvent[] = [];
  return {
    messages,
    recentEvents,
    report(type, message) {
      appendExploreEvent(recentEvents, { type, at: Date.now(), message });
      if (emitted < 12) {
        emitted++;
        messages.push(message);
      }
      onProgress?.(message);
    },
  };
}

function appendExploreEvent(events: ExploreAgentEvent[], event: ExploreAgentEvent): void {
  events.push(event);
  while (events.length > 20) {
    const evictIndex = events.findIndex((item) => !isLifecycleExploreEvent(item.type));
    events.splice(evictIndex >= 0 ? evictIndex : 0, 1);
  }
}

function addLimitReason(reasons: ExploreAgentLimitReason[], reason: ExploreAgentLimitReason): void {
  if (!reasons.includes(reason)) reasons.push(reason);
}

function isLifecycleExploreEvent(type: ExploreAgentEvent['type']): boolean {
  return type === 'started' || type === 'completed' || type === 'failed' || type === 'aborted';
}

async function listTextFiles(
  root: string,
  workspaceRoot: string,
  budget: number,
  ignoredPaths: string[],
  abortSignal?: AbortSignal,
): Promise<{
  files: string[];
  skipped: number;
  sensitiveSkipped: number;
  aborted: boolean;
  truncated: boolean;
}> {
  const files: string[] = [];
  let skipped = 0;
  let sensitiveSkipped = 0;
  let aborted = false;
  let truncated = false;

  async function walk(abs: string): Promise<void> {
    if (abortSignal?.aborted) {
      aborted = true;
      return;
    }
    if (files.length >= budget) {
      truncated = true;
      return;
    }
    let entryStat;
    try {
      entryStat = await lstat(abs);
    } catch {
      skipped++;
      return;
    }
    if (entryStat.isSymbolicLink()) {
      skipped++;
      return;
    }
    const rel = toRelative(workspaceRoot, abs);
    if (rel !== '.' && isIgnoredPath(rel, ignoredPaths)) {
      skipped++;
      return;
    }
    if (entryStat.isFile()) {
      if (isSensitiveTextFile(abs)) {
        skipped++;
        sensitiveSkipped++;
      } else if (isLikelyTextFile(abs)) {
        files.push(abs);
      } else {
        skipped++;
      }
      return;
    }
    if (!entryStat.isDirectory()) {
      skipped++;
      return;
    }
    if (abs !== root && shouldSkipDir(abs)) {
      skipped++;
      return;
    }
    let entries;
    try {
      entries = await readdir(abs, { withFileTypes: true });
    } catch {
      skipped++;
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (abortSignal?.aborted) {
        aborted = true;
        return;
      }
      if (files.length >= budget) {
        truncated = true;
        return;
      }
      const child = join(abs, entry.name);
      if (!isPathInside(workspaceRoot, child)) {
        skipped++;
        continue;
      }
      await walk(child);
    }
  }

  await walk(root);
  return { files, skipped, sensitiveSkipped, aborted, truncated };
}

function normalizeRoots(roots: string[] | undefined): string[] {
  const normalized = (roots && roots.length > 0 ? roots : ['.'])
    .map((root) => root.trim())
    .filter(Boolean)
    .slice(0, MAX_ROOTS);
  return normalized.length > 0 ? normalized : ['.'];
}

function normalizeQueries(queries: string[] | undefined, objective: string): string[] {
  const explicit = (queries ?? []).map(normalizeText).filter((query) => query.length > 0);
  const source = explicit.length > 0 ? explicit : deriveQueries(objective);
  return Array.from(new Set(source.map((query) => query.slice(0, 120)))).slice(0, MAX_QUERIES);
}

function normalizeIgnorePaths(paths: string[] | undefined): string[] {
  const normalized: string[] = [];
  for (const raw of paths ?? []) {
    const value = raw
      .trim()
      .replace(/\\/g, '/')
      .replace(/^\.\/+/, '')
      .replace(/\/+$/g, '');
    if (!value || value === '.' || value === '..' || value.startsWith('/') || value.includes('\0'))
      continue;
    const segments = value.split('/').filter(Boolean);
    if (segments.length === 0 || segments.some((segment) => segment === '.' || segment === '..'))
      continue;
    normalized.push(segments.join('/').slice(0, 160));
    if (normalized.length >= MAX_IGNORE_PATHS) break;
  }
  return Array.from(new Set(normalized));
}

function isIgnoredPath(path: string, ignoredPaths: string[]): boolean {
  return ignoredPaths.some((ignored) => path === ignored || path.startsWith(`${ignored}/`));
}

function deriveQueries(objective: string): string[] {
  const words = objective
    .split(/[^\p{L}\p{N}_-]+/u)
    .map((word) => word.trim())
    .filter((word) => word.length >= 3 && !COMMON_WORDS.has(word.toLowerCase()));
  return words.length > 0 ? words.slice(0, MAX_QUERIES) : [objective.slice(0, 80)];
}

const COMMON_WORDS = new Set([
  'the',
  'and',
  'for',
  'with',
  'this',
  'that',
  'from',
  'project',
  'research',
  'please',
]);

function normalizeText(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

function clampInteger(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value)
    ? Math.max(min, Math.min(max, value))
    : fallback;
}

function shouldSkipDir(abs: string): boolean {
  return IGNORED_DIRS.has(basename(abs));
}

function isLikelyTextFile(abs: string): boolean {
  return TEXT_EXTENSIONS.has(extname(abs).toLowerCase());
}

function isSensitiveTextFile(abs: string): boolean {
  const base = basename(abs).toLowerCase();
  if (SENSITIVE_TEXT_FILE_NAMES.has(base)) return true;
  if (base.startsWith('.env.')) return true;
  if (/\.(pem|key|p12|pfx|crt|cer)$/i.test(base)) return true;
  return false;
}

function scorePath(path: string, queries: string[]): { score: number; reasons: string[] } {
  const lowerPath = path.toLowerCase();
  const base = basename(path);
  const lowerBase = base.toLowerCase();
  const reasons: string[] = [];
  let score = 0;
  if (PROJECT_MANIFEST_FILES.has(base)) {
    score += 12;
    reasons.push('project manifest');
  }
  if (DOCUMENTATION_FILES.has(base)) {
    score += 10;
    reasons.push('project documentation');
  }
  if (ENTRYPOINT_NAMES.has(lowerBase)) {
    score += 8;
    reasons.push('project entrypoint');
  }
  if (
    /\b(__tests__|tests?|specs?|e2e)\b/i.test(path) ||
    /\.(test|spec)\.[cm]?[jt]sx?$/i.test(path)
  ) {
    score += 6;
    reasons.push('project test surface');
  }
  if (/\b(src|app|packages|apps)\b/i.test(path)) {
    score += 2;
    reasons.push('project source surface');
  }
  for (const query of queries) {
    const lowerQuery = query.toLowerCase();
    if (lowerPath.includes(lowerQuery)) {
      score += 5;
      reasons.push(`path contains "${query}"`);
    }
  }
  return { score, reasons };
}

function findMatches(
  path: string,
  text: string,
  queries: string[],
  remaining: number,
): ExploreAgentResult['matches'] {
  if (remaining <= 0) return [];
  const matches: ExploreAgentResult['matches'] = [];
  const lines = text.split(/\r?\n/);
  const lowerQueries = queries.map((query) => ({ raw: query, lower: query.toLowerCase() }));
  for (let index = 0; index < lines.length; index++) {
    const lowerLine = lines[index]!.toLowerCase();
    const query = lowerQueries.find((item) => lowerLine.includes(item.lower));
    if (!query) continue;
    matches.push({
      path,
      line: index + 1,
      query: query.raw,
      snippet: capSnippet(lines[index]!),
    });
    if (matches.length >= remaining) break;
  }
  return matches;
}

function buildEvidenceAnchors(
  matches: ExploreAgentResult['matches'],
  candidateFiles: ExploreAgentResult['candidateFiles'],
): ExploreAgentResult['evidence'] {
  const anchors: ExploreAgentResult['evidence'] = [];
  const seen = new Set<string>();

  for (const match of matches) {
    if (anchors.length >= 10) break;
    const key = `${match.path}:${match.line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    anchors.push({
      type: 'match',
      path: match.path,
      line: match.line,
      label: `内容命中：${match.query}`,
    });
  }

  for (const candidate of candidateFiles) {
    if (anchors.length >= 10) break;
    if (seen.has(candidate.path)) continue;
    seen.add(candidate.path);
    anchors.push({
      type: 'candidate',
      path: candidate.path,
      label: evidenceLabelForCandidate(candidate.reasons),
      score: candidate.score,
    });
  }

  return anchors;
}

function buildResearchReport(input: {
  statusLine?: string;
  objective: string;
  roots: string[];
  queryTerms: string[];
  stoppingCondition: string;
  limitReasons: ExploreAgentLimitReason[];
  filesDiscovered: number;
  filesInspected: number;
  filesSkipped: number;
  sensitiveFilesSkipped: number;
  bytesRead: number;
  evidence: ExploreAgentResult['evidence'];
  candidateFiles: ExploreAgentResult['candidateFiles'];
  matches: ExploreAgentResult['matches'];
  notes: string[];
  durationMs: number;
}): string {
  const lines = [
    ...(input.statusLine ? [`状态：${input.statusLine}`] : []),
    `目标：${input.objective}`,
    `范围：${input.roots.length > 0 ? input.roots.join(', ') : '.'}`,
    `查询：${input.queryTerms.length > 0 ? input.queryTerms.join(', ') : '未指定'}`,
    ...(input.stoppingCondition ? [`停止条件：${input.stoppingCondition}`] : []),
    ...(input.limitReasons.length > 0
      ? [`预算边界：${input.limitReasons.map(presentExploreAgentLimitReason).join('、')}`]
      : []),
    `发现/读取：${input.filesDiscovered} / ${input.filesInspected} 个文件，跳过 ${input.filesSkipped} 个${input.sensitiveFilesSkipped > 0 ? `（含敏感 ${input.sensitiveFilesSkipped} 个）` : ''}，${formatReportBytes(input.bytesRead)}，耗时 ${formatReportDuration(input.durationMs)}`,
  ];

  if (input.evidence.length > 0) {
    lines.push('', '证据锚点：');
    for (const item of input.evidence.slice(0, 8)) {
      lines.push(
        `- ${item.path}${typeof item.line === 'number' ? `:${item.line}` : ''} — ${item.label}`,
      );
    }
  }

  if (input.matches.length > 0) {
    lines.push('', '命中片段：');
    for (const match of input.matches.slice(0, 5)) {
      lines.push(`- ${match.path}:${match.line} [${match.query}] ${match.snippet}`);
    }
  }

  if (input.candidateFiles.length > 0) {
    lines.push('', '下一步阅读：');
    for (const candidate of input.candidateFiles.slice(0, 5)) {
      lines.push(`- ${candidate.path}（分数 ${candidate.score}）`);
    }
  }

  if (input.notes.length > 0) {
    lines.push('', '说明：');
    for (const note of input.notes.slice(0, 5)) {
      lines.push(`- ${note}`);
    }
  }

  return capReport(lines.join('\n'));
}

function presentExploreAgentTerminalStatus(status: ExploreAgentTerminalStatus): string {
  switch (status) {
    case 'completed':
      return '完成，已找到可交接证据。';
    case 'completed_empty':
      return '完成，但没有找到可交接证据。';
    case 'failed':
      return '失败，未产生结果。';
    case 'canceled':
      return '已取消，未产生结果。';
    case 'canceled_partial':
      return '已取消，以下为取消前部分结果。';
  }
}

function buildResultSummary(input: {
  filesDiscovered: number;
  filesInspected: number;
  matches: number;
  evidence: number;
  candidateFiles: number;
  durationMs: number;
}): string {
  return [
    `发现 ${input.filesDiscovered} 个候选`,
    `读取 ${input.filesInspected} 个文件`,
    `命中 ${input.matches} 处`,
    `证据 ${input.evidence} 个`,
    `候选 ${input.candidateFiles} 个`,
    `耗时 ${formatReportDuration(input.durationMs)}`,
  ].join(' · ');
}

function presentExploreAgentLimitReason(reason: ExploreAgentLimitReason): string {
  switch (reason) {
    case 'candidate_budget':
      return '候选文件预算已满';
    case 'file_budget':
      return '读取文件预算已满';
    case 'match_budget':
      return '命中预算已满';
    case 'byte_budget':
      return '读取字节预算已满';
  }
}

function formatReportBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return `${Math.round(bytes / 1024)} KiB`;
}

function formatReportDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}

function capReport(report: string): string {
  return Array.from(report).slice(0, 6000).join('');
}

function evidenceLabelForCandidate(reasons: string[]): string {
  if (reasons.includes('project manifest')) return '项目配置锚点';
  if (reasons.includes('project documentation')) return '项目文档锚点';
  if (reasons.includes('project entrypoint')) return '入口文件锚点';
  if (reasons.includes('project test surface')) return '测试线索锚点';
  if (reasons.includes('project source surface')) return '源码线索锚点';
  if (reasons.includes('content match')) return '内容命中锚点';
  return '候选阅读锚点';
}

function capSnippet(line: string): string {
  const cleaned = line.replace(/\s+/g, ' ').trim();
  return Array.from(cleaned).slice(0, MATCH_CONTEXT_CHARS).join('');
}

function looksBinary(text: string): boolean {
  return text.includes('\u0000');
}

function failure(
  reason: NonNullable<ExploreAgentResult['reason']>,
  objective: string,
  roots: string[],
  queries: string[],
  ignoredPaths: string[],
  stoppingCondition: string,
  message: string,
  progress: string[] | ProgressState = [],
  startedAt = Date.now(),
): ExploreAgentResult {
  const completedAt = Date.now();
  const progressState = normalizeProgressState(progress, startedAt);
  appendExploreEvent(progressState.recentEvents, {
    type: reason === 'aborted' ? 'aborted' : 'failed',
    at: completedAt,
    message,
  });
  return {
    kind: 'explore_agent',
    ok: false,
    partial: false,
    terminalStatus: reason === 'aborted' ? 'canceled' : 'failed',
    mode: 'read_only',
    objective,
    roots,
    queries,
    ignoredPaths,
    stoppingCondition,
    limitReasons: [],
    filesDiscovered: 0,
    filesInspected: 0,
    filesSkipped: 0,
    sensitiveFilesSkipped: 0,
    bytesRead: 0,
    startedAt,
    completedAt,
    durationMs: Math.max(0, completedAt - startedAt),
    progress: progressState.messages,
    recentEvents: progressState.recentEvents,
    evidence: [],
    summary: `未完成：${message}`,
    report: '',
    candidateFiles: [],
    matches: [],
    notes: ['只读探索边界：不写文件、不联网、不启动进程。'],
    reason,
    message,
  };
}

function partialAbortFailure(input: {
  objective: string;
  roots: string[];
  queryTerms: string[];
  ignoredPaths: string[];
  stoppingCondition: string;
  limitReasons: ExploreAgentLimitReason[];
  filesDiscovered: number;
  filesInspected: number;
  filesSkipped: number;
  sensitiveFilesSkipped: number;
  bytesRead: number;
  candidates: Map<string, { path: string; score: number; reasons: Set<string> }>;
  matches: ExploreAgentResult['matches'];
  notes: string[];
  progress: ProgressState;
  startedAt: number;
}): ExploreAgentResult {
  if (input.filesInspected <= 0 && input.matches.length === 0 && input.candidates.size === 0) {
    return abortFailure(
      input.objective,
      input.roots,
      input.queryTerms,
      input.ignoredPaths,
      input.stoppingCondition,
      input.progress,
      input.startedAt,
    );
  }
  const completedAt = Date.now();
  appendExploreEvent(input.progress.recentEvents, {
    type: 'aborted',
    at: completedAt,
    message: '只读探索已取消，已保留取消前的部分结果。',
  });
  const candidateFiles = Array.from(input.candidates.values())
    .map((candidate) => ({
      path: candidate.path,
      score: candidate.score,
      reasons: Array.from(candidate.reasons).sort(),
    }))
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
    .slice(0, 20);
  const evidence = buildEvidenceAnchors(input.matches, candidateFiles);
  const terminalStatus: ExploreAgentTerminalStatus = 'canceled_partial';
  const durationMs = Math.max(0, completedAt - input.startedAt);
  const notes = [...input.notes, '只读探索已取消；以下为取消前已读取的部分结果，不代表完整结论。'];
  const summary = `已取消：${buildResultSummary({
    filesDiscovered: input.filesDiscovered,
    filesInspected: input.filesInspected,
    matches: input.matches.length,
    evidence: evidence.length,
    candidateFiles: candidateFiles.length,
    durationMs,
  })}`;
  const report = buildResearchReport({
    statusLine: presentExploreAgentTerminalStatus(terminalStatus),
    objective: input.objective,
    roots: input.roots,
    queryTerms: input.queryTerms,
    stoppingCondition: input.stoppingCondition,
    filesDiscovered: input.filesDiscovered,
    filesInspected: input.filesInspected,
    filesSkipped: input.filesSkipped,
    sensitiveFilesSkipped: input.sensitiveFilesSkipped,
    bytesRead: input.bytesRead,
    evidence,
    candidateFiles,
    matches: input.matches,
    notes,
    limitReasons: input.limitReasons,
    durationMs,
  });
  return {
    kind: 'explore_agent',
    ok: false,
    partial: true,
    terminalStatus,
    mode: 'read_only',
    objective: input.objective,
    roots: input.roots,
    queries: input.queryTerms,
    ignoredPaths: input.ignoredPaths,
    stoppingCondition: input.stoppingCondition,
    limitReasons: [...input.limitReasons],
    filesDiscovered: input.filesDiscovered,
    filesInspected: input.filesInspected,
    filesSkipped: input.filesSkipped,
    sensitiveFilesSkipped: input.sensitiveFilesSkipped,
    bytesRead: input.bytesRead,
    startedAt: input.startedAt,
    completedAt,
    durationMs,
    progress: [...input.progress.messages],
    recentEvents: [...input.progress.recentEvents],
    evidence,
    summary,
    report,
    candidateFiles,
    matches: [...input.matches],
    notes,
    reason: 'aborted',
    message: '只读探索已取消，已保留取消前的部分结果。',
  };
}

function abortFailure(
  objective: string,
  roots: string[],
  queries: string[],
  ignoredPaths: string[],
  stoppingCondition: string,
  progress: string[] | ProgressState = [],
  startedAt = Date.now(),
): ExploreAgentResult {
  return failure(
    'aborted',
    objective,
    roots,
    queries,
    ignoredPaths,
    stoppingCondition,
    '只读探索已取消。',
    progress,
    startedAt,
  );
}

function normalizeProgressState(
  progress: string[] | ProgressState,
  startedAt: number,
): ProgressState {
  if (!Array.isArray(progress)) {
    return {
      messages: [...progress.messages],
      recentEvents: progress.recentEvents.map((event) => ({ ...event })),
    };
  }
  return {
    messages: [...progress],
    recentEvents: progress.map((message, index) => ({
      type: 'progress',
      at: startedAt + index,
      message,
    })),
  };
}
