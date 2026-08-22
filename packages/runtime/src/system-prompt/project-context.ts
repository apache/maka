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

import { readFile, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

/**
 * Project git context (read-only). Resolves whether a path is inside a git
 * repo and which branch HEAD points at, plus a git-root resolver used by the
 * desktop app's project-root resolution. Pure fs; moved here from
 * apps/desktop/src/main/project-context.ts so the CLI/TUI can reuse the same
 * environment fragment without duplicating the git probe.
 */

export interface ProjectGitInfo {
  isGitRepo: boolean;
  branch?: string;
}

export async function resolveProjectGitInfo(projectRoot: string): Promise<ProjectGitInfo> {
  const gitDir = await resolveGitDir(projectRoot);
  if (!gitDir) return { isGitRepo: false };

  try {
    const head = (await readFile(join(gitDir, 'HEAD'), 'utf8')).trim();
    const match = head.match(/^ref:\s+refs\/heads\/(.+)$/);
    return {
      isGitRepo: true,
      ...(match?.[1] ? { branch: match[1] } : {}),
    };
  } catch {
    return { isGitRepo: true };
  }
}

export async function resolveProjectRoot(candidates: readonly string[]): Promise<string> {
  let firstUsable: string | undefined;
  for (const candidate of candidates) {
    const directory = await normalizeProjectCandidate(candidate);
    if (!directory) continue;
    firstUsable ??= directory;
    const gitRoot = await findGitRoot(directory);
    if (gitRoot) return gitRoot;
  }
  return firstUsable ?? resolve(process.cwd());
}

async function normalizeProjectCandidate(
  candidate: string | undefined,
): Promise<string | undefined> {
  if (!candidate) return undefined;
  const resolved = resolve(candidate);
  const candidateStat = await stat(resolved).catch(() => null);
  if (!candidateStat) return undefined;
  if (candidateStat.isDirectory()) return resolved;
  if (candidateStat.isFile()) return dirname(resolved);
  return undefined;
}

async function findGitRoot(start: string): Promise<string | undefined> {
  let current = start;
  while (true) {
    if (await resolveGitDir(current)) return current;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

async function resolveGitDir(projectRoot: string): Promise<string | undefined> {
  const marker = join(projectRoot, '.git');
  const markerStat = await stat(marker).catch(() => null);
  if (!markerStat) return undefined;
  if (markerStat.isDirectory()) return marker;
  if (!markerStat.isFile()) return undefined;

  try {
    const content = await readFile(marker, 'utf8');
    const match = content.match(/^gitdir:\s*(.+)$/m);
    if (!match?.[1]) return undefined;
    return resolve(dirname(marker), match[1].trim());
  } catch {
    return undefined;
  }
}
