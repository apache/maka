// Session-scoped task ledger primitive for the main agent. The model manages a
// flat task list via task_create/task_update; each turn tail re-injects the
// current list. The durable contract is intentionally narrow: task status,
// compact evidence/reason fields, append-only task events, and conservative
// resume trust diagnostics. Priority, dependencies, and assignee fields remain
// out of scope.

import { redactSecrets } from './redaction.js';

export const TASK_SUBJECT_MAX_CHARS = 200;
export const TASK_EVIDENCE_MAX_CHARS = 1000;
/**
 * Hard cap on total tasks per session ledger (any status). The full ledger is
 * re-injected into every turn tail, so an unbounded ledger burns context on
 * every turn; this is a runaway guard on the total count, not a workflow quota
 * — completing or cancelling tasks does not free capacity.
 */
export const TASK_LEDGER_MAX_TASKS = 200;
export const TASK_ARCHIVE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Max length of a task id accepted on both the write and read paths. The write
 * path generates randomUUID (36 chars); the bound leaves headroom for a future
 * id format while keeping the turn-tail `id=` fielded render bounded.
 */
export const TASK_ID_MAX_CHARS = 64;
export const TASK_KEY_MAX_CHARS = 64;
export const TASK_LEDGER_PROMPT_MAX_CHARS = 8_000;
export const TASK_LEDGER_PROMPT_RECENT_TERMINAL = 3;

export const TASK_STATUSES = [
  'pending',
  'in_progress',
  'blocked',
  'completed',
  'failed',
  'cancelled',
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const TASK_TERMINAL_STATUSES = ['completed', 'failed', 'cancelled'] as const;

export function isTerminalTaskStatus(status: TaskStatus): boolean {
  return (TASK_TERMINAL_STATUSES as readonly TaskStatus[]).includes(status);
}

export const TASK_RESUME_TRUST_LEVELS = [
  'trusted',
  'needs_revalidation',
  'stale',
  'repaired',
  'untrusted',
] as const;
export type ResumeTrust = (typeof TASK_RESUME_TRUST_LEVELS)[number];

export interface TaskOwner {
  actor: 'main_agent' | 'child_agent';
  /** Owning child Session for durable subagent work; absent on legacy child AgentRuns. */
  sessionId?: string;
  agentId?: string;
  runId?: string;
  turnId?: string;
}

export interface Task {
  id: string;
  key: string;
  subject: string;
  status: TaskStatus;
  createdAt: number;
  updatedAt: number;
  parentId?: string;
  owner?: TaskOwner;
  endedAt?: number;
  blockedReason?: string;
  failureReason?: string;
  completionEvidence?: string;
  resumeTrust?: ResumeTrust;
}

export interface TaskLedgerMutationContext {
  runId?: string;
  turnId?: string;
  toolCallId?: string;
  source?: 'tool' | 'system' | 'recovery' | 'import';
  actor?: 'main_agent' | 'child_agent' | 'user' | 'system';
  reason?: string;
}

export interface TaskLedgerChangedEvent {
  sessionId: string;
  taskIds: string[];
  at: number;
}

export interface TaskAgentOutcome {
  status: 'completed' | 'failed' | 'cancelled' | 'running' | 'waiting_for_user';
  owner: TaskOwner;
  reason?: string;
}

export interface TaskAvailableClaimScope {
  /** Main AgentRun that made this task available to its child team. */
  parentRunId: string;
}

/**
 * Store contract shared by the storage implementation and the runtime tools.
 * Mutations return the changed task(s) and the new total, computed inside the
 * store's serialized write section, so callers render exactly the state their
 * mutation produced instead of re-reading outside the write queue. The full
 * ledger never leaves the store through the mutation result.
 */
export interface TaskLedgerStore {
  list(sessionId: string, options?: TaskLedgerListOptions): Promise<Task[]>;
  get(sessionId: string, id: string, options?: TaskLedgerListOptions): Promise<Task | undefined>;
  create(
    sessionId: string,
    drafts: unknown,
    context?: TaskLedgerMutationContext,
  ): Promise<{ created: Task[]; total: number }>;
  update(
    sessionId: string,
    id: string,
    patch: unknown,
    context?: TaskLedgerMutationContext,
  ): Promise<{ updated: Task; total: number }>;
  claim(
    sessionId: string,
    id: string,
    owner: TaskOwner,
    context?: TaskLedgerMutationContext,
  ): Promise<{ updated: Task; total: number }>;
  claimAvailable(
    sessionId: string,
    id: string,
    owner: TaskOwner,
    scope: TaskAvailableClaimScope,
    context?: TaskLedgerMutationContext,
  ): Promise<{ updated: Task; total: number }>;
  settleAgentOutcome(
    sessionId: string,
    id: string,
    outcome: TaskAgentOutcome,
    context?: TaskLedgerMutationContext,
  ): Promise<{ updated: Task; total: number }>;
  subscribe(listener: (event: TaskLedgerChangedEvent) => void): () => void;
}

export interface TaskLedgerListOptions {
  classifyResumeTrust?: boolean;
  status?: TaskStatus;
  includeTerminal?: boolean;
  includeArchived?: boolean;
  now?: number;
}

export interface CreateTaskInput {
  subject: unknown;
  parentId?: unknown;
}

export interface UpdateTaskInput {
  subject?: unknown;
  status?: unknown;
  blockedReason?: unknown;
  failureReason?: unknown;
  completionEvidence?: unknown;
  explicitReopen?: unknown;
}

export type TaskLedgerNormalizeResult<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      reason:
        | 'invalid_subject'
        | 'invalid_status'
        | 'invalid_blocked_reason'
        | 'invalid_failure_reason'
        | 'invalid_completion_evidence'
        | 'invalid_resume_trust'
        | 'invalid_transition'
        | 'empty_patch';
      message: string;
    };

