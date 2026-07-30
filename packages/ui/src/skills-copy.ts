import type { UiCatalog, UiLocale } from '@maka/core';
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
    official: string;
    sourceActions: string;
    importLocal: string;
    emptySearchTitle: string;
    emptyTitle: string;
    emptySearchBody: string;
    emptyBody: string;
    emptyFilterBody: string;
    sourceFallback: string;
  };
  tabs: { ariaLabel: string; market: string; builtin: string; installed: string };
  banner: {
    ariaLabel: string;
    title: string;
    body: string;
    review: string;
    reviewDetail: string;
    documents: string;
    documentsDetail: string;
    publish: string;
    publishDetail: string;
  };
  install: {
    action: (name: string) => string;
    installedTitle: string;
    installed: string;
    notInstalled: string;
  };
  builtin: {
    ariaLabel: string;
    title: string;
    emptyTitle: string;
    emptyBody: string;
    noMatchTitle: string;
    noMatchBody: string;
    fallback: string;
  };
  installed: {
    emptySearchTitle: string;
    emptyTitle: string;
    emptySearchBody: string;
    emptyBodyBeforeCode: string;
    emptyBodyAfterCode: string;
    createPending: string;
    createExample: string;
    refreshPending: string;
    refresh: string;
    count: (count: number) => string;
    listAriaLabel: string;
    sectionLabel: string;
    summary: (skills: number, tools: number) => string;
  };
  context: {
    title: string;
    summary: (discovered: number, advertised: number, omitted: number, shadowed: number) => string;
    scope: Record<'project' | 'workspace' | 'user' | 'custom', string>;
    decision: Record<
      'advertised' | 'disabled' | 'invalid' | 'host_incompatible' | 'shadowed' | 'budget',
      string
    >;
    needsReview: string;
    needsReviewTitle: string;
    discoverySource: (scope: string, source: string) => string;
    discoveryDiagnostic: Record<'blocked_path' | 'read_failed', string>;
  };
  row: {
    hoverWithTools: (id: string, runtime: string, status: string, tools: string) => string;
    hover: (id: string, runtime: string, status: string) => string;
    opening: string;
    updating: string;
    toggling: string;
    reviewing: string;
    useAriaLabel: (name: string) => string;
    use: string;
    openAriaLabel: (name: string) => string;
    openTitle: string;
    disableAriaLabel: (name: string) => string;
    enableAriaLabel: (name: string) => string;
    stateErrorTitle: string;
    enabledTitle: string;
    disabledTitle: string;
    pinAriaLabel: (name: string) => string;
    unpinAriaLabel: (name: string) => string;
    pinTitle: string;
    unpinTitle: string;
    viewDiff: string;
    viewUpdate: string;
    confirmDeleteAriaLabel: (name: string) => string;
    deleteAriaLabel: (name: string) => string;
    confirmDelete: string;
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
    subtitle: string;
    actions: string;
    search: string;
    openFolder: string;
    creating: string;
    createExample: string;
    add: string;
    refreshing: string;
    refresh: string;
  };
}

