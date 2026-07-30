import type {
  AutomationModule,
  ExtensionModule,
  NavModuleMemory,
  NavSelection,
  SessionFilter,
} from '@maka/ui';
import { safeLocalStorageGet } from './browser-storage.js';

export type NavigationState = {
  selection: NavSelection;
  moduleMemory: NavModuleMemory;
};

const DEFAULT_MODULE_MEMORY: NavModuleMemory = {
  extensions: 'skills',
  automations: 'plan-reminders',
};

function defaultNavigationState(): NavigationState {
  return {
    selection: { section: 'sessions', filter: 'chats' },
    moduleMemory: { ...DEFAULT_MODULE_MEMORY },
  };
}

function isSessionFilter(value: unknown): value is SessionFilter {
  return value === 'chats' || value === 'flagged' || value === 'archived';
}

function isExtensionModule(value: unknown): value is ExtensionModule {
  return value === 'skills' || value === 'mcp';
}

function isAutomationModule(value: unknown): value is AutomationModule {
  return value === 'plan-reminders' || value === 'daily-review';
}

function parseSelection(value: unknown): NavSelection | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as { section?: unknown; filter?: unknown; module?: unknown };
  if (candidate.section === 'sessions' && isSessionFilter(candidate.filter)) {
    return { section: 'sessions', filter: candidate.filter };
  }
  if (candidate.section === 'extensions' && isExtensionModule(candidate.module)) {
    return { section: 'extensions', module: candidate.module };
  }
  if (candidate.section === 'automations' && isAutomationModule(candidate.module)) {
    return { section: 'automations', module: candidate.module };
  }

  // Migrate the pre-hub destinations written by maka-nav-selection-v1.
  if (candidate.section === 'skills' || candidate.section === 'mcp') {
    return { section: 'extensions', module: candidate.section };
  }
  if (candidate.section === 'daily-review') {
    return { section: 'automations', module: 'daily-review' };
  }
  if (candidate.section === 'automations') {
    return { section: 'automations', module: 'plan-reminders' };
  }
  return null;
}

function parseModuleMemory(value: unknown): NavModuleMemory {
  if (!value || typeof value !== 'object') return { ...DEFAULT_MODULE_MEMORY };
  const candidate = value as { extensions?: unknown; automations?: unknown };
  return {
    extensions: isExtensionModule(candidate.extensions) ? candidate.extensions : DEFAULT_MODULE_MEMORY.extensions,
    automations: isAutomationModule(candidate.automations) ? candidate.automations : DEFAULT_MODULE_MEMORY.automations,
  };
}

export function selectNavigation(state: NavigationState, selection: NavSelection): NavigationState {
  if (selection.section === 'extensions') {
    return {
      selection,
      moduleMemory: { ...state.moduleMemory, extensions: selection.module },
    };
  }
  if (selection.section === 'automations') {
    return {
      selection,
      moduleMemory: { ...state.moduleMemory, automations: selection.module },
    };
  }
  return { selection, moduleMemory: state.moduleMemory };
}

export function parseNavigationState(raw: string | null): NavigationState {
  if (!raw) return defaultNavigationState();
  try {
    const parsed = JSON.parse(raw) as unknown;
    const candidate = parsed && typeof parsed === 'object'
      ? parsed as { selection?: unknown; moduleMemory?: unknown }
      : null;
    const selection = parseSelection(candidate?.selection ?? parsed);
    if (!selection) return defaultNavigationState();
    return selectNavigation(
      {
        selection,
        moduleMemory: parseModuleMemory(candidate?.moduleMemory),
      },
      selection,
    );
  } catch {
    return defaultNavigationState();
  }
}

export function readNavigationState(): NavigationState {
  return parseNavigationState(safeLocalStorageGet('maka-nav-selection-v1'));
}
