import type { SubagentProfile } from '@maka/core/subagent-settings';

import type { ThinkingLevel } from '@maka/core/model-thinking';

import type { UiCatalog, UiLocale } from '@maka/core/ui-locale';

type ProfileCopy = {
  label: string;
  description: string;
};

export type SubagentSettingsCopy = {
  section: {
    title: string;
    count(total: number): string;
    add: string;
    emptyTitle: string;
    emptyDescription: string;
  };
  row: {
    enabled: string;
    configure(name: string): string;
    fallbackDescription: string;
  };
  status: {
    missingConnection: string;
    connectionDisabled: string;
    modelDisabled: string;
  };
  editor: {
    backToList: string;
    createSubtitle: string;
    editSubtitle: string;
    groupPurpose: string;
    groupPurposeHelp: string;
    groupRoute: string;
    groupRouteHelp: string;
    dangerZone: string;
    dangerZoneHelp: string;
    delete: string;
    enabled: string;
    enabledDescription: string;
    name: string;
    namePlaceholder: string;
    id: string;
    idDescription: string;
    idPlaceholder: string;
    description: string;
    descriptionPlaceholder: string;
    profile: string;
    connection: string;
    model: string;
    thinking: string;
    defaultThinking: string;
    implementationWarning: string;
    noConnection: string;
    noModel: string;
    requiredName: string;
    invalidId(max: number): string;
    duplicateId: string;
    invalidConnection: string;
    invalidModel: string;
    cancel: string;
    create: string;
    save: string;
    saving: string;
  };
  remove: {
    title(name: string): string;
    description: string;
    confirm: string;
    cancel: string;
  };
  toast: {
    saveFailed: string;
    rejected: string;
  };
  profiles: Record<SubagentProfile, ProfileCopy>;
  thinking: Record<ThinkingLevel, string>;
};

