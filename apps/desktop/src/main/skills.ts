import { lstat, mkdir, readFile, realpath, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  BUNDLED_SKILL_CATALOG,
  buildStarterSkillTemplate,
  clearResolvedSkillPreferenceReviews,
  createBundledSkillLock,
  createManagedSkillLock,
  getSkillRuntimePreference,
  getBundledSkillSource,
  invalidSkillLockStatus,
  isPathInside,
  isSafeSkillId,
  isSkillPreferenceReviewPending,
  MANAGED_SKILL_BASELINE_RELATIVE_PATH,
  MANAGED_SKILL_CATEGORIES,
  migrateSkillRuntimePreferences,
  missingSkillLockStatus,
  parseSkillFrontMatter,
  patchSkillRuntimePreference,
  readContainedRegularTextFile,
  readManagedSkillSource,
  resolveSkillDiscoveryPaths,
  resolveManagedSkillSourcesRoot,
  resolveSkillPreferenceTarget,
  scanSkillsWithDiagnostics,
  scanWorkspaceSkills,
  selectSkillScanForContext,
  validateSkillLock,
  writeContainedRegularTextFile,
  writeSkillRuntimePreferences,
  type HostCapabilities,
  type BundledSkillSource,
  type ManagedSkillCategory,
  type ManagedSkillUpdateStatus,
  type RejectedSkillDefinition,
  type RuntimeSkillDefinition,
  type ScannedSkill,
  type SkillContextDecisionReason,
  type SkillDiscoverySource,
  type SkillDiscoveryDiagnostic,
  type SkillRuntimeStatus,
  type SkillSelectionReport,
  type SkillSourceType,
  type SkillScope,
  type SkillValidationStatus,
  type SkillLockFile,
  type SkillLockValidationCode,
} from '@maka/runtime';

// Re-export runtime-facing skill exports so existing call sites and tests
// keep importing from './skills.js' unchanged. Governance (lock, provenance,
// managed-source status and built-in skill seeding) stays defined below.
export {
  buildSkillAgentTool,
  buildSkillSearchAgentTool,
  SkillShadowSelectionTracker,
  buildSkillsPromptFragment,
  buildSkillsPromptFragmentWithReport,
  loadSkillInstructions,
  parseSkillFrontMatter,
  MAX_SKILL_TOOL_BODY_CHARS,
} from '@maka/runtime';
export type { SkillRuntimeStatus } from '@maka/runtime';

export type { SkillSourceType, SkillValidationStatus, ManagedSkillUpdateStatus };
export type SkillValidationCode = SkillLockValidationCode;

export interface InstalledSkill extends RuntimeSkillDefinition {
  sourceType: SkillSourceType;
  sourceName?: string;
  sourceVersion?: string;
  contentSha256?: string;
  installedAt?: string;
  userModified: boolean;
  validationStatus: SkillValidationStatus;
  validationCodes: SkillValidationCode[];
  validationMessages?: string[];
  managedSourceId?: string;
  managedUpdateStatus?: ManagedSkillUpdateStatus;
  sourceContentSha256?: string;
}

export interface SkillEntry {
  kind: 'skill' | 'discovery_diagnostic';
  ref: string;
  id: string;
  name: string;
  description: string;
  path: string;
  declaredTools: string[];
  sourceType: 'workspace' | 'bundled' | 'managed' | 'unknown';
  userModified: boolean;
  validationStatus: SkillValidationStatus;
  managedUpdateStatus?: ManagedSkillUpdateStatus;
  enabled: boolean;
  pinned: boolean;
  runtimeStatus: SkillRuntimeStatus;
  scope: SkillScope;
  source: SkillDiscoverySource;
  contextStatus: SkillContextDecisionReason;
  contextRank?: number;
  shadowedBy?: string;
  /** Legacy id preference matched multiple refs and needs explicit choices. */
  needsReview: boolean;
  discoveryDiagnosticReason?: SkillDiscoveryDiagnostic['reason'];
  /** Whether this panel can delete the skill. See {@link isManageableSkill}. */
  manageable: boolean;
}

/**
 * Scopes the Skills panel is allowed to delete from.
 *
 * `workspace`/`legacy` is the original `{workspaceRoot}/skills/` install dir.
 * `user` covers `~/.maka/skills` and `~/.agents/skills` — those are the user's
 * own installs, so refusing to delete them left the panel showing skills it
 * could not manage with no explanation for why the button was missing.
 *
 * `project` is deliberately excluded: `{cwd}/.maka/skills` and
 * `{cwd}/.agents/skills` live inside the user's repo and are normally tracked
 * by git. Deleting repo files from an agent panel is a different, more
 * surprising action than removing something the user installed for themselves,
 * so it stays out until it is asked for explicitly. `custom` is excluded for
 * the same reason — its containment root is the scan dir itself, supplied by
 * whoever constructed the scan, so there is no user-owned root to anchor to.
 */
export function isManageableSkill(scope: SkillScope, source: SkillDiscoverySource): boolean {
  if (scope === 'user') return true;
  return scope === 'workspace' && source === 'legacy';
}

export interface SkillGovernanceDetails {
  id: string;
  name: string;
  description: string;
  path: string;
  declaredTools: string[];
  sourceType: SkillSourceType;
  userModified: boolean;
  validationStatus: SkillValidationStatus;
  enabled: boolean;
  runtimeStatus: SkillRuntimeStatus;
  validationCodes: SkillValidationCode[];
  validationMessages: string[];
  managedSourceId?: string;
  managedUpdateStatus?: ManagedSkillUpdateStatus;
  hasManagedBaseline: boolean;
  sourceAvailable?: boolean;
  sourceChanged?: boolean;
}

export interface ManagedSkillUpdatePreview {
  skill: SkillGovernanceDetails;
  currentContent: string;
  sourceContent: string;
  baselineContent?: string;
  expectedCurrentSha256: string;
  expectedSourceSha256: string;
  summary: {
    currentLineCount: number;
    sourceLineCount: number;
    changedLineCount: number;
  };
}

export type CreateStarterSkillResult =
  | { ok: true; created: boolean; skill: InstalledSkill; filePath: string }
  | { ok: false; reason: 'blocked_path' | 'already_exists' | 'write_failed' };

export type DeleteSkillResult =
  | { ok: true }
  /**
   * `blocked_scope` is distinct from `blocked_path`: the skill was found and
   * its path is sound, but its discovery scope is not one this panel deletes
   * from (see {@link isManageableSkill}). Keeping it separate stops a policy
   * refusal from reading as a path-traversal block in logs and toasts.
   */
  | { ok: false; reason: 'not_found' | 'blocked_path' | 'blocked_scope' | 'delete_failed' };

export type SkillOpenTarget = 'file' | 'directory';
export type ResolveSkillOpenPathResult =
  | { ok: true; path: string; target: SkillOpenTarget }
  | { ok: false; reason: 'invalid_id' | 'missing' | 'blocked_path' | 'not_file' | 'not_directory' };

export type SetSkillEnabledResult =
  | { ok: true; skill: SkillEntry }
  | {
      ok: false;
      reason: 'not_found' | 'needs_review' | 'blocked_path' | 'state_error' | 'write_failed';
    };
