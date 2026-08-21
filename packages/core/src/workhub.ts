import type { PermissionMode } from './permission.js';
import type { InteractionAnswer, InteractionRequest } from './interaction.js';
import type { AttachmentIngestItem } from './events.js';
import type { StoredMessage } from './session.js';

/** Stable identity of the Session that owns one user-visible Work. */
export interface WorkHubWorkRef {
  workspaceId: string;
  sessionId: string;
}

/** Model selected in WorkHub and applied to routing, discussion, and submitted Work turns. */
export interface WorkHubModelSelection {
  llmConnectionSlug: string;
  model: string;
}

export type WorkHubWorkStatus = 'running' | 'waiting_for_user' | 'completed' | 'failed' | 'stopped';

export type WorkHubCoordinationStatus =
  | 'active'
  | 'waiting_for_user'
  | 'completed'
  | 'failed'
  | 'stopped';

export type WorkHubCoordinationNodeStatus =
  | 'pending'
  | 'running'
  | 'waiting_for_user'
  | 'completed'
  | 'failed'
  | 'stopped'
  | 'blocked';

export interface WorkHubCoordinationNode {
  nodeId: string;
  work: WorkHubWorkRef;
  projectName: string;
  workName: string;
  instruction: string;
  status: WorkHubCoordinationNodeStatus;
  blockId?: string;
  detail?: string;
}

export interface WorkHubCoordinationEdge {
  edgeId: string;
  fromNodeId: string;
  toNodeId: string;
}

/** Durable projection of one WorkHub-owned graph spanning ordinary Works. */
export interface WorkHubCoordinationItem {
  kind: 'coordination';
  id: string;
  sourceRequestId: string;
  title: string;
  status: WorkHubCoordinationStatus;
  nodes: WorkHubCoordinationNode[];
  edges: WorkHubCoordinationEdge[];
  modelSelection?: WorkHubModelSelection;
  createdAt: number;
  updatedAt: number;
}

export interface WorkHubDiscussionItem {
  kind: 'discussion';
  id: string;
  sourceRequestId: string;
  role: 'user' | 'assistant';
  text: string;
  status: 'running' | 'completed' | 'failed';
  replyToItemId?: string;
  createdAt: number;
}

export interface WorkHubTargetOption {
  candidateId: string;
  work: WorkHubWorkRef;
  projectName: string;
  workName: string;
  archived: boolean;
}

export type WorkHubRouteConfidence = 'high' | 'medium' | 'low';
export type WorkHubRouteSource =
  | 'explicit'
  | 'name'
  | 'focus'
  | 'memory'
  | 'semantic'
  | 'model'
  | 'correction'
  | 'new_work'
  | 'coordination';

export interface WorkHubRouteSummary {
  confidence: WorkHubRouteConfidence;
  source: WorkHubRouteSource;
  alternatives: WorkHubTargetOption[];
  correctedTo?: WorkHubWorkRef;
  correctedAt?: number;
}

export interface WorkHubClarificationItem {
  kind: 'clarification';
  id: string;
  sourceRequestId: string;
  text: string;
  question: string;
  options: WorkHubTargetOption[];
  routing?: Pick<WorkHubRouteSummary, 'confidence' | 'source'>;
  /** Persisted choice makes historical clarification cards non-actionable and
   * gives retries one idempotency key instead of resubmitting the text. */
  resolvedTo?: WorkHubWorkRef;
  resolvedAt?: number;
  createdAt: number;
}

export interface WorkHubWorkBlock {
  kind: 'work';
  id: string;
  sourceRequestId: string;
  work: WorkHubWorkRef;
  projectName: string;
  workName: string;
  requestText: string;
  permissionMode: PermissionMode;
  status: WorkHubWorkStatus;
  turnId?: string;
  detail?: string;
  interaction?: {
    interactionId: string;
    request: InteractionRequest;
  };
  coordination?: {
    coordinationId: string;
    nodeId: string;
  };
  routing?: WorkHubRouteSummary;
  createdAt: number;
  updatedAt: number;
}

/**
 * WorkHub is an overview surface, so one completed Work shows the Turn's final
 * answer rather than replaying every assistant narration around tool calls.
 * Empty assistant rows are valid transcript projections and must not become
 * visible whitespace when the overview is assembled.
 */
export function selectWorkHubResultText(
  transcript: readonly StoredMessage[],
  turnId: string,
): string {
  const final = [...transcript]
    .reverse()
    .find(
      (message) =>
        message.type === 'assistant' && message.turnId === turnId && message.text.trim().length > 0,
    );
  return final?.type === 'assistant' ? presentWorkHubResultText(final.text) : '';
}

/**
 * Older WorkHub snapshots joined every assistant step with blank lines. The
 * final, user-facing response follows the last tool-step-sized blank run, so
 * trim that legacy prefix and keep ordinary Markdown paragraph spacing.
 */
export function presentWorkHubResultText(detail: string): string {
  const normalized = detail.replace(/\r\n?/gu, '\n').trim();
  let finalResultStart = 0;
  for (const gap of normalized.matchAll(/\n{4,}/gu)) {
    finalResultStart = (gap.index ?? 0) + gap[0].length;
  }
  return normalized
    .slice(finalResultStart)
    .trim()
    .replace(/\n{3,}/gu, '\n\n');
}