type TaskLedgerNormalizeErrorReason = Extract<
  TaskLedgerNormalizeResult<never>,
  { ok: false }
>['reason'];

export function isTaskStatus(value: unknown): value is TaskStatus {
  return typeof value === 'string' && (TASK_STATUSES as readonly string[]).includes(value);
}

export function isResumeTrust(value: unknown): value is ResumeTrust {
  return (
    typeof value === 'string' && (TASK_RESUME_TRUST_LEVELS as readonly string[]).includes(value)
  );
}

/**
 * Stable-token id contract shared by the runtime tool schema (front-door) and
 * the storage read path. The id is rendered verbatim (see
 * renderSafeTaskLedgerText), so it must not be deformable by any face that has
 * ever rendered it: no angle brackets/slashes/quotes/parens/equals (a past
 * whole-string tag strip would have eaten them; even the fielded renderer
 * emits the id bare), no whitespace (would break the list-line structure), no
 * huge length (would bloat every turn tail), and redaction-stable (a renderer
 * that runs redactSecrets must not turn the id into [redacted] while the store
 * keeps the real id -- a later task_update would miss). The whitelist
 * (alphanumeric plus . _ : -, 1-64 chars) plus redactSecrets(id) === id enforces
 * these constraints without coupling to the UUID format.
 */
export function isSafeTaskId(value: unknown): value is string {
  // Stable token (alphanumeric plus . _ : -, 1-64 chars) AND redaction-stable:
  // the id is rendered verbatim, so a secret-shaped id (ghp_..., sk-..., a
  // 40-char hex, AIza...) must be rejected -- otherwise a renderer that does
  // run redactSecrets would turn it into [redacted] while the store keeps the
  // real id, and a later task_update would miss.
  return (
    typeof value === 'string' &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(value) &&
    redactSecrets(value) === value
  );
}

export function isTaskKey(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= TASK_KEY_MAX_CHARS &&
    /^T[1-9]\d*(?:\.[1-9]\d*)*$/.test(value)
  );
}

export function compareTaskKeys(left: string, right: string): number {
  const a = left.slice(1).split('.').map(Number);
  const b = right.slice(1).split('.').map(Number);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    if (a[index] === undefined) return -1;
    if (b[index] === undefined) return 1;
    if (a[index] !== b[index]) return a[index]! - b[index]!;
  }
  return 0;
}

export function findTaskByRef(tasks: readonly Task[], ref: string): Task | undefined {
  return tasks.find((task) => task.id === ref || task.key === ref);
}

export function normalizeTaskSubject(input: unknown): TaskLedgerNormalizeResult<string> {
  if (typeof input !== 'string') {
    return invalid('invalid_subject', 'Task subject must be a string');
  }
  const subject = input.normalize('NFC').replace(/\s+/g, ' ').trim();
  if (subject.length === 0) {
    return invalid('invalid_subject', 'Task subject cannot be empty');
  }
  if (Array.from(subject).length > TASK_SUBJECT_MAX_CHARS) {
    return invalid(
      'invalid_subject',
      `Task subject must be ${TASK_SUBJECT_MAX_CHARS} characters or fewer`,
    );
  }
  return { ok: true, value: subject };
}

export function normalizeTaskStatus(input: unknown): TaskLedgerNormalizeResult<TaskStatus> {
  if (!isTaskStatus(input)) {
    return invalid('invalid_status', `Task status must be one of ${TASK_STATUSES.join(', ')}`);
  }
  return { ok: true, value: input };
}

export function normalizeResumeTrust(input: unknown): TaskLedgerNormalizeResult<ResumeTrust> {
  if (!isResumeTrust(input)) {
    return invalid(
      'invalid_resume_trust',
      `Task resumeTrust must be one of ${TASK_RESUME_TRUST_LEVELS.join(', ')}`,
    );
  }
  return { ok: true, value: input };
}

export function normalizeTaskEvidenceText(
  input: unknown,
  field: 'blockedReason' | 'failureReason' | 'completionEvidence',
): TaskLedgerNormalizeResult<string> {
  if (typeof input !== 'string') {
    return invalid(evidenceReason(field), `${field} must be a string`);
  }
  const value = input.normalize('NFC').replace(/\s+/g, ' ').trim();
  if (value.length === 0) {
    return invalid(evidenceReason(field), `${field} cannot be empty`);
  }
  if (Array.from(value).length > TASK_EVIDENCE_MAX_CHARS) {
    return invalid(
      evidenceReason(field),
      `${field} must be ${TASK_EVIDENCE_MAX_CHARS} characters or fewer`,
    );
  }
  return { ok: true, value };
}