export type SetSkillPinnedResult = SetSkillEnabledResult;

interface InstalledSkillDefinition extends InstalledSkill {
  content: string;
}

interface SkillReadOptions {
  managedSourceRoot?: string;
  cwd?: string;
  homeDir?: string;
  host?: HostCapabilities;
  contextWindow?: number;
  /** Exact report from the last prompt build; absent means compute a policy preview. */
  selectionReport?: SkillSelectionReport;
}

interface ManagedSkillUpdateOptions {
  force?: boolean;
  expectedCurrentSha256?: string;
  expectedSourceSha256?: string;
}

// Shipped built-in skills are installed on demand from the 内置 tab. Their
// installed copies carry a trusted `bundled` lock (sourceName maka-bundled).
const BUNDLED_CATALOG_BODY_BY_ID = new Map(
  BUNDLED_SKILL_CATALOG.map((skill) => [skill.id, skill.body]),
);
const BUNDLED_CATALOG_CATEGORY_DEFAULT: ManagedSkillCategory = '效率工具';

/**
 * Scan `{workspaceRoot}/skills/` for directories that contain a SKILL.md.
 * Parse the YAML front-matter for `name`, `description`, and `allowed-tools`.
 * Errors per skill fall through silently so one malformed folder can't blank
 * the listing.
 *
 * `allowed-tools` is intentionally surfaced as "declared/requested" - never
 * granted. The active session ExecutionBoundary remains authoritative.
 */
export async function listInstalledSkills(root: string, options: SkillReadOptions = {}): Promise<InstalledSkill[]> {
  const definitions = await readInstalledSkillDefinitions(root, options);
  return definitions.map(({ content: _content, ...skill }) => skill);
}

export async function listGovernedSkillEntries(
  root: string,
  options: SkillReadOptions = {},
): Promise<SkillEntry[]> {
  const scan = await scanSkillsWithDiagnostics(
    resolveSkillDiscoveryPaths(options.cwd ?? root, root, options.homeDir),
  );
  const installed = (
    await enrichInstalledSkillDefinitions(
      scan.inventory.filter(
        (skill) => skill.scope === 'workspace' && skill.source === 'legacy',
      ),
      options,
    )
  ).map(({ content: _content, ...skill }) => skill);
  const runtimeState = scan.runtimeState;
  const migration = runtimeState.ok
    ? migrateSkillRuntimePreferences(runtimeState, scan.inventory)
    : null;
  const effectiveInventory: ScannedSkill[] = scan.inventory.map((skill) => {
    const preference =
      migration === null ? undefined : getSkillRuntimePreference(migration, skill);
    const enabled = preference?.enabled ?? skill.enabled;
    return {
      ...skill,
      enabled,
      pinned: preference?.pinned ?? skill.pinned,
      runtimeStatus:
        skill.runtimeStatus === 'state_error'
          ? 'state_error'
          : enabled
            ? 'enabled'
            : 'disabled',
    };
  });
  const report = options.selectionReport ?? selectSkillScanForContext(
    { ...scan, inventory: effectiveInventory },
    options.host,
    { contextWindow: options.contextWindow },
  ).report;
  const decisionByRef = new Map(report.decisions.map((decision) => [decision.ref, decision]));
  const installedByPath = new Map(installed.map((skill) => [skill.path, skill]));
  const validEntries = effectiveInventory.map((skill) => {
    const governed = installedByPath.get(skill.path);
    const decision = decisionByRef.get(skill.ref);
    return toSkillEntry(
      {
        ...(governed ?? {
          ...skill,
          sourceType: 'unknown',
          userModified: false,
          validationStatus: 'ok',
          validationCodes: [],
        }),
        enabled: skill.enabled,
        pinned: skill.pinned,
        runtimeStatus: skill.runtimeStatus,
      },
      decision,
      migration === null ? false : isSkillPreferenceReviewPending(migration, skill.id),
    );
  });
  return [
    ...validEntries,
    ...scan.rejected.map(toRejectedSkillEntry),
    ...scan.discoveryDiagnostics.map(toDiscoveryDiagnosticEntry),
  ];
}

function toRejectedSkillEntry(skill: RejectedSkillDefinition): SkillEntry {
  return {
    kind: 'skill',
    ref: skill.ref,
    id: skill.id,
    name: skill.name,
    description: skill.description,
    path: skill.path,
    declaredTools: skill.declaredTools,
    sourceType: skill.scope === 'workspace' && skill.source === 'legacy' ? 'workspace' : 'unknown',
    userModified: false,
    validationStatus: 'metadata_error',
    enabled: false,
    pinned: false,
    runtimeStatus: 'disabled',
    scope: skill.scope,
    source: skill.source,
    contextStatus: 'invalid',
    needsReview: false,
    manageable: isManageableSkill(skill.scope, skill.source),
  };
}

function toDiscoveryDiagnosticEntry(
  diagnostic: SkillDiscoveryDiagnostic,
): SkillEntry {
  return {
    kind: 'discovery_diagnostic',
    ref: `diagnostic:${diagnostic.scope}:${diagnostic.source}:${diagnostic.precedence}`,
    id: `source-${diagnostic.precedence}`,
    name: '',
    description: '',
    path: diagnostic.path,
    declaredTools: [],
    sourceType: 'unknown',
    userModified: false,
    validationStatus: 'metadata_error',
    enabled: false,
    pinned: false,
    runtimeStatus: 'disabled',
    scope: diagnostic.scope,
    source: diagnostic.source,
    contextStatus: 'invalid',
    needsReview: false,
    discoveryDiagnosticReason: diagnostic.reason,
    manageable: false,
  };
}

export function toSkillEntry(
  skill: InstalledSkill,
  decision?: { reason: SkillContextDecisionReason; rank?: number; shadowedBy?: string },
  needsReview = false,
): SkillEntry {
  return {
    kind: 'skill',
    ref: skill.ref,
    id: skill.id,
    name: skill.name,
    description: skill.description,
    path: skill.path,
    declaredTools: skill.declaredTools,
    sourceType: skill.sourceType === 'bundled' || skill.sourceType === 'managed' || skill.sourceType === 'unknown'
      ? skill.sourceType
      : 'workspace',
    userModified: skill.userModified,
    validationStatus: skill.validationStatus,
    enabled: skill.enabled,
    pinned: skill.pinned,
    runtimeStatus: skill.runtimeStatus,
    scope: skill.scope,
    source: skill.source,
    contextStatus: decision?.reason ?? (skill.enabled ? 'advertised' : 'disabled'),
    ...(decision?.rank !== undefined ? { contextRank: decision.rank } : {}),
    ...(decision?.shadowedBy ? { shadowedBy: decision.shadowedBy } : {}),
    needsReview,
    manageable: isManageableSkill(skill.scope, skill.source),
    ...(skill.sourceType === 'managed' && skill.managedUpdateStatus ? { managedUpdateStatus: skill.managedUpdateStatus } : {}),
  };
}

