import { randomUUID } from 'node:crypto';
import { BROWSER_WORKFLOW_MAX_ACTIONS, isSafeBrowserWorkflowUrl } from '@maka/core/browser-workflow';
import type {
  BrowserWorkflow,
  BrowserWorkflowAction,
  BrowserWorkflowDraft,
  BrowserWorkflowWaitConditionInput,
  BrowserWorkflowProgress,
} from '@maka/core/browser-workflow';
import {
  isBrowserWorkflow,
  isBrowserWorkflowWaitConditionInput,
  validateBrowserWorkflow,
} from '@maka/core/browser-workflow';
import type { IPage } from '@jackwener/opencli/types';
import type { BrowserViewManager } from './view-manager.js';
import type { BrowserViewController } from './controller.js';
import { withBrowserPage, type BrowserPageRun, type TakeoverMode } from './session.js';
import {
  normalizeBrowserRecorderEvent,
  setBrowserWorkflowNavigationRecorder,
  type BrowserWorkflowNavigationSource,
  type BrowserRecorderEvent,
} from './workflow-recorder.js';
import { runBrowserWorkflowAction } from './workflow-runner.js';
import { assertBrowserWorkflowWaitCondition } from './workflow-runner.js';
import type { BrowserWorkflowStore } from '@maka/storage';

export interface BrowserWorkflowServiceDeps {
  store: BrowserWorkflowStore;
  views: BrowserViewManager<BrowserViewController>;
  sendToRenderer(channel: 'browser:workflow-progress', payload: BrowserWorkflowProgress): void;
  runWithPage?: <T>(
    sessionId: string,
    label: string,
    run: BrowserPageRun<T>,
    opts?: { timeoutMs?: number; abort?: AbortSignal; takeover?: TakeoverMode },
  ) => Promise<T>;
}

export interface BrowserWorkflowRecordingHandle {
  recordingId: string;
  sessionId: string;
}

export interface BrowserWorkflowRecordingResult {
  draftId: string;
  actionCount: number;
  sensitiveActionIds: string[];
  actions: BrowserWorkflowAction[];
}

export interface BrowserWorkflowService {
  list(): Promise<BrowserWorkflow[]>;
  startRecording(sessionId: string): Promise<BrowserWorkflowRecordingHandle>;
  stopRecording(sessionId: string): Promise<BrowserWorkflowRecordingResult>;
  addWaitCondition(sessionId: string, input: BrowserWorkflowWaitConditionInput): Promise<string>;
  cancelRecording(sessionId: string): Promise<void>;
  releaseSession(sessionId: string): Promise<void>;
  saveRecording(draftId: string, name: string): Promise<BrowserWorkflow>;
  discardRecording(draftId: string): void;
  run(workflowId: string, sessionId: string, sensitiveValues?: Record<string, string>): Promise<void>;
  cancel(runId: string): void;
  rename(workflowId: string, name: string): Promise<BrowserWorkflow>;
  remove(workflowId: string): Promise<void>;
}

type Recording = {
  recordingId: string;
  sessionId: string;
  startedAt: number;
  actions: BrowserWorkflowAction[];
  seenEventIds: Set<string>;
  lastTypeByLocator: Map<string, RecordedTypeAction>;
  drainQueue: Promise<void>;
  timer: ReturnType<typeof setInterval> | null;
  pendingInteractionUrl?: string;
  pendingInteractionObservedAt?: number;
  pendingInteractionTimer?: ReturnType<typeof setTimeout>;
  pendingInteractionFlush?: Promise<void>;
  pendingInteractionResolve?: () => void;
  failure?: string;
  released?: boolean;
};

type RecordedTypeAction = Extract<BrowserWorkflowAction, { kind: 'type' }> & { updatedAt: number };

type PendingDraft = BrowserWorkflowDraft & { sessionId: string };

type ActiveRun = {
  controller: AbortController;
  sessionId: string;
  settled: Promise<void>;
  settle(): void;
};

