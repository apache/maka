import { lazy, Suspense } from 'react';
import type { PlanReminder } from '@maka/core';
import { deriveCapabilityAuditReport } from '@maka/core';
import { CalendarDays } from './icons.js';
import { EmptyState } from '@astryxdesign/core';
import { ModulePage } from './primitives/module-page.js';
import { useUiLocale } from './locale-context.js';
import { getSharedUiCopy } from './shared-ui-copy.js';
import type { ModuleHubHeader } from './module-hub-selector.js';
import type {
  BundledSkillCatalogEntry,
  DailyReviewBridge,
  DailyReviewMarkdownActionInput,
  ManagedSkillSourceEntry,
  ManagedSkillUpdatePreview,
  PlanReminderDraftInput,
  PlanReminderUpdatePatch,
  SkillEntry,
} from './module-panel-types.js';

const SkillsModuleMain = lazy(() => import('./skills-panel.js').then((module) => ({ default: module.SkillsModuleMain })));
const DailyReviewPanel = lazy(() => import('./daily-review-panel.js').then((module) => ({ default: module.DailyReviewPanel })));
const PlanReminderPanel = lazy(() => import('./plan-reminder-panel.js').then((module) => ({ default: module.PlanReminderPanel })));

/** Skills renders its own <main> inside the lazy chunk, so its fallback must too. */
function ModulePageFallback(props: { label: string; message: string }) {
  return (
    <main className="maka-main detailPane maka-module-main agents-chat-panel" data-page-shell="layout" aria-label={props.label}>
      <ModulePanelFallback message={props.message} />
    </main>
  );
}

function ModulePanelFallback(props: { message: string }) {
  return (
    <div className="maka-lazy-fallback" data-surface="module" role="status" aria-busy="true">
      {props.message}
    </div>
  );
}

export function SkillsPage(props: {
  skills?: SkillEntry[];
  hubHeader?: ModuleHubHeader;
  planReminders?: PlanReminder[];
  onRefreshSkills?(): void | Promise<void>;
  onOpenSkill?(skillId: string): void | Promise<void>;
  onUseSkill?(skillId: string, skillName: string): void;
  onOpenSkillsFolder?(): void | Promise<void>;
  managedSkillSources?: ManagedSkillSourceEntry[];
  onRefreshManagedSkillSources?(): void | Promise<void>;
  onImportManagedSkillSource?(): void | Promise<void>;
  onInstallManagedSkill?(sourceId: string): void | Promise<void>;
  bundledSkillCatalog?: BundledSkillCatalogEntry[];
  onRefreshBundledSkillCatalog?(): void | Promise<void>;
  onInstallBundledSkill?(id: string): void | Promise<void>;
  onPreviewManagedSkillUpdate?(skillId: string): Promise<ManagedSkillUpdatePreview | null>;
  onUpdateManagedSkill?(skillId: string, options?: { force?: boolean; expectedCurrentSha256?: string; expectedSourceSha256?: string }): boolean | Promise<boolean>;
  onSetSkillEnabled?(skillId: string, enabled: boolean): void | Promise<void>;
  onSetSkillPinned?(skillRef: string, pinned: boolean): void | Promise<void>;
  onDeleteSkill?(skillRef: string): void | Promise<void>;
}) {
  const copy = getSharedUiCopy(useUiLocale()).modules;
  const auditReport = deriveCapabilityAuditReport({
    skills: props.skills ?? [],
    planReminders: props.planReminders ?? [],
  });
  return (
    <Suspense fallback={<ModulePageFallback label={props.hubHeader?.title ?? copy.skills} message={copy.loadingSkills} />}>
      <SkillsModuleMain {...props} auditReport={auditReport} />
    </Suspense>
  );
}

export function AutomationsPage(props: {
  hubHeader?: ModuleHubHeader;
  reminders?: PlanReminder[];
  createRequestNonce?: number;
  onCreateRequestHandled?: () => void;
  keepSystemAwake?: boolean;
  onKeepSystemAwakeChange?: (next: boolean) => Promise<void>;
  onRefresh?: () => void | Promise<void>;
  onCreate?(input: PlanReminderDraftInput): boolean | Promise<boolean> | void | Promise<void>;
  onUpdate?(id: string, patch: PlanReminderUpdatePatch): boolean | Promise<boolean> | void | Promise<void>;
  onToggle?: (id: string, enabled: boolean) => void | Promise<void>;
  onTriggerNow?: (id: string) => void | Promise<void>;
  onSnooze?: (id: string) => void | Promise<void>;
  onClearRunHistory?: (id: string) => void | Promise<void>;
  onDelete?: (id: string) => void | Promise<void>;
}) {
  const copy = getSharedUiCopy(useUiLocale()).modules;
  const label = props.hubHeader?.title ?? copy.automations;
  return (
    <main className="maka-main detailPane maka-module-main agents-chat-panel" data-page-shell="layout" data-module="plan-reminders" aria-label={label}>
      <Suspense fallback={<ModulePanelFallback message={copy.loadingAutomations} />}>
        <PlanReminderPanel {...props} reminders={props.reminders ?? []} />
      </Suspense>
    </main>
  );
}

export function DailyReviewPage(props: {
  bridge?: DailyReviewBridge;
  hubHeader?: ModuleHubHeader;
  onSelectSession?: (sessionId: string) => void;
  onCopyMarkdown?: (input: DailyReviewMarkdownActionInput) => Promise<void> | void;
  onAppendMarkdown?: (input: DailyReviewMarkdownActionInput) => Promise<void> | void;
  onSaveMarkdown?: (input: DailyReviewMarkdownActionInput) => Promise<void> | void;
}) {
  const copy = getSharedUiCopy(useUiLocale()).modules;
  const label = props.hubHeader?.title ?? copy.dailyReview;
  return (
    <main className="maka-main detailPane maka-module-main agents-chat-panel" data-page-shell="layout" data-module="daily-review" aria-label={label}>
      {props.bridge ? (
        // The page header lives INSIDE the panel: its primary action (生成分析 /
        // 查看分析) rides the panel's run state, exactly like 计划提醒's 新建.
        // The bridge-less fallback keeps its own static header below.
        <Suspense fallback={<ModulePanelFallback message={copy.loadingDailyReview} />}>
          <DailyReviewPanel {...props} bridge={props.bridge} />
        </Suspense>
      ) : (
        // The disconnected state keeps the module switch: it is the only
        // in-page way back to 计划提醒, and a page you cannot leave is a worse
        // failure than the one it is reporting.
        <ModulePage
          title={label}
          toolbar={props.hubHeader?.badge ? <div className="maka-module-page-bar">{props.hubHeader.badge}</div> : undefined}
        >
          <div className="maka-module-page-panel">
            <EmptyState icon={<CalendarDays />} title={copy.dailyReviewDisconnectedTitle} description={copy.dailyReviewDisconnectedBody} />
          </div>
        </ModulePage>
      )}
    </main>
  );
}
