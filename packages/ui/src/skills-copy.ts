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

import type { UiCatalog, UiLocale } from '@maka/core/ui-locale';
import type { ManagedSkillCategory, SkillEntry } from './module-panel-types.js';

type ManagedUpdateStatus = NonNullable<SkillEntry['managedUpdateStatus']>;

export interface SkillsCopy {
  categories: Record<ManagedSkillCategory, string>;
  discover: {
    builtinFallback: string;
    sourceFallback: string;
  };
  install: {
    action: (name: string) => string;
    short: string;
  };
  installed: {
    emptySearchTitle: string;
    emptyTitle: string;
    emptySearchBody: string;
    emptyBodyBeforeCode: string;
    emptyBodyAfterCode: string;
    refreshPending: string;
    refresh: string;
    listAriaLabel: string;
  };
  context: {
    scope: Record<'project' | 'workspace' | 'user' | 'custom', string>;
    decision: Record<
      'advertised' | 'disabled' | 'invalid' | 'host_incompatible' | 'shadowed' | 'budget',
      string
    >;
    needsReview: string;
    discoverySource: (scope: string, source: string) => string;
    discoveryDiagnostic: Record<'blocked_path' | 'read_failed', string>;
  };
  row: {
    opening: string;
    reviewing: string;
    use: string;
    openTitle: string;
    pinTitle: string;
    viewDiff: string;
    viewUpdate: string;
    confirmDeleteAriaLabel: (name: string) => string;
    deleteDescription: string;
    cancel: string;
    delete: string;
  };
  review: {
    ariaLabel: string;
    title: string;
    source: (id: string) => string;
    managedSource: string;
    hasBaseline: string;
    missingBaseline: string;
    lineTransition: (current: number, source: number) => string;
    changedLines: (count: number) => string;
    warning: string;
    workspace: string;
    sourceVersion: string;
    cancel: string;
    overwrite: string;
    update: string;
  };
  /** Product copy for bundled skills, keyed by BUNDLED_SKILL_CATALOG id. */
  bundledDescription: Partial<Record<string, string>>;
  status: {
    metadataError: string;
    managed: Record<ManagedUpdateStatus, string>;
    modified: string;
    bundled: string;
    local: string;
    stateError: string;
    enabled: string;
    disabled: string;
  };
  page: {
    title: string;
    actionsAria: string;
    installed: string;
    discover: string;
    add: string;
    importLocal: string;
    searchMatches: (count: number) => string;
    search: string;
    clearSearch: string;
    locations: string;
    refreshing: string;
    refresh: string;
  };
  locations: {
    labels: Record<import('./module-panel-types.js').SkillLocationRef, string>;
    count: (count: number) => string;
    missing: string;
    blocked: string;
    readFailed: string;
  };
  detail: {
    enabled: string;
    idLabel: string;
    scopeLabel: string;
    toolsLabel: string;
    pathLabel: string;
  };
}