export function normalizeCreateTaskInput(
  input: unknown,
): TaskLedgerNormalizeResult<{ subject: string; parentId?: string }> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return invalid('invalid_subject', 'Task input must be an object');
  }
  const record = input as CreateTaskInput;
  const subject = normalizeTaskSubject(record.subject);
  if (!subject.ok) return subject;
  if (record.parentId !== undefined && !isSafeTaskId(record.parentId)) {
    return invalid('invalid_subject', 'Task parentId must be a stable task id or key');
  }
  return {
    ok: true,
    value: { subject: subject.value, ...(record.parentId ? { parentId: record.parentId } : {}) },
  };
}

export function normalizeUpdateTaskInput(input: unknown): TaskLedgerNormalizeResult<{
  subject?: string;
  status?: TaskStatus;
  blockedReason?: string;
  failureReason?: string;
  completionEvidence?: string;
  explicitReopen?: boolean;
}> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return invalid('empty_patch', 'Task update must be an object');
  }
  const record = input as UpdateTaskInput;
  const patch: {
    subject?: string;
    status?: TaskStatus;
    blockedReason?: string;
    failureReason?: string;
    completionEvidence?: string;
    explicitReopen?: boolean;
  } = {};
  if (record.subject !== undefined) {
    const subject = normalizeTaskSubject(record.subject);
    if (!subject.ok) return subject;
    patch.subject = subject.value;
  }
  if (record.status !== undefined) {
    const status = normalizeTaskStatus(record.status);
    if (!status.ok) return status;
    patch.status = status.value;
  }
  if (record.blockedReason !== undefined) {
    const blockedReason = normalizeTaskEvidenceText(record.blockedReason, 'blockedReason');
    if (!blockedReason.ok) return blockedReason;
    patch.blockedReason = blockedReason.value;
  }
  if (record.failureReason !== undefined) {
    const failureReason = normalizeTaskEvidenceText(record.failureReason, 'failureReason');
    if (!failureReason.ok) return failureReason;
    patch.failureReason = failureReason.value;
  }
  if (record.completionEvidence !== undefined) {
    const completionEvidence = normalizeTaskEvidenceText(
      record.completionEvidence,
      'completionEvidence',
    );
    if (!completionEvidence.ok) return completionEvidence;
    patch.completionEvidence = completionEvidence.value;
  }
  if (record.explicitReopen !== undefined) {
    patch.explicitReopen = record.explicitReopen === true;
  }
  if (
    patch.subject === undefined &&
    patch.status === undefined &&
    patch.blockedReason === undefined &&
    patch.failureReason === undefined &&
    patch.completionEvidence === undefined &&
    patch.explicitReopen === undefined
  ) {
    return invalid('empty_patch', 'Task update must change at least one field');
  }
  return { ok: true, value: patch };
}

export interface TaskStatusTransitionOptions {
  explicitReopen?: boolean;
}

export function canTransitionTaskStatus(
  from: TaskStatus,
  to: TaskStatus,
  options: TaskStatusTransitionOptions = {},
): boolean {
  if (from === to) return true;
  switch (from) {
    case 'pending':
      return to === 'in_progress' || to === 'cancelled';
    case 'in_progress':
      return to === 'blocked' || to === 'completed' || to === 'failed' || to === 'cancelled';
    case 'blocked':
      return to === 'in_progress' || to === 'cancelled' || to === 'failed';
    case 'failed':
      return to === 'pending' || to === 'cancelled';
    case 'completed':
      return options.explicitReopen === true && to === 'in_progress';
    case 'cancelled':
      return options.explicitReopen === true && to === 'pending';
  }
}

export function validateTaskEvidence(
  task: Pick<Task, 'status' | 'blockedReason' | 'failureReason' | 'completionEvidence'>,
): TaskLedgerNormalizeResult<void> {
  if (task.status === 'blocked' && !task.blockedReason) {
    return invalid('invalid_blocked_reason', 'Blocked tasks require blockedReason');
  }
  if (task.status === 'failed' && !task.failureReason) {
    return invalid('invalid_failure_reason', 'Failed tasks require failureReason');
  }
  if (task.status === 'completed' && !task.completionEvidence) {
    return invalid('invalid_completion_evidence', 'Completed tasks require completionEvidence');
  }
  return { ok: true, value: undefined };
}

export interface ValidateTaskUpdateOptions extends TaskStatusTransitionOptions {}

