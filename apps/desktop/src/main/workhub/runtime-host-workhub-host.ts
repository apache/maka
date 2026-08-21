import { randomUUID } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { basename } from 'node:path';
import type { PermissionMode } from '@maka/core/permission';
import type { AttachmentIngestItem } from '@maka/core/events';
import type { InteractionPendingSnapshot } from '@maka/runtime-host/protocol';
import {
  WORKHUB_INTERNAL_SESSION_LABEL,
  WORKHUB_ROUTER_SESSION_LABEL,
  isWorkHubInternalSession,
  selectWorkHubResultText,
  workHubWorkKey,
  type WorkHubModelSelection,
  type WorkHubSnapshot,
  type WorkHubWorkRef,
} from '@maka/core/workhub';
import type {
  SessionCatalogProjection,
  SessionCreateInput,
  WorkspaceTarget,
} from '@maka/runtime-host/protocol';
import type { DesktopRuntimeHostClient } from '../runtime-host-client.js';
import type {
  RuntimeHostDesktopManager,
  RuntimeHostDesktopTargetState,
} from '../runtime-host-desktop-manager.js';
import type {
  WorkHubCandidate,
  WorkHubHostDirectory,
  WorkHubIntentDisposition,
  WorkHubIntentResolver,
  WorkHubTurnOutcome,
} from './work-orchestrator.js';
import { normalizeGeneratedWorkHubTitle } from './workhub-title.js';
import { resolveAttachmentRefs, type AttachmentIngestFile } from '../attachment-ingest.js';

const TURN_POLL_INTERVAL_MS = 250;
const INTENT_ROUTER_TIMEOUT_MS = 15_000;

type WorkHubInternalSessionClient = Pick<
  DesktopRuntimeHostClient,
  'createSession' | 'updateSessionConfiguration'
>;

export async function createWorkHubInternalSession(
  client: WorkHubInternalSessionClient,
  input: Omit<SessionCreateInput, 'permissionMode'>,
): Promise<SessionCatalogProjection> {
  const created = await client.createSession({ ...input, permissionMode: 'ask' });
  return client.updateSessionConfiguration(created.id, { permissionMode: 'explore' });
}

export function createRuntimeHostWorkHubHost(deps: {
  manager: RuntimeHostDesktopManager;
  resolveCreateWorkspace(workspaceId: string): Promise<WorkspaceTarget>;
  includeFakeSessions?: boolean;
  createId?: () => string;
  resizeImage?: (bytes: Uint8Array) => Promise<Uint8Array>;
}): WorkHubHostDirectory {
  const createId = deps.createId ?? randomUUID;

  return {
    async listCandidates(query, limit) {
      const targets = readyTargets(deps.manager);
      const candidates = (
        await Promise.all(
          targets.map((target) => candidatesForTarget(target, deps.includeFakeSessions === true)),
        )
      ).flat();
      return candidates
        .map((candidate) => ({ candidate, score: recallScore(query, candidate) }))
        .sort(
          (left, right) =>
            right.score - left.score ||
            (right.candidate.updatedAt ?? 0) - (left.candidate.updatedAt ?? 0) ||
            left.candidate.candidateId.localeCompare(right.candidate.candidateId),
        )
        .slice(0, limit)
        .map(({ candidate }) => candidate);
    },

    async findWork(work) {
      const target = targetForWork(deps.manager, work);
      if (!target) return undefined;
      const session = await target.candidate.client.getSession(work.sessionId);
      if (!session || isWorkHubInternalSession(session.labels)) return undefined;
      return candidateForSession(target, session);
    },

    async createWork(input) {
      const target = targetForWorkspace(deps.manager, input.workspaceId);
      if (!target) throw new Error('WORKHUB_WORKSPACE_UNAVAILABLE');
      const session = await target.candidate.client.createSession({
        sessionId: createId(),
        workspace: await deps.resolveCreateWorkspace(input.workspaceId),
        name: input.title,
        modelTarget: workHubModelTarget(input.modelSelection),
        permissionMode: input.permissionMode,
        collaborationMode: 'agent',
        orchestrationMode: 'default',
      });
      return candidateForSession(target, session);
    },

    async restoreWork(work) {
      const target = requireTargetForWork(deps.manager, work);
      await target.candidate.client.setSessionLifecycle(work.sessionId, 'active');
    },

    async startTurn(work, text, onProgress, modelSelection, attachmentItems) {
      const target = requireTargetForWork(deps.manager, work);
      if (modelSelection) {
        await target.candidate.client.updateSessionConfiguration(work.sessionId, {
          modelTarget: workHubModelTarget(modelSelection),
        });
      }
      const attachments = attachmentItems?.length
        ? await resolveAttachmentRefs({
            files: decodeWorkHubAttachmentFiles(attachmentItems),
            resizeImage: deps.resizeImage,
            snapshot: ({ name, mimeType, content }) =>
              target.candidate.client.ingestAttachment({
                sessionId: work.sessionId,
                name,
                mimeType,
                content,
              }),
          })
        : [];
      const turnId = createId();
      const started = await target.candidate.client.startTurn({
        sessionId: work.sessionId,
        turnId,
        content: {
          text,
          ...(attachments.length > 0 ? { attachments } : {}),
        },
      });
      if (started.kind === 'blocked') throw new Error('WORKHUB_TURN_BLOCKED');
      return {
        turnId,
        completion: watchTurn(target.candidate.client, work.sessionId, turnId, onProgress),
      };
    },

    async observeTurn(work, turnId, onProgress) {
      const target = requireTargetForWork(deps.manager, work);
      return watchTurn(target.candidate.client, work.sessionId, turnId, onProgress);
    },

    async setPermissionMode(work, mode) {
      const target = requireTargetForWork(deps.manager, work);
      await target.candidate.client.updateSessionConfiguration(work.sessionId, {
        permissionMode: mode,
      });
    },

    async answerInteraction(work, interactionId, answer) {
      const target = requireTargetForWork(deps.manager, work);
      await target.candidate.client.answerInteraction({
        sessionId: work.sessionId,
        interactionId,
        answer,
      });
    },

    async stopWork(work) {
      const target = requireTargetForWork(deps.manager, work);
      await target.candidate.stopSession(work.sessionId);
    },
  };
}

