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
  market: {
    categoryAll: string;
    sortName: string;
    sortRecent: string;
    controls: string;
    categoryFilter: string;
    sortAriaLabel: string;
    ariaLabel: string;
    importLocal: string;
    emptySearchTitle: string;
    emptyTitle: string;
    emptySearchBody: string;
    emptyBody: string;
    emptyFilterBody: string;
    clearSearch: string;
    clearFilters: string;
    sourceFallback: string;
  };
  tabs: { ariaLabel: string; market: string; builtin: string; installed: string };
  install: {
    action: (name: string) => string;
    installedTitle: string;
    installed: string;
    notInstalled: string;
  };
  builtin: {
    ariaLabel: string;
    emptyTitle: string;
    emptyBody: string;
    noMatchTitle: string;
    noMatchBody: string;
    fallback: string;
    /** How many tools a built-in skill declares, shown as row metadata. */
    toolCount(count: number): string;
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
    unpinTitle: string;
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
  description: {
    document: string;
    presentation: string;
    spreadsheet: string;
    image: string;
    browser: string;
    macos: string;
    fallback: string;
  };
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
    toolbarAria: string;
    metaInstalled: (count: number) => string;
    metaUpdates: (count: number) => string;
    /** How many skills the marketplace and built-in catalogs offer. */
    metaAvailable: (count: number) => string;
    searchMatches: (count: number) => string;
    search: string;
    openFolder: string;
    moreActions: string;
    refreshing: string;
    refresh: string;
  };
  detail: {
    label: string;
    enabled: string;
    pinned: string;
    inspectorOpened: (name: string) => string;
    idLabel: string;
    scopeLabel: string;
    sourceLabel: string;
    contextLabel: string;
    runtimeLabel: string;
    toolsLabel: string;
    pathLabel: string;
  };
}

