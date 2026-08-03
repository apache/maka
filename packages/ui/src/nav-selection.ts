/**
 * The rail's session section takes no filter.
 *
 * It used to carry `'chats' | 'flagged' | 'archived'`. Archived became Settings
 * › 活动 › 已归档任务 (#2985) — cleaning tasks up is management, and the rail
 * lists what you are working on. `flagged` never had a writer: nothing ever
 * selected it, so the branch that filtered on it could not run. What was left
 * was a one-value filter: a control whose answer is always the same answer.
 *
 * The rail's 任务 row went with it, and nothing replaced it. Selecting this
 * section is what clicking a task row already does, so expanded the row sat
 * directly above the list that is its own destination. Collapsed the list is
 * not rendered — but the rail cannot switch tasks there at all, so coming back
 * from 扩展 means widening the rail either way. `activeId` is untouched by a
 * section change, so the task you left is still marked when it does.
 *
 * `sessions` therefore has no control of its own on the rail. It is where you
 * are unless you went somewhere, which is why the other two sections light up
 * and this one has nothing to light.
 */
export type ExtensionModule = 'skills' | 'mcp';
export type AutomationModule = 'scheduled-tasks' | 'daily-review' | 'browser-workflows';

export type NavSelection =
  | { section: 'sessions' }
  | { section: 'extensions'; module: ExtensionModule }
  | { section: 'automations'; module: AutomationModule };

export type NavModuleMemory = {
  extensions: ExtensionModule;
  automations: AutomationModule;
};
