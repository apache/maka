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
  buildSkillsPromptFragmentFromInventoryWithReport,
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
  buildSkillAgentToolFromInventory,
  buildSkillSearchAgentTool,
  buildSkillSearchAgentToolFromInventory,
  SkillShadowSelectionTracker,
  SKILL_TOOL_NAME,
  SKILL_SEARCH_TOOL_NAME,
} from './skills-agent-tools.js';
export type {
  SkillInventoryResolver,
  SkillToolOptions,
} from './skills-agent-tools.js';

// ── From skills-starter ───────────────────────────────────────────────────
export { buildStarterSkillTemplate } from './skills-starter.js';