const SKILLS_COPY = {
  'zh-CN': {
    categories: { '内容创作': '内容创作', '数据与AI': '数据与 AI', '设计与UI': '设计与 UI', 'DevOps与部署': 'DevOps 与部署', '文档与写作': '文档与写作', '效率工具': '效率工具', '研究与分析': '研究与分析' },
    discover: { builtinFallback: '应用自带 Skill。', sourceFallback: '本地来源库 Skill。' },
    install: { action: (name) => `安装 ${name}`, short: '安装' },
    installed: { emptySearchTitle: '没有匹配的 Skill', emptyTitle: '等待添加 Skill', emptySearchBody: '换一个关键词，或清空搜索查看全部本地技能。', emptyBodyBeforeCode: '把一个含', emptyBodyAfterCode: '的文件夹放到工作区的 skills/ 目录下，刷新后会出现在这里。', refreshPending: '刷新中…', refresh: '刷新技能', listAriaLabel: '技能列表' },
    context: { scope: { project: '项目', workspace: '工作区', user: '用户', custom: '自定义' }, decision: { advertised: '已进入上下文', disabled: '已停用', invalid: '元数据无效', host_incompatible: '主机不兼容', shadowed: '被高优先级覆盖', budget: '因预算省略' }, needsReview: '待确认', discoverySource: (scope, source) => `${scope}/${source} 发现源`, discoveryDiagnostic: { blocked_path: '路径被安全策略阻止', read_failed: '来源不可读取' } },
    row: { opening: '打开中…', reviewing: '审查中…', use: '使用', openTitle: '打开 SKILL.md', pinTitle: '固定到技能上下文', viewDiff: '查看差异', viewUpdate: '查看更新', confirmDeleteAriaLabel: (name) => `确认删除 ${name}`, deleteDescription: '此操作会删除这个 Skill 的文件，且无法撤销。', cancel: '取消', delete: '删除' },
    review: { ariaLabel: 'Skill 更新审查', title: '更新审查', source: (id) => `来源 ${id}`, managedSource: '受管理来源', hasBaseline: '已有基线', missingBaseline: '缺少基线', lineTransition: (current, source) => `${current} → ${source} 行`, changedLines: (count) => `${count} 行不同`, warning: '工作区副本已有本地修改。继续更新会用来源库版本覆盖当前 SKILL.md。', workspace: '当前工作区', sourceVersion: '来源库版本', cancel: '取消', overwrite: '覆盖本地修改', update: '更新到来源版本' },
    bundledDescription: { 'computer-use': '查看并操作本机桌面应用的界面。' },
    status: { metadataError: '元数据异常', managed: { source_missing: '来源缺失', update_available: '可更新', local_modified: '本地已修改', metadata_error: '元数据异常', up_to_date: '受管理', not_managed: '受管理' }, modified: '已修改', bundled: '内置', local: '本地', stateError: '状态异常', enabled: '已启用', disabled: '已停用' },
    page: { title: '技能', actionsAria: '技能操作', installed: '已安装', discover: '发现', add: '添加', importLocal: '导入本地 Skill', searchMatches: (count) => `${count} 个匹配`, search: '搜索技能', clearSearch: '清空搜索', locations: '技能位置…', refreshing: '刷新中…', refresh: '刷新' },
    locations: { labels: { 'project:maka': '项目 · Maka', 'project:agents': '项目 · Agents', 'workspace:legacy': '工作区兼容目录', 'user:maka': '用户 · Maka', 'user:agents': '用户 · Agents' }, count: (count) => `${count} 个 Skill`, missing: '创建并打开', blocked: '路径已被阻止', readFailed: '无法读取' },
    detail: { enabled: '启用', idLabel: '标识', scopeLabel: '范围', toolsLabel: '工具', pathLabel: '路径' },
  },
  'zh-TW': {
    categories: { '内容创作': '內容創作', '数据与AI': '資料與 AI', '设计与UI': '設計與 UI', 'DevOps与部署': 'DevOps 與部署', '文档与写作': '文件與寫作', '效率工具': '效率工具', '研究与分析': '研究與分析' },
    discover: { builtinFallback: '應用自帶 Skill。', sourceFallback: '本地來源庫 Skill。' },
    install: { action: (name) => `安裝 ${name}`, short: '安裝' },
    installed: { emptySearchTitle: '沒有符合的 Skill', emptyTitle: '等待新增 Skill', emptySearchBody: '換一個關鍵詞，或清空搜尋檢視全部本地技能。', emptyBodyBeforeCode: '把一個含', emptyBodyAfterCode: '的資料夾放到工作區的 skills/ 目錄下，重新整理後會出現在這裡。', refreshPending: '重新整理中…', refresh: '重新整理技能', listAriaLabel: '技能列表' },
    context: { scope: { project: '專案', workspace: '工作區', user: '使用者', custom: '自訂' }, decision: { advertised: '已進入上下文', disabled: '已停用', invalid: '後設資料無效', host_incompatible: '主機不相容', shadowed: '被高優先順序覆蓋', budget: '因預算省略' }, needsReview: '待確認', discoverySource: (scope, source) => `${scope}/${source} 發現源`, discoveryDiagnostic: { blocked_path: '路徑被安全策略阻止', read_failed: '來源不可讀取' } },
    row: { opening: '開啟中…', reviewing: '審查中…', use: '使用', openTitle: '開啟 SKILL.md', pinTitle: '固定到技能上下文', viewDiff: '檢視差異', viewUpdate: '檢視更新', confirmDeleteAriaLabel: (name) => `確認刪除 ${name}`, deleteDescription: '此操作會刪除這個 Skill 的檔案，且無法撤銷。', cancel: '取消', delete: '刪除' },
    review: { ariaLabel: 'Skill 更新審查', title: '更新審查', source: (id) => `來源 ${id}`, managedSource: '受管理來源', hasBaseline: '已有基線', missingBaseline: '缺少基線', lineTransition: (current, source) => `${current} → ${source} 行`, changedLines: (count) => `${count} 行不同`, warning: '工作區副本已有本地修改。繼續更新會用來源庫版本覆蓋目前 SKILL.md。', workspace: '目前工作區', sourceVersion: '來源庫版本', cancel: '取消', overwrite: '覆蓋本地修改', update: '更新到來源版本' },
    bundledDescription: { 'computer-use': '檢視並操作本機桌面應用的介面。' },
    status: { metadataError: '後設資料異常', managed: { source_missing: '來源缺失', update_available: '可更新', local_modified: '本地已修改', metadata_error: '後設資料異常', up_to_date: '受管理', not_managed: '受管理' }, modified: '已修改', bundled: '內建', local: '本地', stateError: '狀態異常', enabled: '已啟用', disabled: '已停用' },
    page: { title: '技能', actionsAria: '技能操作', installed: '已安裝', discover: '探索', add: '新增', importLocal: '匯入本地 Skill', searchMatches: (count) => `${count} 個符合`, search: '搜尋技能', clearSearch: '清空搜尋', locations: '技能位置…', refreshing: '重新整理中…', refresh: '重新整理' },
    locations: { labels: { 'project:maka': '專案 · Maka', 'project:agents': '專案 · Agents', 'workspace:legacy': '工作區相容目錄', 'user:maka': '使用者 · Maka', 'user:agents': '使用者 · Agents' }, count: (count) => `${count} 個 Skill`, missing: '建立並開啟', blocked: '路徑已被阻止', readFailed: '無法讀取' },
    detail: { enabled: '啟用', idLabel: '標識', scopeLabel: '範圍', toolsLabel: '工具', pathLabel: '路徑' },
  },
  en: {
    categories: { '内容创作': 'Content creation', '数据与AI': 'Data & AI', '设计与UI': 'Design & UI', 'DevOps与部署': 'DevOps & deployment', '文档与写作': 'Documents & writing', '效率工具': 'Productivity', '研究与分析': 'Research & analysis' },
    discover: { builtinFallback: 'Skill included with the app.', sourceFallback: 'Local source-library Skill.' },
    install: { action: (name) => `Install ${name}`, short: 'Install' },
    installed: { emptySearchTitle: 'No matching Skills', emptyTitle: 'Waiting for a Skill', emptySearchBody: 'Try another keyword or clear search to see all local skills.', emptyBodyBeforeCode: 'Place a folder containing', emptyBodyAfterCode: 'in the workspace skills/ directory, then refresh to show it here.', refreshPending: 'Refreshing…', refresh: 'Refresh skills', listAriaLabel: 'Skill list' },
    context: { scope: { project: 'Project', workspace: 'Workspace', user: 'User', custom: 'Custom' }, decision: { advertised: 'In context', disabled: 'Disabled', invalid: 'Invalid metadata', host_incompatible: 'Host incompatible', shadowed: 'Shadowed', budget: 'Budget omitted' }, needsReview: 'Needs review', discoverySource: (scope, source) => `${scope}/${source} discovery source`, discoveryDiagnostic: { blocked_path: 'Path blocked by the safety policy', read_failed: 'Source could not be read' } },
    row: { opening: 'Opening…', reviewing: 'Reviewing…', use: 'Use', openTitle: 'Open SKILL.md', pinTitle: 'Pin to the skill context', viewDiff: 'View diff', viewUpdate: 'View update', confirmDeleteAriaLabel: (name) => `Delete ${name}?`, deleteDescription: 'This removes the Skill files and cannot be undone.', cancel: 'Cancel', delete: 'Delete' },
    review: { ariaLabel: 'Skill update review', title: 'Update review', source: (id) => `Source ${id}`, managedSource: 'Managed source', hasBaseline: 'Baseline available', missingBaseline: 'No baseline', lineTransition: (current, source) => `${current} → ${source} lines`, changedLines: (count) => `${count} ${count === 1 ? 'line differs' : 'lines differ'}`, warning: 'The workspace copy has local changes. Continuing will replace the current SKILL.md with the source version.', workspace: 'Current workspace', sourceVersion: 'Source version', cancel: 'Cancel', overwrite: 'Overwrite local changes', update: 'Update to source version' },
    bundledDescription: { 'computer-use': 'Inspect and operate local desktop app interfaces.' },
    status: { metadataError: 'Metadata error', managed: { source_missing: 'Source missing', update_available: 'Update available', local_modified: 'Locally modified', metadata_error: 'Metadata error', up_to_date: 'Managed', not_managed: 'Managed' }, modified: 'Modified', bundled: 'Built in', local: 'Local', stateError: 'State error', enabled: 'Enabled', disabled: 'Disabled' },
    page: { title: 'Skills', actionsAria: 'Skill actions', installed: 'Installed', discover: 'Discover', add: 'Add', importLocal: 'Import local Skill', searchMatches: (count) => `${count} ${count === 1 ? 'match' : 'matches'}`, search: 'Search skills', clearSearch: 'Clear search', locations: 'Skill locations…', refreshing: 'Refreshing…', refresh: 'Refresh' },
    locations: { labels: { 'project:maka': 'Project · Maka', 'project:agents': 'Project · Agents', 'workspace:legacy': 'Workspace compatibility folder', 'user:maka': 'User · Maka', 'user:agents': 'User · Agents' }, count: (count) => count === 1 ? '1 Skill' : `${count} Skills`, missing: 'Create and open', blocked: 'Path blocked', readFailed: 'Could not read' },
    detail: { enabled: 'Enabled', idLabel: 'ID', scopeLabel: 'Scope', toolsLabel: 'Tools', pathLabel: 'Path' },
  },
} satisfies UiCatalog<SkillsCopy>;

export function getSkillsCopy(locale: UiLocale): SkillsCopy {
  return SKILLS_COPY[locale];
}