const SETTINGS_SUBAGENTS_COPY_BY_LOCALE = {
  zh: {
    section: {
      title: '已批准的子 Agent',
      count: (total) => `共 ${total} 个配置`,
      add: '添加子 Agent',
      emptyTitle: '还没有子 Agent 配置',
      emptyDescription: '添加一个配置后，主 Agent 就能把合适的任务交给独立模型处理。',
    },
    row: {
      enabled: '启用',
      configure: (name) => `配置“${name}”`,
      fallbackDescription: '尚未填写适用场景',
    },
    status: {
      missingConnection: '连接不存在',
      connectionDisabled: '连接已停用',
      modelDisabled: '模型未启用',
    },
    editor: {
      backToList: '返回子 Agent 列表',
      createSubtitle: '创建一个可由主 Agent 自动选择的模型配置。',
      editSubtitle: '修改适用场景、能力边界和模型路由。',
      groupPurpose: '用途',
      groupPurposeHelp: '主 Agent 主要根据这里的名称和适用场景挑选配置。',
      groupRoute: '能力与模型',
      groupRouteHelp: '固定这个子 Agent 能做什么，以及它运行在哪个模型上。',
      dangerZone: '删除子 Agent',
      dangerZoneHelp: '此操作不可撤销。',
      delete: '删除',
      enabled: '启用',
      enabledDescription: '关闭后配置仍会保留，但主 Agent 暂时不会选择它。',
      name: '显示名称',
      namePlaceholder: '快速代码阅读',
      id: 'subagent_id',
      idDescription: '创建后保持不变，主 Agent 和历史会话会用它识别此配置。',
      idPlaceholder: 'fast-reader',
      description: '适用场景',
      descriptionPlaceholder: '适合快速、低成本地阅读大型仓库',
      profile: '能力 Profile',
      connection: '模型连接',
      model: '模型',
      thinking: '思考级别',
      defaultThinking: '跟随模型默认',
      implementationWarning: '实现代码 Profile 可以写文件和执行命令，并会在隔离 worktree 中运行。',
      noConnection: '请先在“模型”页启用一个模型连接。',
      noModel: '所选连接没有已启用的模型。',
      requiredName: '请输入显示名称。',
      invalidId: (max) => `只能使用字母、数字、点、下划线、冒号和连字符，最多 ${max} 个字符。`,
      duplicateId: '这个 subagent_id 已经存在。',
      invalidConnection: '请选择一个已启用的模型连接。',
      invalidModel: '请选择一个已启用的模型。',
      cancel: '取消',
      create: '创建',
      save: '保存',
      saving: '保存中…',
    },
    remove: {
      title: (name) => `删除“${name}”？`,
      description: '主 Agent 将不再看到这个配置。已创建的子会话不会被删除。',
      confirm: '删除',
      cancel: '取消',
    },
    toast: {
      saveFailed: '保存子 Agent 配置失败',
      rejected: '配置没有被保存。请确认名称长度和配置数量都在上限之内。',
    },
    profiles: {
      local_read: { label: '代码阅读', description: '只读访问当前工作区，适合搜索、理解和总结代码。' },
      web_research: { label: '网络研究', description: '只使用联网搜索，适合查找外部资料和最新信息。' },
      implementation: { label: '实现代码', description: '可以读写文件并执行命令，在隔离 worktree 中完成改动。' },
    },
    thinking: {
      off: '关闭',
      minimal: '最少',
      low: '低',
      medium: '中',
      high: '高',
      xhigh: '超高',
      max: '最大',
    },
  },
  en: {
    section: {
      title: 'Approved subagents',
      count: (total) => `${total} presets`,
      add: 'Add subagent',
      emptyTitle: 'No subagent presets yet',
      emptyDescription: 'Add a preset so the main agent can delegate suitable work to a separate model.',
    },
    row: {
      enabled: 'Enabled',
      configure: (name) => `Configure “${name}”`,
      fallbackDescription: 'No usage guidance yet',
    },
    status: {
      missingConnection: 'Connection missing',
      connectionDisabled: 'Connection disabled',
      modelDisabled: 'Model not enabled',
    },
    editor: {
      backToList: 'Back to subagents',
      createSubtitle: 'Create a model preset that the main agent can select automatically.',
      editSubtitle: 'Change its usage guidance, capability boundary, and model route.',
      groupPurpose: 'Purpose',
      groupPurposeHelp: 'The main agent selects a preset primarily from the name and guidance here.',
      groupRoute: 'Capability and model',
      groupRouteHelp: 'Fix what this subagent may do, and which model it runs on.',
      dangerZone: 'Remove subagent',
      dangerZoneHelp: 'This cannot be undone.',
      delete: 'Remove',
      enabled: 'Enabled',
      enabledDescription: 'Turn this off to keep the preset without letting the main agent select it.',
      name: 'Display name',
      namePlaceholder: 'Fast code reader',
      id: 'subagent_id',
      idDescription: 'Stable after creation. The main agent and session history use it to identify this preset.',
      idPlaceholder: 'fast-reader',
      description: 'When to use',
      descriptionPlaceholder: 'Fast, low-cost exploration of large repositories',
      profile: 'Capability profile',
      connection: 'Model connection',
      model: 'Model',
      thinking: 'Thinking level',
      defaultThinking: 'Use model default',
      implementationWarning: 'The Implementation profile can write files and run commands inside an isolated worktree.',
      noConnection: 'Enable a model connection on the Models page first.',
      noModel: 'The selected connection has no enabled models.',
      requiredName: 'Enter a display name.',
      invalidId: (max) => `Use only letters, numbers, dots, underscores, colons, and hyphens, up to ${max} characters.`,
      duplicateId: 'That subagent_id already exists.',
      invalidConnection: 'Select an enabled model connection.',
      invalidModel: 'Select an enabled model.',
      cancel: 'Cancel',
      create: 'Create',
      save: 'Save',
      saving: 'Saving…',
    },
    remove: {
      title: (name) => `Remove “${name}”?`,
      description: 'The main agent will no longer see this preset. Existing child sessions are not deleted.',
      confirm: 'Remove',
      cancel: 'Cancel',
    },
    toast: {
      saveFailed: 'Failed to save subagent presets',
      rejected: 'The preset was not saved. Check that its name length and the preset count are within their limits.',
    },
    profiles: {
      local_read: { label: 'Code reading', description: 'Read-only access to the current workspace for search, understanding, and summaries.' },
      web_research: { label: 'Web research', description: 'Web search only, for external sources and current information.' },
      implementation: { label: 'Implementation', description: 'Read and write files and run commands in an isolated worktree.' },
    },
    thinking: {
      off: 'Off',
      minimal: 'Minimal',
      low: 'Low',
      medium: 'Medium',
      high: 'High',
      xhigh: 'Extra high',
      max: 'Maximum',
    },
  },
} satisfies UiCatalog<SubagentSettingsCopy>;

export function getSubagentSettingsCopy(locale: UiLocale): SubagentSettingsCopy {
  return SETTINGS_SUBAGENTS_COPY_BY_LOCALE[locale];
}
