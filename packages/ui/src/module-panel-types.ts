import type {
  DailyReviewArchive,
  DailyReviewArchiveSummary,
  DailyReviewConfig,
  DailyReviewMode,
  DailyReviewSummary,
  DailyReviewTopEntry,
  PlanReminderDeliveryTarget,
  PlanReminderRecurrence,
} from '@maka/core';
import type { SelectorOptionData } from '@astryxdesign/core/Selector';

export interface SkillEntry {
  kind?: 'skill' | 'discovery_diagnostic';
  ref?: string;
  id: string;
  name: string;
  description: string;
  path: string;
  /**
   * Tools the skill *declares* it would like to use. This is a request, not
   * a grant — the active session sandbox boundary still applies. We surface
   * the list so users can see what a skill is asking for before installation.
   */
  declaredTools?: string[];
  sourceType?: 'workspace' | 'bundled' | 'managed' | 'unknown';
  userModified?: boolean;
  validationStatus?: 'ok' | 'missing_lock' | 'modified' | 'metadata_error';
  managedUpdateStatus?: 'not_managed' | 'source_missing' | 'up_to_date' | 'update_available' | 'local_modified' | 'metadata_error';
  enabled: boolean;
  pinned?: boolean;
  runtimeStatus: 'enabled' | 'disabled' | 'state_error';
  scope?: 'project' | 'workspace' | 'user' | 'custom';
  source?: 'maka' | 'agents' | 'legacy' | 'custom';
  contextStatus?:
    | 'advertised'
    | 'disabled'
    | 'invalid'
    | 'host_incompatible'
    | 'shadowed'
    | 'budget';
  contextRank?: number;
  shadowedBy?: string;
  needsReview?: boolean;
  discoveryDiagnosticReason?: 'blocked_path' | 'read_failed';
  manageable?: boolean;
}

export type SkillGovernanceStatus = 'not_managed' | 'source_missing' | 'up_to_date' | 'update_available' | 'local_modified' | 'metadata_error';
export type SkillValidationStatus = 'ok' | 'missing_lock' | 'modified' | 'metadata_error';
export type SkillValidationCode =
  | 'missing_lock'
  | 'modified'
  | 'invalid_json'
  | 'id_mismatch'
  | 'unsupported_schema'
  | 'invalid_hash'
  | 'write_failed'
  | 'lock_symlink';

export interface SkillGovernanceDetails {
  id: string;
  name: string;
  description: string;
  path: string;
  declaredTools: string[];
  sourceType: 'workspace' | 'bundled' | 'managed' | 'unknown';
  userModified: boolean;
  validationStatus: SkillValidationStatus;
  enabled: boolean;
  runtimeStatus: 'enabled' | 'disabled' | 'state_error';
  validationCodes: SkillValidationCode[];
  validationMessages: string[];
  managedSourceId?: string;
  managedUpdateStatus?: SkillGovernanceStatus;
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

/**
 * Marketplace taxonomy buckets surfaced by the 市场 tab category filter.
 * Mirrors MANAGED_SKILL_CATEGORIES in apps/desktop's managed-skill-sources;
 * the main-process reader always resolves an entry to one of these, so the
 * renderer can treat `category` as required (unknown → 效率工具 upstream).
 */
export type ManagedSkillCategory =
  | '内容创作'
  | '数据与AI'
  | '设计与UI'
  | 'DevOps与部署'
  | '文档与写作'
  | '效率工具'
  | '研究与分析';

export interface ManagedSkillSourceEntry {
  id: string;
  name: string;
  description: string;
  category: ManagedSkillCategory;
  sourceType: 'local';
}

/**
 * One entry in the built-in (内置) skill catalog shipped with the app. Mirrors
 * listBundledSkillCatalog in apps/desktop's skills module. `installed` reflects
 * whether the current workspace already has skills/<id>; nothing here is
 * auto-installed — the 内置 tab offers a per-entry install action.
 */
export interface BundledSkillCatalogEntry {
  id: string;
  name: string;
  description: string;
  category: ManagedSkillCategory;
  declaredTools: string[];
  installed: boolean;
}

export type PlanReminderDraftInput = {
  title: string;
  note?: string;
  runAt: number;
  recurrence?: PlanReminderRecurrence;
  cronExpression?: string;
  delivery?: PlanReminderDeliveryTarget;
};

export type PlanReminderUpdatePatch = {
  title?: string;
  note?: string;
  runAt?: number;
  recurrence?: PlanReminderRecurrence;
  cronExpression?: string;
  delivery?: PlanReminderDeliveryTarget;
  enabled?: boolean;
};

/**
 * PR-DAILY-REVIEW-MVP-0: bridge handed in by `main.tsx`. Keeps
 * `@maka/ui` independent of desktop preload globals — the renderer wires a
 * host-injected daily-review reader, and the UI layer stays reusable in fixtures,
 * e2e-fixture tests, and future surfaces
 * (e.g. a desktop notification renderer).
 */
export interface DailyReviewBridge {
  fetchDay(offsetDays: number, daySpan?: number): Promise<DailyReviewSummary>;
  /**
   * PR-DAILY-REVIEW-FULL-0 — optional pipeline methods. Renderer checks
   * for presence before exposing the matching UI. When undefined, the
   * panel still works as the MVP telemetry view.
   */
  runOnce?(opts: { mode: DailyReviewMode; modelKey?: string }): Promise<{ archiveId: string }>;
  modelOptions?: SelectorOptionData[];
  listArchives?(): Promise<DailyReviewArchiveSummary[]>;
  getArchive?(archiveId: string): Promise<DailyReviewArchive>;
  deleteArchive?(archiveId: string): Promise<void>;
  fetchConfig?(): Promise<DailyReviewConfig>;
  updateConfig?(patch: Partial<DailyReviewConfig>): Promise<DailyReviewConfig>;
}

/**
 * Local-only daily summary view. Renders today by default; the
 * left/right arrows step through `offsetDays`. No LLM call — the
 * bullet list of sessions / top tools / top models is the whole
 * value-prop. Future PR can layer a generated narrative on top.
 *
 * borrow: external "today" digest concept (read-only summary).
 * diverge: no cron, no auto-push, no memory promotion (privacy default).
 */
export type DailyReviewMarkdownActionInput = {
  markdown: string;
  label: string;
  summary: DailyReviewSummary;
};