const SKILLS_COPY = {
  zh: {
    categories: { '内容创作': '内容创作', '数据与AI': '数据与 AI', '设计与UI': '设计与 UI', 'DevOps与部署': 'DevOps 与部署', '文档与写作': '文档与写作', '效率工具': '效率工具', '研究与分析': '研究与分析' },
    market: { categoryAll: '全部分类', sortName: '排序：名称', sortRecent: '排序：最近', controls: '市场筛选与排序', categoryFilter: '按分类筛选市场技能', sortAriaLabel: '市场技能排序方式', ariaLabel: '技能市场', importLocal: '导入本地 Skill', emptySearchTitle: '没有匹配的市场技能', emptyTitle: '来源库还是空的', emptySearchBody: '换一个关键词，或清空搜索查看全部来源。', emptyBody: '导入一个含 SKILL.md 的本地文件，它会作为可安装的来源出现在这里。', emptyFilterBody: '换一个分类或关键词，或清空筛选查看全部来源。', clearSearch: '清空搜索', clearFilters: '清空筛选', sourceFallback: '本地来源库 Skill。' },
    tabs: { ariaLabel: '技能视图', market: '市场', builtin: '内置', installed: '已安装' },
    install: { action: (name) => `安装 ${name}`, installedTitle: '已安装到当前工作区', installed: '已安装', notInstalled: '未安装' },
    builtin: { ariaLabel: '内置技能', emptyTitle: '暂无内置技能', emptyBody: '应用自带的技能会出现在这里。', noMatchTitle: '没有匹配的内置技能', noMatchBody: '换一个关键词，或清空搜索查看全部内置技能。', fallback: '应用自带 Skill。', toolCount: (count: number) => `${count} 个工具` },
    installed: { emptySearchTitle: '没有匹配的 Skill', emptyTitle: '等待添加 Skill', emptySearchBody: '换一个关键词，或清空搜索查看全部本地技能。', emptyBodyBeforeCode: '把一个含', emptyBodyAfterCode: '的文件夹放到工作区的 skills/ 目录下，刷新后会出现在这里。', refreshPending: '刷新中…', refresh: '刷新技能', listAriaLabel: '技能列表' },
    context: { scope: { project: '项目', workspace: '工作区', user: '用户', custom: '自定义' }, decision: { advertised: '已进入上下文', disabled: '已停用', invalid: '元数据无效', host_incompatible: '主机不兼容', shadowed: '被高优先级覆盖', budget: '因预算省略' }, needsReview: '待确认', discoverySource: (scope, source) => `${scope}/${source} 发现源`, discoveryDiagnostic: { blocked_path: '路径被安全策略阻止', read_failed: '来源不可读取' } },
    row: { opening: '打开中…', reviewing: '审查中…', use: '使用', openTitle: '打开 SKILL.md', pinTitle: '固定到技能上下文', unpinTitle: '取消固定', viewDiff: '查看差异', viewUpdate: '查看更新', confirmDeleteAriaLabel: (name) => `确认删除 ${name}`, deleteDescription: '此操作会删除这个 Skill 的文件，且无法撤销。', cancel: '取消', delete: '删除' },
    review: { ariaLabel: 'Skill 更新审查', title: '更新审查', source: (id) => `来源 ${id}`, managedSource: '受管理来源', hasBaseline: '已有基线', missingBaseline: '缺少基线', lineTransition: (current, source) => `${current} → ${source} 行`, changedLines: (count) => `${count} 行不同`, warning: '工作区副本已有本地修改。继续更新会用来源库版本覆盖当前 SKILL.md。', workspace: '当前工作区', sourceVersion: '来源库版本', cancel: '取消', overwrite: '覆盖本地修改', update: '更新到来源版本' },
    description: { document: '创建、编辑、检查文档内容。', presentation: '创建、编辑、检查演示文稿。', spreadsheet: '创建、编辑、分析表格数据。', image: '生成或编辑图片素材。', browser: '打开、检查、操作网页界面。', macos: '辅助构建和调试 macOS 应用。', fallback: '打开技能文件查看适用场景。' },
    status: { metadataError: '元数据异常', managed: { source_missing: '来源缺失', update_available: '可更新', local_modified: '本地已修改', metadata_error: '元数据异常', up_to_date: '受管理', not_managed: '受管理' }, modified: '已修改', bundled: '内置', local: '本地', stateError: '状态异常', enabled: '已启用', disabled: '已停用' },
    page: { title: '技能', toolbarAria: '技能筛选与视图', metaInstalled: (count) => `${count} 个已安装`, metaUpdates: (count) => `${count} 个可更新`, metaAvailable: (count) => `${count} 个可安装`, searchMatches: (count) => `${count} 个匹配`, search: '搜索技能', openFolder: '打开目录', moreActions: '更多技能操作', refreshing: '刷新中…', refresh: '刷新' },
    detail: { label: '技能详情', enabled: '启用', pinned: '已固定', inspectorOpened: (name) => `已打开 ${name} 的详情`, idLabel: '标识', scopeLabel: '范围', sourceLabel: '来源', contextLabel: '上下文', runtimeLabel: '运行状态', toolsLabel: '声明工具', pathLabel: '路径' },
  },
  en: {
    categories: { '内容创作': 'Content creation', '数据与AI': 'Data & AI', '设计与UI': 'Design & UI', 'DevOps与部署': 'DevOps & deployment', '文档与写作': 'Documents & writing', '效率工具': 'Productivity', '研究与分析': 'Research & analysis' },
    market: { categoryAll: 'All categories', sortName: 'Sort: Name', sortRecent: 'Sort: Recent', controls: 'Marketplace filters and sorting', categoryFilter: 'Filter marketplace skills by category', sortAriaLabel: 'Marketplace skill sort order', ariaLabel: 'Skill marketplace', importLocal: 'Import local Skill', emptySearchTitle: 'No matching marketplace skills', emptyTitle: 'The source library is empty', emptySearchBody: 'Try another keyword or clear search to see all sources.', emptyBody: 'Import a local file containing SKILL.md to make it available as an installable source.', emptyFilterBody: 'Try another category or keyword, or clear the filters.', clearSearch: 'Clear search', clearFilters: 'Clear filters', sourceFallback: 'Local source-library Skill.' },
    tabs: { ariaLabel: 'Skill views', market: 'Marketplace', builtin: 'Built in', installed: 'Installed' },
    install: { action: (name) => `Install ${name}`, installedTitle: 'Installed in this workspace', installed: 'Installed', notInstalled: 'Not installed' },
    builtin: { ariaLabel: 'Built-in skills', emptyTitle: 'No built-in skills', emptyBody: 'Skills included with the app appear here.', noMatchTitle: 'No matching built-in skills', noMatchBody: 'Try another keyword or clear search to see all built-in skills.', fallback: 'Skill included with the app.', toolCount: (count: number) => (count === 1 ? '1 tool' : `${count} tools`) },
    installed: { emptySearchTitle: 'No matching Skills', emptyTitle: 'Waiting for a Skill', emptySearchBody: 'Try another keyword or clear search to see all local skills.', emptyBodyBeforeCode: 'Place a folder containing', emptyBodyAfterCode: 'in the workspace skills/ directory, then refresh to show it here.', refreshPending: 'Refreshing…', refresh: 'Refresh skills', listAriaLabel: 'Skill list' },
    context: { scope: { project: 'Project', workspace: 'Workspace', user: 'User', custom: 'Custom' }, decision: { advertised: 'In context', disabled: 'Disabled', invalid: 'Invalid metadata', host_incompatible: 'Host incompatible', shadowed: 'Shadowed', budget: 'Budget omitted' }, needsReview: 'Needs review', discoverySource: (scope, source) => `${scope}/${source} discovery source`, discoveryDiagnostic: { blocked_path: 'Path blocked by the safety policy', read_failed: 'Source could not be read' } },
    row: { opening: 'Opening…', reviewing: 'Reviewing…', use: 'Use', openTitle: 'Open SKILL.md', pinTitle: 'Pin to the skill context', unpinTitle: 'Unpin', viewDiff: 'View diff', viewUpdate: 'View update', confirmDeleteAriaLabel: (name) => `Delete ${name}?`, deleteDescription: 'This removes the Skill files and cannot be undone.', cancel: 'Cancel', delete: 'Delete' },
    review: { ariaLabel: 'Skill update review', title: 'Update review', source: (id) => `Source ${id}`, managedSource: 'Managed source', hasBaseline: 'Baseline available', missingBaseline: 'No baseline', lineTransition: (current, source) => `${current} → ${source} lines`, changedLines: (count) => `${count} ${count === 1 ? 'line differs' : 'lines differ'}`, warning: 'The workspace copy has local changes. Continuing will replace the current SKILL.md with the source version.', workspace: 'Current workspace', sourceVersion: 'Source version', cancel: 'Cancel', overwrite: 'Overwrite local changes', update: 'Update to source version' },
    description: { document: 'Create, edit, and inspect documents.', presentation: 'Create, edit, and inspect presentations.', spreadsheet: 'Create, edit, and analyze spreadsheet data.', image: 'Generate or edit images.', browser: 'Open, inspect, and operate web interfaces.', macos: 'Build and debug macOS apps.', fallback: 'Open the skill file to see when to use it.' },
    status: { metadataError: 'Metadata error', managed: { source_missing: 'Source missing', update_available: 'Update available', local_modified: 'Locally modified', metadata_error: 'Metadata error', up_to_date: 'Managed', not_managed: 'Managed' }, modified: 'Modified', bundled: 'Built in', local: 'Local', stateError: 'State error', enabled: 'Enabled', disabled: 'Disabled' },
    page: { title: 'Skills', toolbarAria: 'Skill filters and views', metaInstalled: (count) => `${count} installed`, metaUpdates: (count) => count === 1 ? '1 update available' : `${count} updates available`, metaAvailable: (count) => count === 1 ? '1 available to install' : `${count} available to install`, searchMatches: (count) => `${count} ${count === 1 ? 'match' : 'matches'}`, search: 'Search skills', openFolder: 'Open folder', moreActions: 'More Skill actions', refreshing: 'Refreshing…', refresh: 'Refresh' },
    detail: { label: 'Skill details', enabled: 'Enabled', pinned: 'Pinned', inspectorOpened: (name) => `${name} details opened`, idLabel: 'ID', scopeLabel: 'Scope', sourceLabel: 'Source', contextLabel: 'Context', runtimeLabel: 'Runtime', toolsLabel: 'Declared tools', pathLabel: 'Path' },
  },
} satisfies UiCatalog<SkillsCopy>;

export function getSkillsCopy(locale: UiLocale): SkillsCopy {
  return SKILLS_COPY[locale];
}
