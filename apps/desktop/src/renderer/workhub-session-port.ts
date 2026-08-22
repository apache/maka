import type {
  WorkHubSessionFacts,
  WorkHubSessionPort,
  WorkHubSessionState,
  WorkHubSessionTarget,
} from './workhub-controller.js';

export interface WorkHubDesktopSession {
  id: string;
  name: string;
  labels: readonly string[];
  isArchived: boolean;
  status: 'active' | 'running' | 'waiting_for_user' | 'blocked' | 'aborted';
  runningTurnIds?: readonly string[];
  projectId?: string | null;
  cwd?: string;
  lastMessageAt?: number;
  lastMessagePreview?: string;
  statusUpdatedAt?: number;
  subagent?: object;
}

export interface WorkHubDesktopSessionBridge {
  list(): Promise<readonly WorkHubDesktopSession[]>;
  listTurns(sessionId: string): Promise<readonly { userPromptPreview?: string }[]>;
  create(input: { name: string }): Promise<WorkHubDesktopSession>;
  send(
    sessionId: string,
    command: { type: 'send'; turnId: string; text: string },
  ): Promise<{ ok: true; turnId: string } | { ok: false; reason: string }>;
  stop(sessionId: string, input?: { source?: 'stop_button' }): Promise<void>;
  subscribeChanges(handler: () => void): () => void;
}

export function createDesktopWorkHubSessionPort(deps: {
  sessions: WorkHubDesktopSessionBridge;
  projectName(projectId: string): string | undefined;
  newTurnId(): string;
}): WorkHubSessionPort {
  // The first prompt is immutable Session-log evidence. This cache is only a
  // rebuildable read optimization; it is never an authority or a write path.
  const originPromptCache = new Map<string, string>();
  const project = (session: WorkHubDesktopSession): string => {
    if (session.projectId) {
      const name = deps.projectName(session.projectId);
      if (name) return name;
    }
    const normalizedCwd = session.cwd?.replace(/[/\\]+$/, '');
    return normalizedCwd?.split(/[/\\]/).at(-1) || 'Unassigned';
  };
  const projectSession = (session: WorkHubDesktopSession): WorkHubSessionFacts => ({
    target: { sessionId: session.id },
    projectName: project(session),
    sessionName: session.name,
    kind: session.subagent
      ? 'subagent'
      : session.labels.includes('mode:side_conversation')
        ? 'internal'
        : 'ordinary',
    archived: session.isArchived,
    state: projectState(session),
    ...(session.lastMessagePreview
      ? { latestResult: session.lastMessagePreview }
      : {}),
    updatedAt: session.lastMessageAt ?? session.statusUpdatedAt ?? 0,
  });

  return {
    async list() {
      return (await deps.sessions.list()).map(projectSession);
    },
    async routingEvidence(targets) {
      return Promise.all(targets.map(async (target) => {
        const cached = originPromptCache.get(target.sessionId);
        if (cached) return { target, originPrompt: cached };
        try {
          const turns = await deps.sessions.listTurns(target.sessionId);
          const originPrompt = turns
            .map((turn) => turn.userPromptPreview?.trim())
            .find((prompt): prompt is string => Boolean(prompt));
          if (originPrompt) originPromptCache.set(target.sessionId, originPrompt);
          return originPrompt ? { target, originPrompt } : { target };
        } catch {
          // A missing/unavailable transcript must not make the WorkHub surface
          // unusable; title and latest Session projection remain available.
          return { target };
        }
      }));
    },
    async create({ name }) {
      return projectSession(await deps.sessions.create({ name }));
    },
    async submit(target: WorkHubSessionTarget, text: string) {
      const turnId = deps.newTurnId();
      const result = await deps.sessions.send(target.sessionId, {
        type: 'send',
        turnId,
        text,
      });
      if (!result.ok) throw new Error(`WorkHub Session send failed: ${result.reason}`);
      return { turnId: result.turnId };
    },
    async stop(target) {
      await deps.sessions.stop(target.sessionId, { source: 'stop_button' });
    },
    subscribe(handler) {
      return deps.sessions.subscribeChanges(handler);
    },
  };
}

function projectState(session: WorkHubDesktopSession): WorkHubSessionState {
  // A root Turn can remain live while it is blocked on a user interaction.
  // WorkHub must surface that interaction boundary before the broader running
  // fact so it never attempts to enqueue a second root request.
  if (session.status === 'waiting_for_user') {
    return 'waiting_for_user';
  }
  if ((session.runningTurnIds?.length ?? 0) > 0 || session.status === 'running') {
    return 'running';
  }
  return session.status;
}