/** Durable, bounded routing knowledge learned from one Work's real activity. */
export interface WorkHubWorkMemory {
  work: WorkHubWorkRef;
  projectName: string;
  workName: string;
  aliases: string[];
  entities: string[];
  recentRequests: string[];
  recentOutcomes: string[];
  lastFocusedAt: number;
  focusCount: number;
}

export interface WorkHubRoutingMemory {
  recentFocus: WorkHubWorkRef[];
  works: WorkHubWorkMemory[];
  corrections: WorkHubRouteCorrection[];
}

/** A user-confirmed routing override. Entries are bounded and local to WorkHub. */
export interface WorkHubRouteCorrection {
  query: string;
  from: WorkHubWorkRef;
  to: WorkHubWorkRef;
  correctedAt: number;
}

export type WorkHubItem =
  | WorkHubDiscussionItem
  | WorkHubClarificationItem
  | WorkHubCoordinationItem
  | WorkHubWorkBlock;

export interface WorkHubSnapshot {
  revision: number;
  items: WorkHubItem[];
  workFocus?: WorkHubWorkRef;
  /** Most-recent-first Work focus history used for local reference resolution. */
  routingMemory?: WorkHubRoutingMemory;
}

/** Anonymous, local-only product counters. No content or identity is recorded. */
export type WorkHubMetricName =
  | 'workhub_opened'
  | 'submission'
  | 'clarification'
  | 'manual_session_switch';

export interface WorkHubMetrics {
  workhubOpened: number;
  submissions: number;
  clarifications: number;
  manualSessionSwitches: number;
}

/** Metrics that may be emitted directly by the renderer. */
export type WorkHubClientMetricName = 'workhub_opened' | 'manual_session_switch';

export type WorkHubCommand =
  | { kind: 'inspect' }
  | { kind: 'inspect_metrics' }
  | { kind: 'record_metric'; metric: WorkHubClientMetricName }
  | {
      kind: 'submit';
      requestId: string;
      text: string;
      explicitWork?: WorkHubWorkRef;
      modelSelection?: WorkHubModelSelection;
      /** Desktop-validated attachment payloads. WorkHub only accepts these
       * when the user has explicitly selected a target Work. */
      attachmentItems?: AttachmentIngestItem[];
    }
  | { kind: 'set_permission'; work: WorkHubWorkRef; mode: PermissionMode }
  | {
      kind: 'answer_interaction';
      work: WorkHubWorkRef;
      interactionId: string;
      answer: InteractionAnswer;
    }
  | { kind: 'stop_work'; work: WorkHubWorkRef }
  | {
      kind: 'resolve_clarification';
      clarificationId: string;
      work: WorkHubWorkRef;
      modelSelection?: WorkHubModelSelection;
    }
  | { kind: 'correct_route'; blockId: string; work: WorkHubWorkRef }
  | { kind: 'stop_coordination'; coordinationId: string };

export type WorkHubCommandResult =
  | { kind: 'snapshot'; snapshot: WorkHubSnapshot }
  | { kind: 'metrics'; metrics: WorkHubMetrics }
  | { kind: 'metric_acknowledged'; metric: WorkHubClientMetricName }
  | { kind: 'discussion'; item: WorkHubDiscussionItem }
  | { kind: 'clarification'; item: WorkHubClarificationItem }
  | { kind: 'work'; block: WorkHubWorkBlock }
  | { kind: 'work_waiting'; block: WorkHubWorkBlock }
  | { kind: 'coordination'; coordination: WorkHubCoordinationItem }
  | { kind: 'acknowledged'; work: WorkHubWorkRef }
  | { kind: 'coordination_acknowledged'; coordinationId: string };

export interface WorkHubSnapshotChangedEvent {
  kind: 'snapshot_changed';
  reason: 'command' | 'discussion_outcome' | 'turn_outcome';
  snapshot: WorkHubSnapshot;
}

/** Label of the model-backed Discussion Session, hidden from ordinary Work lists. */
export const WORKHUB_INTERNAL_SESSION_LABEL = 'maka:workhub-internal';
export const WORKHUB_ROUTER_SESSION_LABEL = 'maka:workhub-router-internal';

export function isWorkHubInternalSession(labels: readonly string[]): boolean {
  return (
    labels.includes(WORKHUB_INTERNAL_SESSION_LABEL) || labels.includes(WORKHUB_ROUTER_SESSION_LABEL)
  );
}

export type WorkHubEvent = WorkHubSnapshotChangedEvent;

export function workHubWorkKey(work: WorkHubWorkRef): string {
  return `${encodeURIComponent(work.workspaceId)}:${encodeURIComponent(work.sessionId)}`;
}

export function sameWorkHubWork(
  left: WorkHubWorkRef | undefined,
  right: WorkHubWorkRef | undefined,
): boolean {
  return Boolean(
    left && right && left.workspaceId === right.workspaceId && left.sessionId === right.sessionId,
  );
}
