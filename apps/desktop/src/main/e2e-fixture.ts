import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { E2eFixtureScenario, E2eFixtureState } from '@maka/core/e2e-fixture';
import type { UiLocale } from '@maka/core/ui-locale';
import { createFileCredentialStore, createProjectCatalog } from '@maka/storage';
import type { CredentialStore } from '@maka/storage';
import { resolveStorageRoot } from '@maka/storage/root-authority';
import {
  E2E_FIXTURE_NOW,
  LONG_SIDEBAR_PROJECT_ID,
  LONG_SIDEBAR_PROJECT_NAME,
  LONG_SIDEBAR_SESSION_PREFIX,
  PROMPT_RAIL_SESSION_ID,
  TURN_SESSION_ID,
  writeSession,
} from './e2e-fixture/seed-helpers.js';
import {
  promptRailMessages,
  promptRailSession,
  turnMessages,
  turnSession,
} from './e2e-fixture/scenarios-chat.js';
import { seedMcpFixture, seedSkillsMarketFixture } from './e2e-fixture/scenarios-modules.js';
import { longSidebarSessions } from './e2e-fixture/scenarios-sessions.js';
import {
  writeConnections,
  writeDailyReviewArchives,
  writeScheduledTasks,
  writeSettings,
} from './e2e-fixture/scenarios-settings.js';
import { usageStatsSessions } from './e2e-fixture/scenarios-usage.js';

const E2E_FIXTURE_SCENARIOS = new Set<E2eFixtureScenario>([
  'fetched-empty',
  'turn-narrative',
  'chat-prompt-rail',
  'settings-data',
  'settings-bots-onboarding',
  'settings-general',
  'settings-permissions',
  'settings-usage',
  'module-skills',
  'module-mcp',
  'module-daily-review',
  'scheduled-tasks',
  'sidebar-search-modal-open',
]);

export interface E2eFixture {
  scenario: E2eFixtureScenario;
  workspaceName: string;
  reducedMotion: boolean;
  theme: 'light' | 'dark' | 'auto' | null;
  locale: UiLocale | null;
  timezone: string | null;
  platform: 'darwin' | 'win32' | 'linux' | null;
  scrollMotion: 'auto' | 'smooth' | null;
}

export function resolveE2eFixture(
  rawScenario: string | undefined,
  isPackaged: boolean,
  rawReducedMotion: string | undefined = undefined,
  rawTheme: string | undefined = undefined,
  rawLocale: string | undefined = undefined,
  rawTimezone: string | undefined = undefined,
  rawPlatform: string | undefined = undefined,
  rawScrollMotion: string | undefined = undefined,
): E2eFixture | null {
  if (!rawScenario) return null;
  if (isPackaged) throw new Error('MAKA_E2E_FIXTURE is only available in dev/test builds.');
  if (!E2E_FIXTURE_SCENARIOS.has(rawScenario as E2eFixtureScenario)) {
    throw new Error(`Unknown MAKA_E2E_FIXTURE scenario: ${rawScenario}`);
  }
  const scenario = rawScenario as E2eFixtureScenario;
  return {
    scenario,
    workspaceName: `e2e-fixture-${scenario}`,
    reducedMotion: parseReducedMotionFlag(rawReducedMotion),
    theme: parseThemeFlag(rawTheme),
    locale: parseLocaleFlag(rawLocale),
    timezone: parseTimezoneFlag(rawTimezone),
    platform: parsePlatformFlag(rawPlatform),
    scrollMotion: parseScrollMotionFlag(rawScrollMotion),
  };
}

function parseScrollMotionFlag(raw: string | undefined): 'auto' | 'smooth' | null {
  const normalized = raw?.trim().toLowerCase();
  return normalized === 'auto' || normalized === 'smooth' ? normalized : null;
}

function parseThemeFlag(raw: string | undefined): 'light' | 'dark' | 'auto' | null {
  const normalized = raw?.trim().toLowerCase();
  return normalized === 'light' || normalized === 'dark' || normalized === 'auto'
    ? normalized
    : null;
}

function parseLocaleFlag(raw: string | undefined): UiLocale | null {
  const normalized = raw?.trim().toLowerCase();
  return normalized === 'zh' || normalized === 'en' ? normalized : null;
}

function parseTimezoneFlag(raw: string | undefined): string | null {
  const trimmed = raw?.trim();
  if (!trimmed || trimmed.length > 128) return null;
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: trimmed });
    return trimmed;
  } catch {
    return null;
  }
}

function parsePlatformFlag(raw: string | undefined): 'darwin' | 'win32' | 'linux' | null {
  const normalized = raw?.trim().toLowerCase();
  return normalized === 'darwin' || normalized === 'win32' || normalized === 'linux'
    ? normalized
    : null;
}

function parseReducedMotionFlag(raw: string | undefined): boolean {
  const normalized = raw?.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes';
}