async function writeSkillLock(skillDir: string, lock: SkillLockFile): Promise<boolean> {
  const lockPath = join(skillDir, 'skill.lock.json');
  const tempPath = join(skillDir, `.skill.lock.json.${process.pid}.${Date.now()}.tmp`);
  try {
    await writeFile(tempPath, `${JSON.stringify(lock, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    const tempStat = await lstat(tempPath);
    if (!tempStat.isFile() || tempStat.isSymbolicLink()) {
      await unlink(tempPath).catch(() => {});
      return false;
    }
    await rename(tempPath, lockPath);
    return true;
  } catch {
    await unlink(tempPath).catch(() => {});
    return false;
  }
}

const STARTER_SKILL_ID_PATTERN = /^starter-skill(?:-(\d+))?$/;

export async function createStarterSkill(root: string): Promise<CreateStarterSkillResult> {
  const skillsDir = join(root, 'skills');
  try {
    await mkdir(skillsDir, { recursive: true, mode: 0o700 });
    const skillsStat = await lstat(skillsDir);
    if (!skillsStat.isDirectory() || skillsStat.isSymbolicLink()) {
      return { ok: false, reason: 'blocked_path' };
    }
  } catch {
    return { ok: false, reason: 'write_failed' };
  }

  let skillsReal: string;
  try {
    skillsReal = await realpath(skillsDir);
  } catch {
    return { ok: false, reason: 'blocked_path' };
  }

  // Idempotent seeding: if a starter-skill (or starter-skill-N) already exists,
  // reuse the lowest-ordinal one instead of minting another. Clicking 添加 used
  // to spawn a fresh starter-skill-N per click, leaving duplicate 示例技能 rows
  // the user could not tell apart. Reuse the shared loader so the returned skill
  // carries the same parsed metadata every other surface sees.
  const existingStarter = (await listInstalledSkills(root))
    .map((skill) => {
      const match = STARTER_SKILL_ID_PATTERN.exec(skill.id);
      return match ? { skill, ordinal: match[1] ? Number(match[1]) : 1 } : null;
    })
    .filter((entry): entry is { skill: InstalledSkill; ordinal: number } => entry !== null)
    .sort((a, b) => a.ordinal - b.ordinal)[0];
  if (existingStarter) {
    return {
      ok: true,
      created: false,
      skill: existingStarter.skill,
      filePath: join(existingStarter.skill.path, 'SKILL.md'),
    };
  }

  for (let index = 1; index <= 99; index += 1) {
    const id = index === 1 ? 'starter-skill' : `starter-skill-${index}`;
    // Display name follows the id's ordinal — three clicks used to mint
    // three IDENTICAL 「示例技能」 rows (ids differed, names didn't, and the
    // slug lives in the tooltip), leaving the list visually indistinguishable.
    const name = index === 1 ? '示例技能' : `示例技能 ${index}`;
    const skillDir = join(skillsDir, id);
    try {
      await mkdir(skillDir, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue;
      return { ok: false, reason: 'write_failed' };
    }

    try {
      const skillReal = await realpath(skillDir);
      if (!isPathInside(skillsReal, skillReal)) {
        return { ok: false, reason: 'blocked_path' };
      }

      const filePath = join(skillDir, 'SKILL.md');
      await writeFile(filePath, buildStarterSkillTemplate(id, name), {
        encoding: 'utf8',
        flag: 'wx',
        mode: 0o600,
      });
      return {
        ok: true,
        created: true,
        filePath,
        skill: {
          ref: `workspace:legacy:${id}`,
          id,
          name,
          description: '把常用工作流写成可复用的本地指令。',
          path: skillDir,
          declaredTools: ['Read'],
          requiredTools: [],
          requiredCapabilities: [],
          sourceType: 'workspace',
          userModified: false,
          validationStatus: 'missing_lock',
          validationCodes: ['missing_lock'],
          enabled: true,
          pinned: false,
          runtimeStatus: 'enabled',
          scope: 'workspace',
          source: 'legacy',
          precedence: 0,
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue;
      return { ok: false, reason: 'write_failed' };
    }
  }

  return { ok: false, reason: 'already_exists' };
}

/**
 * Delete a discovered skill directory by scope-aware `ref`.
 *
 * The caller only ever supplies the ref string; the directory to remove is
 * re-derived from a fresh discovery scan, never from renderer-supplied input.
 * On top of that the target must clear four checks before anything is removed:
 *
 *  1. its scope is deletable ({@link isManageableSkill}),
 *  2. it is a real directory and not a symlink (so the rm cannot follow a link
 *     out of the scan root),
 *  3. its parent is one of the discovery dirs this scan actually enumerated —
 *     the tight check, since the containment root for user scope is the whole
 *     home dir,
 *  4. and it is still inside its discovery root after realpath resolution.
 *
 * Mirrors `resolveSkillOpenPath`'s ref branch, with (1) and (3) added because
 * this operation is destructive and irreversible.
 */
async function deleteSkillByRef(
  root: string,
  ref: string,
  options: SkillReadOptions = {},
): Promise<DeleteSkillResult> {
  if (ref.length > 512) return { ok: false, reason: 'not_found' };

  const discovery = resolveSkillDiscoveryPaths(options.cwd ?? root, root, options.homeDir);
  const scan = await scanSkillsWithDiagnostics(discovery);
  const skill = [...scan.inventory, ...scan.rejected].find((candidate) => candidate.ref === ref);
  if (!skill) return { ok: false, reason: 'not_found' };
  if (!isManageableSkill(skill.scope, skill.source)) return { ok: false, reason: 'blocked_scope' };

  let skillReal: string;
  try {
    const skillStat = await lstat(skill.path);
    if (!skillStat.isDirectory() || skillStat.isSymbolicLink()) return { ok: false, reason: 'blocked_path' };
    skillReal = await realpath(skill.path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { ok: false, reason: 'not_found' };
    return { ok: false, reason: 'blocked_path' };
  }

  // The skill must sit DIRECTLY in a dir the scan enumerated. Comparing against
  // discovery dirs rather than `discoveryRoot` is what keeps a user-scope
  // delete pinned to ~/.maka/skills or ~/.agents/skills instead of anywhere
  // under $HOME.
  const parentReal = dirname(skillReal);
  const discoveryDirsReal = await Promise.all(
    discovery.entries.map((entry) => realpath(entry.dir).catch(() => null)),
  );
  if (!discoveryDirsReal.some((dir) => dir !== null && dir === parentReal)) {
    return { ok: false, reason: 'blocked_path' };
  }

  try {
    const containmentReal = await realpath(skill.discoveryRoot);
    if (!isPathInside(containmentReal, skillReal)) return { ok: false, reason: 'blocked_path' };
  } catch {
    return { ok: false, reason: 'blocked_path' };
  }

  try {
    await rm(skillReal, { recursive: true });
    return { ok: true };
  } catch {
    return { ok: false, reason: 'delete_failed' };
  }
}

/**
 * Delete an installed skill directory. Accepts either a scope-aware `ref`
 * (`user:agents:<id>`, `workspace:legacy:<id>`, …) which routes to
 * {@link deleteSkillByRef}, or a bare workspace id for the original
 * {root}/skills/<id> path kept below.
 *
 * The bare-id path is path-hardened exactly like createStarterSkill /
 * installManagedSkill: the skills dir and the skill dir must both be real,
 * contained directories (no symlinks, no escape outside the workspace) before
 * anything is removed. The recursive rm also clears any managed-skill baseline
 * metadata under the skill's .maka/ subtree.
 */
export async function deleteSkill(
  root: string,
  idOrRef: string,
  options: SkillReadOptions = {},
): Promise<DeleteSkillResult> {
  // A ref always contains ':', which `isSafeSkillId` rejects — so a value that
  // fails the id check but looks like a ref is routed rather than refused.
  if (!isSafeSkillId(idOrRef)) {
    if (!idOrRef.includes(':')) return { ok: false, reason: 'not_found' };
    return deleteSkillByRef(root, idOrRef, options);
  }

  const id = idOrRef;
  const skillsDir = join(root, 'skills');
  let skillsReal: string;
  try {
    const [rootReal, skillsStat] = await Promise.all([realpath(root), lstat(skillsDir)]);
    if (!skillsStat.isDirectory() || skillsStat.isSymbolicLink()) return { ok: false, reason: 'blocked_path' };
    skillsReal = await realpath(skillsDir);
    if (!isPathInside(rootReal, skillsReal)) return { ok: false, reason: 'blocked_path' };
  } catch {
    return { ok: false, reason: 'not_found' };
  }

  const skillDir = join(skillsDir, id);
  let skillReal: string;
  try {
    const skillStat = await lstat(skillDir);
    if (!skillStat.isDirectory() || skillStat.isSymbolicLink()) return { ok: false, reason: 'blocked_path' };
    skillReal = await realpath(skillDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { ok: false, reason: 'not_found' };
    return { ok: false, reason: 'blocked_path' };
  }
  if (!isPathInside(skillsReal, skillReal)) return { ok: false, reason: 'blocked_path' };

  try {
    await rm(skillReal, { recursive: true });
    return { ok: true };
  } catch {
    return { ok: false, reason: 'delete_failed' };
  }
}

export async function installManagedSkill(
  root: string,
  sourceId: string,
  sourceRoot = resolveManagedSkillSourcesRoot(),
): Promise<
  | { ok: true; skill: InstalledSkill }
  | { ok: false; reason: 'not_found' | 'already_exists' | 'blocked_path' | 'write_failed' }
> {
  if (!isSafeSkillId(sourceId)) return { ok: false, reason: 'not_found' };
  const source = await readManagedSkillSource(sourceRoot, sourceId);
  if (!source.ok) {
    if (source.reason === 'blocked_path') return { ok: false, reason: 'blocked_path' };
    return { ok: false, reason: 'not_found' };
  }

  const skillsDir = join(root, 'skills');
  let skillsReal: string;
  try {
    await mkdir(skillsDir, { recursive: true, mode: 0o700 });
    const skillsStat = await lstat(skillsDir);
    if (!skillsStat.isDirectory() || skillsStat.isSymbolicLink()) return { ok: false, reason: 'blocked_path' };
    const rootReal = await realpath(root);
    skillsReal = await realpath(skillsDir);
    if (!isPathInside(rootReal, skillsReal)) return { ok: false, reason: 'blocked_path' };
  } catch {
    return { ok: false, reason: 'write_failed' };
  }

  const skillDir = join(skillsDir, sourceId);
  const skillFile = join(skillDir, 'SKILL.md');
  let createdSkillDir = false;
  try {
    await mkdir(skillDir, { mode: 0o700 });
    createdSkillDir = true;
    const skillReal = await realpath(skillDir);
    if (!isPathInside(skillsReal, skillReal)) {
      if (createdSkillDir) await rm(skillDir, { recursive: true, force: true }).catch(() => {});
      return { ok: false, reason: 'blocked_path' };
    }
    await writeFile(skillFile, source.content, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    if (
      !await writeSkillLock(
        skillDir,
        createManagedSkillLock(sourceId, source.contentSha256, source.contentSha256),
      )
    ) {
      if (createdSkillDir) await rm(skillDir, { recursive: true, force: true }).catch(() => {});
      return { ok: false, reason: 'write_failed' };
    }
    if (!await writeManagedSkillBaseline(skillDir, source.content)) {
      if (createdSkillDir) await rm(skillDir, { recursive: true, force: true }).catch(() => {});
      return { ok: false, reason: 'write_failed' };
    }
    const installed = await listInstalledSkills(root, { managedSourceRoot: sourceRoot });
    const skill = installed.find((candidate) => candidate.id === sourceId);
    if (!skill) {
      if (createdSkillDir) await rm(skillDir, { recursive: true, force: true }).catch(() => {});
      return { ok: false, reason: 'write_failed' };
    }
    return { ok: true, skill };
  } catch (error) {
    if (createdSkillDir) await rm(skillDir, { recursive: true, force: true }).catch(() => {});
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return { ok: false, reason: 'already_exists' };
    return { ok: false, reason: 'write_failed' };
  }
}

export interface BundledSkillCatalogEntry {
  id: string;
  name: string;
  description: string;
  category: ManagedSkillCategory;
  declaredTools: string[];
  installed: boolean;
}

export type InstallBundledSkillResult =
  | { ok: true; skill: InstalledSkill }
  | { ok: false; reason: 'not_found' | 'already_exists' | 'blocked_path' | 'write_failed' };

export type EnsureBundledSkillInstalledResult =
  | { ok: true; action: 'installed' | 'updated' | 'already_installed'; skill: InstalledSkill }
  | {
      ok: false;
      reason: 'not_found' | 'blocked_path' | 'write_failed' | 'existing_untrusted';
    };

function parseBundledSkillCategory(body: string): ManagedSkillCategory {
  if (!body.startsWith('---')) return BUNDLED_CATALOG_CATEGORY_DEFAULT;
  const close = body.indexOf('\n---', 3);
  if (close < 0) return BUNDLED_CATALOG_CATEGORY_DEFAULT;
  for (const raw of body.slice(3, close).split(/\r?\n/)) {
    const match = raw.match(/^category:\s*(.*)$/);
    if (!match) continue;
    const value = match[1].trim().replace(/^['"]|['"]$/g, '');
    return (MANAGED_SKILL_CATEGORIES as readonly string[]).includes(value)
      ? (value as ManagedSkillCategory)
      : BUNDLED_CATALOG_CATEGORY_DEFAULT;
  }
  return BUNDLED_CATALOG_CATEGORY_DEFAULT;
}

/**
 * The built-in (内置) catalog. `installed` reflects whether the current
 * workspace already has skills/<id>. The renderer surfaces this under the 内置
 * tab with a per-entry install action that calls `installBundledSkill`.
 */
export async function listBundledSkillCatalog(root: string): Promise<BundledSkillCatalogEntry[]> {
  const installedIds = new Set((await listInstalledSkills(root)).map((skill) => skill.id));
  return BUNDLED_SKILL_CATALOG
    .map(({ id, body }) => {
      const { name, description, allowedTools } = parseSkillFrontMatter(body);
      return {
        id,
        name: name ?? id,
        description: description ?? '',
        category: parseBundledSkillCategory(body),
        declaredTools: allowedTools,
        installed: installedIds.has(id),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

async function writeBundledCatalogLock(skillDir: string, id: string, body: string): Promise<boolean> {
  const source = getBundledSkillSource(id);
  if (!source || source.body !== body) return false;
  return writeSkillLock(skillDir, createBundledSkillLock(source));
}

/**
 * Install a built-in catalog skill into {root}/skills/<id> on demand. Mirrors
 * installManagedSkill's hardened write path (containment checks, fail-if-exists)
 * but sources the body from the shipped catalog.
 */
export async function installBundledSkill(root: string, id: string): Promise<InstallBundledSkillResult> {
  if (!isSafeSkillId(id)) return { ok: false, reason: 'not_found' };
  const body = BUNDLED_CATALOG_BODY_BY_ID.get(id);
  if (body === undefined) return { ok: false, reason: 'not_found' };

  const skillsDir = join(root, 'skills');
  let skillsReal: string;
  try {
    await mkdir(skillsDir, { recursive: true, mode: 0o700 });
    const skillsStat = await lstat(skillsDir);
    if (!skillsStat.isDirectory() || skillsStat.isSymbolicLink()) return { ok: false, reason: 'blocked_path' };
    const rootReal = await realpath(root);
    skillsReal = await realpath(skillsDir);
    if (!isPathInside(rootReal, skillsReal)) return { ok: false, reason: 'blocked_path' };
  } catch {
    return { ok: false, reason: 'write_failed' };
  }

  const skillDir = join(skillsDir, id);
  const skillFile = join(skillDir, 'SKILL.md');
  let createdSkillDir = false;
  try {
    await mkdir(skillDir, { mode: 0o700 });
    createdSkillDir = true;
    const skillReal = await realpath(skillDir);
    if (!isPathInside(skillsReal, skillReal)) {
      await rm(skillDir, { recursive: true, force: true }).catch(() => {});
      return { ok: false, reason: 'blocked_path' };
    }
    await writeFile(skillFile, body, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    const lockWritten = await writeBundledCatalogLock(skillDir, id, body);
    if (!lockWritten) {
      await rm(skillDir, { recursive: true, force: true }).catch(() => {});
      return { ok: false, reason: 'write_failed' };
    }
    const installed = await listInstalledSkills(root);
    const skill = installed.find((candidate) => candidate.id === id);
    if (!skill) {
      await rm(skillDir, { recursive: true, force: true }).catch(() => {});
      return { ok: false, reason: 'write_failed' };
    }
    return { ok: true, skill };
  } catch (error) {
    if (createdSkillDir) await rm(skillDir, { recursive: true, force: true }).catch(() => {});
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return { ok: false, reason: 'already_exists' };
    return { ok: false, reason: 'write_failed' };
  }
}

/**
 * Seed one product-owned bundled Skill without overwriting a workspace file.
 *
 * A core capability may need its operating guide before the model can use that
 * capability correctly. Repeated startup is idempotent, but an existing
 * untrusted or modified copy is never replaced silently.
 */
export async function ensureBundledSkillInstalled(
  root: string,
  id: string,
): Promise<EnsureBundledSkillInstalledResult> {
  const source = getBundledSkillSource(id);
  if (!source) return { ok: false, reason: 'not_found' };
  const existing = (await listInstalledSkills(root)).find((skill) => skill.id === id);
  if (existing) return reconcileBundledSkill(root, existing, source);

  const installed = await installBundledSkill(root, id);
  if (installed.ok) return { ok: true, action: 'installed', skill: installed.skill };
  switch (installed.reason) {
    case 'not_found':
    case 'blocked_path':
    case 'write_failed':
      return { ok: false, reason: installed.reason };
    case 'already_exists':
      break;
  }

  // Another startup may have won the mkdir race. Re-read the authoritative
  // installed projection instead of treating EEXIST as either success or loss.
  const raced = (await listInstalledSkills(root)).find((skill) => skill.id === id);
  return raced
    ? reconcileBundledSkill(root, raced, source)
    : { ok: false, reason: 'write_failed' };
}

async function reconcileBundledSkill(
  root: string,
  skill: InstalledSkill,
  source: BundledSkillSource,
): Promise<EnsureBundledSkillInstalledResult> {
  if (!isTrustedBundledSkill(skill)) return { ok: false, reason: 'existing_untrusted' };
  if (skill.contentSha256?.toLowerCase() === source.contentSha256.toLowerCase()) {
    return { ok: true, action: 'already_installed', skill };
  }
  if (
    !skill.contentSha256
    || !source.legacyContentSha256.some(
      (hash) => hash.toLowerCase() === skill.contentSha256?.toLowerCase(),
    )
  ) {
    return { ok: false, reason: 'existing_untrusted' };
  }
  return updateBundledSkill(root, skill, source);
}

function isTrustedBundledSkill(skill: InstalledSkill): boolean {
  return (
    skill.sourceType === 'bundled'
    && skill.sourceName === 'maka-bundled'
    && skill.userModified === false
    && skill.validationStatus === 'ok'
  );
}

async function updateBundledSkill(
  root: string,
  skill: InstalledSkill,
  source: BundledSkillSource,
): Promise<EnsureBundledSkillInstalledResult> {
  const target = await resolveSkillFileUpdateTarget(root, skill.id);
  if (!target.ok) {
    return {
      ok: false,
      reason: target.reason === 'blocked_path' ? 'blocked_path' : 'write_failed',
    };
  }

  const skillDir = join(root, 'skills', skill.id);
  const skillFile = join(skillDir, 'SKILL.md');
  const lockFile = join(skillDir, 'skill.lock.json');
  try {
    const [current, currentLock] = await Promise.all([
      readContainedRegularTextFile(skillDir, skillFile),
      readContainedRegularTextFile(skillDir, lockFile),
    ]);
    if (!current.ok) {
      return {
        ok: false,
        reason: current.reason === 'blocked_path' ? 'blocked_path' : 'write_failed',
      };
    }
    if (!currentLock.ok) {
      return {
        ok: false,
        reason: currentLock.reason === 'blocked_path' ? 'blocked_path' : 'write_failed',
      };
    }
    if (
      !skill.contentSha256
      || current.sha256.toLowerCase() !== skill.contentSha256.toLowerCase()
    ) {
      return { ok: false, reason: 'existing_untrusted' };
    }

    const restorePrevious = async () => {
      await writeContainedRegularTextFile(skillDir, skillFile, current.content).catch(() => {});
      await writeContainedRegularTextFile(skillDir, lockFile, currentLock.content).catch(() => {});
    };
    if (!await writeContainedRegularTextFile(skillDir, skillFile, source.body)) {
      return { ok: false, reason: 'write_failed' };
    }
    if (!await writeSkillLock(skillDir, createBundledSkillLock(source))) {
      await restorePrevious();
      return { ok: false, reason: 'write_failed' };
    }

    const updated = (await listInstalledSkills(root)).find(
      (candidate) => candidate.id === skill.id,
    );
    if (
      !updated
      || !isTrustedBundledSkill(updated)
      || updated.contentSha256?.toLowerCase() !== source.contentSha256.toLowerCase()
    ) {
      await restorePrevious();
      return { ok: false, reason: 'write_failed' };
    }
    return { ok: true, action: 'updated', skill: updated };
  } catch {
    return { ok: false, reason: 'write_failed' };
  }
}

export async function updateManagedSkill(
  root: string,
  skillId: string,
  sourceRoot = resolveManagedSkillSourcesRoot(),
  options: ManagedSkillUpdateOptions = {},
): Promise<
  | { ok: true; skill: InstalledSkill }
  | { ok: false; reason: 'not_managed' | 'source_missing' | 'local_modified' | 'metadata_error' | 'blocked_path' | 'write_failed' }
> {
  if (!isSafeSkillId(skillId)) return { ok: false, reason: 'not_managed' };
  const updateTarget = await resolveSkillFileUpdateTarget(root, skillId);
  if (!updateTarget.ok && updateTarget.reason === 'blocked_path') return { ok: false, reason: 'blocked_path' };
  const installed = await listInstalledSkills(root, { managedSourceRoot: sourceRoot });
  const skill = installed.find((candidate) => candidate.id === skillId);
  if (!skill) return { ok: false, reason: 'not_managed' };
  if (skill.validationStatus === 'metadata_error' || skill.managedUpdateStatus === 'metadata_error') {
    return { ok: false, reason: 'metadata_error' };
  }
  if (skill.sourceType !== 'managed' || !skill.managedSourceId) return { ok: false, reason: 'not_managed' };
  if (skill.managedUpdateStatus === 'local_modified' && !options.force) return { ok: false, reason: 'local_modified' };
  if (skill.managedUpdateStatus === 'source_missing') return { ok: false, reason: 'source_missing' };

  const source = await readManagedSkillSource(sourceRoot, skill.managedSourceId);
  if (!source.ok) {
    if (source.reason === 'blocked_path') return { ok: false, reason: 'blocked_path' };
    return { ok: false, reason: 'source_missing' };
  }

  const skillDir = join(root, 'skills', skillId);
  const skillFile = join(skillDir, 'SKILL.md');
  const lockFile = join(skillDir, 'skill.lock.json');
  try {
    const [skillsReal, skillReal, current, currentLock] = await Promise.all([
      realpath(join(root, 'skills')),
      realpath(skillDir),
      readContainedRegularTextFile(skillDir, skillFile),
      readContainedRegularTextFile(skillDir, lockFile),
    ]);
    if (!isPathInside(skillsReal, skillReal)) return { ok: false, reason: 'blocked_path' };
    if (!current.ok) return { ok: false, reason: current.reason === 'blocked_path' ? 'blocked_path' : 'write_failed' };
    if (!currentLock.ok) return { ok: false, reason: currentLock.reason === 'blocked_path' ? 'blocked_path' : 'write_failed' };

    const hasExpectedHashes = options.expectedCurrentSha256 !== undefined || options.expectedSourceSha256 !== undefined;
    if (options.force || hasExpectedHashes) {
      if (
        !isSha256(options.expectedCurrentSha256) ||
        !isSha256(options.expectedSourceSha256) ||
        current.sha256.toLowerCase() !== options.expectedCurrentSha256.toLowerCase() ||
        source.contentSha256.toLowerCase() !== options.expectedSourceSha256.toLowerCase()
      ) {
        return { ok: false, reason: 'local_modified' };
      }
    }
    const previousBaseline = await readManagedSkillBaseline(skillDir);
    const restorePrevious = async () => {
      await writeContainedRegularTextFile(skillDir, skillFile, current.content).catch(() => {});
      await writeContainedRegularTextFile(skillDir, lockFile, currentLock.content).catch(() => {});
      if (previousBaseline !== undefined) {
        await writeManagedSkillBaseline(skillDir, previousBaseline).catch(() => {});
      } else {
        await removeManagedSkillBaseline(skillDir).catch(() => {});
      }
    };

    if (!await writeContainedRegularTextFile(skillDir, skillFile, source.content)) {
      return { ok: false, reason: 'write_failed' };
    }
    if (
      !await writeSkillLock(
        skillDir,
        createManagedSkillLock(
          skillId,
          source.contentSha256,
          source.contentSha256,
          skill.managedSourceId,
        ),
      )
    ) {
      await restorePrevious();
      return { ok: false, reason: 'write_failed' };
    }
    if (!await writeManagedSkillBaseline(skillDir, source.content)) {
      await restorePrevious();
      return { ok: false, reason: 'write_failed' };
    }
    const refreshed = await listInstalledSkills(root, { managedSourceRoot: sourceRoot });
    const updated = refreshed.find((candidate) => candidate.id === skillId);
    if (!updated) {
      await restorePrevious();
      return { ok: false, reason: 'write_failed' };
    }
    return { ok: true, skill: updated };
  } catch {
    return { ok: false, reason: 'write_failed' };
  }
}

async function resolveSkillFileUpdateTarget(root: string, skillId: string): Promise<
  | { ok: true }
  | { ok: false; reason: 'missing' | 'blocked_path' }
> {
  const skillsDir = join(root, 'skills');
  const skillDir = join(skillsDir, skillId);
  const skillFile = join(skillDir, 'SKILL.md');
  try {
    const [rootReal, skillsStat] = await Promise.all([realpath(root), lstat(skillsDir)]);
    if (!skillsStat.isDirectory() || skillsStat.isSymbolicLink()) return { ok: false, reason: 'blocked_path' };
    const skillsReal = await realpath(skillsDir);
    if (!isPathInside(rootReal, skillsReal)) return { ok: false, reason: 'blocked_path' };

    const skillStat = await lstat(skillDir);
    if (!skillStat.isDirectory() || skillStat.isSymbolicLink()) return { ok: false, reason: 'blocked_path' };
    const skillReal = await realpath(skillDir);
    if (!isPathInside(skillsReal, skillReal)) return { ok: false, reason: 'blocked_path' };

    const fileStat = await lstat(skillFile);
    if (!fileStat.isFile() || fileStat.isSymbolicLink()) return { ok: false, reason: 'blocked_path' };
    const fileReal = await realpath(skillFile);
    if (!isPathInside(skillReal, fileReal)) return { ok: false, reason: 'blocked_path' };
    return { ok: true };
  } catch {
    return { ok: false, reason: 'missing' };
  }
}

export async function getSkillGovernanceDetails(
  root: string,
  skillId: string,
  sourceRoot = resolveManagedSkillSourcesRoot(),
): Promise<
  | { ok: true; details: SkillGovernanceDetails }
  | { ok: false; reason: 'not_found' | 'invalid_id' }
> {
  if (!isSafeSkillId(skillId)) return { ok: false, reason: 'invalid_id' };
  const installed = await listInstalledSkills(root, { managedSourceRoot: sourceRoot });
  const skill = installed.find((candidate) => candidate.id === skillId);
  if (!skill) return { ok: false, reason: 'not_found' };
  return { ok: true, details: await toSkillGovernanceDetails(skill, sourceRoot) };
}

export async function previewManagedSkillUpdate(
  root: string,
  skillId: string,
  sourceRoot = resolveManagedSkillSourcesRoot(),
): Promise<
  | { ok: true; preview: ManagedSkillUpdatePreview }
  | { ok: false; reason: 'not_managed' | 'source_missing' | 'metadata_error' | 'blocked_path' | 'read_failed' }
> {
  if (!isSafeSkillId(skillId)) return { ok: false, reason: 'not_managed' };
  const updateTarget = await resolveSkillFileUpdateTarget(root, skillId);
  if (!updateTarget.ok && updateTarget.reason === 'blocked_path') return { ok: false, reason: 'blocked_path' };
  const installed = await listInstalledSkills(root, { managedSourceRoot: sourceRoot });
  const skill = installed.find((candidate) => candidate.id === skillId);
  if (!skill || skill.sourceType !== 'managed' || !skill.managedSourceId) return { ok: false, reason: 'not_managed' };
  if (skill.validationStatus === 'metadata_error' || skill.managedUpdateStatus === 'metadata_error') {
    return { ok: false, reason: 'metadata_error' };
  }
  if (skill.managedUpdateStatus === 'source_missing') return { ok: false, reason: 'source_missing' };

  const source = await readManagedSkillSource(sourceRoot, skill.managedSourceId);
  if (!source.ok) {
    if (source.reason === 'blocked_path') return { ok: false, reason: 'blocked_path' };
    return { ok: false, reason: 'source_missing' };
  }

  const skillDir = join(root, 'skills', skillId);
  const skillFile = join(skillDir, 'SKILL.md');
  try {
    const [skillsReal, skillReal, current] = await Promise.all([
      realpath(join(root, 'skills')),
      realpath(skillDir),
      readContainedRegularTextFile(skillDir, skillFile),
    ]);
    if (!isPathInside(skillsReal, skillReal)) return { ok: false, reason: 'blocked_path' };
    if (!current.ok) return { ok: false, reason: current.reason === 'blocked_path' ? 'blocked_path' : 'read_failed' };
    const baselineContent = await readManagedSkillBaseline(skillDir);
    return {
      ok: true,
      preview: {
        skill: await toSkillGovernanceDetails(skill, sourceRoot),
        currentContent: current.content,
        sourceContent: source.content,
        ...(baselineContent !== undefined ? { baselineContent } : {}),
        expectedCurrentSha256: current.sha256,
        expectedSourceSha256: source.contentSha256,
        summary: diffSummary(current.content, source.content),
      },
    };
  } catch {
    return { ok: false, reason: 'read_failed' };
  }
}

async function toSkillGovernanceDetails(skill: InstalledSkill, sourceRoot: string): Promise<SkillGovernanceDetails> {
  const baselineContent = skill.sourceType === 'managed'
    ? await readManagedSkillBaseline(skill.path)
    : undefined;
  let sourceAvailable: boolean | undefined;
  let sourceChanged: boolean | undefined;
  if (skill.sourceType === 'managed' && skill.managedSourceId) {
    const source = await readManagedSkillSource(sourceRoot, skill.managedSourceId);
    sourceAvailable = source.ok;
    sourceChanged = source.ok && skill.sourceContentSha256 !== undefined
      ? source.contentSha256.toLowerCase() !== skill.sourceContentSha256.toLowerCase()
      : undefined;
  }
  return {
    id: skill.id,
    name: skill.name,
    description: skill.description,
    path: skill.path,
    declaredTools: skill.declaredTools,
    sourceType: skill.sourceType,
    userModified: skill.userModified,
    validationStatus: skill.validationStatus,
    enabled: skill.enabled,
    runtimeStatus: skill.runtimeStatus,
    validationCodes: skill.validationCodes,
    validationMessages: skill.validationMessages ?? [],
    ...(skill.managedSourceId ? { managedSourceId: skill.managedSourceId } : {}),
    ...(skill.managedUpdateStatus ? { managedUpdateStatus: skill.managedUpdateStatus } : {}),
    hasManagedBaseline: baselineContent !== undefined,
    ...(sourceAvailable !== undefined ? { sourceAvailable } : {}),
    ...(sourceChanged !== undefined ? { sourceChanged } : {}),
  };
}

async function writeManagedSkillBaseline(skillDir: string, content: string): Promise<boolean> {
  try {
    const baselineFile = join(skillDir, MANAGED_SKILL_BASELINE_RELATIVE_PATH);
    const baselineDir = dirname(baselineFile);
    const metadataDir = dirname(baselineDir);
    await mkdir(metadataDir, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'EEXIST') throw error;
    });
    await mkdir(baselineDir, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'EEXIST') throw error;
    });

    const resolved = await resolveManagedSkillBaselineDir(skillDir);
    if (!resolved.ok) return false;
    return writeContainedRegularTextFile(resolved.baselineDir, baselineFile, content);
  } catch {
    return false;
  }
}

async function readManagedSkillBaseline(skillDir: string): Promise<string | undefined> {
  const resolved = await resolveManagedSkillBaselineDir(skillDir);
  if (!resolved.ok) return undefined;
  const baselineFile = join(skillDir, MANAGED_SKILL_BASELINE_RELATIVE_PATH);
  const baseline = await readContainedRegularTextFile(resolved.baselineDir, baselineFile);
  return baseline.ok ? baseline.content : undefined;
}

async function removeManagedSkillBaseline(skillDir: string): Promise<void> {
  const resolved = await resolveManagedSkillBaselineDir(skillDir);
  if (!resolved.ok) return;
  const baselineFile = join(skillDir, MANAGED_SKILL_BASELINE_RELATIVE_PATH);
  const [baselineReal, fileStat] = await Promise.all([
    realpath(resolved.baselineDir),
    lstat(baselineFile).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    }),
  ]);
  if (fileStat === null) return;
  if (!fileStat.isFile() || fileStat.isSymbolicLink()) return;
  const fileReal = await realpath(baselineFile);
  if (!isPathInside(baselineReal, fileReal)) return;
  await unlink(baselineFile);
}

async function resolveManagedSkillBaselineDir(skillDir: string): Promise<
  | { ok: true; baselineDir: string }
  | { ok: false }
> {
  try {
    const baselineDir = dirname(
      join(skillDir, MANAGED_SKILL_BASELINE_RELATIVE_PATH),
    );
    const metadataDir = dirname(baselineDir);
    const [skillReal, metadataStat, baselineStat] = await Promise.all([
      realpath(skillDir),
      lstat(metadataDir),
      lstat(baselineDir),
    ]);
    if (
      !metadataStat.isDirectory() ||
      metadataStat.isSymbolicLink() ||
      !baselineStat.isDirectory() ||
      baselineStat.isSymbolicLink()
    ) {
      return { ok: false };
    }
    const [metadataReal, baselineReal] = await Promise.all([realpath(metadataDir), realpath(baselineDir)]);
    if (!isPathInside(skillReal, metadataReal) || !isPathInside(metadataReal, baselineReal)) return { ok: false };
    return { ok: true, baselineDir };
  } catch {
    return { ok: false };
  }
}

export async function setSkillEnabled(
  root: string,
  skillRefOrId: string,
  enabled: boolean,
  options: SkillReadOptions = {},
): Promise<SetSkillEnabledResult> {
  return setSkillPreference(root, skillRefOrId, { enabled }, options);
}

export async function setSkillPinned(
  root: string,
  skillRefOrId: string,
  pinned: boolean,
  options: SkillReadOptions = {},
): Promise<SetSkillPinnedResult> {
  return setSkillPreference(root, skillRefOrId, { pinned }, options);
}

async function setSkillPreference(
  root: string,
  skillRefOrId: string,
  patch: { enabled?: boolean; pinned?: boolean },
  options: SkillReadOptions,
): Promise<SetSkillEnabledResult> {
  const source = resolveSkillDiscoveryPaths(options.cwd ?? root, root, options.homeDir);
  const scan = await scanSkillsWithDiagnostics(source);
  const resolvedTarget = resolveSkillPreferenceTarget(scan.inventory, skillRefOrId);
  if (!resolvedTarget.ok) return resolvedTarget;
  const target = resolvedTarget.target;
  const current = scan.runtimeState;
  if (!current.ok) {
    return { ok: false, reason: current.reason === 'blocked_path' ? 'blocked_path' : 'state_error' };
  }
  const migration = clearResolvedSkillPreferenceReviews(
    patchSkillRuntimePreference(
      migrateSkillRuntimePreferences(current, scan.inventory),
      target,
      patch,
    ),
    scan.inventory,
  );
  const written = await writeSkillRuntimePreferences(root, migration.preferences, {
    needsReview: migration.needsReview,
  });
  if (!written.ok) return written;

  const refreshed = await listGovernedSkillEntries(root, options);
  const skill = refreshed.find((candidate) => candidate.ref === target.ref);
  if (!skill) return { ok: false, reason: 'not_found' };
  return { ok: true, skill };
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^sha256:[a-f0-9]{64}$/i.test(value);
}

function diffSummary(currentContent: string, sourceContent: string): ManagedSkillUpdatePreview['summary'] {
  const currentLines = splitLines(currentContent);
  const sourceLines = splitLines(sourceContent);
  const max = Math.max(currentLines.length, sourceLines.length);
  let changedLineCount = 0;
  for (let index = 0; index < max; index += 1) {
    if (currentLines[index] !== sourceLines[index]) changedLineCount += 1;
  }
  return {
    currentLineCount: currentLines.length,
    sourceLineCount: sourceLines.length,
    changedLineCount,
  };
}

function splitLines(content: string): string[] {
  if (content.length === 0) return [];
  return content.replace(/\r\n/g, '\n').split('\n');
}

export async function resolveSkillOpenPath(
  root: string,
  idOrRef: string,
  target: SkillOpenTarget,
  options: SkillReadOptions = {},
): Promise<ResolveSkillOpenPathResult> {
  if (target !== 'file' && target !== 'directory') return { ok: false, reason: 'missing' };

  if (!isSafeSkillId(idOrRef)) {
    if (!idOrRef.includes(':') || idOrRef.length > 512) return { ok: false, reason: 'invalid_id' };
    const scan = await scanSkillsWithDiagnostics(
      resolveSkillDiscoveryPaths(options.cwd ?? root, root, options.homeDir),
    );
    const skill = [...scan.inventory, ...scan.rejected].find(
      (candidate) => candidate.ref === idOrRef,
    );
    if (!skill) return { ok: false, reason: 'missing' };
    const candidate = target === 'file' ? join(skill.path, 'SKILL.md') : skill.path;
    try {
      const [containmentReal, openedPath] = await Promise.all([
        realpath(skill.discoveryRoot),
        realpath(candidate),
      ]);
      if (!isPathInside(containmentReal, openedPath)) return { ok: false, reason: 'blocked_path' };
      const openedStat = await stat(openedPath);
      if (target === 'file' && !openedStat.isFile()) return { ok: false, reason: 'not_file' };
      if (target === 'directory' && !openedStat.isDirectory()) return { ok: false, reason: 'not_directory' };
      return { ok: true, path: openedPath, target };
    } catch {
      return { ok: false, reason: 'missing' };
    }
  }

  const skillsDir = join(root, 'skills');
  let rootReal: string;
  let skillsReal: string;
  try {
    [rootReal, skillsReal] = await Promise.all([realpath(root), realpath(skillsDir)]);
  } catch {
    return { ok: false, reason: 'missing' };
  }
  if (!isPathInside(rootReal, skillsReal)) return { ok: false, reason: 'blocked_path' };

  const skillDir = join(skillsDir, idOrRef);
  const candidate = target === 'file' ? join(skillDir, 'SKILL.md') : skillDir;
  let openedPath: string;
  try {
    openedPath = await realpath(candidate);
  } catch {
    return { ok: false, reason: 'missing' };
  }
  if (!isPathInside(skillsReal, openedPath)) return { ok: false, reason: 'blocked_path' };

  const openedStat = await stat(openedPath).catch(() => null);
  if (!openedStat) return { ok: false, reason: 'missing' };
  if (target === 'file' && !openedStat.isFile()) return { ok: false, reason: 'not_file' };
  if (target === 'directory' && !openedStat.isDirectory()) return { ok: false, reason: 'not_directory' };
  return { ok: true, path: openedPath, target };
}

async function readInstalledSkillDefinitions(root: string, options: SkillReadOptions = {}): Promise<InstalledSkillDefinition[]> {
  const scanned = await scanWorkspaceSkills(root);
  return enrichInstalledSkillDefinitions(scanned, options);
}

async function enrichInstalledSkillDefinitions(
  scanned: readonly ScannedSkill[],
  options: SkillReadOptions = {},
): Promise<InstalledSkillDefinition[]> {
  const out: InstalledSkillDefinition[] = [];
  for (const skill of scanned) {
    const status = await readSkillLockStatus(skill.path, skill.id, skill.contentSha256, options);
    out.push({
      ...skill,
      ...status,
    });
  }
  return out;
}

async function readSkillLockStatus(skillPath: string, id: string, currentHash: string, options: SkillReadOptions = {}): Promise<Pick<
  InstalledSkill,
  | 'sourceType'
  | 'sourceName'
  | 'sourceVersion'
  | 'contentSha256'
  | 'installedAt'
  | 'userModified'
  | 'validationStatus'
  | 'validationCodes'
  | 'validationMessages'
  | 'managedSourceId'
  | 'managedUpdateStatus'
  | 'sourceContentSha256'
>> {
  const lockPath = join(skillPath, 'skill.lock.json');
  let lockStat: Awaited<ReturnType<typeof lstat>>;
  try {
    lockStat = await lstat(lockPath);
  } catch {
    return missingSkillLockStatus();
  }

  if (!lockStat.isFile() || lockStat.isSymbolicLink()) {
    return invalidSkillLockStatus('lock_symlink', 'Skill lock is not a regular file.');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(lockPath, 'utf8'));
  } catch {
    return invalidSkillLockStatus('invalid_json', 'Skill lock JSON is invalid.');
  }

  let managedSource: { status: 'available'; contentSha256: string } | { status: 'missing' } | undefined;
  if (
    parsed &&
    typeof parsed === 'object' &&
    !Array.isArray(parsed) &&
    (parsed as Record<string, unknown>).sourceType === 'managed'
  ) {
    const sourceId = (parsed as Record<string, unknown>).sourceId;
    if (typeof sourceId === 'string' && isSafeSkillId(sourceId)) {
      const source = await readManagedSkillSource(
        options.managedSourceRoot ?? resolveManagedSkillSourcesRoot(),
        sourceId,
      );
      managedSource = source.ok
        ? { status: 'available', contentSha256: source.contentSha256 }
        : { status: 'missing' };
    }
  }
  return validateSkillLock({
    lock: parsed,
    skillId: id,
    currentContentSha256: currentHash,
    ...(managedSource ? { managedSource } : {}),
  });
}