export function createBrowserWorkflowService(deps: BrowserWorkflowServiceDeps): BrowserWorkflowService {
  const recordings = new Map<string, Recording>();
  const recordingStarts = new Set<string>();
  const drafts = new Map<string, PendingDraft>();
  const draftIdsBySession = new Map<string, string>();
  const pendingRuns = new Map<string, ActiveRun>();
  const runs = new Map<string, ActiveRun>();
  const recordingTransitions = new Map<string, Promise<void>>();
  const releasingSessions = new Set<string>();
  const sessionReleases = new Map<string, Promise<void>>();
  const runWithPage = deps.runWithPage ?? withBrowserPage;

  const emit = (progress: BrowserWorkflowProgress): void => {
    deps.sendToRenderer('browser:workflow-progress', progress);
  };

  function viewFor(sessionId: string): BrowserViewController {
    return deps.views.getOrCreate(sessionId);
  }

  function discardPendingDraftForSession(sessionId: string): void {
    const draftId = draftIdsBySession.get(sessionId);
    if (!draftId) return;
    drafts.delete(draftId);
    draftIdsBySession.delete(sessionId);
  }

  function assertRecordingCanAcceptAction(recording: Recording): void {
    if (recording.failure) throw new Error(recording.failure);
    if (recording.actions.length >= BROWSER_WORKFLOW_MAX_ACTIONS) {
      throw new Error(`Browser workflow recordings are limited to ${BROWSER_WORKFLOW_MAX_ACTIONS} actions.`);
    }
  }

  function serializeRecordingTransition<T>(sessionId: string, transition: () => Promise<T>): Promise<T> {
    const previous = recordingTransitions.get(sessionId) ?? Promise.resolve();
    const result = previous.catch(() => {}).then(transition);
    const settled = result.then(
      () => undefined,
      () => undefined,
    );
    recordingTransitions.set(sessionId, settled);
    void settled.finally(() => {
      if (recordingTransitions.get(sessionId) === settled) recordingTransitions.delete(sessionId);
    });
    return result;
  }

  function addNavigation(
    recording: Recording,
    url: string,
    source: BrowserWorkflowNavigationSource,
  ): void {
    if (!/^https?:\/\//i.test(url)) return;
    const previous = recording.actions.at(-1);
    if (
      source === 'interaction' &&
      (previous?.kind === 'click' || previous?.kind === 'check' || (previous?.kind === 'type' && previous.submit))
    ) {
      appendAction(
        recording,
        isSafeBrowserWorkflowUrl(url) && isDeterministicInteractionUrl(url)
          ? { id: randomUUID(), kind: 'wait', url, timeoutMs: 30_000 }
          : { id: randomUUID(), kind: 'wait', navigation: true, timeoutMs: 30_000 },
      );
      return;
    }
    if (!isSafeBrowserWorkflowUrl(url)) {
      recording.failure =
        'Browser workflow recordings cannot save URLs containing credentials, query values, sensitive paths, or fragments.';
      return;
    }
    if (previous?.kind === 'navigate' && previous.url === url) return;
    appendAction(recording, { id: randomUUID(), kind: 'navigate', url });
  }

  function isDeterministicInteractionUrl(value: string): boolean {
    try {
      const url = new URL(value);
      if ([...url.searchParams.keys()].length > 0) return false;
      return !url.pathname.split('/').some((segment) =>
        /^\d+$/.test(segment) || /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(segment),
      );
    } catch {
      return false;
    }
  }

  function appendAction(recording: Recording, action: BrowserWorkflowAction): boolean {
    if (recording.actions.length >= BROWSER_WORKFLOW_MAX_ACTIONS) {
      recording.failure = `Browser workflow recordings are limited to ${BROWSER_WORKFLOW_MAX_ACTIONS} actions.`;
      return false;
    }
    recording.actions.push(action);
    emitRecordingProgress(recording);
    return true;
  }

  async function drain(recording: Recording): Promise<void> {
    if (recording.released) return;
    const view = deps.views.get(recording.sessionId);
    if (!view) return;
    const raw = await view.drainWorkflowRecorderEvents();
    for (const value of raw) {
      const event = normalizeBrowserRecorderEvent(value);
      if (event) addEvent(recording, event);
    }
  }

  function queueDrain(recording: Recording): Promise<void> {
    if (recording.released) return Promise.resolve();
    const pendingInteraction = recording.pendingInteractionFlush;
    if (pendingInteraction) {
      return pendingInteraction.then(() => queueDrain(recording));
    }
    const next = recording.drainQueue.then(() => drain(recording));
    recording.drainQueue = next.catch(() => {});
    return next;
  }

  async function queueNavigation(
    sessionId: string,
    url: string,
    source: BrowserWorkflowNavigationSource,
  ): Promise<void> {
    const recording = recordings.get(sessionId);
    if (!recording) return Promise.resolve();
    if (source === 'interaction') {
      recording.pendingInteractionUrl = url;
      recording.pendingInteractionObservedAt = performance.timeOrigin + performance.now();
      if (!recording.pendingInteractionFlush) {
        recording.pendingInteractionFlush = new Promise<void>((resolve) => {
          recording.pendingInteractionResolve = resolve;
          recording.pendingInteractionTimer = setTimeout(() => {
            flushPendingInteraction(recording);
          }, 150);
        });
      }
      return recording.pendingInteractionFlush;
    }
    if (recording.pendingInteractionFlush) await recording.pendingInteractionFlush;
    if (recording.released) return;
    const next = recording.drainQueue.then(async () => {
      await drain(recording);
      addNavigation(recording, url, source);
    });
    recording.drainQueue = next.catch(() => {});
    return next;
  }

  function flushPendingInteraction(recording: Recording): void {
    if (recording.pendingInteractionTimer) clearTimeout(recording.pendingInteractionTimer);
    recording.pendingInteractionTimer = undefined;
    const pendingUrl = recording.pendingInteractionUrl;
    recording.pendingInteractionUrl = undefined;
    recording.pendingInteractionObservedAt = undefined;
    const resolve = recording.pendingInteractionResolve;
    recording.pendingInteractionResolve = undefined;
    recording.pendingInteractionFlush = undefined;
    if (!resolve) return;
    const next = recording.drainQueue.then(() => {
      if (pendingUrl) addNavigation(recording, pendingUrl, 'interaction');
    });
    recording.drainQueue = next.catch(() => {});
    void next.then(resolve, resolve);
  }

  function cancelPendingInteraction(recording: Recording): void {
    if (recording.pendingInteractionTimer) clearTimeout(recording.pendingInteractionTimer);
    recording.pendingInteractionTimer = undefined;
    recording.pendingInteractionUrl = undefined;
    recording.pendingInteractionObservedAt = undefined;
    const resolve = recording.pendingInteractionResolve;
    recording.pendingInteractionResolve = undefined;
    recording.pendingInteractionFlush = undefined;
    resolve?.();
  }

  function queueRecorderEvent(recording: Recording, event: BrowserRecorderEvent): void {
    const canTriggerNavigation = event.kind === 'click' || event.kind === 'check' || event.submit === true;
    const causedPendingNavigation =
      canTriggerNavigation &&
      recording.pendingInteractionFlush !== undefined &&
      recording.pendingInteractionObservedAt !== undefined &&
      event.timestamp <= recording.pendingInteractionObservedAt;
    if (recording.pendingInteractionFlush && !causedPendingNavigation) flushPendingInteraction(recording);
    const next = recording.drainQueue.then(() => addEvent(recording, event));
    recording.drainQueue = next.catch(() => {});
    if (causedPendingNavigation) flushPendingInteraction(recording);
  }

  function addEvent(recording: Recording, event: BrowserRecorderEvent): void {
    if (event.eventId) {
      if (recording.seenEventIds.has(event.eventId)) return;
      recording.seenEventIds.add(event.eventId);
    }
    if (event.kind === 'click') {
      appendAction(recording, { id: randomUUID(), kind: 'click', locator: event.locator });
      return;
    }
    if (event.kind === 'check') {
      appendAction(recording, {
        id: randomUUID(),
        kind: 'check',
        locator: event.locator,
        checked: event.checked === true,
      });
      return;
    }
    const locatorKey = JSON.stringify(event.locator);
    const previous = recording.lastTypeByLocator.get(locatorKey);
    if (previous && recording.actions.at(-1)?.id === previous.id && event.timestamp - previous.updatedAt < 1500) {
      previous.sensitive = previous.sensitive || event.sensitive === true;
      previous.submit = previous.submit || event.submit === true;
      if (previous.sensitive) delete previous.value;
      else previous.value = event.value ?? '';
      previous.updatedAt = event.timestamp;
      emitRecordingProgress(recording);
      return;
    }
    const action: RecordedTypeAction = {
      id: randomUUID(),
      kind: 'type',
      locator: event.locator,
      ...(event.sensitive ? {} : { value: event.value ?? '' }),
      sensitive: event.sensitive === true,
      submit: event.submit === true,
      updatedAt: event.timestamp,
    };
    if (appendAction(recording, action)) recording.lastTypeByLocator.set(locatorKey, action);
  }

  function emitRecordingProgress(recording: Recording): void {
    if (!recordings.has(recording.sessionId)) return;
    emit({
      runId: recording.recordingId,
      workflowId: 'recording',
      sessionId: recording.sessionId,
      status: 'running',
      current: recording.actions.length,
      total: 0,
    });
  }

  async function startRecording(sessionId: string): Promise<BrowserWorkflowRecordingHandle> {
    if (recordings.has(sessionId)) throw new Error('A browser workflow recording is already active for this page.');
    if ([...runs.values()].some((run) => run.sessionId === sessionId)) {
      throw new Error('A browser workflow is running for this page. Wait for it to finish before recording.');
    }
    recordingStarts.add(sessionId);
    try {
      const view = viewFor(sessionId);
      await view.startWorkflowRecorder();
      discardPendingDraftForSession(sessionId);
      const recordingId = randomUUID();
      const startedAt = Date.now();
      const recording: Recording = {
        recordingId,
        sessionId,
        startedAt,
        actions: [],
        seenEventIds: new Set(),
        lastTypeByLocator: new Map(),
        drainQueue: Promise.resolve(),
        timer: null,
      };
      recording.timer = setInterval(() => void queueDrain(recording).catch(() => {}), 100);
      recordings.set(sessionId, recording);
      const url = view.state().url;
      if (/^https?:\/\//i.test(url)) addNavigation(recording, url, 'explicit');
      emit({
        runId: recordingId,
        workflowId: 'recording',
        sessionId,
        status: 'running',
        current: recording.actions.length,
        total: 0,
      });
      return { recordingId, sessionId };
    } finally {
      recordingStarts.delete(sessionId);
    }
  }

  async function stopRecording(sessionId: string): Promise<BrowserWorkflowRecordingResult> {
    const recording = recordings.get(sessionId);
    if (!recording) throw new Error('No browser workflow recording is active for this page.');
    recordings.delete(sessionId);
    if (recording.timer) clearInterval(recording.timer);
    recording.timer = null;
    try {
      if (recording.pendingInteractionTimer) {
        flushPendingInteraction(recording);
      }
      if (recording.pendingInteractionFlush) await recording.pendingInteractionFlush;
      await queueDrain(recording);
    } finally {
      const trailing = (await deps.views.get(sessionId)?.stopWorkflowRecorder().catch(() => [])) ?? [];
      for (const value of trailing) {
        const event = normalizeBrowserRecorderEvent(value);
        if (event) addEvent(recording, event);
      }
    }
    const actions = recording.actions.map((action) => {
      if (action.kind !== 'type') return action;
      const { updatedAt: _updatedAt, ...clean } = action as typeof action & { updatedAt: number };
      if (clean.sensitive) delete clean.value;
      return clean;
    });
    if (recording.failure) {
      emit({
        runId: recording.recordingId,
        workflowId: 'recording',
        sessionId,
        status: 'failed',
        current: actions.length,
        total: actions.length,
        message: recording.failure,
      });
      throw new Error(recording.failure);
    }
    if (actions.length === 0) throw new Error('No browser actions were recorded. Perform a page action and try again.');
    const draftId = randomUUID();
    discardPendingDraftForSession(sessionId);
    draftIdsBySession.set(sessionId, draftId);
    drafts.set(draftId, { sessionId, actions, startedAt: recording.startedAt, endedAt: Date.now() });
    emit({
      runId: recording.recordingId,
      workflowId: 'recording',
      sessionId,
      status: 'completed',
      current: actions.length,
      total: actions.length,
    });
    return {
      draftId,
      actionCount: actions.length,
      sensitiveActionIds: actions.filter((action) => action.kind === 'type' && action.sensitive).map((action) => action.id),
      actions,
    };
  }

  async function addWaitCondition(sessionId: string, input: BrowserWorkflowWaitConditionInput): Promise<string> {
    if (!isBrowserWorkflowWaitConditionInput(input)) throw new Error('Invalid browser workflow wait condition.');
    const recording = recordings.get(sessionId);
    if (!recording) throw new Error('No browser workflow recording is active for this page.');
    assertRecordingCanAcceptAction(recording);
    await queueDrain(recording);
    assertRecordingCanAcceptAction(recording);
    await runWithPage(
      sessionId,
      'validate browser workflow wait condition',
      (page) => assertBrowserWorkflowWaitCondition(page, input),
      { takeover: 'observe', timeoutMs: Math.min(input.timeoutMs, 25_000) },
    );
    const action: BrowserWorkflowAction = {
      id: randomUUID(),
      kind: 'wait',
      ...(input.kind === 'selector' ? { selector: input.value.trim() } : { text: input.value.trim() }),
      timeoutMs: input.timeoutMs,
    };
    if (!appendAction(recording, action)) {
      throw new Error(`Browser workflow recordings are limited to ${BROWSER_WORKFLOW_MAX_ACTIONS} actions.`);
    }
    return action.id;
  }

  async function cancelRecording(sessionId: string): Promise<void> {
    const recording = recordings.get(sessionId);
    if (!recording) return;
    recordings.delete(sessionId);
    recording.released = true;
    if (recording.timer) clearInterval(recording.timer);
    recording.timer = null;
    cancelPendingInteraction(recording);
    await recording.drainQueue;
    await deps.views.get(sessionId)?.stopWorkflowRecorder().catch(() => []);
    emit({
      runId: recording.recordingId,
      workflowId: 'recording',
      sessionId,
      status: 'canceled',
      current: recording.actions.length,
      total: recording.actions.length,
      message: 'Browser workflow recording canceled.',
    });
  }

  async function releaseSessionResources(sessionId: string): Promise<void> {
    const sessionRuns = [...pendingRuns.values(), ...runs.values()].filter((run) => run.sessionId === sessionId);
    for (const run of sessionRuns) {
      run.controller.abort(new Error('The browser workflow session is being released.'));
    }
    await Promise.all(sessionRuns.map((run) => run.settled));
    await cancelRecording(sessionId);
    discardPendingDraftForSession(sessionId);
  }

  function releaseSession(sessionId: string): Promise<void> {
    const activeRelease = sessionReleases.get(sessionId);
    if (activeRelease) return activeRelease;
    releasingSessions.add(sessionId);
    const release = serializeRecordingTransition(sessionId, () => releaseSessionResources(sessionId)).finally(() => {
      releasingSessions.delete(sessionId);
      if (sessionReleases.get(sessionId) === release) sessionReleases.delete(sessionId);
    });
    sessionReleases.set(sessionId, release);
    return release;
  }

  async function saveRecording(draftId: string, name: string): Promise<BrowserWorkflow> {
    const draft = drafts.get(draftId);
    if (!draft) throw new Error('The browser workflow draft is no longer available. Record it again.');
    const normalizedName = name.trim().slice(0, 200);
    if (!normalizedName) throw new Error('Workflow name cannot be empty.');
    const now = Date.now();
    const workflow: BrowserWorkflow = {
      schemaVersion: 1,
      id: randomUUID(),
      name: normalizedName,
      createdAt: now,
      updatedAt: now,
      actions: draft.actions,
    };
    validateBrowserWorkflow(workflow);
    await deps.store.save(workflow);
    drafts.delete(draftId);
    if (draftIdsBySession.get(draft.sessionId) === draftId) draftIdsBySession.delete(draft.sessionId);
    return workflow;
  }

  function discardRecording(draftId: string): void {
    const draft = drafts.get(draftId);
    if (!draft) return;
    drafts.delete(draftId);
    if (draftIdsBySession.get(draft.sessionId) === draftId) draftIdsBySession.delete(draft.sessionId);
  }

  async function run(
    workflowId: string,
    sessionId: string,
    sensitiveValues: Record<string, string> = {},
  ): Promise<void> {
    if (releasingSessions.has(sessionId)) {
      throw new Error('The browser workflow session is being released.');
    }
    const runId = randomUUID();
    const controller = new AbortController();
    let settleRun!: () => void;
    const settled = new Promise<void>((resolve) => {
      settleRun = resolve;
    });
    const activeRun = { controller, sessionId, settled, settle: settleRun };
    pendingRuns.set(runId, activeRun);
    try {
      const workflow = await deps.store.get(workflowId);
      if (controller.signal.aborted) {
        throw controller.signal.reason instanceof Error
          ? controller.signal.reason
          : new Error('The browser workflow session is being released.');
      }
      if (!workflow || !isBrowserWorkflow(workflow)) throw new Error('Browser workflow not found.');
      const missingSensitiveAction = workflow.actions.find(
        (action) => action.kind === 'type' && action.sensitive && typeof sensitiveValues[action.id] !== 'string',
      );
      if (missingSensitiveAction?.kind === 'type') {
        throw new Error(`Sensitive value required for workflow action ${missingSensitiveAction.id}.`);
      }
      if (recordings.has(sessionId) || recordingStarts.has(sessionId)) {
        throw new Error(
          'A browser workflow recording is active for this page. Stop recording before replaying a workflow.',
        );
      }
      if (runs.size > 0) {
        throw new Error('Another browser workflow is already running.');
      }
      pendingRuns.delete(runId);
      runs.set(runId, activeRun);
      const total = workflow.actions.length;
      const timeoutMs = Math.max(
        25_000,
        workflow.actions.reduce(
          (sum, action) => sum + (action.kind === 'wait' ? action.timeoutMs + 5_000 : 35_000),
          0,
        ),
      );
      let completed = 0;
      emit({ runId, workflowId, sessionId, status: 'running', current: 0, total });
      try {
        const runActions = async (page: IPage, startIndex: number, endIndex = workflow.actions.length): Promise<void> => {
          const context = {};
          for (let index = startIndex; index < endIndex; index += 1) {
            if (controller.signal.aborted) throw new Error('Browser workflow canceled.');
            await runBrowserWorkflowAction(page, workflow.actions[index], sensitiveValues, context);
            completed = index + 1;
            emit({ runId, workflowId, sessionId, status: 'running', current: completed, total });
          }
        };
        // A fresh session has an about:blank view and therefore no renderer
        // viewport yet. Its initial recorded navigation is safe under the
        // navigation lease and gives the BrowserPanel a real page to display;
        // every later action still requires the normal mutate lease.
        const firstAction = workflow.actions[0];
        const remainingStartIndex = firstAction?.kind === 'navigate' ? 1 : 0;
        if (remainingStartIndex === 1) {
          await runWithPage(
            sessionId,
            `workflow ${workflow.name} initial navigation`,
            (page: IPage) => runActions(page, 0, 1),
            { abort: controller.signal, takeover: 'navigate', timeoutMs },
          );
        }
        if (remainingStartIndex < workflow.actions.length) {
          await runWithPage(
            sessionId,
            `workflow ${workflow.name}`,
            (page: IPage) => runActions(page, remainingStartIndex),
            { abort: controller.signal, takeover: 'mutate', timeoutMs },
          );
        }
        if (controller.signal.aborted) throw new Error('Browser workflow canceled.');
        emit({ runId, workflowId, sessionId, status: 'completed', current: total, total });
      } catch (error) {
        const canceled = controller.signal.aborted || (error instanceof Error && /canceled/i.test(error.message));
        emit({
          runId,
          workflowId,
          sessionId,
          status: canceled ? 'canceled' : 'failed',
          current: completed,
          total,
          message: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    } finally {
      pendingRuns.delete(runId);
      runs.delete(runId);
      activeRun.settle();
    }
  }

  async function rename(workflowId: string, name: string): Promise<BrowserWorkflow> {
    const workflow = await deps.store.get(workflowId);
    if (!workflow) throw new Error('Browser workflow not found.');
    const normalizedName = name.trim().slice(0, 200);
    if (!normalizedName) throw new Error('Workflow name cannot be empty.');
    const next = { ...workflow, name: normalizedName, updatedAt: Date.now() };
    await deps.store.save(next);
    return next;
  }

  setBrowserWorkflowNavigationRecorder(queueNavigation, async (sessionId) => {
    const recording = recordings.get(sessionId);
    if (recording) await queueDrain(recording);
  }, (sessionId, value) => {
    const recording = recordings.get(sessionId);
    const event = normalizeBrowserRecorderEvent(value);
    if (recording && event) queueRecorderEvent(recording, event);
  });
  return {
    list: () => deps.store.loadAll(),
    startRecording: (sessionId) => serializeRecordingTransition(sessionId, () => startRecording(sessionId)),
    stopRecording: (sessionId) => serializeRecordingTransition(sessionId, () => stopRecording(sessionId)),
    addWaitCondition: (sessionId, input) =>
      serializeRecordingTransition(sessionId, () => addWaitCondition(sessionId, input)),
    cancelRecording: (sessionId) => serializeRecordingTransition(sessionId, () => cancelRecording(sessionId)),
    releaseSession,
    saveRecording,
    discardRecording,
    run,
    cancel(runId) {
      runs.get(runId)?.controller.abort();
    },
    rename,
    remove: (workflowId) => deps.store.remove(workflowId),
  };
}
