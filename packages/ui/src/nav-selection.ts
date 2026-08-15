/**
 * The rail's session section takes no filter.
 *
 * It used to carry `'chats' | 'flagged' | 'archived'`. Archived became Settings
 * › 活动 › 已归档任务 (#2985) — cleaning tasks up is management, and the rail
 * lists what you are working on. `flagged` never had a writer: nothing ever
 * selected it, so the branch that filtered on it could not run. What was left
 * was a one-value filter: a control whose answer is always the same answer.
 *
 * The rail's 任务 row survives that deletion. It carried the dead filter, but
 * its job was to select this section — it is how you get back here from
 * 扩展 or 定时任务, and collapsed at 48px it is the ONLY way, because the list
 * itself is not rendered there.
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
