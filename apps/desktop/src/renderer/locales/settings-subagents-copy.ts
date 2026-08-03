import type {
  SubagentProfile,
  ThinkingLevel,
  UiCatalog,
  UiLocale,
} from '@maka/core';

type ProfileCopy = {
  label: string;
  description: string;
};

export type SubagentSettingsCopy = {
  section: {
    title: string;
    description: string;
    count(enabled: number, total: number): string;
    add: string;
    limitReached: string;
    emptyTitle: string;
    emptyDescription: string;
  };
  row: {
    edit: string;
    remove: string;
    enabled: string;
    fallbackDescription: string;
    route(profile: string, connection: string, model: string, thinking?: string): string;
  };
  status: {
    available: string;
    disabled: string;
    missingConnection: string;
    connectionDisabled: string;
    modelDisabled: string;
  };
  editor: {
    createTitle: string;
    createSubtitle: string;
    editTitle: string;
    editSubtitle: string;
    name: string;
    namePlaceholder: string;
    id: string;
    idDescription: string;
    idPlaceholder: string;
    description: string;
    descriptionHelp: string;
    descriptionPlaceholder: string;
    profile: string;
    connection: string;
    model: string;
    thinking: string;
    defaultThinking: string;
    enabled: string;
    enabledDescription: string;
    implementationWarning: string;
    noConnection: string;
    noModel: string;
    requiredName: string;
    requiredDescription: string;
    invalidId: string;
    duplicateId: string;
    invalidRoute: string;
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
  };
  profiles: Record<SubagentProfile, ProfileCopy>;
  thinking: Record<ThinkingLevel, string>;
};

const SETTINGS_SUBAGENTS_COPY_BY_LOCALE = {
  zh: {
    section: {
      title: '已批准的子 Agent',
      description: '主 Agent 会根据适用场景，从已启用且可用的配置中选择。每个配置固定自己的能力边界、连接和模型。',
      count: (enabled, total) => `已启用 ${enabled} / 共 ${total}`,
      add: '添加子 Agent',
      limitReached: '已达到 64 个配置的上限',
      emptyTitle: '还没有子 Agent 配置',
      emptyDescription: '添加一个配置后，主 Agent 就能把合适的任务交给独立模型处理。',
    },
    row: {
      edit: '编辑',
      remove: '删除',
      enabled: '启用',
      fallbackDescription: '尚未填写适用场景',
      route: (profile, connection, model, thinking) =>
        `${profile} · ${connection} / ${model}${thinking ? ` · 思考 ${thinking}` : ''}`,
    },
    status: {
      available: '可用',
      disabled: '已停用',
      missingConnection: '连接不存在',
      connectionDisabled: '连接已停用',
      modelDisabled: '模型未启用',
    },
    editor: {
      createTitle: '添加子 Agent',
      createSubtitle: '创建一个可由主 Agent 自动选择的模型配置。',
      editTitle: '编辑子 Agent',
      editSubtitle: '修改适用场景、能力边界和模型路由。',
      name: '显示名称',
      namePlaceholder: '快速代码阅读',
      id: 'subagent_id',
      idDescription: '创建后保持不变，主 Agent 和历史会话会用它识别此配置。',
      idPlaceholder: 'fast-reader',
      description: '适用场景',
      descriptionHelp: '写清楚何时应该使用它；主 Agent 主要根据这段描述挑选配置。',
      descriptionPlaceholder: '适合快速、低成本地阅读大型仓库',
      profile: '能力 Profile',
      connection: '模型连接',
      model: '模型',
      thinking: '思考级别',
      defaultThinking: '跟随模型默认',
      enabled: '立即启用',
      enabledDescription: '启用后，主 Agent 可以选择这个配置。',
      implementationWarning: '实现代码 Profile 可以写文件和执行命令，并会在隔离 worktree 中运行。',
      noConnection: '请先在“模型”页启用一个模型连接。',
      noModel: '所选连接没有已启用的模型。',
      requiredName: '请输入显示名称。',
      requiredDescription: '请说明这个子 Agent 的适用场景。',
      invalidId: '只能使用字母、数字、点、下划线、冒号和连字符，最多 128 个字符。',
      duplicateId: '这个 subagent_id 已经存在。',
      invalidRoute: '请选择已启用的连接和模型。',
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
      description: 'The main agent selects from enabled, available presets based on when each should be used. Every preset fixes its capability boundary, connection, and model.',
      count: (enabled, total) => `${enabled} enabled · ${total} total`,
      add: 'Add subagent',
      limitReached: 'The 64-preset limit has been reached',
      emptyTitle: 'No subagent presets yet',
      emptyDescription: 'Add a preset so the main agent can delegate suitable work to a separate model.',
    },
    row: {
      edit: 'Edit',
      remove: 'Remove',
      enabled: 'Enabled',
      fallbackDescription: 'No usage guidance yet',
      route: (profile, connection, model, thinking) =>
        `${profile} · ${connection} / ${model}${thinking ? ` · Thinking ${thinking}` : ''}`,
    },
    status: {
      available: 'Available',
      disabled: 'Disabled',
      missingConnection: 'Connection missing',
      connectionDisabled: 'Connection disabled',
      modelDisabled: 'Model not enabled',
    },
    editor: {
      createTitle: 'Add subagent',
      createSubtitle: 'Create a model preset that the main agent can select automatically.',
      editTitle: 'Edit subagent',
      editSubtitle: 'Change its usage guidance, capability boundary, and model route.',
      name: 'Display name',
      namePlaceholder: 'Fast code reader',
      id: 'subagent_id',
      idDescription: 'Stable after creation. The main agent and session history use it to identify this preset.',
      idPlaceholder: 'fast-reader',
      description: 'When to use',
      descriptionHelp: 'Describe when this preset is the right choice. The main agent relies primarily on this guidance.',
      descriptionPlaceholder: 'Fast, low-cost exploration of large repositories',
      profile: 'Capability profile',
      connection: 'Model connection',
      model: 'Model',
      thinking: 'Thinking level',
      defaultThinking: 'Use model default',
      enabled: 'Enable immediately',
      enabledDescription: 'When enabled, the main agent may select this preset.',
      implementationWarning: 'The Implementation profile can write files and run commands inside an isolated worktree.',
      noConnection: 'Enable a model connection on the Models page first.',
      noModel: 'The selected connection has no enabled models.',
      requiredName: 'Enter a display name.',
      requiredDescription: 'Describe when this subagent should be used.',
      invalidId: 'Use only letters, numbers, dots, underscores, colons, and hyphens, up to 128 characters.',
      duplicateId: 'That subagent_id already exists.',
      invalidRoute: 'Select an enabled connection and model.',
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