function decodeWorkHubAttachmentFiles(
  items: readonly AttachmentIngestItem[],
): AttachmentIngestFile[] {
  return items.map((item) => {
    if (!('base64' in item)) {
      throw new Error('WORKHUB_ATTACHMENT_NOT_MATERIALIZED');
    }
    const content = Buffer.from(item.base64, 'base64');
    return {
      name: item.name,
      ...(item.mimeType ? { mimeType: item.mimeType } : {}),
      size: content.byteLength,
      content,
    };
  });
}

export function createRuntimeHostWorkHubDiscussionResponder(deps: {
  manager: RuntimeHostDesktopManager;
  resolveCreateWorkspace(workspaceId: string): Promise<WorkspaceTarget>;
  createId?: () => string;
}): (input: {
  text: string;
  snapshot: WorkHubSnapshot;
  responseId: string;
  modelSelection?: WorkHubModelSelection;
}) => Promise<string> {
  const createId = deps.createId ?? randomUUID;
  let queue = Promise.resolve();
  let sessionRef: WorkHubWorkRef | undefined;

  return (input) => {
    const result = queue.then(async () => {
      let target = sessionRef ? targetForWork(deps.manager, sessionRef) : undefined;
      let session = target && sessionRef
        ? await target.candidate.client.getSession(sessionRef.sessionId)
        : undefined;
      if (!target || !session) {
        target = defaultReadyTarget(deps.manager);
        const existing = (await target.candidate.client.listSessions()).find((candidate) =>
          candidate.labels.includes(WORKHUB_INTERNAL_SESSION_LABEL),
        );
        session = existing ?? await createWorkHubInternalSession(target.candidate.client, {
          sessionId: createId(),
          workspace: await deps.resolveCreateWorkspace(target.candidate.client.hostId),
          name: 'WorkHub',
          labels: [WORKHUB_INTERNAL_SESSION_LABEL],
          modelTarget: workHubModelTarget(input.modelSelection),
          collaborationMode: 'agent',
          orchestrationMode: 'default',
        });
        sessionRef = {
          workspaceId: target.candidate.client.hostId,
          sessionId: session.id,
        };
      }
      if (session.isArchived) {
        await target.candidate.client.setSessionLifecycle(session.id, 'active');
      }
      if (input.modelSelection) {
        session = await target.candidate.client.updateSessionConfiguration(session.id, {
          modelTarget: workHubModelTarget(input.modelSelection),
        });
      }
      const turnId = isProtocolId(input.responseId) ? input.responseId : createId();
      const started = await target.candidate.client.startTurn({
        sessionId: session.id,
        turnId,
        content: { text: input.text },
      });
      if (started.kind === 'blocked') throw new Error('WorkHub Discussion is blocked');
      const outcome = await watchTurn(target.candidate.client, session.id, turnId);
      if (outcome.status !== 'completed') {
        throw new Error(outcome.detail ?? `WorkHub Discussion ${outcome.status}`);
      }
      return outcome.detail ?? '';
    });
    queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
}

/**
 * Hybrid semantic resolver: obvious cases stay local and fast; only a
 * create-vs-resume ambiguity reaches a hidden read-only Session. The parser
 * accepts only candidate ids supplied by code, so model output cannot invent
 * a Session or a Runtime Host.
 */
export function createRuntimeHostWorkHubIntentResolver(deps: {
  manager: RuntimeHostDesktopManager;
  resolveCreateWorkspace(workspaceId: string): Promise<WorkspaceTarget>;
  fallback: WorkHubIntentResolver;
  createId?: () => string;
  intentTimeoutMs?: number;
}): WorkHubIntentResolver {
  const createId = deps.createId ?? randomUUID;
  let queue = Promise.resolve();
  let sessionRef: WorkHubWorkRef | undefined;

  return async (input) => {
    const deterministicCoordination = resolveDeterministicWorkHubCoordination(
      input.text,
      input.candidates,
    );
    if (deterministicCoordination) return deterministicCoordination;
    const fallback = await deps.fallback(input);
    const safeFallback = resolveExplicitUncertaintyFallback(
      input.text,
      input.candidates,
      fallback,
    );
    const coordinationRequested = looksLikeWorkHubCoordination(input.text, input.candidates.length);
    if (
      !coordinationRequested &&
      (fallback.kind === 'resume_work' || fallback.kind === 'discussion')
    ) {
      return safeFallback;
    }
    const result = queue.then(async (): Promise<WorkHubIntentDisposition> => {
      let target = sessionRef ? targetForWork(deps.manager, sessionRef) : undefined;
      let session = target && sessionRef
        ? await target.candidate.client.getSession(sessionRef.sessionId)
        : undefined;
      if (!target || !session) {
        target = defaultReadyTarget(deps.manager);
        const existing = (await target.candidate.client.listSessions()).find((candidate) =>
          candidate.labels.includes(WORKHUB_ROUTER_SESSION_LABEL),
        );
        session = existing ?? await createWorkHubInternalSession(target.candidate.client, {
          sessionId: createId(),
          workspace: await deps.resolveCreateWorkspace(target.candidate.client.hostId),
          name: 'WorkHub Router',
          labels: [WORKHUB_ROUTER_SESSION_LABEL],
          modelTarget: workHubModelTarget(input.modelSelection),
          collaborationMode: 'agent',
          orchestrationMode: 'default',
        });
        sessionRef = { workspaceId: target.candidate.client.hostId, sessionId: session.id };
      }
      if (session.isArchived) {
        await target.candidate.client.setSessionLifecycle(session.id, 'active');
      }
      if (input.modelSelection) {
        session = await target.candidate.client.updateSessionConfiguration(session.id, {
          modelTarget: workHubModelTarget(input.modelSelection),
        });
      }
      const turnId = createId();
      const started = await target.candidate.client.startTurn({
        sessionId: session.id,
        turnId,
        content: { text: intentPrompt(input.text, input.candidates) },
      });
      if (started.kind === 'blocked') return safeFallback;
      const outcome = await watchWorkHubTurnWithTimeout(
        target.candidate.client,
        session.id,
        turnId,
        started.turn.runId,
        deps.intentTimeoutMs ?? INTENT_ROUTER_TIMEOUT_MS,
      );
      if (!outcome) return safeFallback;
      if (outcome.status !== 'completed' || !outcome.detail) return safeFallback;
      const decoded = decodeRuntimeHostWorkHubIntent(
        outcome.detail,
        input.candidates,
        target.candidate.client.hostId,
      );
      return resolveExplicitUncertaintyFallback(
        input.text,
        input.candidates,
        decoded ? withModelRouting(decoded) : safeFallback,
      );
    });
    queue = result.then(() => undefined, () => undefined);
    try {
      return await result;
    } catch {
      return safeFallback;
    }
  };
}

function workHubModelTarget(modelSelection: WorkHubModelSelection | undefined): SessionCreateInput['modelTarget'] {
  return modelSelection
    ? {
        kind: 'explicit',
        connectionSlug: modelSelection.llmConnectionSlug,
        model: modelSelection.model,
      }
    : { kind: 'default' };
}

export function resolveExplicitUncertaintyFallback(
  text: string,
  candidates: readonly WorkHubCandidate[],
  fallback: WorkHubIntentDisposition,
): WorkHubIntentDisposition {
  if (candidates.length < 2 || !looksExplicitlyUncertain(text)) return fallback;
  return {
    kind: 'clarify',
    candidateIds: candidates.slice(0, 5).map((candidate) => candidate.candidateId),
    question: /[\u3400-\u9fff]/u.test(text)
      ? '你指的是哪一项工作？'
      : 'Which work do you mean?',
    routing: { confidence: 'low', source: 'semantic' },
  };
}

function looksExplicitlyUncertain(text: string): boolean {
  return /(?:不确定|不清楚|不知道|不记得).{0,12}(?:哪(?:一|个)?|具体)|(?:which|not sure|uncertain|don['’]?t know).{0,30}(?:work|one)/iu.test(text);
}

export async function watchWorkHubTurnWithTimeout(
  client: DesktopRuntimeHostClient,
  sessionId: string,
  turnId: string,
  runId: string,
  timeoutMs: number,
): Promise<WorkHubTurnOutcome | undefined> {
  const timedOut = Symbol('workhub-intent-timeout');
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const completion = watchTurn(client, sessionId, turnId, undefined, controller.signal);
  const outcome = await Promise.race([
    completion,
    new Promise<typeof timedOut>((resolve) => {
      timeout = setTimeout(() => resolve(timedOut), timeoutMs);
    }),
  ]);
  if (timeout) clearTimeout(timeout);
  if (outcome !== timedOut) return outcome;

  controller.abort();
  void client.stopTurn({ sessionId, turnId, runId }).catch(() => {
    // A terminal Turn may race the timeout; the deterministic fallback remains safe.
  });
  void completion.catch(() => undefined);
  return undefined;
}

function intentPrompt(text: string, candidates: readonly WorkHubCandidate[]): string {
  return [
    'Route the message to one existing Work, coordinate multiple Works, ask the user to choose, or create a new Work.',
    'Return JSON only. Allowed shapes:',
    '{"kind":"resume_work","candidateId":"exact supplied id"}',
    '{"kind":"clarify","candidateIds":["exact supplied ids"]}',
    '{"kind":"create_work","title":"concise descriptive title"}',
    '{"kind":"coordinate","title":"short title","nodes":[{"nodeId":"short unique id","candidateId":"exact supplied id","instruction":"self-contained instruction for this Work"}],"edges":[{"fromNodeId":"node id","toNodeId":"node id"}]}',
    'Never invent a candidate id. Prefer clarify when two candidates remain plausible.',
    'For create_work, summarize the concrete object and goal. Use 6–16 Chinese characters or 3–8 words in the user\'s language. Remove polite filler, implementation steps, and trailing punctuation.',
    'Use coordinate only when the user asks two or more Works to act, especially with an explicit order or dependency. Edges mean the source must complete before the target starts. Independent roots may run in parallel.',
    `Message: ${JSON.stringify(text)}`,
    `Candidates: ${JSON.stringify(candidates.map((candidate) => ({
      candidateId: candidate.candidateId,
      projectName: candidate.projectName,
      workName: candidate.workName,
      archived: candidate.archived,
      searchableText: candidate.searchableText.slice(0, 500),
    })))}`,
  ].join('\n');
}

function withModelRouting(disposition: WorkHubIntentDisposition): WorkHubIntentDisposition {
  if (disposition.kind === 'clarify' || disposition.kind === 'discussion') {
    return { ...disposition, routing: { confidence: 'low', source: 'model' } };
  }
  return { ...disposition, routing: { confidence: 'medium', source: 'model' } };
}

export function decodeRuntimeHostWorkHubIntent(
  text: string,
  candidates: readonly WorkHubCandidate[],
  defaultWorkspaceId: string,
): WorkHubIntentDisposition | undefined {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(text.slice(start, end + 1));
  } catch {
    return undefined;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const allowed = new Set(candidates.map((candidate) => candidate.candidateId));
  if (
    record.kind === 'resume_work' &&
    typeof record.candidateId === 'string' &&
    allowed.has(record.candidateId)
  ) {
    return { kind: 'resume_work', candidateId: record.candidateId };
  }
  if (record.kind === 'clarify' && Array.isArray(record.candidateIds)) {
    const candidateIds = record.candidateIds.filter(
      (candidateId): candidateId is string =>
        typeof candidateId === 'string' && allowed.has(candidateId),
    ).slice(0, 4);
    return candidateIds.length > 0 ? { kind: 'clarify', candidateIds } : undefined;
  }
  if (record.kind === 'create_work' && typeof record.title === 'string' && record.title.trim()) {
    const title = normalizeGeneratedWorkHubTitle(record.title);
    if (!title) return undefined;
    return {
      kind: 'create_work',
      workspaceId: defaultWorkspaceId,
      title,
    };
  }
  if (
    record.kind === 'coordinate' &&
    typeof record.title === 'string' &&
    record.title.trim() &&
    Array.isArray(record.nodes) &&
    Array.isArray(record.edges) &&
    record.nodes.length >= 2 &&
    record.nodes.length <= 8 &&
    record.edges.length <= 64
  ) {
    const nodes: Array<{ nodeId: string; candidateId: string; instruction: string }> = [];
    for (const node of record.nodes) {
      if (!node || typeof node !== 'object' || Array.isArray(node)) return undefined;
      const value = node as Record<string, unknown>;
      if (
        typeof value.nodeId !== 'string' ||
        !value.nodeId.trim() ||
        typeof value.candidateId !== 'string' ||
        !allowed.has(value.candidateId) ||
        typeof value.instruction !== 'string' ||
        !value.instruction.trim()
      ) return undefined;
      nodes.push({
        nodeId: value.nodeId.trim().slice(0, 128),
        candidateId: value.candidateId,
        instruction: value.instruction.trim().slice(0, 128_000),
      });
    }
    const edges: Array<{ fromNodeId: string; toNodeId: string }> = [];
    for (const edge of record.edges) {
      if (!edge || typeof edge !== 'object' || Array.isArray(edge)) return undefined;
      const value = edge as Record<string, unknown>;
      if (typeof value.fromNodeId !== 'string' || typeof value.toNodeId !== 'string') return undefined;
      edges.push({
        fromNodeId: value.fromNodeId.trim().slice(0, 128),
        toNodeId: value.toNodeId.trim().slice(0, 128),
      });
    }
    return {
      kind: 'coordinate',
      title: record.title.trim().slice(0, 120),
      nodes,
      edges,
    };
  }
  return undefined;
}

export function looksLikeWorkHubCoordination(text: string, candidateCount: number): boolean {
  if (candidateCount < 2) return false;
  const normalized = text.toLocaleLowerCase();
  const sequence = /(?:先|首先|然后|接着|再|之后|完成后|依赖|等.+后|after|then|once|before|depends? on|followed by)/u;
  const plurality = /(?:两个|多项|分别|同时|各自|both|multiple|each|across)/u;
  return sequence.test(normalized) || plurality.test(normalized);
}

/**
 * Builds a Graph without model routing only when two or more existing Work
 * names are stated unambiguously. Anything less explicit stays on the semantic
 * router/clarification path.
 */
export function resolveDeterministicWorkHubCoordination(
  text: string,
  candidates: readonly WorkHubCandidate[],
): WorkHubIntentDisposition | undefined {
  if (!looksLikeWorkHubCoordination(text, candidates.length)) return undefined;
  const duplicateNames = new Map<string, number>();
  for (const candidate of candidates) {
    const name = candidate.workName.toLocaleLowerCase();
    duplicateNames.set(name, (duplicateNames.get(name) ?? 0) + 1);
  }
  const matches = candidates.flatMap((candidate) => {
    const qualified = `${candidate.projectName} / ${candidate.workName}`;
    const qualifiedIndex = mentionIndex(text, qualified);
    const workIndex = duplicateNames.get(candidate.workName.toLocaleLowerCase()) === 1
      ? mentionIndex(text, candidate.workName)
      : -1;
    const index = qualifiedIndex >= 0 ? qualifiedIndex : workIndex;
    return index >= 0 ? [{ candidate, index }] : [];
  }).sort((left, right) => left.index - right.index);
  if (matches.length < 2) return undefined;

  const nodes = matches.map(({ candidate }, index) => ({
    nodeId: `step_${index + 1}`,
    candidateId: candidate.candidateId,
    instruction: `In ${candidate.projectName} / ${candidate.workName}, complete the relevant part of this coordinated request: ${text}`,
  }));
  const edges = hasSequenceLanguage(text)
    ? nodes.slice(1).map((node, index) => ({
        fromNodeId: nodes[index]!.nodeId,
        toNodeId: node.nodeId,
      }))
    : [];
  const names = matches.map(({ candidate }) => candidate.workName).join(' → ');
  return {
    kind: 'coordinate',
    title: `Coordinate ${names}`.slice(0, 120),
    nodes,
    edges,
    routing: { confidence: 'high', source: 'coordination' },
  };
}

function hasSequenceLanguage(text: string): boolean {
  return /(?:先|首先|然后|接着|再|之后|完成后|依赖|等.+后|after|then|once|before|depends? on|followed by)/iu.test(
    text,
  );
}

function mentionIndex(text: string, label: string): number {
  const normalizedText = text.toLocaleLowerCase();
  const normalizedLabel = label.trim().toLocaleLowerCase();
  if (!normalizedLabel) return -1;
  if (/^[a-z0-9 _./-]+$/u.test(normalizedLabel)) {
    const escaped = normalizedLabel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = new RegExp(`(^|[^a-z0-9])(${escaped})(?=$|[^a-z0-9])`, 'u').exec(normalizedText);
    return match ? match.index + match[1]!.length : -1;
  }
  return normalizedText.indexOf(normalizedLabel);
}

async function candidatesForTarget(
  target: ReadyTarget,
  includeFakeSessions: boolean,
): Promise<WorkHubCandidate[]> {
  const sessions = await target.candidate.client.listSessions();
  return Promise.all(
    sessions
      .filter((session) => !session.subagent)
      .filter((session) => includeFakeSessions || session.backend !== 'fake')
      .filter((session) => !isWorkHubInternalSession(session.labels))
      .map((session) => candidateForSession(target, session)),
  );
}

async function candidateForSession(
  target: ReadyTarget,
  session: SessionCatalogProjection,
): Promise<WorkHubCandidate> {
  const projectName = await projectNameFor(target, session.workspace.target, session.workspace.hostCwd);
  const work: WorkHubWorkRef = {
    workspaceId: target.candidate.client.hostId,
    sessionId: session.id,
  };
  return {
    candidateId: workHubWorkKey(work),
    work,
    projectName,
    workName: session.name,
    permissionMode: session.permissionMode,
    searchableText: [
      projectName,
      session.name,
      ...session.labels,
      session.lastMessagePreview ?? '',
    ].join(' '),
    archived: session.isArchived,
    updatedAt: session.lastMessageAt ?? session.lastUsedAt,
  };
}

async function projectNameFor(
  target: ReadyTarget,
  workspace: WorkspaceTarget,
  hostCwd: string,
): Promise<string> {
  if (workspace.kind === 'project') {
    const project = (await target.candidate.client.listProjects(false)).find(
      (candidate) => candidate.id === workspace.projectId,
    );
    if (project) return project.name;
  }
  return basename(hostCwd) || target.target.profile.name;
}

async function watchTurn(
  client: DesktopRuntimeHostClient,
  sessionId: string,
  turnId: string,
  onProgress?: (outcome: WorkHubTurnOutcome) => void,
  signal?: AbortSignal,
): Promise<WorkHubTurnOutcome> {
  let reportedInteractionId: string | undefined;
  while (true) {
    if (signal?.aborted) return { status: 'stopped', detail: 'observer_aborted' };
    const turn = await client.queryTurn({ sessionId, turnId });
    if (turn.status === 'completed') {
      return { status: 'completed', detail: await readAssistantText(client, sessionId, turnId) };
    }
    if (turn.status === 'failed') {
      return { status: 'failed', detail: turn.failureMessage ?? turn.failureClass };
    }
    if (turn.status === 'cancelled') {
      return { status: 'stopped', detail: turn.abortSource };
    }
    if (turn.status === 'waiting_for_user') {
      const interaction = await readPendingInteraction(client, sessionId, turnId);
      const nextId = interaction?.interactionId ?? 'waiting';
      if (reportedInteractionId !== nextId) {
        reportedInteractionId = nextId;
        onProgress?.({
          status: 'waiting_for_user',
          ...(interaction ? { interaction } : {}),
        });
      }
    }
    await delay(TURN_POLL_INTERVAL_MS);
  }
}

async function readPendingInteraction(
  client: DesktopRuntimeHostClient,
  sessionId: string,
  turnId: string,
): Promise<Pick<InteractionPendingSnapshot, 'interactionId' | 'request'> | undefined> {
  const session = await client.openSession(sessionId);
  try {
    const pending = session.snapshot.interactions.pending.find(
      (interaction) => interaction.turnId === turnId,
    );
    return pending ? { interactionId: pending.interactionId, request: pending.request } : undefined;
  } finally {
    await session.close();
  }
}

async function readAssistantText(
  client: DesktopRuntimeHostClient,
  sessionId: string,
  turnId: string,
): Promise<string> {
  const session = await client.openSession(sessionId);
  try {
    return selectWorkHubResultText(await session.loadTranscript(), turnId);
  } finally {
    await session.close();
  }
}

type ReadyTarget = Extract<RuntimeHostDesktopTargetState, { readiness: 'ready' }>;

function readyTargets(manager: RuntimeHostDesktopManager): ReadyTarget[] {
  return manager.entries().filter((target): target is ReadyTarget => target.readiness === 'ready');
}

function defaultReadyTarget(manager: RuntimeHostDesktopManager): ReadyTarget {
  const profileId = manager.defaultProfileId();
  const target = readyTargets(manager).find((candidate) => candidate.target.profile.id === profileId);
  if (!target) throw new Error('WORKHUB_DEFAULT_WORKSPACE_UNAVAILABLE');
  return target;
}

function targetForWorkspace(
  manager: RuntimeHostDesktopManager,
  workspaceId: string,
): ReadyTarget | undefined {
  return readyTargets(manager).find((target) => target.candidate.client.hostId === workspaceId);
}

function targetForWork(
  manager: RuntimeHostDesktopManager,
  work: WorkHubWorkRef,
): ReadyTarget | undefined {
  return targetForWorkspace(manager, work.workspaceId);
}

function requireTargetForWork(
  manager: RuntimeHostDesktopManager,
  work: WorkHubWorkRef,
): ReadyTarget {
  const target = targetForWork(manager, work);
  if (!target) throw new Error('WORKHUB_WORKSPACE_UNAVAILABLE');
  return target;
}

function recallScore(query: string, candidate: WorkHubCandidate): number {
  const terms = salientTerms(query);
  const name = candidate.workName.toLocaleLowerCase();
  const project = candidate.projectName.toLocaleLowerCase();
  const text = candidate.searchableText.toLocaleLowerCase();
  return terms.reduce((score, term) => {
    const normalized = term.toLocaleLowerCase();
    return score + (name.includes(normalized) ? 8 : 0) + (project.includes(normalized) ? 4 : 0) +
      (text.includes(normalized) ? 1 : 0);
  }, 0);
}

function salientTerms(text: string): string[] {
  const latin = text.toLocaleLowerCase().match(/[a-z0-9_./-]{3,}/giu) ?? [];
  const chinese = text.match(/[\p{Script=Han}]{2,8}/gu) ?? [];
  return [...new Set([...latin, ...chinese])].slice(0, 32);
}

function isProtocolId(value: string): boolean {
  return /^[A-Za-z0-9_-]{1,128}$/.test(value);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