export function validateTaskUpdate(
  previousTask: Task,
  input: unknown,
  options: ValidateTaskUpdateOptions = {},
): TaskLedgerNormalizeResult<{
  subject?: string;
  status?: TaskStatus;
  blockedReason?: string;
  failureReason?: string;
  completionEvidence?: string;
  explicitReopen?: boolean;
}> {
  const normalized = normalizeUpdateTaskInput(input);
  if (!normalized.ok) return normalized;
  const { explicitReopen: patchExplicitReopen, ...taskPatch } = normalized.value;
  const nextTask: Task = {
    ...previousTask,
    ...taskPatch,
  };
  const explicitReopen = options.explicitReopen === true || patchExplicitReopen === true;
  if (
    normalized.value.status !== undefined &&
    !canTransitionTaskStatus(previousTask.status, normalized.value.status, {
      ...options,
      explicitReopen,
    })
  ) {
    const recovery =
      previousTask.status === 'pending' && normalized.value.status === 'completed'
        ? '. Call task_update with status "in_progress" first, then call task_update with status "completed" and completionEvidence.'
        : '';
    return invalid(
      'invalid_transition',
      `Invalid task status transition from ${previousTask.status} to ${normalized.value.status}${recovery}`,
    );
  }
  const evidence = validateTaskEvidence(nextTask);
  if (!evidence.ok) return evidence;
  return normalized;
}

export interface TaskResumeTrustRefs {
  corruptLedger?: boolean;
  missingReferences?: boolean;
  interrupted?: boolean;
  repaired?: boolean;
  needsRevalidation?: boolean;
}

export function classifyTaskResumeTrust(
  task: Pick<Task, 'status' | 'blockedReason' | 'failureReason' | 'completionEvidence'>,
  refs: TaskResumeTrustRefs = {},
): ResumeTrust {
  if (refs.corruptLedger || refs.missingReferences) return 'untrusted';
  if (refs.repaired) return 'repaired';
  if (refs.interrupted || task.status === 'in_progress') return 'stale';
  if (refs.needsRevalidation) return 'needs_revalidation';
  if (!validateTaskEvidence(task).ok) return 'needs_revalidation';
  return 'trusted';
}

export const TASK_LEDGER_EVENT_TYPES = [
  'task_created',
  'task_updated',
  'task_started',
  'task_blocked',
  'task_completed',
  'task_failed',
  'task_cancelled',
  'task_reopened',
  'task_resume_classified',
  'task_repaired',
  'task_imported',
] as const;
export type TaskLedgerEventType = (typeof TASK_LEDGER_EVENT_TYPES)[number];

export interface TaskLedgerEventRefs {
  runId?: string;
  turnId?: string;
  toolCallId?: string;
}

/** Persisted snapshots from before task-ledger v2 legitimately lack these fields. */
export type TaskLedgerEventTaskSnapshot = Omit<Task, 'key'> & {
  key?: string;
};

export interface TaskLedgerEvent {
  eventId: string;
  type: TaskLedgerEventType;
  ts: number;
  sessionId: string;
  taskId: string;
  previousStatus?: TaskStatus;
  nextStatus: TaskStatus;
  task: TaskLedgerEventTaskSnapshot;
  reason?: string;
  evidence?: string;
  refs?: TaskLedgerEventRefs;
  source?: TaskLedgerMutationContext['source'];
  actor?: TaskLedgerMutationContext['actor'];
}

export interface TaskLedgerProjection {
  tasks: Task[];
  diagnostics: string[];
  backfilledTaskIds: string[];
}

export function taskLedgerEventTypeForCreate(task: Task): TaskLedgerEventType {
  return taskLedgerEventTypeForStatus(task.status, true);
}

export function taskLedgerEventTypeForUpdate(previous: Task, next: Task): TaskLedgerEventType {
  if (previous.status === next.status) return 'task_updated';
  if (
    (previous.status === 'completed' && next.status === 'in_progress') ||
    (previous.status === 'cancelled' && next.status === 'pending') ||
    (previous.status === 'failed' && next.status === 'pending')
  ) {
    return 'task_reopened';
  }
  return taskLedgerEventTypeForStatus(next.status, false);
}

export function projectTaskLedgerEvents(events: readonly TaskLedgerEvent[]): TaskLedgerProjection {
  const tasks = new Map<string, TaskLedgerEventTaskSnapshot>();
  const firstSeen = new Map<string, number>();
  const diagnostics: string[] = [];
  for (let eventIndex = 0; eventIndex < events.length; eventIndex += 1) {
    const event = events[eventIndex]!;
    if (!isTaskLedgerEvent(event)) {
      diagnostics.push('invalid task ledger event shape');
      continue;
    }
    const current = tasks.get(event.taskId);
    const typeDiagnostic = validateTaskLedgerEventType(event, current);
    if (typeDiagnostic) diagnostics.push(typeDiagnostic);
    if (event.type === 'task_created' || event.type === 'task_imported') {
      if (current) diagnostics.push(`duplicate ${event.type} for ${event.taskId}`);
      if (!firstSeen.has(event.taskId)) firstSeen.set(event.taskId, eventIndex);
      tasks.set(event.taskId, { ...event.task });
      continue;
    }
    if (!current) {
      diagnostics.push(`task event ${event.type} references unknown task ${event.taskId}`);
      if (!firstSeen.has(event.taskId)) firstSeen.set(event.taskId, eventIndex);
      tasks.set(event.taskId, { ...event.task });
      continue;
    }
    if (event.previousStatus !== undefined && current.status !== event.previousStatus) {
      diagnostics.push(
        `task event ${event.type} for ${event.taskId} expected previous status ${event.previousStatus} but saw ${current.status}`,
      );
    }
    if (
      !canTransitionTaskStatus(current.status, event.nextStatus, {
        explicitReopen: event.type === 'task_reopened',
      })
    ) {
      diagnostics.push(
        `invalid task transition ${current.status} -> ${event.nextStatus} for ${event.taskId}`,
      );
    }
    tasks.set(event.taskId, { ...event.task });
  }
  const hydrated = hydrateTaskLedger([...tasks.values()], firstSeen, diagnostics);
  return { tasks: hydrated.tasks, diagnostics, backfilledTaskIds: hydrated.backfilledTaskIds };
}

