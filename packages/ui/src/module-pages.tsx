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

import { lazy, Suspense } from 'react';
import type { ScheduledTask } from '@maka/core/scheduled-task';
import { deriveCapabilityAuditReport } from '@maka/core/capability-audit';
import { ICON_SIZE, CalendarDays } from './icons.js';
import { EmptyState, Spinner } from '@astryxdesign/core';
import { ModulePage } from './primitives/module-page.js';
import { useUiLocale } from './locale-context.js';
import { getSharedUiCopy } from './shared-ui-copy.js';
import { getSkillsCopy } from './skills-copy.js';
import type { ModuleHubHeader } from './module-hub-selector.js';
import type {
  BundledSkillCatalogEntry,
  DailyReviewBridge,
  DailyReviewMarkdownActionInput,
  ManagedSkillSourceEntry,
  ManagedSkillUpdatePreview,
  ScheduledTaskDraftInput,
  ScheduledTaskUpdatePatch,
  SkillEntry,
} from './module-panel-types.js';

const SkillsModuleMain = lazy(() => import('./skills-panel.js').then((module) => ({ default: module.SkillsModuleMain })));
const DailyReviewPanel = lazy(() => import('./daily-review-panel.js').then((module) => ({ default: module.DailyReviewPanel })));
const ScheduledTaskPanel = lazy(() => import('./scheduled-task-panel.js').then((module) => ({ default: module.ScheduledTaskPanel })));

/** Skills renders its own labelled region inside the lazy chunk, so its fallback must too. */
function ModulePageFallback(props: { label: string; message: string }) {
  return (
    <section className="maka-main detailPane maka-module-main agents-chat-panel" data-page-shell="layout" aria-label={props.label}>
      <ModulePanelFallback message={props.message} />
    </section>
  );
}

function ModulePanelFallback(props: { message: string }) {
  return (
    <div className="maka-lazy-fallback" data-surface="module">
      <Spinner size="sm" shade="subtle" label={props.message} />
    </div>
  );
}

export function SkillsPage(props: {
  skills?: SkillEntry[];
  hubHeader?: ModuleHubHeader;
  scheduledTasks?: ScheduledTask[];
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
  const locale = useUiLocale();
  const copy = getSharedUiCopy(locale).modules;
  const label = props.hubHeader?.title ?? getSkillsCopy(locale).page.title;
  const auditReport = deriveCapabilityAuditReport({
    skills: props.skills ?? [],
    scheduledTasks: props.scheduledTasks ?? [],
  });
  return (
    <Suspense fallback={<ModulePageFallback label={label} message={copy.loadingSkills} />}>
      <SkillsModuleMain {...props} auditReport={auditReport} />
    </Suspense>
  );
}

export function ScheduledTasksPage(props: {
  hubHeader?: ModuleHubHeader;
  tasks?: ScheduledTask[];
  createRequestNonce?: number;
  onCreateRequestHandled?: () => void;
  keepSystemAwake?: boolean;
  onKeepSystemAwakeChange?: (next: boolean) => Promise<void>;
  onRefresh?: () => void | Promise<void>;
  onCreate?(input: ScheduledTaskDraftInput): boolean | Promise<boolean> | void | Promise<void>;
  onUpdate?(id: string, patch: ScheduledTaskUpdatePatch): boolean | Promise<boolean> | void | Promise<void>;
  onToggle?: (id: string, enabled: boolean) => void | Promise<void>;
  onTriggerNow?: (id: string) => void | Promise<void>;
  onSnooze?: (id: string) => void | Promise<void>;
  onClearRunHistory?: (id: string) => void | Promise<void>;
  onDelete?: (id: string) => void | Promise<void>;
}) {
  const copy = getSharedUiCopy(useUiLocale()).modules;
  const label = props.hubHeader?.title ?? copy.automations;
  return (
    <section className="maka-main detailPane maka-module-main agents-chat-panel" data-page-shell="layout" data-module="scheduled-tasks" aria-label={label}>
      <Suspense fallback={<ModulePanelFallback message={copy.loadingAutomations} />}>
        <ScheduledTaskPanel {...props} tasks={props.tasks ?? []} />
      </Suspense>
    </section>
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
    <section className="maka-main detailPane maka-module-main agents-chat-panel" data-page-shell="layout" data-module="daily-review" aria-label={label}>
      {props.bridge ? (
        // The page header lives INSIDE the panel: its primary action (生成分析 /
        // 查看分析) rides the panel's run state, exactly like 定时任务's 新建.
        // The bridge-less fallback keeps its own static header below.
        (<Suspense fallback={<ModulePanelFallback message={copy.loadingDailyReview} />}>
          <DailyReviewPanel {...props} bridge={props.bridge} />
        </Suspense>)
      ) : (
        // The disconnected state keeps the module switch: it is the only
        // in-page way back to 定时任务, and a page you cannot leave is a worse
        // failure than the one it is reporting.
        (<ModulePage
          title={label}
          toolbar={props.hubHeader?.badge ? <div className="maka-module-page-bar">{props.hubHeader.badge}</div> : undefined}
        >
          <div className="maka-module-page-panel">
            <EmptyState icon={<CalendarDays size={ICON_SIZE.empty} />} title={copy.dailyReviewDisconnectedTitle} description={copy.dailyReviewDisconnectedBody} />
          </div>
        </ModulePage>)
      )}
    </section>
  );
}
