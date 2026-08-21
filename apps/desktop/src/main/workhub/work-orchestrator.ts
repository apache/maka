import { randomUUID } from 'node:crypto';
import type { PermissionMode } from '@maka/core/permission';
import type { InteractionAnswer, InteractionRequest } from '@maka/core/interaction';
import type { AttachmentIngestItem } from '@maka/core/events';
import {
  sameWorkHubWork,
  type WorkHubClarificationItem,
  type WorkHubCommand,
  type WorkHubCommandResult,
  type WorkHubCoordinationItem,
  type WorkHubCoordinationNode,
  type WorkHubDiscussionItem,
  type WorkHubEvent,
  type WorkHubItem,
  type WorkHubMetricName,
  type WorkHubMetrics,
  type WorkHubModelSelection,
  type WorkHubRouteConfidence,
  type WorkHubRouteSource,
  type WorkHubSnapshot,
  type WorkHubTargetOption,
  type WorkHubWorkBlock,
  type WorkHubWorkRef,
} from '@maka/core/workhub';
import {
  rememberWorkOutcome,
  rememberWorkRequest,
  rememberRouteCorrection,
  scoreWorkMemory,
} from './workhub-routing-memory.js';

const DEFAULT_CANDIDATE_LIMIT = 8;
const DEFAULT_RECALL_LIMIT = 32;
const DEFAULT_CLARIFICATION_QUESTION = 'Which work should this message target?';
const MAX_COORDINATION_NODES = 8;
const MAX_COORDINATION_EDGES = 64;

export interface WorkHubCandidate extends WorkHubTargetOption {
  permissionMode: PermissionMode;
  searchableText: string;
  updatedAt?: number;
}

export interface WorkHubIntentRouting {
  confidence: WorkHubRouteConfidence;
  source: WorkHubRouteSource;
}

export type WorkHubIntentDisposition = (
  | { kind: 'discussion' }
  | { kind: 'clarify'; candidateIds?: string[]; question?: string }
  | { kind: 'resume_work'; candidateId: string }
  | { kind: 'create_work'; workspaceId: string; title: string }
  | {
      kind: 'coordinate';
      title: string;
      nodes: Array<{ nodeId: string; candidateId: string; instruction: string }>;
      edges: Array<{ fromNodeId: string; toNodeId: string }>;
    }
) & { routing?: WorkHubIntentRouting };

export interface WorkHubIntentResolverInput {
  text: string;
  snapshot: WorkHubSnapshot;
  candidates: WorkHubCandidate[];
  modelSelection?: WorkHubModelSelection;
}

export type WorkHubIntentResolver = (
  input: WorkHubIntentResolverInput,
) => Promise<WorkHubIntentDisposition>;

export type WorkHubTurnOutcome =
  | { status: 'completed'; detail?: string }
  | {
      status: 'waiting_for_user';
      detail?: string;
      interaction?: { interactionId: string; request: InteractionRequest };
    }
  | { status: 'failed'; detail: string }
  | { status: 'stopped'; detail?: string };

/**
 * Internal seam implemented by the current Runtime/Session composition in
 * production and by an in-memory adapter in interface-level tests.
 */
export interface WorkHubHostDirectory {
  listCandidates(query: string, limit: number): Promise<WorkHubCandidate[]>;
  findWork(work: WorkHubWorkRef): Promise<WorkHubCandidate | undefined>;
  createWork(input: {
    workspaceId: string;
    title: string;
    permissionMode: PermissionMode;
    modelSelection?: WorkHubModelSelection;
  }): Promise<WorkHubCandidate>;
  restoreWork(work: WorkHubWorkRef): Promise<void>;
  startTurn(
    work: WorkHubWorkRef,
    text: string,
    onProgress?: (outcome: WorkHubTurnOutcome) => void,
    modelSelection?: WorkHubModelSelection,
    attachmentItems?: readonly AttachmentIngestItem[],
  ): Promise<{ turnId: string; completion: Promise<WorkHubTurnOutcome> }>;
  /** Reattach to a persisted in-flight Turn after the desktop restarts. */
  observeTurn?(
    work: WorkHubWorkRef,
    turnId: string,
    onProgress?: (outcome: WorkHubTurnOutcome) => void,
  ): Promise<WorkHubTurnOutcome>;
  setPermissionMode(work: WorkHubWorkRef, mode: PermissionMode): Promise<void>;
  answerInteraction(
    work: WorkHubWorkRef,
    interactionId: string,
    answer: InteractionAnswer,
  ): Promise<void>;
  stopWork(work: WorkHubWorkRef): Promise<void>;
}

/**
 * Internal persistence seam. P2 supplies the SQLite adapter; tests use a
 * compare-and-swap in-memory adapter so command serialization is observable.
 */
export interface WorkHubStateStore {
  read(): Promise<WorkHubSnapshot>;
  write(expectedRevision: number, snapshot: WorkHubSnapshot): Promise<void>;
  readMetrics(): Promise<WorkHubMetrics>;
  incrementMetric(metric: WorkHubMetricName): Promise<void>;
}

/** The complete caller and test interface of the WorkHub Orchestrator Module. */
export interface WorkHubOrchestrator {
  handle(command: WorkHubCommand): Promise<WorkHubCommandResult>;
  subscribe(listener: (event: WorkHubEvent) => void): () => void;
}