function validateTaskLedgerEventType(
  event: TaskLedgerEvent,
  current: TaskLedgerEventTaskSnapshot | undefined,
): string | undefined {
  switch (event.type) {
    case 'task_created':
      return event.nextStatus === 'pending'
        ? undefined
        : `task_created for ${event.taskId} must create a pending task, saw ${event.nextStatus}`;
    case 'task_updated':
      if (!current) return undefined;
      return current.status === event.nextStatus
        ? undefined
        : `task_updated for ${event.taskId} changed status ${current.status} -> ${event.nextStatus}`;
    case 'task_started':
      return event.nextStatus === 'in_progress'
        ? undefined
        : `task_started for ${event.taskId} must set status in_progress, saw ${event.nextStatus}`;
    case 'task_blocked':
      return event.nextStatus === 'blocked'
        ? undefined
        : `task_blocked for ${event.taskId} must set status blocked, saw ${event.nextStatus}`;
    case 'task_completed':
      return event.nextStatus === 'completed'
        ? undefined
        : `task_completed for ${event.taskId} must set status completed, saw ${event.nextStatus}`;
    case 'task_failed':
      return event.nextStatus === 'failed'
        ? undefined
        : `task_failed for ${event.taskId} must set status failed, saw ${event.nextStatus}`;
    case 'task_cancelled':
      return event.nextStatus === 'cancelled'
        ? undefined
        : `task_cancelled for ${event.taskId} must set status cancelled, saw ${event.nextStatus}`;
    case 'task_reopened':
      if (!current) return undefined;
      return (current.status === 'completed' && event.nextStatus === 'in_progress') ||
        (current.status === 'cancelled' && event.nextStatus === 'pending') ||
        (current.status === 'failed' && event.nextStatus === 'pending')
        ? undefined
        : `task_reopened for ${event.taskId} must reopen completed -> in_progress, cancelled -> pending, or failed -> pending, saw ${current.status} -> ${event.nextStatus}`;
    case 'task_resume_classified':
    case 'task_repaired':
    case 'task_imported':
      return undefined;
  }
}

/**
 * Safe-render the task ledger for any face that persists into history or is
 * re-injected into a prompt (tool results, turn-tail fragment). Two invariants:
 *   - the canonical id is rendered verbatim, and the subject is a safe
 *     (redacted, tag-stripped) rendered payload of what the store holds; and
 *   - the model can unambiguously recover each task's id from what it sees, so
 *     a later task_update hits the right task.
 *
 * Rendering is per-task and fielded, not a free-text bullet: each line is
 * `id=<id> status=<status> subject=<JSON-stringified safe subject>`. The
 * canonical id is a distinct leading field, so a subject cannot smuggle a fake
 * `id=` field or any other id-like span past it -- any id-like text in the subject stays
 * inside the quoted JSON payload. The id is emitted verbatim: it is a
 * redaction-stable stable token validated on write and read, so scrubbing it
 * could only deform it (and break task_update); it must not be redacted or
 * tag-stripped. Each subject is redacted (secrets) and tag-stripped (complete
 * `<task-ledger ...>` / `</task-ledger ...>` tags on a single line, so a
 * model-authored subject cannot open or close the <task-ledger> data envelope)
 * independently -- a subject on one task can never eat or deform text on
 * another task's line. Other angle brackets (e.g. `a < b`) are left intact.
 * Returns '' for an empty ledger.
 */
export function renderSafeTaskLedgerText(tasks: readonly Task[]): string {
  if (tasks.length === 0) return '';
  return tasks
    .map((rawTask) => {
      const task = sanitizeTaskLedgerTask(rawTask);
      const fields = [
        `key=${task.key}`,
        `id=${task.id}`,
        `status=${task.status}`,
        `subject=${JSON.stringify(task.subject)}`,
      ];
      if (task.parentId) fields.push(`parentId=${task.parentId}`);
      if (task.owner) fields.push(`owner=${JSON.stringify(task.owner)}`);
      if (task.blockedReason)
        fields.push(`blockedReason=${JSON.stringify(safeTaskLedgerField(task.blockedReason))}`);
      if (task.failureReason)
        fields.push(`failureReason=${JSON.stringify(safeTaskLedgerField(task.failureReason))}`);
      if (task.completionEvidence)
        fields.push(
          `completionEvidence=${JSON.stringify(safeTaskLedgerField(task.completionEvidence))}`,
        );
      return fields.join(' ');
    })
    .join('\n');
}

