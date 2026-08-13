export type AgentGraphPanelStatus =
  | 'empty'
  | 'active'
  | 'closing'
  | 'waiting'
  | 'stopped'
  | 'failed'
  | 'completed';

export type AgentGraphPanelDismissals = Readonly<Record<string, string>>;

const DISMISSIBLE_STATUSES = new Set<AgentGraphPanelStatus>([
  'completed',
  'stopped',
  'failed',
]);

export function isAgentGraphPanelDismissible(
  status: AgentGraphPanelStatus | undefined,
): boolean {
  return status !== undefined && DISMISSIBLE_STATUSES.has(status);
}

export function dismissAgentGraphPanel(
  dismissedBySession: AgentGraphPanelDismissals,
  sessionId: string,
  graphId: string,
): AgentGraphPanelDismissals {
  if (dismissedBySession[sessionId] === graphId) return dismissedBySession;
  return { ...dismissedBySession, [sessionId]: graphId };
}

export function reconcileAgentGraphPanelDismissals(
  dismissedBySession: AgentGraphPanelDismissals,
  sessionId: string,
  snapshot:
    | { rootSessionId: string; graphId: string; status: AgentGraphPanelStatus }
    | undefined,
): AgentGraphPanelDismissals {
  const dismissed = dismissedBySession[sessionId];
  if (!dismissed || !snapshot || snapshot.rootSessionId !== sessionId) {
    return dismissedBySession;
  }
  if (snapshot.graphId === dismissed && isAgentGraphPanelDismissible(snapshot.status)) {
    return dismissedBySession;
  }
  const next = { ...dismissedBySession };
  delete next[sessionId];
  return next;
}

export function shouldShowAgentGraphPanel(input: {
  enabled: boolean;
  hasGraphActivity: boolean;
  error: boolean;
  sessionId: string;
  graphId?: string;
  status?: AgentGraphPanelStatus;
  dismissedBySession: AgentGraphPanelDismissals;
}): boolean {
  if (
    input.graphId !== undefined &&
    input.dismissedBySession[input.sessionId] === input.graphId &&
    isAgentGraphPanelDismissible(input.status)
  ) {
    return false;
  }
  return input.enabled || input.hasGraphActivity || input.error;
}
