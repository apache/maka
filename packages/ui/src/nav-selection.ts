/**
 * Archived tasks are not a rail filter. Cleaning them up is management, and it
 * lives in Settings › 活动 › 已归档任务; the rail lists what you are working on.
 */
export type SessionFilter = 'chats' | 'flagged';
export type ExtensionModule = 'skills' | 'mcp';
export type AutomationModule = 'scheduled-tasks' | 'daily-review';

export type NavSelection =
  | { section: 'sessions'; filter: SessionFilter }
  | { section: 'extensions'; module: ExtensionModule }
  | { section: 'automations'; module: AutomationModule };

export type NavModuleMemory = {
  extensions: ExtensionModule;
  automations: AutomationModule;
};
