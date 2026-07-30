export type SessionFilter = 'chats' | 'flagged' | 'archived';
export type ExtensionModule = 'skills' | 'mcp';
export type AutomationModule = 'plan-reminders' | 'daily-review';

export type NavSelection =
  | { section: 'sessions'; filter: SessionFilter }
  | { section: 'extensions'; module: ExtensionModule }
  | { section: 'automations'; module: AutomationModule };

export type NavModuleMemory = {
  extensions: ExtensionModule;
  automations: AutomationModule;
};
