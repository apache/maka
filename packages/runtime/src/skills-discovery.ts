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
import { homedir } from 'node:os';
import { lstat, readdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { isPathInside, readContainedRegularFile } from './path-containment.js';
import { validateSkillMetadata } from './skills-metadata.js';
import type { SkillValidationIssue } from './skills-metadata.js';
import {
  getSkillRuntimePreference,
  migrateSkillRuntimePreferences,
  readSkillRuntimeState,
  type SkillRuntimeStatus,
  type SkillRuntimeStateReadResult,
} from './skills-state.js';
import type { MakaToolContext } from './tool-runtime.js';

/**
 * Skill discovery: resolving discovery paths, normalising skill sources,
 * scanning directories for `SKILL.md` files, and deduping by id.
 *
 * Depends on {@link skills-metadata} for front-matter validation and
 * {@link skills-state} for per-workspace enablement state.
 */

// ── Types ─────────────────────────────────────────────────────────────────

export type SkillScope = 'project' | 'workspace' | 'user' | 'custom';
export type SkillDiscoverySource = 'maka' | 'agents' | 'legacy' | 'custom';

export interface SkillDiscoveryEntry {
  dir: string;
  containmentRoot: string;
  scope?: SkillScope;
  source?: SkillDiscoverySource;
  /** Stable source identity; defaults to `${scope}:${source}`. */
  refPrefix?: string;
}

export type SkillSource =
  | string
  | { dirs: string[]; stateRoot: string; entries?: SkillDiscoveryEntry[] };
export type SkillSourceResolver = (
  context: Pick<MakaToolContext, 'sessionId' | 'cwd'>,
) => SkillSource;

/**
 * Runtime-facing skill definition. Stable public shape produced by scanning
 * the workspace skills directory. Desktop's `InstalledSkill` extends this
 * with governance fields (source type, lock validation, managed status).
 * The SKILL.md body and its content hash ride on {@link ScannedSkill} only,
 * so the always-on prompt fragment and the lazy loader can use them without
 * exposing them on the stable type.
 */
export interface RuntimeSkillDefinition {
  /** Stable scope-aware identity used by governance state and UI actions. */
  ref: string;
  id: string;
  name: string;
  description: string;
  path: string;
  declaredTools: string[];
  /**
   * Tools the host must have registered for this skill to be advertised or
   * loaded. Independent from `declaredTools` (which is declaration only): a
   * missing `requiredTools` entry hard-hides the skill on incompatible hosts,
   * while a missing `declaredTools` entry is only an informational hint.
   */
  requiredTools: string[];
  /** Host capability tags the host must provide for this skill to be eligible. */
  requiredCapabilities: string[];
  enabled: boolean;
  pinned: boolean;
  runtimeStatus: SkillRuntimeStatus;
  scope: SkillScope;
  source: SkillDiscoverySource;
  /** Stable discovery ordering. Lower values have higher precedence. */
  precedence: number;
  /** Higher-precedence copy that suppresses this skill from the runtime catalog. */
  shadowedBy?: string;
}

/**
 * A scanned skill: {@link RuntimeSkillDefinition} plus the SKILL.md body
 * (`content`, front matter stripped) and the sha256 of the original file
 * bytes (`contentSha256`). Desktop governance consumes `contentSha256` to
 * validate the lock without re-reading the file.
 */
export interface ScannedSkill extends RuntimeSkillDefinition {
  content: string;
  contentSha256: string;
  /**
   * The containment root this skill was discovered under (e.g. workspace root,
   * home dir). Used to compute `relativePath` in `loadSkillInstructions` so
   * legacy callers see `skills/<id>/SKILL.md` while multi-path callers see
   * the actual subpath.
   */
  discoveryRoot: string;
}

/** Diagnostics for one discovered skill directory, including rejected skills. */
export interface SkillScanDiagnostic {
  id: string;
  path: string;
  issues: SkillValidationIssue[];
}

/** A configured discovery root that could not be inspected safely. */
export interface SkillDiscoveryDiagnostic {
  path: string;
  scope: SkillScope;
  source: SkillDiscoverySource;
  precedence: number;
  reason: 'blocked_path' | 'read_failed';
}

export interface SkillScanResult {
  skills: ScannedSkill[];
  /** Every valid discovered skill, including lower-precedence shadowed copies. */
  inventory: ScannedSkill[];
  /** Discovered SKILL.md files rejected by typed metadata validation. */
  rejected: RejectedSkillDefinition[];
  diagnostics: SkillScanDiagnostic[];
  /** Source-level failures that previously appeared as an empty catalog. */
  discoveryDiagnostics: SkillDiscoveryDiagnostic[];
  /** State snapshot used to resolve enabled/pinned values during this scan. */
  runtimeState: SkillRuntimeStateReadResult;
}

export interface RejectedSkillDefinition {
  ref: string;
  id: string;
  name: string;
  description: string;
  path: string;
  discoveryRoot: string;
  declaredTools: string[];
  scope: SkillScope;
  source: SkillDiscoverySource;
  precedence: number;
  issues: SkillValidationIssue[];
}

// ── Public API ────────────────────────────────────────────────────────────

/**
 * Standard skill discovery paths per the Agent Skills spec
 * (https://agentskills.io/client-implementation/adding-skills-support).
 *
 * Ordered by precedence: project-level paths win over user-level, and
 * client-specific paths win over cross-client paths at the same scope.
 * Collision resolution: first-found wins within the dedup pass.
 *
 * `{workspaceRoot}/skills/` is included for backward compatibility with
 * existing desktop-installed skills.
 *
 * Returns containment roots so `scanSkillDir` can reject ancestor-level
 * symlink escapes (e.g. `repo/.agents -> /outside`).
 */
export function resolveSkillDiscoveryPaths(
  cwd: string,
  workspaceRoot: string,
  homeDir?: string,
): { entries: SkillDiscoveryEntry[]; dirs: string[]; stateRoot: string } {
  const home = homeDir ?? homedir();
  const entries: SkillDiscoveryEntry[] = [
    { dir: join(cwd, '.maka', 'skills'), containmentRoot: cwd, scope: 'project', source: 'maka' },
    {
      dir: join(cwd, '.agents', 'skills'),
      containmentRoot: cwd,
      scope: 'project',
      source: 'agents',
    },
    {
      dir: join(workspaceRoot, 'skills'),
      containmentRoot: workspaceRoot,
      scope: 'workspace',
      source: 'legacy',
    },
    { dir: join(home, '.maka', 'skills'), containmentRoot: home, scope: 'user', source: 'maka' },
    {
      dir: join(home, '.agents', 'skills'),
      containmentRoot: home,
      scope: 'user',
      source: 'agents',
    },
  ];
  return { entries, dirs: entries.map((e) => e.dir), stateRoot: workspaceRoot };
}

/**
 * Scan multiple skill directories and dedupe by `id` (first-found wins).
 * `source` can be a workspace root string (scans `{root}/skills/`) or an
 * explicit `{ dirs, stateRoot }` for multi-path discovery. Directories
 * earlier in the list have higher precedence; ties within the same directory
 * break alphabetically. Dedup and truncation preserve this order so
 * project-level skills are never crowded out by user-level ones.
 */
export async function scanSkillsWithDiagnostics(source: SkillSource): Promise<SkillScanResult> {
  const { entries, stateRoot } = normalizeSkillSource(source);
  let runtimeState = await readSkillRuntimeState(stateRoot);
  const seenIds = new Map<string, ScannedSkill>();
  const seenNames = new Map<string, ScannedSkill>();
  const out: ScannedSkill[] = [];
  const inventory: ScannedSkill[] = [];
  const rejected: RejectedSkillDefinition[] = [];
  const discoveryDiagnostics: SkillDiscoveryDiagnostic[] = [];
  const diagnostics = new Map<string, SkillScanDiagnostic>();
  for (const [precedence, entry] of entries.entries()) {
    const found = await scanSkillDir(entry, runtimeState, precedence);
    rejected.push(...found.rejected);
    discoveryDiagnostics.push(...found.discoveryDiagnostics);
    for (const diagnostic of found.diagnostics) {
      appendSkillDiagnostic(diagnostics, diagnostic.id, diagnostic.path, diagnostic.issues);
    }
    for (const skill of found.skills) {
      const normalizedId = skill.id.toLowerCase();
      const retainedId = seenIds.get(normalizedId);
      if (retainedId) {
        skill.shadowedBy = retainedId.ref;
        inventory.push(skill);
        appendSkillDiagnostic(diagnostics, skill.id, skill.path, [
          {
            code: 'duplicate_id',
            severity: 'warning',
            field: 'id',
            message: `Skill id "${skill.id}" is shadowed by a higher-precedence discovered skill.`,
          },
        ]);
        continue;
      }
      seenIds.set(normalizedId, skill);
      inventory.push(skill);

      const normalizedName = skill.name.toLowerCase();
      const retainedName = seenNames.get(normalizedName);
      if (retainedName) {
        const duplicateNameIssue: SkillValidationIssue = {
          code: 'duplicate_name',
          severity: 'warning',
          field: 'name',
          message: `Skill display name "${skill.name}" is also used by another discovered skill. Load by id to avoid ambiguity.`,
        };
        appendSkillDiagnostic(diagnostics, retainedName.id, retainedName.path, [
          duplicateNameIssue,
        ]);
        appendSkillDiagnostic(diagnostics, skill.id, skill.path, [duplicateNameIssue]);
      } else {
        seenNames.set(normalizedName, skill);
      }
      out.push(skill);
    }
  }
  if (runtimeState.ok) {
    const migration = migrateSkillRuntimePreferences(runtimeState, inventory);
    for (const skill of inventory) {
      const preference = getSkillRuntimePreference(migration, skill);
      skill.enabled = preference.enabled;
      skill.pinned = preference.pinned;
      skill.runtimeStatus = preference.enabled ? 'enabled' : 'disabled';
    }
    runtimeState = {
      ...runtimeState,
      states: new Map(
        [...migration.preferences].map(([key, preference]) => [key, preference.enabled]),
      ),
      preferences: migration.preferences,
      needsReview: migration.needsReview,
    };
  }
  return {
    skills: out,
    inventory,
    rejected,
    diagnostics: [...diagnostics.values()],
    discoveryDiagnostics,
    runtimeState,
  };
}

/** Backward-compatible scan API. Use scanSkillsWithDiagnostics for inspection. */
export async function scanSkills(source: SkillSource): Promise<ScannedSkill[]> {
  return (await scanSkillsWithDiagnostics(source)).skills;
}

/**
 * Scan `{workspaceRoot}/skills/` for directories that contain a SKILL.md.
 * Parse the YAML front matter for `name`, `description`, and `allowed-tools`,
 * and read per-workspace enablement state. Invalid skills are excluded from
 * this compatibility result; use the diagnostics variant to inspect them.
 *
 * This is the original single-root entry point; desktop governance uses it.
 * New call sites should prefer {@link scanSkills} with a multi-path source.
 */
export async function scanWorkspaceSkills(root: string): Promise<ScannedSkill[]> {
  return scanSkills(root);
}

/** Single-workspace convenience wrapper that preserves validation diagnostics. */
export async function scanWorkspaceSkillsWithDiagnostics(root: string): Promise<SkillScanResult> {
  return scanSkillsWithDiagnostics(root);
}

// ── Internal helpers ─────────────────────────────────────────────────────

function normalizeSkillSource(source: SkillSource): {
  entries: SkillDiscoveryEntry[];
  stateRoot: string;
} {
  if (typeof source === 'string') {
    return {
      entries: [
        {
          dir: join(source, 'skills'),
          containmentRoot: source,
          scope: 'workspace',
          source: 'legacy',
        },
      ],
      stateRoot: source,
    };
  }
  if (source.entries && source.entries.length > 0) {
    return { entries: source.entries, stateRoot: source.stateRoot };
  }
  // Fallback for manually constructed { dirs, stateRoot } objects without
  // entries: use each dir as its own containment root. This is the least
  // permissive option that still works.
  return {
    entries: source.dirs.map((dir, index) => ({
      dir,
      containmentRoot: dir,
      scope: 'custom' as const,
      source: 'custom' as const,
      refPrefix: `custom:${index}`,
    })),
    stateRoot: source.stateRoot,
  };
}

/**
 * Scan a single skill directory. Each immediate subdirectory containing a
 * `SKILL.md` is parsed. Metadata validation errors exclude only the malformed
 * skill and are returned as structured diagnostics.
 *
 * The directory itself must be a real directory (not a symlink) and its
 * realpath must be contained within the realpath of its parent directory.
 * This prevents ancestor-level symlinks (e.g. `repo/.agents -> /outside`)
 * from escaping the expected boundary.
 */
async function scanSkillDir(
  discovery: SkillDiscoveryEntry,
  runtimeState: SkillRuntimeStateReadResult,
  precedence: number,
): Promise<SkillScanResult> {
  const { dir, containmentRoot } = discovery;
  const scope = discovery.scope ?? 'custom';
  const source = discovery.source ?? 'custom';
  const empty = (discoveryDiagnostics: SkillDiscoveryDiagnostic[] = []): SkillScanResult => ({
    skills: [],
    inventory: [],
    rejected: [],
    diagnostics: [],
    discoveryDiagnostics,
    runtimeState,
  });
  const sourceDiagnostic = (
    reason: SkillDiscoveryDiagnostic['reason'],
  ): SkillDiscoveryDiagnostic => ({
    path: dir,
    scope,
    source,
    precedence,
    reason,
  });
  let entries: import('node:fs').Dirent[];
  try {
    const dirStat = await lstat(dir);
    if (!dirStat.isDirectory() || dirStat.isSymbolicLink()) {
      return empty([sourceDiagnostic('blocked_path')]);
    }
    // Verify the resolved directory has not escaped its containment root via
    // an ancestor symlink (e.g. `repo/.agents -> /outside`).
    const [rootReal, dirReal] = await Promise.all([realpath(containmentRoot), realpath(dir)]);
    if (!isPathInside(rootReal, dirReal)) {
      return empty([sourceDiagnostic('blocked_path')]);
    }
    entries = await readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
  } catch (error) {
    // An absent optional discovery root is normal. A configured path that
    // exists but cannot be inspected is not: expose it to governance clients.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return empty();
    return empty([sourceDiagnostic('read_failed')]);
  }

  const out: ScannedSkill[] = [];
  const rejected: RejectedSkillDefinition[] = [];
  const diagnostics: SkillScanDiagnostic[] = [];
  for (const dirEntry of entries) {
    if (!dirEntry.isDirectory()) continue;
    const skillPath = join(dir, dirEntry.name);
    const skillFile = join(skillPath, 'SKILL.md');
    try {
      const read = await readContainedRegularFile(skillPath, skillFile);
      if (!read.ok) continue;
      const bytes = read.bytes;
      const text = bytes.toString('utf8');
      const validation = validateSkillMetadata(text);
      const discoverySource = source;
      const ref = `${discovery.refPrefix ?? `${scope}:${discoverySource}`}:${dirEntry.name}`;
      if (validation.issues.length > 0) {
        diagnostics.push({ id: dirEntry.name, path: skillPath, issues: validation.issues });
      }
      if (!validation.valid) {
        rejected.push({
          ref,
          id: dirEntry.name,
          name: validation.manifest.name ?? dirEntry.name,
          description: validation.manifest.description ?? '',
          path: skillPath,
          discoveryRoot: containmentRoot,
          declaredTools: validation.manifest.allowedTools,
          scope,
          source: discoverySource,
          precedence,
          issues: validation.issues,
        });
        continue;
      }
      const { name, description, allowedTools, requiredTools, requiredCapabilities } =
        validation.manifest;
      const preference = runtimeState.ok
        ? (runtimeState.preferences.get(ref) ?? runtimeState.preferences.get(dirEntry.name))
        : undefined;
      const runtimeStatus: SkillRuntimeStatus = runtimeState.ok
        ? preference?.enabled === false
          ? 'disabled'
          : 'enabled'
        : 'state_error';
      out.push({
        ref,
        id: dirEntry.name,
        name: name ?? dirEntry.name,
        description: description ?? '',
        path: skillPath,
        declaredTools: allowedTools,
        requiredTools,
        requiredCapabilities,
        content: validation.body,
        contentSha256: `sha256:${sha256Buffer(bytes)}`,
        discoveryRoot: containmentRoot,
        enabled: runtimeStatus === 'enabled',
        pinned: preference?.pinned === true,
        runtimeStatus,
        scope,
        source: discoverySource,
        precedence,
      });
    } catch {
      // Skip directories without a readable SKILL.md.
    }
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return {
    skills: out,
    inventory: out,
    rejected,
    diagnostics,
    discoveryDiagnostics: [],
    runtimeState,
  };
}

function appendSkillDiagnostic(
  diagnostics: Map<string, SkillScanDiagnostic>,
  id: string,
  path: string,
  issues: SkillValidationIssue[],
): void {
  if (issues.length === 0) return;
  const existing = diagnostics.get(path);
  if (!existing) {
    diagnostics.set(path, { id, path, issues: [...issues] });
    return;
  }
  for (const issue of issues) {
    if (
      !existing.issues.some(
        (candidate) =>
          candidate.code === issue.code &&
          candidate.field === issue.field &&
          candidate.message === issue.message,
      )
    ) {
      existing.issues.push(issue);
    }
  }
}

function sha256Buffer(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}