/** Safe structured DTO for renderer and diagnostic faces. */
export function sanitizeTaskLedgerTask(task: Task): Task {
  return {
    ...task,
    subject: safeTaskLedgerField(task.subject),
    ...(task.blockedReason ? { blockedReason: safeTaskLedgerField(task.blockedReason) } : {}),
    ...(task.failureReason ? { failureReason: safeTaskLedgerField(task.failureReason) } : {}),
    ...(task.completionEvidence
      ? { completionEvidence: safeTaskLedgerField(task.completionEvidence) }
      : {}),
  };
}

export interface TaskLedgerPromptRender {
  text: string;
  included: Task[];
  omittedCount: number;
}

export function renderTaskLedgerPromptText(
  tasks: readonly Task[],
  maxChars = TASK_LEDGER_PROMPT_MAX_CHARS,
): TaskLedgerPromptRender {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const selected = new Set<string>();
  const addWithAncestors = (task: Task): void => {
    const chain: Task[] = [];
    let current: Task | undefined = task;
    const seen = new Set<string>();
    while (current && !seen.has(current.id)) {
      seen.add(current.id);
      chain.unshift(current);
      current = current.parentId ? byId.get(current.parentId) : undefined;
    }
    for (const item of chain) selected.add(item.id);
  };
  const active = tasks
    .filter((task) => !isTerminalTaskStatus(task.status))
    .sort(compareTaskPromptPriority);
  for (const task of active) addWithAncestors(task);
  const recentTerminal = tasks
    .filter((task) => isTerminalTaskStatus(task.status) && task.status !== 'cancelled')
    .sort(
      (a, b) =>
        (b.endedAt ?? b.updatedAt) - (a.endedAt ?? a.updatedAt) || compareTaskKeys(a.key, b.key),
    )
    .slice(0, TASK_LEDGER_PROMPT_RECENT_TERMINAL);
  for (const task of recentTerminal) addWithAncestors(task);

  const chosen = tasks.filter((task) => selected.has(task.id));
  const ordered = orderTaskTree(chosen);
  const lines: string[] = [];
  const included: Task[] = [];
  const includedIds = new Set<string>();
  for (const task of ordered) {
    if (task.parentId && !includedIds.has(task.parentId)) continue;
    const depth = task.key.split('.').length - 1;
    const fields = [
      `key=${task.key}`,
      `status=${task.status}`,
      `subject=${JSON.stringify(safeTaskLedgerField(task.subject))}`,
    ];
    if (task.blockedReason)
      fields.push(`blockedReason=${JSON.stringify(safeTaskLedgerField(task.blockedReason))}`);
    if (task.failureReason)
      fields.push(`failureReason=${JSON.stringify(safeTaskLedgerField(task.failureReason))}`);
    if (task.completionEvidence)
      fields.push(
        `completionEvidence=${JSON.stringify(safeTaskLedgerField(task.completionEvidence))}`,
      );
    if (task.owner) fields.push(`owner=${JSON.stringify(task.owner)}`);
    const line = `${'  '.repeat(depth)}${fields.join(' ')}`;
    const nextLength = lines.length === 0 ? line.length : lines.join('\n').length + 1 + line.length;
    if (nextLength > maxChars) continue;
    lines.push(line);
    included.push(task);
    includedIds.add(task.id);
  }
  return {
    text: lines.join('\n'),
    included,
    omittedCount: tasks.length - included.length,
  };
}

function compareTaskPromptPriority(left: Task, right: Task): number {
  return (
    taskStatusRank(left.status) - taskStatusRank(right.status) ||
    compareTaskKeys(left.key, right.key)
  );
}

function orderTaskTree(tasks: readonly Task[]): Task[] {
  const byParent = new Map<string | undefined, Task[]>();
  for (const task of tasks) {
    const bucket = byParent.get(task.parentId) ?? [];
    bucket.push(task);
    byParent.set(task.parentId, bucket);
  }
  const branchRanks = new Map<string, number>();
  const branchRank = (task: Task): number => {
    const cached = branchRanks.get(task.id);
    if (cached !== undefined) return cached;
    const rank = Math.min(
      taskStatusRank(task.status),
      ...(byParent.get(task.id) ?? []).map(branchRank),
    );
    branchRanks.set(task.id, rank);
    return rank;
  };
  const out: Task[] = [];
  const visit = (parentId: string | undefined): void => {
    for (const task of (byParent.get(parentId) ?? []).sort(
      (left, right) => branchRank(left) - branchRank(right) || compareTaskKeys(left.key, right.key),
    )) {
      out.push(task);
      visit(task.id);
    }
  };
  visit(undefined);
  return out;
}

function taskStatusRank(status: TaskStatus): number {
  switch (status) {
    case 'in_progress':
      return 0;
    case 'pending':
      return 1;
    case 'blocked':
      return 2;
    case 'completed':
      return 3;
    case 'failed':
      return 4;
    case 'cancelled':
      return 5;
  }
}

