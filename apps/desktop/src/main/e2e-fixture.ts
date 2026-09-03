/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { E2eFixtureScenario, E2eFixtureState } from '@maka/core/e2e-fixture';
import type { AgentGraphClientSnapshot } from '@maka/runtime/stream-graph-read-model';
import { agentGraphIdForRootSession } from '@maka/runtime/stream-graph-coordinator';
import { createAgentGraphControlStore } from '@maka/storage/agent-graph-control-store';
import { AGENT_GRAPH_CLIENT_PROJECTION_SCHEMA_VERSION } from '@maka/core/agent-graph-client-projection';
import { MODEL_CALL_ATTEMPT_EVENT_TYPE } from '@maka/core/model-call-attempt';
import type { UiLocale } from '@maka/core/ui-locale';
import { createSqliteAgentRunStore } from '@maka/storage/agent-run-store';
import { createProjectCatalog } from '@maka/storage/project-catalog';
import {
  resolveStorageRoot,
  tryAcquireInteractiveRootOwner,
} from '@maka/storage/root-authority';
import { openInteractiveSessionTodoStoreForWrite } from '@maka/storage/session-todo-authority';
import { openInteractiveUsageStoresForWrite } from '@maka/storage/usage-stores';
import {
  E2E_FIXTURE_NOW,
  LONG_SIDEBAR_PROJECT_ID,
  LONG_SIDEBAR_PROJECT_NAME,
  LONG_SIDEBAR_SESSION_PREFIX,
  PARTIAL_HISTORY_SESSION_ID,
  PROMPT_RAIL_SESSION_ID,
  AGENT_GRAPH_SESSION_ID,
  TURN_SESSION_ID,
  writeSession,
} from './e2e-fixture/seed-helpers.js';
import {
  partialHistoryMessages,
  partialHistorySession,
  promptRailMessages,
  promptRailSession,
  turnMessages,
  turnSession,
  agentGraphSession,
} from './e2e-fixture/scenarios-chat.js';
import { seedMcpFixture, seedSkillsMarketFixture } from './e2e-fixture/scenarios-modules.js';
import { longSidebarSessions } from './e2e-fixture/scenarios-sessions.js';
import {
  writeConnections,
  writeDailyReviewArchives,
  writeScheduledTasks,
  writeSettings,
} from './e2e-fixture/scenarios-settings.js';
import { usageStatsRecords, usageStatsSessions } from './e2e-fixture/scenarios-usage.js';

const E2E_FIXTURE_SCENARIOS = new Set<E2eFixtureScenario>([
  'settings-models',
  'turn-narrative',
  'turn-narrative-browser',
  'chat-prompt-rail',
  'chat-partial-history',
  'settings-data',
  'settings-bots-onboarding',
  'settings-general',
  'settings-permissions',
  'settings-usage',
  'module-skills',
  'module-mcp',
  'module-daily-review',
  'scheduled-tasks',
  'agent-graph-layout',
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
    case 'settings-models':
      return { ...state, activeSessionId: TURN_SESSION_ID, openSettingsSection: 'models' };
    case 'turn-narrative':
      return { ...state, activeSessionId: TURN_SESSION_ID, workbarCollapsed: false, workbarTab: 'tasks' };
    case 'turn-narrative-browser':
      return { ...state, activeSessionId: TURN_SESSION_ID, workbarCollapsed: false, workbarTab: 'browser' };
    case 'chat-prompt-rail':
      // Workbar collapsed: the rail lives on the chat scrollport's right edge,
      // and the panel would take the width the measurements are about. Whether
      // this window scrolls smoothly is a per-launch choice (`scrollMotion`),
      // because only the jump case needs it and it costs seconds of settling.
      return { ...state, activeSessionId: PROMPT_RAIL_SESSION_ID, workbarCollapsed: true };
    case 'chat-partial-history':
      return { ...state, activeSessionId: PARTIAL_HISTORY_SESSION_ID, workbarCollapsed: true };
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
    case 'agent-graph-layout':
      return { ...state, activeSessionId: AGENT_GRAPH_SESSION_ID };
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
  now?: number;
}): Promise<void> {
  const now = input.now ?? E2E_FIXTURE_NOW;
  const scenario = input.fixture.scenario;
  await rm(input.workspaceRoot, { recursive: true, force: true });
  await mkdir(input.workspaceRoot, { recursive: true });
  const storageRoot = await resolveStorageRoot({ path: input.workspaceRoot, kind: 'interactive' });
  await writeSettings(input.workspaceRoot, scenario);
  await writeConnections(input.workspaceRoot, now, scenario);
  await writeSession(
    input.workspaceRoot,
    scenario === 'agent-graph-layout' ? agentGraphSession(now) : turnSession(now),
    turnMessages(now),
  );

  if (scenario === 'agent-graph-layout') await seedAgentGraphLayout(input.workspaceRoot, now);

  if (scenario === 'turn-narrative' || scenario === 'turn-narrative-browser') {
    const owner = await tryAcquireInteractiveRootOwner(storageRoot);
    if (!owner) throw new Error('Unable to acquire the E2E fixture SessionTodo root');
    try {
      const todos = await openInteractiveSessionTodoStoreForWrite(owner.lease);
      try {
        await todos.replaceAll(TURN_SESSION_ID, [
          { content: '补齐桌面端无障碍覆盖', status: 'in_progress' },
          { content: '核对模型选择器的键盘路径', status: 'pending' },
          { content: '确认工具结果可以展开阅读', status: 'completed' },
        ]);
      } finally {
        todos.close();
      }
    } finally {
      await owner.close();
    }
  }

  if (scenario === 'chat-prompt-rail') {
    await writeSession(input.workspaceRoot, promptRailSession(now), promptRailMessages(now));
  }
  if (scenario === 'chat-partial-history') {
    await writeSession(
      input.workspaceRoot,
      partialHistorySession(now),
      partialHistoryMessages(now),
    );
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
    const owner = await tryAcquireInteractiveRootOwner(storageRoot);
    if (!owner) throw new Error('Unable to acquire the E2E fixture storage root');
    const usage = await openInteractiveUsageStoresForWrite(owner.lease);
    // The AgentRun store and the interactive usage stores share one refcounted
    // operational-state DB keyed by the lease's resolved path, so the canonical
    // model-call events written here are visible to `catchUpModelCallProjection`
    // below. It MUST be the lease's canonicalPath, not the raw workspaceRoot —
    // a /var vs /private/var realpath difference would open a different DB.
    const runStore = createSqliteAgentRunStore(owner.lease.canonicalPath);
    try {
      const records = usageStatsRecords(now);
      // Model calls seed the CANONICAL ledger through the AgentRun event stream;
      // tools stay on the legacy telemetry table (there is no canonical tool
      // ledger). This is what actually exercises the canonical merge branch.
      for (const { header: runHeader, attempt } of records.modelCalls) {
        await runStore.createRun(runHeader);
        await runStore.appendEvent(attempt.sessionId, attempt.runId, {
          id: attempt.attemptId,
          type: MODEL_CALL_ATTEMPT_EVENT_TYPE,
          ts: attempt.completedAt,
          sessionId: attempt.sessionId,
          runId: attempt.runId,
          turnId: attempt.turnId,
          data: { ...attempt },
        });
      }
      for (const record of records.tools) await usage.telemetry.recordToolInvocation(record);
      await runStore.close?.();
      // Fold the appended attempts into the read model so the page's first read
      // sees canonical usage (production's readCanonicalUsage also repairs).
      await usage.modelCalls.catchUpModelCallProjection();
      await usage.flush();
    } finally {
      await usage.close();
      await owner.close();
    }
  }
}