export function getE2eFixtureState(fixture: E2eFixture | null): E2eFixtureState | null {
  if (!fixture) return null;
  const state: E2eFixtureState = {
    enabled: true,
    now: E2E_FIXTURE_NOW,
    ...(fixture.reducedMotion ? { reducedMotion: true } : {}),
    ...(fixture.theme ? { theme: fixture.theme } : {}),
    ...(fixture.locale ? { locale: fixture.locale } : {}),
    ...(fixture.timezone ? { timezone: fixture.timezone } : {}),
    ...(fixture.scrollMotion ? { scrollMotion: fixture.scrollMotion } : {}),
  };
  switch (fixture.scenario) {
    case 'fetched-empty':
      return { ...state, activeSessionId: TURN_SESSION_ID, openSettingsSection: 'models' };
    case 'turn-narrative':
      return { ...state, activeSessionId: TURN_SESSION_ID, workbarCollapsed: false, workbarTab: 'tasks' };
    case 'chat-prompt-rail':
      // Workbar collapsed: the rail lives on the chat scrollport's right edge,
      // and the panel would take the width the measurements are about. Whether
      // this window scrolls smoothly is a per-launch choice (`scrollMotion`),
      // because only the jump case needs it and it costs seconds of settling.
      return { ...state, activeSessionId: PROMPT_RAIL_SESSION_ID, workbarCollapsed: true };
    case 'settings-data':
      return { ...state, activeSessionId: TURN_SESSION_ID, openSettingsSection: 'data' };
    case 'settings-bots-onboarding':
      return {
        ...state,
        activeSessionId: TURN_SESSION_ID,
        openSettingsSection: 'bot-chat',
        botOnboardingProvider: 'dingtalk',
      };
    case 'settings-general':
      return { ...state, activeSessionId: TURN_SESSION_ID, openSettingsSection: 'general' };
    case 'settings-permissions':
      return { ...state, activeSessionId: TURN_SESSION_ID, openSettingsSection: 'permissions' };
    case 'settings-usage':
      return { ...state, activeSessionId: TURN_SESSION_ID, openSettingsSection: 'usage' };
    case 'module-skills':
      return { ...state, activeSessionId: TURN_SESSION_ID, sidebarSection: 'skills', sidebarCollapsed: false };
    case 'module-mcp':
      return { ...state, activeSessionId: TURN_SESSION_ID, sidebarSection: 'mcp', sidebarCollapsed: false };
    case 'module-daily-review':
      return { ...state, activeSessionId: TURN_SESSION_ID, sidebarSection: 'daily-review', sidebarCollapsed: false };
    case 'scheduled-tasks':
      return { ...state, activeSessionId: TURN_SESSION_ID, sidebarSection: 'automations', sidebarCollapsed: false };
    case 'sidebar-search-modal-open':
      return {
        ...state,
        activeSessionId: LONG_SIDEBAR_SESSION_PREFIX + '00',
        sidebarCollapsed: false,
        searchModalOpen: true,
      };
  }
  return state;
}

export async function seedE2eFixture(input: {
  workspaceRoot: string;
  fixture: E2eFixture;
  credentialStore?: Pick<CredentialStore, 'setSecret'>;
  now?: number;
}): Promise<void> {
  const now = input.now ?? E2E_FIXTURE_NOW;
  const scenario = input.fixture.scenario;
  await rm(input.workspaceRoot, { recursive: true, force: true });
  await mkdir(input.workspaceRoot, { recursive: true });
  await resolveStorageRoot({ path: input.workspaceRoot, kind: 'interactive' });
  await writeSettings(input.workspaceRoot, scenario);
  await writeConnections(input.workspaceRoot, now, scenario);

  const credentialStore = input.credentialStore ?? createFileCredentialStore(input.workspaceRoot);
  await credentialStore.setSecret('zai-live', 'api_key', 'fixture-key-zai-live');
  if (scenario === 'fetched-empty') {
    await credentialStore.setSecret('empty-fetched', 'api_key', 'fixture-key-empty-fetched');
  }
  await writeSession(input.workspaceRoot, turnSession(now), turnMessages(now));

  if (scenario === 'chat-prompt-rail') {
    await writeSession(input.workspaceRoot, promptRailSession(now), promptRailMessages(now));
  }
  if (scenario === 'sidebar-search-modal-open') {
    for (const seed of longSidebarSessions(now)) {
      await writeSession(input.workspaceRoot, seed.header, seed.messages);
    }
    const catalog = createProjectCatalog(input.workspaceRoot, {
      now: () => now,
      createId: () => LONG_SIDEBAR_PROJECT_ID,
    });
    try {
      const project = await catalog.register(input.workspaceRoot);
      await catalog.rename(project.id, LONG_SIDEBAR_PROJECT_NAME);
    } finally {
      catalog.close();
    }
  }
  if (scenario === 'scheduled-tasks') await writeScheduledTasks(input.workspaceRoot, now);
  if (scenario === 'module-daily-review') await writeDailyReviewArchives(input.workspaceRoot, now);
  if (scenario === 'module-skills') await seedSkillsMarketFixture(input.workspaceRoot);
  if (scenario === 'module-mcp') await seedMcpFixture(input.workspaceRoot);
  if (scenario === 'settings-usage') {
    for (const seed of usageStatsSessions(now)) {
      await writeSession(input.workspaceRoot, seed.header, seed.messages);
    }
  }
}