export function createWorkHubOrchestrator(deps: {
  store: WorkHubStateStore;
  hosts: WorkHubHostDirectory;
  resolveIntent?: WorkHubIntentResolver;
  defaultPermissionMode(): Promise<PermissionMode>;
  answerDiscussion?: (input: {
    text: string;
    snapshot: WorkHubSnapshot;
    responseId: string;
    modelSelection?: WorkHubModelSelection;
  }) => Promise<string>;
  now?: () => number;
  createId?: () => string;
  onError?: (error: unknown) => void;
  candidateLimit?: number;
  recallLimit?: number;
}): WorkHubOrchestrator {
  const listeners = new Set<(event: WorkHubEvent) => void>();
  const resolveIntent = deps.resolveIntent ?? (async () => ({ kind: 'discussion' as const }));
  const now = deps.now ?? Date.now;
  const createId = deps.createId ?? randomUUID;
  const candidateLimit = normalizeCandidateLimit(deps.candidateLimit);
  const recallLimit = normalizeRecallLimit(deps.recallLimit, candidateLimit);
  let commandTail: Promise<void> = Promise.resolve();
  let recoveryStarted = false;

  function serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = commandTail.then(operation, operation);
    commandTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async function handle(command: WorkHubCommand): Promise<WorkHubCommandResult> {
    return serialize(async () => {
      await recoverPersistedActivity();
      switch (command.kind) {
        case 'inspect':
          return { kind: 'snapshot', snapshot: clone(await deps.store.read()) };
        case 'inspect_metrics':
          return { kind: 'metrics', metrics: clone(await deps.store.readMetrics()) };
        case 'record_metric':
          await deps.store.incrementMetric(command.metric);
          return { kind: 'metric_acknowledged', metric: command.metric };
        case 'submit':
          return handleSubmit(command);
        case 'set_permission':
          return handleSetPermission(command.work, command.mode);
        case 'answer_interaction':
          return handleAnswerInteraction(command.work, command.interactionId, command.answer);
        case 'stop_work':
          return handleStopWork(command.work);
        case 'resolve_clarification':
          return handleResolveClarification(
            command.clarificationId,
            command.work,
            command.modelSelection,
          );
        case 'correct_route':
          return handleCorrectRoute(command.blockId, command.work);
        case 'stop_coordination':
          return handleStopCoordination(command.coordinationId);
      }
    });
  }

  async function recoverPersistedActivity(): Promise<void> {
    if (recoveryStarted) return;
    recoveryStarted = true;
    let snapshot = await deps.store.read();
    const reconciled = reconcileLegacyClarificationChoices(snapshot);
    if (reconciled) snapshot = await mutate('command', () => reconciled);

    for (const item of snapshot.items) {
      if (item.kind === 'discussion' && item.role === 'assistant' && item.status === 'running') {
        const user = item.replyToItemId
          ? snapshot.items.find(
              (candidate): candidate is WorkHubDiscussionItem =>
                candidate.kind === 'discussion' && candidate.id === item.replyToItemId,
            )
          : undefined;
        if (user) observeDiscussionAnswer(user, item, snapshot);
        else await updateDiscussion(item.id, { text: 'Interrupted before reply.', status: 'failed' });
        continue;
      }
      if (item.kind !== 'work' || (item.status !== 'running' && item.status !== 'waiting_for_user')) {
        continue;
      }
      if (!item.turnId || !deps.hosts.observeTurn) {
        await projectTurnOutcome(item.id, {
          status: 'failed',
          detail: 'WorkHub could not resume this Turn after restart.',
        });
        continue;
      }
      const completion = deps.hosts.observeTurn(item.work, item.turnId, (outcome) => {
        void serialize(async () => projectTurnOutcome(item.id, outcome))
          .catch((error) => deps.onError?.(error));
      });
      observeTurnOutcome(item.id, completion);
    }
    const recovered = await deps.store.read();
    for (const item of recovered.items) {
      if (item.kind === 'coordination' && !isTerminalCoordination(item.status)) {
        await advanceCoordination(item.id);
      }
    }
  }

  async function handleSubmit(
    command: Extract<WorkHubCommand, { kind: 'submit' }>,
  ): Promise<WorkHubCommandResult> {
    const requestId = requireNonEmpty(command.requestId, 'requestId');
    const text = requireNonEmpty(command.text, 'text');
    const current = await deps.store.read();
    const existing = current.items.find((item) => item.sourceRequestId === requestId);
    if (existing) return resultForExistingItem(existing);
    await deps.store.incrementMetric('submission');

    if ((command.attachmentItems?.length ?? 0) > 0 && !command.explicitWork) {
      throw new Error('WORKHUB_ATTACHMENTS_REQUIRE_TARGET');
    }

    if (command.explicitWork) {
      const candidate = await deps.hosts.findWork(command.explicitWork);
      if (!candidate) throw new Error('WORKHUB_TARGET_NOT_FOUND');
      return startWork(
        requestId,
        text,
        candidate,
        command.modelSelection,
        { confidence: 'high', source: 'explicit' },
        [],
        command.attachmentItems,
      );
    }

    const candidates = await recallCandidates(text, current);
    let disposition: WorkHubIntentDisposition;
    try {
      disposition = await resolveIntent({
        text,
        snapshot: clone(current),
        candidates: clone(candidates),
        ...(command.modelSelection ? { modelSelection: clone(command.modelSelection) } : {}),
      });
    } catch (error) {
      deps.onError?.(error);
      disposition = candidates.length > 0 ? { kind: 'clarify' } : { kind: 'discussion' };
    }

    switch (disposition.kind) {
      case 'discussion':
        return startDiscussion(requestId, text, command.modelSelection);
      case 'clarify':
        return appendClarification(requestId, text, candidates, disposition, command.modelSelection);
      case 'resume_work': {
        const candidate = candidates.find(
          (item) => item.candidateId === disposition.candidateId,
        );
        if (!candidate) {
          return candidates.length > 0
            ? appendClarification(
              requestId,
              text,
              candidates,
              { kind: 'clarify' },
              command.modelSelection,
            )
            : startDiscussion(requestId, text, command.modelSelection);
        }
        const routing = disposition.routing ?? { confidence: 'medium', source: 'semantic' };
        if (routing.confidence === 'low') {
          return appendClarification(
            requestId,
            text,
            candidates,
            { kind: 'clarify', routing },
            command.modelSelection,
          );
        }
        return startWork(
          requestId,
          text,
          candidate,
          command.modelSelection,
          routing,
          candidates,
        );
      }
      case 'create_work': {
        const title = requireNonEmpty(disposition.title, 'title');
        const permissionMode = await deps.defaultPermissionMode();
        const candidate = await deps.hosts.createWork({
          workspaceId: requireNonEmpty(disposition.workspaceId, 'workspaceId'),
          title,
          permissionMode,
          ...(command.modelSelection ? { modelSelection: command.modelSelection } : {}),
        });
        return startWork(
          requestId,
          text,
          candidate,
          command.modelSelection,
          disposition.routing ?? { confidence: 'high', source: 'new_work' },
        );
      }
      case 'coordinate':
        return startCoordination(
          requestId,
          text,
          disposition,
          candidates,
          command.modelSelection,
        );
    }
  }

  async function recallCandidates(
    text: string,
    snapshot: WorkHubSnapshot,
  ): Promise<WorkHubCandidate[]> {
    const lexical = uniqueCandidates(await deps.hosts.listCandidates(text, recallLimit));
    const memoryMatches = (snapshot.routingMemory?.works ?? [])
      .map((memory) => ({ memory, score: scoreWorkMemory(text, memory) }))
      .filter(({ score }) => score > 0)
      .sort(
        (left, right) =>
          right.score - left.score || right.memory.lastFocusedAt - left.memory.lastFocusedAt,
      )
      .map(({ memory }) => memory.work);
    const priorityRefs = uniqueWorkRefs([
      ...memoryMatches,
      ...(snapshot.workFocus ? [snapshot.workFocus] : []),
      ...(snapshot.routingMemory?.recentFocus ?? []),
    ]).slice(0, candidateLimit);
    const missingRefs = priorityRefs.filter((work) =>
      !lexical.some((candidate) => sameWorkHubWork(candidate.work, work)),
    );
    const recovered = (await Promise.all(
      missingRefs.map((work) => deps.hosts.findWork(work)),
    )).filter((candidate): candidate is WorkHubCandidate => candidate !== undefined);
    return uniqueCandidates([...recovered, ...lexical]).slice(0, candidateLimit);
  }

  async function startDiscussion(
    sourceRequestId: string,
    text: string,
    modelSelection?: WorkHubModelSelection,
  ): Promise<WorkHubCommandResult> {
    const user: WorkHubDiscussionItem = {
      kind: 'discussion',
      id: createId(),
      sourceRequestId,
      role: 'user',
      text,
      status: 'completed',
      createdAt: now(),
    };
    const assistant: WorkHubDiscussionItem = {
      kind: 'discussion',
      id: createId(),
      sourceRequestId: `${sourceRequestId}:assistant`,
      role: 'assistant',
      text: '',
      status: 'running',
      replyToItemId: user.id,
      createdAt: now(),
    };
    const snapshot = await mutate('command', (current) => ({
      ...current,
      items: [...current.items, user, assistant],
    }));
    observeDiscussionAnswer(user, assistant, snapshot, modelSelection);
    return { kind: 'discussion', item: clone(user) };
  }

  function observeDiscussionAnswer(
    user: WorkHubDiscussionItem,
    assistant: WorkHubDiscussionItem,
    snapshot: WorkHubSnapshot,
    modelSelection?: WorkHubModelSelection,
  ): void {
    const answer = deps.answerDiscussion
      ? deps.answerDiscussion({
        text: user.text,
        snapshot: clone(snapshot),
        responseId: assistant.id,
        ...(modelSelection ? { modelSelection: clone(modelSelection) } : {}),
      })
      : Promise.resolve('I will keep this as a discussion until you give me a concrete goal.');
    void answer.then(
      (text) =>
        serialize(async () => {
          await updateDiscussion(assistant.id, {
            text: requireNonEmpty(text, 'discussion_answer'),
            status: 'completed',
          });
        }),
      (error) =>
        serialize(async () => {
          deps.onError?.(error);
          await updateDiscussion(assistant.id, {
            text: errorMessage(error),
            status: 'failed',
          });
        }),
    ).catch((error) => deps.onError?.(error));
  }

  async function appendClarification(
    sourceRequestId: string,
    text: string,
    candidates: WorkHubCandidate[],
    disposition: Extract<WorkHubIntentDisposition, { kind: 'clarify' }>,
    modelSelection?: WorkHubModelSelection,
  ): Promise<WorkHubCommandResult> {
    const requestedIds = disposition.candidateIds
      ? new Set(disposition.candidateIds)
      : undefined;
    const options = candidates
      .filter((candidate) => !requestedIds || requestedIds.has(candidate.candidateId))
      .map(toTargetOption);
    if (options.length === 0) return startDiscussion(sourceRequestId, text, modelSelection);

    const item: WorkHubClarificationItem = {
      kind: 'clarification',
      id: createId(),
      sourceRequestId,
      text,
      question: disposition.question?.trim() || DEFAULT_CLARIFICATION_QUESTION,
      options,
      routing: disposition.routing ?? { confidence: 'low', source: 'semantic' },
      createdAt: now(),
    };
    await appendItem(item);
    await deps.store.incrementMetric('clarification');
    return { kind: 'clarification', item: clone(item) };
  }

  async function startWork(
    sourceRequestId: string,
    text: string,
    candidate: WorkHubCandidate,
    modelSelection?: WorkHubModelSelection,
    routing: WorkHubIntentRouting = { confidence: 'medium', source: 'semantic' },
    candidates: readonly WorkHubCandidate[] = [],
    attachmentItems?: readonly AttachmentIngestItem[],
  ): Promise<WorkHubCommandResult> {
    const current = await deps.store.read();
    const waiting = [...current.items].reverse().find(
      (item): item is WorkHubWorkBlock =>
        item.kind === 'work' &&
        item.status === 'waiting_for_user' &&
        sameWorkHubWork(item.work, candidate.work),
    );
    if (waiting) return { kind: 'work_waiting', block: clone(waiting) };
    if (candidate.archived) await deps.hosts.restoreWork(candidate.work);
    const createdAt = now();
    const block: WorkHubWorkBlock = {
      kind: 'work',
      id: createId(),
      sourceRequestId,
      work: clone(candidate.work),
      projectName: candidate.projectName,
      workName: candidate.workName,
      requestText: text,
      permissionMode: candidate.permissionMode,
      status: 'running',
      routing: {
        ...routing,
        alternatives: candidates
          .filter((alternative) => alternative.candidateId !== candidate.candidateId)
          .slice(0, 3)
          .map(toTargetOption),
      },
      createdAt,
      updatedAt: createdAt,
    };
    await mutate('command', (snapshot) => ({
      ...snapshot,
      items: [...snapshot.items, block],
      workFocus: clone(candidate.work),
      routingMemory: rememberWorkRequest(snapshot.routingMemory, candidate, text, createdAt),
    }));

    try {
      const admission = await deps.hosts.startTurn(
        candidate.work,
        text,
        (outcome) => {
          void serialize(async () => {
            await projectTurnOutcome(block.id, outcome);
          }).catch((error) => deps.onError?.(error));
        },
        modelSelection,
        attachmentItems,
      );
      const admitted = await updateBlock(block.id, {
        turnId: requireNonEmpty(admission.turnId, 'turnId'),
        updatedAt: now(),
      });
      observeTurnOutcome(block.id, admission.completion);
      return { kind: 'work', block: admitted };
    } catch (error) {
      deps.onError?.(error);
      const failed = await updateBlock(block.id, {
        status: 'failed',
        detail: errorMessage(error),
        updatedAt: now(),
      });
      return { kind: 'work', block: failed };
    }
  }

  async function handleResolveClarification(
    clarificationId: string,
    targetWork: WorkHubWorkRef,
    modelSelection?: WorkHubModelSelection,
  ): Promise<WorkHubCommandResult> {
    const id = requireNonEmpty(clarificationId, 'clarificationId');
    const current = await deps.store.read();
    const clarification = current.items.find(
      (item): item is WorkHubClarificationItem => item.kind === 'clarification' && item.id === id,
    );
    if (!clarification) throw new Error('WORKHUB_CLARIFICATION_NOT_FOUND');
    const resolutionRequestId = `${clarification.sourceRequestId}:clarification:${clarification.id}`;
    const existing = current.items.find(
      (item): item is WorkHubWorkBlock =>
        item.kind === 'work' && item.sourceRequestId === resolutionRequestId,
    ) ?? findLegacyClarificationResult(current, clarification);
    if (clarification.resolvedTo && !sameWorkHubWork(clarification.resolvedTo, targetWork)) {
      throw new Error('WORKHUB_CLARIFICATION_ALREADY_RESOLVED');
    }
    const option = clarification.options.find((candidate) =>
      sameWorkHubWork(candidate.work, targetWork));
    if (!option) throw new Error('WORKHUB_CLARIFICATION_TARGET_NOT_ALLOWED');
    const candidate = await deps.hosts.findWork(targetWork);
    if (!candidate) throw new Error('WORKHUB_TARGET_NOT_FOUND');

    const markResolved = async () => {
      if (clarification.resolvedTo) return;
      const resolvedAt = now();
      await mutate('command', (snapshot) => ({
        ...snapshot,
        items: snapshot.items.map((item) => item.kind === 'clarification' && item.id === id
          ? { ...item, resolvedTo: clone(targetWork), resolvedAt }
          : item),
      }));
    };
    if (existing) {
      await markResolved();
      return { kind: 'work', block: clone(existing) };
    }
    const result = await startWork(
      resolutionRequestId,
      clarification.text,
      candidate,
      modelSelection,
      { confidence: 'high', source: 'explicit' },
    );
    // A waiting Work did not accept this request, so keep the clarification
    // actionable. The user can resolve the pending interaction and try again.
    if (result.kind === 'work_waiting') return result;
    await markResolved();
    return result;
  }

  async function handleCorrectRoute(
    blockId: string,
    targetWork: WorkHubWorkRef,
  ): Promise<WorkHubCommandResult> {
    const current = await deps.store.read();
    const block = current.items.find(
      (item): item is WorkHubWorkBlock => item.kind === 'work' && item.id === blockId,
    );
    if (!block) throw new Error('WORKHUB_BLOCK_NOT_FOUND');
    if (sameWorkHubWork(block.work, targetWork)) return { kind: 'work', block: clone(block) };
    const allowed = block.routing?.alternatives.some((option) => sameWorkHubWork(option.work, targetWork));
    if (!allowed) throw new Error('WORKHUB_CORRECTION_TARGET_NOT_ALLOWED');
    const candidate = await deps.hosts.findWork(targetWork);
    if (!candidate) throw new Error('WORKHUB_TARGET_NOT_FOUND');

    const active = block.status === 'running' || block.status === 'waiting_for_user';
    if (active) await deps.hosts.stopWork(block.work);
    const correctedAt = now();
    await mutate('command', (snapshot) => ({
      ...snapshot,
      items: snapshot.items.map((item) => item.kind === 'work' && item.id === block.id
        ? {
            ...item,
            ...(active ? { status: 'stopped' as const, interaction: undefined } : {}),
            routing: {
              ...(item.routing ?? { confidence: 'medium' as const, source: 'semantic' as const, alternatives: [] }),
              correctedTo: clone(targetWork),
              correctedAt,
            },
            updatedAt: correctedAt,
          }
        : item),
      routingMemory: rememberRouteCorrection(snapshot.routingMemory, {
        query: block.requestText,
        from: clone(block.work),
        to: clone(targetWork),
        correctedAt,
      }),
    }));

    return startWork(
      `${block.sourceRequestId}:correction:${createId()}`,
      block.requestText,
      candidate,
      undefined,
      { confidence: 'high', source: 'correction' },
    );
  }

  async function startCoordination(
    sourceRequestId: string,
    requestText: string,
    disposition: Extract<WorkHubIntentDisposition, { kind: 'coordinate' }>,
    candidates: WorkHubCandidate[],
    modelSelection?: WorkHubModelSelection,
  ): Promise<WorkHubCommandResult> {
    const candidateById = new Map(candidates.map((candidate) => [candidate.candidateId, candidate]));
    const plan = validateCoordinationPlan(disposition, candidateById);
    if (!plan) {
      return appendClarification(sourceRequestId, requestText, candidates, {
        kind: 'clarify',
        question: 'I could not safely determine the dependency order. Which Work should I start with?',
      });
    }
    const createdAt = now();
    const coordination: WorkHubCoordinationItem = {
      kind: 'coordination',
      id: createId(),
      sourceRequestId,
      title: plan.title,
      status: 'active',
      nodes: plan.nodes.map(({ nodeId, candidate, instruction }) => ({
        nodeId,
        work: clone(candidate.work),
        projectName: candidate.projectName,
        workName: candidate.workName,
        instruction,
        status: 'pending',
      })),
      edges: plan.edges.map((edge) => ({ edgeId: createId(), ...edge })),
      ...(modelSelection ? { modelSelection: clone(modelSelection) } : {}),
      createdAt,
      updatedAt: createdAt,
    };
    await appendItem(coordination);
    await advanceCoordination(coordination.id);
    const current = await deps.store.read();
    const updated = findCoordination(current, coordination.id);
    return { kind: 'coordination', coordination: clone(updated) };
  }

  async function advanceCoordination(coordinationId: string): Promise<void> {
    for (;;) {
      const snapshot = await deps.store.read();
      const coordination = findCoordination(snapshot, coordinationId);
      if (isTerminalCoordination(coordination.status)) return;

      const failedPredecessors = new Set(
        coordination.nodes
          .filter((node) => node.status === 'failed' || node.status === 'stopped' || node.status === 'blocked')
          .map((node) => node.nodeId),
      );
      const blockedIds = coordination.nodes
        .filter((node) => node.status === 'pending')
        .filter((node) => coordination.edges.some(
          (edge) => edge.toNodeId === node.nodeId && failedPredecessors.has(edge.fromNodeId),
        ))
        .map((node) => node.nodeId);
      if (blockedIds.length > 0) {
        const blocked = new Set(blockedIds);
        await updateCoordination(coordinationId, (current) => ({
          ...current,
          nodes: current.nodes.map((node) => blocked.has(node.nodeId)
            ? { ...node, status: 'blocked' as const, detail: 'Blocked by an unsuccessful dependency.' }
            : node),
          updatedAt: now(),
        }), 'turn_outcome');
        continue;
      }

      const completed = new Set(
        coordination.nodes.filter((node) => node.status === 'completed').map((node) => node.nodeId),
      );
      const runnable = coordination.nodes
        .filter((node) => node.status === 'pending')
        .filter((node) => coordination.edges
          .filter((edge) => edge.toNodeId === node.nodeId)
          .every((edge) => completed.has(edge.fromNodeId)));
      if (runnable.length === 0) {
        const derived = deriveCoordinationStatus(coordination.nodes);
        if (derived !== coordination.status) {
          await updateCoordination(coordinationId, (current) => ({
            ...current,
            status: deriveCoordinationStatus(current.nodes),
            updatedAt: now(),
          }), 'turn_outcome');
        }
        return;
      }

      const runnableIds = new Set(runnable.map((node) => node.nodeId));
      const launches = runnable.map((node) => {
        const blockId = createId();
        return { node, blockId, createdAt: now() };
      });
      const blockIdByNode = new Map(launches.map(({ node, blockId }) => [node.nodeId, blockId]));
      await mutate('command', (current) => ({
        ...current,
        items: [
          ...current.items.map((item) => {
            if (item.kind !== 'coordination' || item.id !== coordinationId) return item;
            const nodes = item.nodes.map((node) => runnableIds.has(node.nodeId)
              ? { ...node, status: 'running' as const, blockId: blockIdByNode.get(node.nodeId) }
              : node);
            return { ...item, nodes, status: deriveCoordinationStatus(nodes), updatedAt: now() };
          }),
          ...launches.map(({ node, blockId, createdAt }): WorkHubWorkBlock => ({
            kind: 'work',
            id: blockId,
            sourceRequestId: `${coordination.sourceRequestId}:${node.nodeId}`,
            work: clone(node.work),
            projectName: node.projectName,
            workName: node.workName,
            requestText: node.instruction,
            permissionMode: 'ask',
            status: 'running',
            coordination: { coordinationId, nodeId: node.nodeId },
            routing: { confidence: 'high', source: 'coordination', alternatives: [] },
            createdAt,
            updatedAt: createdAt,
          })),
        ],
        workFocus: clone(runnable[0]!.work),
        routingMemory: launches.reduce(
          (memory, { node, createdAt }) => rememberWorkRequest(
            memory,
            node,
            node.instruction,
            createdAt,
          ),
          current.routingMemory,
        ),
      }));

      let launchFailed = false;
      for (const { node, blockId } of launches) {
        try {
          const candidate = await deps.hosts.findWork(node.work);
          if (!candidate) throw new Error('WORKHUB_TARGET_NOT_FOUND');
          if (candidate.archived) await deps.hosts.restoreWork(candidate.work);
          await updateBlock(blockId, { permissionMode: candidate.permissionMode, updatedAt: now() });
          const admission = await deps.hosts.startTurn(
            node.work,
            node.instruction,
            (outcome) => {
              void serialize(async () => projectTurnOutcome(blockId, outcome))
                .catch((error) => deps.onError?.(error));
            },
            coordination.modelSelection,
          );
          await updateBlock(blockId, {
            turnId: requireNonEmpty(admission.turnId, 'turnId'),
            updatedAt: now(),
          });
          observeTurnOutcome(blockId, admission.completion);
        } catch (error) {
          launchFailed = true;
          deps.onError?.(error);
          await projectTurnOutcome(blockId, { status: 'failed', detail: errorMessage(error) });
        }
      }
      if (!launchFailed) return;
    }
  }

  async function handleSetPermission(
    work: WorkHubWorkRef,
    mode: PermissionMode,
  ): Promise<WorkHubCommandResult> {
    await deps.hosts.setPermissionMode(work, mode);
    await mutate('command', (snapshot) => ({
      ...snapshot,
      items: snapshot.items.map((item) =>
        item.kind === 'work' && sameWorkHubWork(item.work, work)
          ? { ...item, permissionMode: mode, updatedAt: now() }
          : item,
      ),
    }));
    return { kind: 'acknowledged', work: clone(work) };
  }

  async function handleStopWork(work: WorkHubWorkRef): Promise<WorkHubCommandResult> {
    await deps.hosts.stopWork(work);
    const affected = new Set<string>();
    await mutate('command', (snapshot) => {
      const stoppedBlockIds = new Set(snapshot.items
        .filter((item): item is WorkHubWorkBlock => item.kind === 'work')
        .filter((item) => sameWorkHubWork(item.work, work))
        .filter((item) => item.status === 'running' || item.status === 'waiting_for_user')
        .map((item) => item.id));
      return {
        ...snapshot,
        items: snapshot.items.map((item) => {
          if (item.kind === 'work' && stoppedBlockIds.has(item.id)) {
            return { ...item, status: 'stopped' as const, interaction: undefined, updatedAt: now() };
          }
          if (item.kind !== 'coordination') return item;
          const nodes = item.nodes.map((node) => node.blockId && stoppedBlockIds.has(node.blockId)
            ? { ...node, status: 'stopped' as const, detail: 'Stopped by the user.' }
            : node);
          if (nodes.some((node, index) => node !== item.nodes[index])) affected.add(item.id);
          return { ...item, nodes, status: deriveCoordinationStatus(nodes), updatedAt: now() };
        }),
      };
    });
    for (const coordinationId of affected) await advanceCoordination(coordinationId);
    return { kind: 'acknowledged', work: clone(work) };
  }

  async function handleStopCoordination(coordinationId: string): Promise<WorkHubCommandResult> {
    const id = requireNonEmpty(coordinationId, 'coordinationId');
    const snapshot = await deps.store.read();
    const coordination = findCoordination(snapshot, id);
    const active = coordination.nodes.filter(
      (node) => node.status === 'running' || node.status === 'waiting_for_user',
    );
    for (const node of active) {
      try {
        await deps.hosts.stopWork(node.work);
      } catch (error) {
        deps.onError?.(error);
      }
    }
    await mutate('command', (current) => ({
      ...current,
      items: current.items.map((item) => {
        if (item.kind === 'coordination' && item.id === id) {
          return {
            ...item,
            status: 'stopped' as const,
            nodes: item.nodes.map((node) =>
              node.status === 'pending' || node.status === 'running' || node.status === 'waiting_for_user'
                ? { ...node, status: 'stopped' as const, detail: 'Coordination stopped by the user.' }
                : node),
            updatedAt: now(),
          };
        }
        if (
          item.kind === 'work' &&
          item.coordination?.coordinationId === id &&
          (item.status === 'running' || item.status === 'waiting_for_user')
        ) {
          return { ...item, status: 'stopped' as const, interaction: undefined, updatedAt: now() };
        }
        return item;
      }),
    }));
    return { kind: 'coordination_acknowledged', coordinationId: id };
  }

  async function handleAnswerInteraction(
    work: WorkHubWorkRef,
    interactionId: string,
    answer: InteractionAnswer,
  ): Promise<WorkHubCommandResult> {
    const current = await deps.store.read();
    const block = [...current.items].reverse().find(
      (item): item is WorkHubWorkBlock =>
        item.kind === 'work' &&
        sameWorkHubWork(item.work, work) &&
        item.interaction?.interactionId === interactionId &&
        item.status === 'waiting_for_user',
    );
    if (!block) throw new Error('WORKHUB_INTERACTION_NOT_PENDING');
    await deps.hosts.answerInteraction(work, interactionId, answer);
    await updateBlock(block.id, {
      status: 'running',
      interaction: undefined,
      detail: undefined,
      updatedAt: now(),
    });
    if (block.coordination) {
      await updateCoordinationNode(block.coordination, {
        status: 'running',
        detail: undefined,
      });
    }
    return { kind: 'acknowledged', work: clone(work) };
  }

  function observeTurnOutcome(blockId: string, completion: Promise<WorkHubTurnOutcome>): void {
    void completion.then(
      (outcome) =>
        serialize(async () => {
          await projectTurnOutcome(blockId, outcome);
        }),
      (error) =>
        serialize(async () => {
          deps.onError?.(error);
          await projectTurnOutcome(blockId, {
            status: 'failed',
            detail: errorMessage(error),
          });
        }),
    ).catch((error) => deps.onError?.(error));
  }

  async function projectTurnOutcome(
    blockId: string,
    outcome: WorkHubTurnOutcome,
  ): Promise<void> {
    const current = await deps.store.read();
    const block = current.items.find(
      (item): item is WorkHubWorkBlock => item.kind === 'work' && item.id === blockId,
    );
    if (!block) throw new Error('WORKHUB_BLOCK_NOT_FOUND');
    if (block.status !== 'running' && block.status !== 'waiting_for_user') return;
    const nextStatus = outcome.status;
    await mutate('turn_outcome', (snapshot) => ({
      ...snapshot,
      routingMemory: rememberWorkOutcome(snapshot.routingMemory, block.work, outcome.detail),
      items: snapshot.items.map((item) => {
        if (item.kind === 'work' && item.id === blockId) {
          return {
            ...item,
            status: nextStatus,
            ...(outcome.detail === undefined ? {} : { detail: outcome.detail }),
            ...(outcome.status === 'waiting_for_user'
              ? { interaction: outcome.interaction }
              : { interaction: undefined }),
            updatedAt: now(),
          };
        }
        if (item.kind !== 'coordination' || item.id !== block.coordination?.coordinationId) {
          return item;
        }
        const nodes = item.nodes.map((node) => node.nodeId === block.coordination?.nodeId
          ? {
              ...node,
              status: nextStatus,
              ...(outcome.detail === undefined ? {} : { detail: outcome.detail }),
            }
          : node);
        return { ...item, nodes, status: deriveCoordinationStatus(nodes), updatedAt: now() };
      }),
    }));
    if (block.coordination && outcome.status !== 'waiting_for_user') {
      await advanceCoordination(block.coordination.coordinationId);
    }
  }

  async function appendItem(item: WorkHubItem): Promise<void> {
    await mutate('command', (snapshot) => ({
      ...snapshot,
      items: [...snapshot.items, item],
    }));
  }

  async function updateDiscussion(
    itemId: string,
    patch: Pick<WorkHubDiscussionItem, 'status' | 'text'>,
  ): Promise<void> {
    await mutate('discussion_outcome', (snapshot) => ({
      ...snapshot,
      items: snapshot.items.map((item) =>
        item.kind === 'discussion' && item.id === itemId ? { ...item, ...patch } : item,
      ),
    }));
  }

  async function updateBlock(
    blockId: string,
    patch: Partial<Omit<WorkHubWorkBlock, 'kind' | 'id' | 'sourceRequestId'>>,
    reason: WorkHubEvent['reason'] = 'command',
  ): Promise<WorkHubWorkBlock> {
    const next = await mutate(reason, (snapshot) => ({
      ...snapshot,
      items: snapshot.items.map((item) => {
        if (item.kind !== 'work' || item.id !== blockId) return item;
        return {
          ...item,
          ...patch,
          kind: 'work' as const,
          id: item.id,
          sourceRequestId: item.sourceRequestId,
        };
      }),
    }));
    const updated = next.items.find(
      (item): item is WorkHubWorkBlock => item.kind === 'work' && item.id === blockId,
    );
    if (!updated) throw new Error('WORKHUB_BLOCK_NOT_FOUND');
    return clone(updated);
  }

  async function updateCoordination(
    coordinationId: string,
    update: (coordination: WorkHubCoordinationItem) => WorkHubCoordinationItem,
    reason: WorkHubEvent['reason'] = 'command',
  ): Promise<WorkHubCoordinationItem> {
    const next = await mutate(reason, (snapshot) => ({
      ...snapshot,
      items: snapshot.items.map((item) =>
        item.kind === 'coordination' && item.id === coordinationId ? update(item) : item),
    }));
    return clone(findCoordination(next, coordinationId));
  }

  async function updateCoordinationNode(
    link: NonNullable<WorkHubWorkBlock['coordination']>,
    patch: Partial<Omit<WorkHubCoordinationNode, 'nodeId' | 'work'>>,
  ): Promise<void> {
    await updateCoordination(link.coordinationId, (coordination) => {
      const nodes = coordination.nodes.map((node) => node.nodeId === link.nodeId
        ? { ...node, ...patch }
        : node);
      return {
        ...coordination,
        nodes,
        status: deriveCoordinationStatus(nodes),
        updatedAt: now(),
      };
    });
  }

  async function mutate(
    reason: WorkHubEvent['reason'],
    update: (snapshot: WorkHubSnapshot) => Omit<WorkHubSnapshot, 'revision'> & { revision?: number },
  ): Promise<WorkHubSnapshot> {
    const current = await deps.store.read();
    const proposed = update(clone(current));
    const next: WorkHubSnapshot = {
      ...proposed,
      revision: current.revision + 1,
    };
    await deps.store.write(current.revision, clone(next));
    emit({ kind: 'snapshot_changed', reason, snapshot: clone(next) });
    return clone(next);
  }

  function emit(event: WorkHubEvent): void {
    for (const listener of listeners) {
      try {
        listener(clone(event));
      } catch (error) {
        deps.onError?.(error);
      }
    }
  }

  return {
    handle,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

function resultForExistingItem(item: WorkHubItem): WorkHubCommandResult {
  switch (item.kind) {
    case 'discussion':
      return { kind: 'discussion', item: clone(item) };
    case 'clarification':
      return { kind: 'clarification', item: clone(item) };
    case 'coordination':
      return { kind: 'coordination', coordination: clone(item) };
    case 'work':
      return { kind: 'work', block: clone(item) };
  }
}

/**
 * Before clarification choices had their own command, the renderer submitted
 * the same text again with a fresh request id. Reconcile only the unambiguous
 * legacy shape: the immediately following item is that same request routed to
 * one of the card's offered Works. Keeping this adjacency requirement avoids
 * treating a later, coincidentally repeated prompt as the original choice.
 */
function reconcileLegacyClarificationChoices(
  snapshot: WorkHubSnapshot,
): WorkHubSnapshot | undefined {
  let changed = false;
  const items = snapshot.items.map((item, index) => {
    if (item.kind !== 'clarification' || item.resolvedTo) return item;
    const next = findLegacyClarificationResult(snapshot, item, index);
    if (!next) return item;
    changed = true;
    return { ...item, resolvedTo: clone(next.work), resolvedAt: next.createdAt };
  });
  return changed ? { ...snapshot, items } : undefined;
}

function findLegacyClarificationResult(
  snapshot: WorkHubSnapshot,
  clarification: WorkHubClarificationItem,
  knownIndex = snapshot.items.findIndex((item) => item.id === clarification.id),
): WorkHubWorkBlock | undefined {
  const next = knownIndex >= 0 ? snapshot.items[knownIndex + 1] : undefined;
  if (
    next?.kind !== 'work' ||
    next.requestText.trim() !== clarification.text.trim() ||
    !clarification.options.some((option) => sameWorkHubWork(option.work, next.work))
  ) return undefined;
  return next;
}

function validateCoordinationPlan(
  disposition: Extract<WorkHubIntentDisposition, { kind: 'coordinate' }>,
  candidateById: ReadonlyMap<string, WorkHubCandidate>,
): {
  title: string;
  nodes: Array<{ nodeId: string; candidate: WorkHubCandidate; instruction: string }>;
  edges: Array<{ fromNodeId: string; toNodeId: string }>;
} | undefined {
  const title = disposition.title.trim().slice(0, 120);
  if (!title || disposition.nodes.length < 2 || disposition.nodes.length > MAX_COORDINATION_NODES) {
    return undefined;
  }
  if (disposition.edges.length > MAX_COORDINATION_EDGES) return undefined;
  const nodeIds = new Set<string>();
  const nodes: Array<{ nodeId: string; candidate: WorkHubCandidate; instruction: string }> = [];
  for (const node of disposition.nodes) {
    const nodeId = node.nodeId.trim();
    const instruction = node.instruction.trim();
    const candidate = candidateById.get(node.candidateId);
    if (!nodeId || nodeId.length > 128 || nodeIds.has(nodeId) || !instruction || !candidate) {
      return undefined;
    }
    nodeIds.add(nodeId);
    nodes.push({ nodeId, candidate, instruction: instruction.slice(0, 128_000) });
  }
  const edgeKeys = new Set<string>();
  const edges: Array<{ fromNodeId: string; toNodeId: string }> = [];
  for (const edge of disposition.edges) {
    const fromNodeId = edge.fromNodeId.trim();
    const toNodeId = edge.toNodeId.trim();
    const key = `${fromNodeId}\u0000${toNodeId}`;
    if (
      !nodeIds.has(fromNodeId) ||
      !nodeIds.has(toNodeId) ||
      fromNodeId === toNodeId ||
      edgeKeys.has(key)
    ) return undefined;
    edgeKeys.add(key);
    edges.push({ fromNodeId, toNodeId });
  }
  if (hasCoordinationCycle(nodeIds, edges)) return undefined;
  return { title, nodes, edges };
}

function hasCoordinationCycle(
  nodeIds: ReadonlySet<string>,
  edges: ReadonlyArray<{ fromNodeId: string; toNodeId: string }>,
): boolean {
  const indegree = new Map([...nodeIds].map((nodeId) => [nodeId, 0]));
  const outgoing = new Map([...nodeIds].map((nodeId) => [nodeId, [] as string[]]));
  for (const edge of edges) {
    indegree.set(edge.toNodeId, (indegree.get(edge.toNodeId) ?? 0) + 1);
    outgoing.get(edge.fromNodeId)?.push(edge.toNodeId);
  }
  const ready = [...indegree].filter(([, degree]) => degree === 0).map(([nodeId]) => nodeId);
  let visited = 0;
  while (ready.length > 0) {
    const nodeId = ready.pop()!;
    visited += 1;
    for (const target of outgoing.get(nodeId) ?? []) {
      const next = (indegree.get(target) ?? 0) - 1;
      indegree.set(target, next);
      if (next === 0) ready.push(target);
    }
  }
  return visited !== nodeIds.size;
}

function deriveCoordinationStatus(
  nodes: readonly WorkHubCoordinationNode[],
): WorkHubCoordinationItem['status'] {
  if (nodes.length > 0 && nodes.every((node) => node.status === 'completed')) return 'completed';
  if (nodes.some((node) => node.status === 'waiting_for_user')) return 'waiting_for_user';
  if (nodes.some((node) => node.status === 'running' || node.status === 'pending')) return 'active';
  if (nodes.some((node) => node.status === 'failed' || node.status === 'blocked')) return 'failed';
  return 'stopped';
}

function isTerminalCoordination(status: WorkHubCoordinationItem['status']): boolean {
  return status === 'completed' || status === 'failed' || status === 'stopped';
}

function findCoordination(
  snapshot: WorkHubSnapshot,
  coordinationId: string,
): WorkHubCoordinationItem {
  const coordination = snapshot.items.find(
    (item): item is WorkHubCoordinationItem =>
      item.kind === 'coordination' && item.id === coordinationId,
  );
  if (!coordination) throw new Error('WORKHUB_COORDINATION_NOT_FOUND');
  return coordination;
}

function uniqueCandidates(candidates: WorkHubCandidate[]): WorkHubCandidate[] {
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const id = requireNonEmpty(candidate.candidateId, 'candidateId');
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

function toTargetOption(candidate: WorkHubCandidate): WorkHubTargetOption {
  return {
    candidateId: candidate.candidateId,
    work: clone(candidate.work),
    projectName: candidate.projectName,
    workName: candidate.workName,
    archived: candidate.archived,
  };
}

function requireNonEmpty(value: string, field: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new TypeError(`WORKHUB_INVALID_${field.toUpperCase()}`);
  return trimmed;
}

function normalizeCandidateLimit(value: number | undefined): number {
  if (value === undefined) return DEFAULT_CANDIDATE_LIMIT;
  if (!Number.isSafeInteger(value) || value < 1 || value > 50) {
    throw new TypeError('WORKHUB_INVALID_CANDIDATE_LIMIT');
  }
  return value;
}

function normalizeRecallLimit(value: number | undefined, candidateLimit: number): number {
  const normalized = value ?? DEFAULT_RECALL_LIMIT;
  if (!Number.isSafeInteger(normalized) || normalized < candidateLimit || normalized > 100) {
    throw new TypeError('WORKHUB_INVALID_RECALL_LIMIT');
  }
  return normalized;
}

function uniqueWorkRefs(works: readonly WorkHubWorkRef[]): WorkHubWorkRef[] {
  const result: WorkHubWorkRef[] = [];
  for (const work of works) {
    if (!result.some((candidate) => sameWorkHubWork(candidate, work))) result.push(clone(work));
  }
  return result;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function clone<T>(value: T): T {
  return structuredClone(value);
}