const SKILLS_COPY = {
  zh: {
    categories: { '内容创作': '内容创作', '数据与AI': '数据与 AI', '设计与UI': '设计与 UI', 'DevOps与部署': 'DevOps 与部署', '文档与写作': '文档与写作', '效率工具': '效率工具', '研究与分析': '研究与分析' },
    market: { categoryAll: '全部分类', sortName: '排序：名称', sortRecent: '排序：最近', controls: '市场筛选与排序', categoryFilter: '按分类筛选市场技能', sortAriaLabel: '市场技能排序方式', ariaLabel: '技能市场', official: '官方精选', sourceActions: '来源库操作', importLocal: '导入本地 Skill', emptySearchTitle: '没有匹配的市场技能', emptyTitle: '来源库还是空的', emptySearchBody: '换一个关键词，或清空搜索查看全部来源。', emptyBody: '导入一个含 SKILL.md 的本地文件，它会作为可安装的来源出现在这里。', emptyFilterBody: '换一个分类或关键词，或清空筛选查看全部来源。', sourceFallback: '本地来源库 Skill。' },
    tabs: { ariaLabel: '技能视图', market: '市场', builtin: '内置', installed: '已安装' },
    banner: { ariaLabel: '精选技能', title: '为你精选的职场技能', body: '涵盖写作、效率、设计、数据分析等场景，将陆续上线，敬请期待。', review: '复盘', reviewDetail: '总结沉淀', documents: '文档', documentsDetail: '审阅润色', publish: '发布', publishDetail: '检查清单' },
    install: { action: (name) => `安装 ${name}`, installedTitle: '已安装到当前工作区', installed: '已安装', notInstalled: '未安装' },
    builtin: { ariaLabel: '内置技能', title: '应用自带', emptyTitle: '暂无内置技能', emptyBody: '应用自带的技能会出现在这里。', noMatchTitle: '没有匹配的内置技能', noMatchBody: '换一个关键词，或清空搜索查看全部内置技能。', fallback: '应用自带 Skill。' },
    installed: { emptySearchTitle: '没有匹配的 Skill', emptyTitle: '等待添加 Skill', emptySearchBody: '换一个关键词，或清空搜索查看全部本地技能。', emptyBodyBeforeCode: '把一个含', emptyBodyAfterCode: '的文件夹放到工作区的 skills/ 目录下，刷新后会出现在这里。', createPending: '创建中…', createExample: '创建示例技能', refreshPending: '刷新中…', refresh: '刷新技能', count: (count) => `${count} 个`, listAriaLabel: '技能列表', sectionLabel: '已安装技能', summary: (skills, tools) => `${skills} 个 Skill · ${tools} 类工具` },
    context: { title: '上下文检查', summary: (discovered, advertised, omitted, shadowed) => `发现 ${discovered} · 已展示 ${advertised} · 预算省略 ${omitted} · 被覆盖 ${shadowed}`, scope: { project: '项目', workspace: '工作区', user: '用户', custom: '自定义' }, decision: { advertised: '已进入上下文', disabled: '已停用', invalid: '元数据无效', host_incompatible: '主机不兼容', shadowed: '被高优先级覆盖', budget: '因预算省略' }, needsReview: '待确认', needsReviewTitle: '旧版偏好同时匹配多个范围。请分别切换或固定每个范围的副本；Maka 不会自动猜测。', discoverySource: (scope, source) => `${scope}/${source} 发现源`, discoveryDiagnostic: { blocked_path: '路径被安全策略阻止', read_failed: '来源不可读取' } },
    row: { hoverWithTools: (id, runtime, status, tools) => `技能：${id}\n\n运行状态：${runtime}\n来源状态：${status}\n声明工具：${tools}\n权限仍按当前会话策略判断；这里不是授权。`, hover: (id, runtime, status) => `技能：${id}\n\n运行状态：${runtime}\n来源状态：${status}`, opening: '打开中…', updating: '更新中…', toggling: '切换中…', reviewing: '审查中…', useAriaLabel: (name) => `在对话中使用 ${name}`, use: '使用', openAriaLabel: (name) => `打开 ${name} 的 SKILL.md`, openTitle: '打开 SKILL.md', disableAriaLabel: (name) => `停用 ${name}`, enableAriaLabel: (name) => `启用 ${name}`, stateErrorTitle: '当前项目的 Skill 状态文件异常', enabledTitle: '当前项目中 agent 可以使用此技能', disabledTitle: '当前项目中 agent 不会看到或加载此技能', pinAriaLabel: (name) => `固定 ${name} 到技能上下文`, unpinAriaLabel: (name) => `取消固定 ${name}`, pinTitle: '优先放入模型可见的技能目录', unpinTitle: '取消上下文优先级', viewDiff: '查看差异', viewUpdate: '查看更新', confirmDeleteAriaLabel: (name) => `确认删除 ${name}`, deleteAriaLabel: (name) => `删除 ${name}`, confirmDelete: '确认删除', delete: '删除' },
    review: { ariaLabel: 'Skill 更新审查', title: '更新审查', source: (id) => `来源 ${id}`, managedSource: '受管理来源', hasBaseline: '已有基线', missingBaseline: '缺少基线', lineTransition: (current, source) => `${current} → ${source} 行`, changedLines: (count) => `${count} 行不同`, warning: '工作区副本已有本地修改。继续更新会用来源库版本覆盖当前 SKILL.md。', workspace: '当前工作区', sourceVersion: '来源库版本', cancel: '取消', overwrite: '覆盖本地修改', update: '更新到来源版本' },
    description: { document: '创建、编辑、检查文档内容。', presentation: '创建、编辑、检查演示文稿。', spreadsheet: '创建、编辑、分析表格数据。', image: '生成或编辑图片素材。', browser: '打开、检查、操作网页界面。', macos: '辅助构建和调试 macOS 应用。', fallback: '打开技能文件查看适用场景。' },
    status: { metadataError: '元数据异常', managed: { source_missing: '来源缺失', update_available: '可更新', local_modified: '本地已修改', metadata_error: '元数据异常', up_to_date: '受管理', not_managed: '受管理' }, modified: '已修改', bundled: '内置', local: '本地', stateError: '状态异常', enabled: '已启用', disabled: '已停用' },
    page: { title: '技能', subtitle: '安装与管理技能，在对话中扩展 Maka 的能力。', actions: '技能操作', search: '搜索技能', openFolder: '打开目录', creating: '创建中…', createExample: '创建示例', add: '添加', refreshing: '刷新中…', refresh: '刷新' },
  },
  en: {
    categories: { '内容创作': 'Content creation', '数据与AI': 'Data & AI', '设计与UI': 'Design & UI', 'DevOps与部署': 'DevOps & deployment', '文档与写作': 'Documents & writing', '效率工具': 'Productivity', '研究与分析': 'Research & analysis' },
    market: { categoryAll: 'All categories', sortName: 'Sort: Name', sortRecent: 'Sort: Recent', controls: 'Marketplace filters and sorting', categoryFilter: 'Filter marketplace skills by category', sortAriaLabel: 'Marketplace skill sort order', ariaLabel: 'Skill marketplace', official: 'Official picks', sourceActions: 'Source library actions', importLocal: 'Import local Skill', emptySearchTitle: 'No matching marketplace skills', emptyTitle: 'The source library is empty', emptySearchBody: 'Try another keyword or clear search to see all sources.', emptyBody: 'Import a local file containing SKILL.md to make it available as an installable source.', emptyFilterBody: 'Try another category or keyword, or clear the filters.', sourceFallback: 'Local source-library Skill.' },
    tabs: { ariaLabel: 'Skill views', market: 'Marketplace', builtin: 'Built in', installed: 'Installed' },
    banner: { ariaLabel: 'Featured skills', title: 'Featured workplace skills', body: 'Writing, productivity, design, and data-analysis skills are coming soon.', review: 'Review', reviewDetail: 'Capture insights', documents: 'Documents', documentsDetail: 'Review and refine', publish: 'Publish', publishDetail: 'Checklists' },
    install: { action: (name) => `Install ${name}`, installedTitle: 'Installed in this workspace', installed: 'Installed', notInstalled: 'Not installed' },
    builtin: { ariaLabel: 'Built-in skills', title: 'Included with the app', emptyTitle: 'No built-in skills', emptyBody: 'Skills included with the app appear here.', noMatchTitle: 'No matching built-in skills', noMatchBody: 'Try another keyword or clear search to see all built-in skills.', fallback: 'Skill included with the app.' },
    installed: { emptySearchTitle: 'No matching Skills', emptyTitle: 'Waiting for a Skill', emptySearchBody: 'Try another keyword or clear search to see all local skills.', emptyBodyBeforeCode: 'Place a folder containing', emptyBodyAfterCode: 'in the workspace skills/ directory, then refresh to show it here.', createPending: 'Creating…', createExample: 'Create example skill', refreshPending: 'Refreshing…', refresh: 'Refresh skills', count: (count) => `${count}`, listAriaLabel: 'Skill list', sectionLabel: 'Installed skills', summary: (skills, tools) => `${skills} ${skills === 1 ? 'Skill' : 'Skills'} · ${tools} tool ${tools === 1 ? 'type' : 'types'}` },
    context: { title: 'Context inspector', summary: (discovered, advertised, omitted, shadowed) => `Discovered ${discovered} · advertised ${advertised} · budget omitted ${omitted} · shadowed ${shadowed}`, scope: { project: 'Project', workspace: 'Workspace', user: 'User', custom: 'Custom' }, decision: { advertised: 'In context', disabled: 'Disabled', invalid: 'Invalid metadata', host_incompatible: 'Host incompatible', shadowed: 'Shadowed', budget: 'Budget omitted' }, needsReview: 'Needs review', needsReviewTitle: 'A legacy preference matches multiple scopes. Toggle or pin each scoped copy explicitly; Maka will not guess.', discoverySource: (scope, source) => `${scope}/${source} discovery source`, discoveryDiagnostic: { blocked_path: 'Path blocked by the safety policy', read_failed: 'Source could not be read' } },
    row: { hoverWithTools: (id, runtime, status, tools) => `Skill: ${id}\n\nRuntime status: ${runtime}\nSource status: ${status}\nDeclared tools: ${tools}\nPermissions still follow the current session policy; this is not authorization.`, hover: (id, runtime, status) => `Skill: ${id}\n\nRuntime status: ${runtime}\nSource status: ${status}`, opening: 'Opening…', updating: 'Updating…', toggling: 'Switching…', reviewing: 'Reviewing…', useAriaLabel: (name) => `Use ${name} in chat`, use: 'Use', openAriaLabel: (name) => `Open SKILL.md for ${name}`, openTitle: 'Open SKILL.md', disableAriaLabel: (name) => `Disable ${name}`, enableAriaLabel: (name) => `Enable ${name}`, stateErrorTitle: 'The Skill state file for this project is invalid', enabledTitle: 'Agents in this project can use this skill', disabledTitle: 'Agents in this project will not see or load this skill', pinAriaLabel: (name) => `Pin ${name} to the skill context`, unpinAriaLabel: (name) => `Unpin ${name}`, pinTitle: 'Prioritize this skill in the model-visible catalog', unpinTitle: 'Remove the context priority', viewDiff: 'View diff', viewUpdate: 'View update', confirmDeleteAriaLabel: (name) => `Confirm deletion of ${name}`, deleteAriaLabel: (name) => `Delete ${name}`, confirmDelete: 'Confirm delete', delete: 'Delete' },
    review: { ariaLabel: 'Skill update review', title: 'Update review', source: (id) => `Source ${id}`, managedSource: 'Managed source', hasBaseline: 'Baseline available', missingBaseline: 'No baseline', lineTransition: (current, source) => `${current} → ${source} lines`, changedLines: (count) => `${count} ${count === 1 ? 'line differs' : 'lines differ'}`, warning: 'The workspace copy has local changes. Continuing will replace the current SKILL.md with the source version.', workspace: 'Current workspace', sourceVersion: 'Source version', cancel: 'Cancel', overwrite: 'Overwrite local changes', update: 'Update to source version' },
    description: { document: 'Create, edit, and inspect documents.', presentation: 'Create, edit, and inspect presentations.', spreadsheet: 'Create, edit, and analyze spreadsheet data.', image: 'Generate or edit images.', browser: 'Open, inspect, and operate web interfaces.', macos: 'Build and debug macOS apps.', fallback: 'Open the skill file to see when to use it.' },
    status: { metadataError: 'Metadata error', managed: { source_missing: 'Source missing', update_available: 'Update available', local_modified: 'Locally modified', metadata_error: 'Metadata error', up_to_date: 'Managed', not_managed: 'Managed' }, modified: 'Modified', bundled: 'Built in', local: 'Local', stateError: 'State error', enabled: 'Enabled', disabled: 'Disabled' },
    page: { title: 'Skills', subtitle: 'Install and manage skills to extend Maka in conversations.', actions: 'Skill actions', search: 'Search skills', openFolder: 'Open folder', creating: 'Creating…', createExample: 'Create example', add: 'Add', refreshing: 'Refreshing…', refresh: 'Refresh' },
  },
} satisfies UiCatalog<SkillsCopy>;

export function getSkillsCopy(locale: UiLocale): SkillsCopy {
  return SKILLS_COPY[locale];
}
