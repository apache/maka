/**
 * The rail's session section takes no filter.
 *
 * It used to carry `'chats' | 'flagged' | 'archived'`. Archived became Settings
 * › 活动 › 已归档任务 (#2985) — cleaning tasks up is management, and the rail
 * lists what you are working on. `flagged` never had a writer: nothing ever
 * selected it, so the branch that filtered on it could not run. What was left
 * was a one-value filter, which is the same tautology the 「会话」 row was: a
 * control whose answer is always the same answer.
 */
export type ExtensionModule = 'skills' | 'mcp';
export type AutomationModule = 'scheduled-tasks' | 'daily-review';

export type NavSelection =
  | { section: 'sessions' }
  | { section: 'extensions'; module: ExtensionModule }
  | { section: 'automations'; module: AutomationModule };

export type NavModuleMemory = {
  extensions: ExtensionModule;
  automations: AutomationModule;
};