async function seedAgentGraphLayout(workspaceRoot: string, now: number): Promise<void> {
  const graphId = agentGraphIdForRootSession(AGENT_GRAPH_SESSION_ID);
  const operators: AgentGraphClientSnapshot['operators'] = Array.from(
    { length: 24 },
    (_, index) => ({
      operatorId: `operator-${index + 1}`,
      childSessionId: `child-session-${index + 1}`,
      provisionId: `provision-${index + 1}`,
      agentId: `agent-${index + 1}`,
      provisionedAt: now - (24 - index) * 1_000,
      status: 'completed' as const,
      inboundEdgeIds: [],
      outboundEdgeIds: [],
      scheduledWorkIds: [`work-${index + 1}`],
      readiness: [],
      omitted: {
        inboundEdgeIds: 0,
        outboundEdgeIds: 0,
        scheduledWorkIds: 0,
        readiness: 0,
        readinessWaits: 0,
      },
    }),
  );
  const snapshot: AgentGraphClientSnapshot = {
    schemaVersion: 1,
    rootSessionId: AGENT_GRAPH_SESSION_ID,
    graphId,
    orchestrationMode: 'graph',
    snapshotVersion: `sha256:${'a'.repeat(64)}`,
    status: 'active',
    scheduleRevision: 1,
    topologyFingerprint: `sha256:${'b'.repeat(64)}`,
    closed: false,
    latestEventTime: now,
    operators,
    edges: [],
    work: operators.map((operator, index) => ({
      workId: `work-${index + 1}`,
      target: { kind: 'agent' as const, agentId: operator.agentId },
      inputIds: [],
      status: 'requested' as const,
      instructionPreview: `布局回归 operator ${index + 1}`,
      instructionTruncated: false,
      revision: 1,
      committedAt: now - (24 - index) * 1_000,
    })),
    reconciliationFailures: [],
    stoppedTargets: [],
    claims: [],
    recentControlDecisions: [],
    recentActivity: [],
    terminalHistory: { records: [] },
    omitted: {
      operators: 0,
      edges: 0,
      work: 0,
      reconciliationFailures: 0,
      stoppedTargets: 0,
      claims: 0,
      controlDecisions: 0,
      recentActivity: 0,
    },
  };
  const controlStore = createAgentGraphControlStore(workspaceRoot);
  try {
    await controlStore.commitAgentGraphClientProjection({
      schemaVersion: AGENT_GRAPH_CLIENT_PROJECTION_SCHEMA_VERSION,
      graphId,
      rootSessionId: AGENT_GRAPH_SESSION_ID,
      expectedSnapshotVersion: null,
      snapshotVersion: snapshot.snapshotVersion,
      snapshot,
      replaceOperators: true,
      operators: [],
      terminalActivities: [],
      activityRecords: [],
    });
  } finally {
    controlStore.close();
  }
}
