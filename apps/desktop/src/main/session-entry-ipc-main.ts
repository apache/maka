import { randomUUID } from 'node:crypto';
import { ipcMain } from 'electron';
import {
  getExpertTeam,
  listExpertTeams,
} from '@maka/runtime';
import type { SessionManager } from '@maka/runtime';
import { expertTeamLabel } from '@maka/core';
import type { CreateSessionInput, OnboardingState, SessionEvent } from '@maka/core';
import { handleExpertTeamStart as runExpertTeamStart } from './expert-team-start.js';
import type { requireReadyConnection } from './chat-readiness.js';

export interface SessionEntryIpcDeps {
  runtime: SessionManager;
  getReadyConnection: (
    slug: string | null | undefined,
    model?: string,
  ) => ReturnType<typeof requireReadyConnection>;
  getCurrentProjectRoot: () => Promise<string>;
  getOnboardingState: () => Promise<OnboardingState>;
  emitSessionsChanged: (reason: 'created', sessionId: string) => void;
  ensureSessionCanSend: (sessionId: string) => Promise<void>;
  createSession: (input: CreateSessionInput) => ReturnType<SessionManager['createSession']>;
  streamEvents: (
    sessionId: string,
    iterator: AsyncIterable<SessionEvent>,
    options: {
      turnId: string;
      goalBoundary: 'external';
    },
  ) => Promise<{ turnId: string; ok: boolean; error?: string }>;
}

export function registerSessionEntryIpc(deps: SessionEntryIpcDeps): void {
  // Expert teams: list the built-in teams and start a labeled team session.
  // A team session is a normal session tagged `mode:expert-team:<teamId>`; the
  // label activates the lead persona + expert_dispatch tool (see the backend
  // factory). The lead runs read-only (explore) and dispatches read-only members.
  ipcMain.handle('expertTeam:list', async () => ({
    teams: listExpertTeams().map((team) => ({
      id: team.id,
      name: team.name,
      description: team.description,
      members: team.members.map((member) => ({
        id: member.id,
        name: member.name,
        description: member.description,
        ...(member.whenToUse ? { whenToUse: member.whenToUse } : {}),
      })),
    })),
  }));
  ipcMain.handle('expertTeam:start', async (_event, input: unknown) => {
    return runExpertTeamStart(input, {
      isKnownTeam: (teamId) => getExpertTeam(teamId) !== undefined,
      getOnboardingState: () => deps.getOnboardingState(),
      createSession: async ({ teamId, defaultConnectionSlug, defaultModel }) => {
        const ready = await deps.getReadyConnection(defaultConnectionSlug, defaultModel);
        const team = getExpertTeam(teamId);
        return deps.createSession({
          cwd: await deps.getCurrentProjectRoot(),
          backend: 'ai-sdk',
          llmConnectionSlug: ready.connection.slug,
          model: ready.model,
          // Shipped teams are read-only review crews: the lead reads + dispatches
          // read-only members, so the whole session stays in explore mode.
          permissionMode: 'explore',
          name: team ? team.name : 'Expert Team',
          labels: [expertTeamLabel(teamId)],
        });
      },
      emitCreated: (sessionId) => deps.emitSessionsChanged('created', sessionId),
      ensureCanSend: (sessionId) => deps.ensureSessionCanSend(sessionId),
      sendFirstMessage: async (sessionId, text) => {
        const turnId = randomUUID();
        const iterator = deps.runtime.sendMessage(sessionId, { turnId, text });
        void deps.streamEvents(sessionId, iterator, { turnId, goalBoundary: 'external' });
      },
    });
  });
}
