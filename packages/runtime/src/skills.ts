/**
 * Re-export barrel for all skill sub-modules.
 *
 * The original `skills.ts` was split along discovery/metadata/context/state
 * seams in #1408. This file re-exports every symbol so existing callers that
 * import from `'./skills.js'` (internal modules, tests, desktop) continue
 * to work without changes. New code should import from the specific
 * sub-module instead.
 *
 * @see skills-discovery.js   – path resolution, directory scanning, dedup
 * @see skills-metadata.js    – front-matter parsing, validation
 * @see skills-context.js     – gating, prompt rendering, search, instruction loading
 * @see skills-state.js       – per-workspace enablement state read/write
 * @see skills-agent-tools.js – Skill / SkillSearch tool builders
 * @see skills-starter.js     – pure starter SKILL.md template
 */

// ── From path-containment (contained I/O moved in #1408) ──────────────────
export {
  readContainedRegularFile,
  readContainedRegularTextFile,
  writeContainedRegularTextFile,
  isRecord,
} from './path-containment.js';

// ── From skills-metadata ──────────────────────────────────────────────────
export {
  validateSkillMetadata,
  parseSkillFrontMatter,
  cleanPromptText,
  truncateCodepoints,
  MAX_SKILL_BODY_CHARS,
  MAX_SKILL_TOOL_BODY_CHARS,
} from './skills-metadata.js';
export type {
  SkillManifest,
  SkillValidationSeverity,
  SkillValidationCode,
  SkillValidationIssue,
  SkillMetadataValidationResult,
} from './skills-metadata.js';

// ── From skills-state ──────────────────────────────────────────────────────
export {
  clearResolvedSkillPreferenceReviews,
  encodeSkillRuntimePreferences,
  getSkillRuntimePreference,
  isSkillPreferenceReviewPending,
  migrateSkillRuntimePreferences,
  patchSkillRuntimePreference,
  readSkillRuntimeState,
  resolveSkillPreferenceTarget,
  writeSkillRuntimeState,
  writeSkillRuntimePreferences,
} from './skills-state.js';
export type {
  ResolveSkillPreferenceTargetResult,
  SkillPreferenceMigration,
  SkillPreferenceTarget,
  SkillRuntimeStatus,
  SkillRuntimePreference,
  SkillRuntimeStateReadResult,
} from './skills-state.js';

export {
  listManagedSkillSources,
  MANAGED_SKILL_CATEGORIES,
  normalizeManagedSkillCategory,
  readManagedSkillSources,
  readManagedSkillSource,
  resolveManagedSkillSourcesRoot,
  toManagedSkillSourceEntry,
} from './managed-skill-sources.js';
export type {
  ManagedSkillCategory,
  ManagedSkillSourceEntry,
  ManagedSkillSourceRecord,
  ReadManagedSkillSourcesResult,
  ReadManagedSkillSourceResult,
} from './managed-skill-sources.js';

export {
  createBundledSkillLock,
  createManagedSkillLock,
  getBundledSkillSource,
  invalidSkillLockStatus,
  isCurrentBundledSkillLock,
  MANAGED_SKILL_BASELINE_RELATIVE_PATH,
  missingSkillLockStatus,
  validateSkillLock,
} from './skills-governance.js';
export type {
  ManagedSkillUpdateStatus,
  ManagedSourceSnapshot,
  SkillGovernanceStatus,
  SkillLockFile,
  SkillLockValidationCode,
  SkillSourceType,
  SkillValidationStatus,
} from './skills-governance.js';

export { BUNDLED_SKILL_CATALOG } from './bundled-skill-catalog.generated.js';
export type { BundledSkillSource } from './bundled-skill-catalog.generated.js';

// ── From skills-discovery ──────────────────────────────────────────────────
export {
  resolveSkillDiscoveryPaths,
  scanSkills,
  scanSkillsWithDiagnostics,
  scanWorkspaceSkills,
  scanWorkspaceSkillsWithDiagnostics,
} from './skills-discovery.js';
export type {
  SkillScope,
  SkillDiscoverySource,
  SkillDiscoveryEntry,
  SkillSource,
  SkillSourceResolver,
  RuntimeSkillDefinition,
  ScannedSkill,
  SkillScanDiagnostic,
  SkillScanResult,
  SkillDiscoveryDiagnostic,
  RejectedSkillDefinition,
} from './skills-discovery.js';

// ── From skills-context ────────────────────────────────────────────────────
export {
  gateSkillsByHostCapabilities,
  resolveSkillsPromptCharBudget,
  selectSkillsForContext,
  selectSkillScanForContext,
  buildSkillsPromptFragment,
  buildSkillsPromptFragmentWithReport,
  loadSkillInstructions,
  loadSkillInstructionsFromScan,
  searchSkills,
  MAX_SKILLS_PROMPT_CHARS,
  MIN_SKILLS_PROMPT_TOKENS,
  MAX_SKILLS_PROMPT_TOKENS,
  SKILLS_PROMPT_CONTEXT_RATIO,
  SKILL_SEARCH_RESULT_LIMIT,
} from './skills-context.js';
export type {
  HostCapabilities,
  HostCapabilitiesResolver,
  SkillCatalogBudgetOptions,
  SkillHostCompatibility,
  GatedSkill,
  SkillContextDecisionReason,
  SkillContextDecision,
  SkillSelectionReport,
  SkillContextSelection,
  SkillsPromptFragmentResult,
  SkillSearchMatch,
  SkillSearchResult,
  LoadedSkillInstructions,
  LoadSkillInstructionsResult,
} from './skills-context.js';

// ── From skills-agent-tools ────────────────────────────────────────────────
export {
  buildSkillAgentTool,
  buildSkillSearchAgentTool,
  SkillShadowSelectionTracker,
  SKILL_TOOL_NAME,
  SKILL_SEARCH_TOOL_NAME,
} from './skills-agent-tools.js';
export type { SkillToolOptions } from './skills-agent-tools.js';

// ── From skills-starter ───────────────────────────────────────────────────
export { buildStarterSkillTemplate } from './skills-starter.js';