export function renderTaskLedgerDebugText(tasks: readonly Task[]): string {
  if (tasks.length === 0) return '';
  return tasks
    .map((task) => {
      const fields = [renderSafeTaskLedgerText([task])];
      if (task.resumeTrust) fields.push(`resumeTrust=${task.resumeTrust}`);
      return fields.join(' ');
    })
    .join('\n');
}

export function filterModelVisibleTaskLedgerTasks(tasks: readonly Task[]): Task[] {
  return tasks.filter((task) => task.resumeTrust !== 'untrusted');
}

export function isTaskLedgerEvent(value: unknown): value is TaskLedgerEvent {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Partial<TaskLedgerEvent>;
  if (
    !isTaskLedgerEventTask(record.task, {
      allowLegacyMissingEvidence: record.type === 'task_imported',
    })
  )
    return false;
  return (
    typeof record.eventId === 'string' &&
    (TASK_LEDGER_EVENT_TYPES as readonly string[]).includes(String(record.type)) &&
    typeof record.ts === 'number' &&
    Number.isFinite(record.ts) &&
    typeof record.sessionId === 'string' &&
    typeof record.taskId === 'string' &&
    record.taskId === record.task.id &&
    isTaskStatus(record.nextStatus) &&
    record.nextStatus === record.task.status &&
    (record.previousStatus === undefined || isTaskStatus(record.previousStatus)) &&
    (record.reason === undefined || typeof record.reason === 'string') &&
    (record.evidence === undefined || typeof record.evidence === 'string') &&
    (record.refs === undefined || isTaskLedgerEventRefs(record.refs)) &&
    (record.source === undefined ||
      record.source === 'tool' ||
      record.source === 'system' ||
      record.source === 'recovery' ||
      record.source === 'import') &&
    (record.actor === undefined ||
      record.actor === 'main_agent' ||
      record.actor === 'child_agent' ||
      record.actor === 'user' ||
      record.actor === 'system')
  );
}

function taskLedgerEventTypeForStatus(status: TaskStatus, create: boolean): TaskLedgerEventType {
  if (create) return 'task_created';
  switch (status) {
    case 'pending':
      return 'task_updated';
    case 'in_progress':
      return 'task_started';
    case 'blocked':
      return 'task_blocked';
    case 'completed':
      return 'task_completed';
    case 'failed':
      return 'task_failed';
    case 'cancelled':
      return 'task_cancelled';
  }
}

function isTaskLedgerEventTask(
  value: unknown,
  options: { allowLegacyMissingEvidence?: boolean } = {},
): value is TaskLedgerEventTaskSnapshot {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const task = value as Partial<Task>;
  if (
    !isSafeTaskId(task.id) ||
    !normalizeTaskSubject(task.subject).ok ||
    !isTaskStatus(task.status) ||
    typeof task.createdAt !== 'number' ||
    !Number.isFinite(task.createdAt) ||
    typeof task.updatedAt !== 'number' ||
    !Number.isFinite(task.updatedAt) ||
    (task.blockedReason !== undefined &&
      !normalizeTaskEvidenceText(task.blockedReason, 'blockedReason').ok) ||
    (task.failureReason !== undefined &&
      !normalizeTaskEvidenceText(task.failureReason, 'failureReason').ok) ||
    (task.completionEvidence !== undefined &&
      !normalizeTaskEvidenceText(task.completionEvidence, 'completionEvidence').ok) ||
    (task.resumeTrust !== undefined && !isResumeTrust(task.resumeTrust)) ||
    (task.key !== undefined && !isTaskKey(task.key)) ||
    (task.parentId !== undefined && !isSafeTaskId(task.parentId)) ||
    (task.owner !== undefined && !isTaskOwner(task.owner)) ||
    (task.endedAt !== undefined &&
      (typeof task.endedAt !== 'number' || !Number.isFinite(task.endedAt)))
  ) {
    return false;
  }
  if (options.allowLegacyMissingEvidence === true) return true;
  return validateTaskEvidence({
    status: task.status,
    blockedReason: task.blockedReason,
    failureReason: task.failureReason,
    completionEvidence: task.completionEvidence,
  }).ok;
}

export function isTaskOwner(value: unknown): value is TaskOwner {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const owner = value as Partial<TaskOwner>;
  return (
    (owner.actor === 'main_agent' || owner.actor === 'child_agent') &&
    (owner.sessionId === undefined || isSafeTaskId(owner.sessionId)) &&
    (owner.agentId === undefined || isSafeTaskId(owner.agentId)) &&
    (owner.runId === undefined || isSafeTaskId(owner.runId)) &&
    (owner.turnId === undefined || isSafeTaskId(owner.turnId))
  );
}

function hydrateTaskLedger(
  snapshots: readonly TaskLedgerEventTaskSnapshot[],
  firstSeen: ReadonlyMap<string, number>,
  diagnostics: string[],
): { tasks: Task[]; backfilledTaskIds: string[] } {
  const byId = new Map(snapshots.map((task) => [task.id, task]));
  const used = new Set<string>();
  const backfilled = new Set<string>();

  for (const task of snapshots) {
    if (!task.key) continue;
    if (used.has(task.key)) diagnostics.push(`duplicate task key ${task.key}`);
    used.add(task.key);
  }
  for (const task of snapshots) {
    if (task.parentId && !byId.has(task.parentId))
      diagnostics.push(`task ${task.id} references missing parent ${task.parentId}`);
    if (task.parentId && task.key) {
      const parent = byId.get(task.parentId);
      if (parent?.key && !isDirectChildTaskKey(parent.key, task.key)) {
        diagnostics.push(
          `task ${task.id} key ${task.key} does not belong under parent key ${parent.key}`,
        );
      }
    } else if (!task.parentId && task.key && task.key.includes('.')) {
      diagnostics.push(`root task ${task.id} cannot use child key ${task.key}`);
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (task: TaskLedgerEventTaskSnapshot): void => {
    if (visited.has(task.id)) return;
    if (visiting.has(task.id)) {
      diagnostics.push(`task hierarchy cycle includes ${task.id}`);
      return;
    }
    visiting.add(task.id);
    if (task.parentId) {
      const parent = byId.get(task.parentId);
      if (parent) visit(parent);
    }
    visiting.delete(task.id);
    visited.add(task.id);
  };
  for (const task of snapshots) visit(task);

  const stable = [...snapshots].sort(
    (a, b) =>
      (firstSeen.get(a.id) ?? Number.MAX_SAFE_INTEGER) -
        (firstSeen.get(b.id) ?? Number.MAX_SAFE_INTEGER) ||
      a.createdAt - b.createdAt ||
      a.id.localeCompare(b.id),
  );
  const children = new Map<string | undefined, TaskLedgerEventTaskSnapshot[]>();
  for (const task of stable) {
    const bucket = children.get(task.parentId) ?? [];
    bucket.push(task);
    children.set(task.parentId, bucket);
  }

  const assign = (parentId: string | undefined, parentKey: string | undefined): void => {
    const siblings = children.get(parentId) ?? [];
    let next = 1;
    for (const task of siblings) {
      if (!task.key) {
        let candidate = parentKey ? `${parentKey}.${next}` : `T${next}`;
        while (used.has(candidate)) {
          next += 1;
          candidate = parentKey ? `${parentKey}.${next}` : `T${next}`;
        }
        task.key = candidate;
        used.add(candidate);
        backfilled.add(task.id);
      }
      if (isTerminalTaskStatus(task.status) && task.endedAt === undefined) {
        task.endedAt = task.updatedAt;
        backfilled.add(task.id);
      }
      const tail = Number(task.key.split('.').at(-1)?.replace(/^T/, ''));
      if (Number.isFinite(tail)) next = Math.max(next, tail + 1);
      assign(task.id, task.key);
    }
  };
  assign(undefined, undefined);

  for (const task of snapshots) {
    if (!task.parentId || !task.key) continue;
    const parent = byId.get(task.parentId);
    if (parent?.key && !isDirectChildTaskKey(parent.key, task.key)) {
      const diagnostic = `task ${task.id} key ${task.key} does not belong under parent key ${parent.key}`;
      if (!diagnostics.includes(diagnostic)) diagnostics.push(diagnostic);
    }
  }

  const tasks = stable.flatMap((task): Task[] => (task.key ? [{ ...task, key: task.key }] : []));
  if (tasks.length !== snapshots.length)
    diagnostics.push('task hierarchy could not assign keys to every task');
  return { tasks, backfilledTaskIds: [...backfilled] };
}

function isDirectChildTaskKey(parentKey: string, childKey: string): boolean {
  return (
    childKey.startsWith(`${parentKey}.`) &&
    childKey.split('.').length === parentKey.split('.').length + 1
  );
}

function isTaskLedgerEventRefs(value: unknown): value is TaskLedgerEventRefs {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const refs = value as Partial<TaskLedgerEventRefs>;
  return (
    (refs.runId === undefined || typeof refs.runId === 'string') &&
    (refs.turnId === undefined || typeof refs.turnId === 'string') &&
    (refs.toolCallId === undefined || typeof refs.toolCallId === 'string')
  );
}

function safeTaskLedgerField(value: string): string {
  return redactSecrets(value).replace(/<\/?task-ledger[^\n>]*>/gi, '');
}

function evidenceReason(
  field: 'blockedReason' | 'failureReason' | 'completionEvidence',
): TaskLedgerNormalizeErrorReason {
  switch (field) {
    case 'blockedReason':
      return 'invalid_blocked_reason';
    case 'failureReason':
      return 'invalid_failure_reason';
    case 'completionEvidence':
      return 'invalid_completion_evidence';
  }
}

function invalid<T extends TaskLedgerNormalizeErrorReason>(
  reason: T,
  message: string,
): Extract<TaskLedgerNormalizeResult<never>, { ok: false }> {
  return { ok: false, reason, message };
}
