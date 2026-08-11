import { execFile, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';

import { AiSdkBackend } from '../../packages/runtime/dist/ai-sdk-backend.js';
import { buildComputerUseTools } from '../../packages/runtime/dist/computer-use-tools.js';
import { getAIModel } from '../../packages/runtime/dist/model-factory.js';
import { createMakaCuBackend } from '../../packages/computer-use/dist/index.js';
import { createDirectRuntimeTurnLedger } from './direct-runtime-ledger.mjs';
import { sanitizeCuDirectReport } from './report-sanitize.mjs';

const repoRoot = new URL('../..', import.meta.url).pathname;
const binaryPath = join(repoRoot, 'apps/desktop/resources/bin/maka-cu');
const labRoot =
  process.env.MAKA_CU_AX_MODEL_LAB_ROOT ??
  '/Users/haoqing/Documents/Learning/codex-computer-use-lab';
const expectedAppPath = join(labRoot, 'test-app/build/Codex CUA Lab.app');
const statePath = join(labRoot, 'test-app/runtime/state.json');
const fixturePID = Number(process.env.MAKA_CU_AX_MODEL_FIXTURE_PID);
const inputAgeProbe = process.env.MAKA_CU_AX_MODEL_INPUT_AGE_PROBE;
const temporaryDirectory = process.env.MAKA_CU_AX_MODEL_TEMP_DIR;
const reportPath = process.env.MAKA_CU_AX_MODEL_REPORT;
const provider = process.env.MAKA_CU_MODEL_PROVIDER ?? 'openai';
const baseUrl =
  process.env.MAKA_CU_MODEL_BASE_URL ??
  (provider === 'anthropic' ? 'http://127.0.0.1:8537' : 'http://127.0.0.1:8538/v1');
const modelId =
  process.env.MAKA_CU_MODEL_ID ?? (provider === 'anthropic' ? 'claude-sonnet-4-6' : 'gpt-5.6-sol');
const apiKey =
  process.env.MAKA_CU_MODEL_API_KEY ?? (provider === 'anthropic' ? 'coproxy' : 'bridge-managed');
const scenario = process.env.MAKA_CU_AX_MODEL_SCENARIO ?? 'set-value';
const targetValue = 'model-real-ax';
// The digest the manifest pins, rather than a copy of it: a hardcoded digest
// here goes stale the first time the executor is rebuilt, and the failure it
// produces is "refusing to spawn an unrecognized binary", which reads like a
// tampering alarm rather than like a stale constant.
const pinnedExecutorSha256 = JSON.parse(
  await readFile(join(repoRoot, 'apps', 'desktop', 'bundled-tools.json'), 'utf8'),
).makaCu.binarySha256;
const expectedBinarySha256 = process.env.MAKA_CU_AX_MODEL_EXPECTED_SHA256 ?? pinnedExecutorSha256;
const resolvedTemporaryDirectory = resolve(temporaryDirectory ?? '');
const relativeTemporaryDirectory = relative(resolve(tmpdir()), resolvedTemporaryDirectory);

if (
  !Number.isInteger(fixturePID) ||
  fixturePID <= 0 ||
  !inputAgeProbe ||
  !temporaryDirectory ||
  !reportPath ||
  relativeTemporaryDirectory.startsWith('..') ||
  relativeTemporaryDirectory === ''
) {
  throw new Error('real AX model E2E requires launcher-owned inputs');
}

const startedAt = Date.now();
const traces = [];
const actions = [];
const messages = [];
const telemetry = [];
const semanticOutcomes = [];
let freshAxValue;
let injectedIntervention = false;
let restartRequested = false;
let staleRecoveryObserved = false;
let ambiguousRecoveryObserved = false;
let semanticStructureChangeRejected = false;
let ambiguityFixtureMutated = false;
let nextId = 0;
let now = Date.now();
let totalActionAttempts = 0;
const actionAttemptCounts = new Map();
const fixtureInstances = new Map();
const observationTargets = new Map();
const generatedAt = new Date().toISOString();
const gitRevision = execFileSync('git', ['rev-parse', 'HEAD'], {
  cwd: repoRoot,
  encoding: 'utf8',
}).trim();
const reportLineage = {
  runId: randomUUID(),
  gitRevision,
  generatedAt,
  contentLineage: {
    generator: 'scripts/computer-use/real-ax-harness.mjs',
    gitRevision,
    generatedAt,
  },
};

function registerFixtureInstance(app, windowId) {
  const windowIds = fixtureInstances.get(app.pid) ?? new Set();
  windowIds.add(windowId);
  fixtureInstances.set(app.pid, windowIds);
}

function parseObservation(text) {
  if (typeof text !== 'string') return undefined;
  const candidates = [text];
  for (const markerText of ['Fresh observation:\n', 'Fresh observation: ']) {
    const marker = text.lastIndexOf(markerText);
    if (marker >= 0) candidates.push(text.slice(marker + markerText.length));
  }
  for (const candidate of candidates.reverse()) {
    try {
      const value = JSON.parse(candidate);
      if (
        value &&
        typeof value === 'object' &&
        typeof value.observation_id === 'string' &&
        Number.isInteger(value.pid) &&
        Number.isInteger(value.window_id)
      ) {
        return value;
      }
    } catch {
      // Try the next model-visible JSON projection.
    }
  }
  return undefined;
}

function actionBudgetFor(currentScenario) {
  const mutation =
    currentScenario === 'ax-click' || currentScenario === 'ambiguity'
      ? 'click_element'
      : 'set_value';
  return {
    total: 8,
    counts: {
      list_apps: 2,
      observe: 4,
      wait: 2,
      [mutation]:
        currentScenario === 'intervention-recovery' || currentScenario === 'restart-recovery'
          ? 2
          : 1,
      ...(currentScenario === 'ax-multi-step' ? { set_value: 1, click_element: 1 } : {}),
    },
  };
}

function qualificationScenarioFor(currentScenario) {
  return {
    expectedFailures:
      currentScenario === 'restart-recovery'
        ? [{ action: 'set_value', error: 'target_missing' }]
        : currentScenario === 'ambiguity'
          ? [
              { action: 'click_element', error: 'stale_frame' },
              { action: 'click_element', error: 'target_changed' },
            ]
          : [],
  };
}

const qualificationScenario = qualificationScenarioFor(scenario);

async function physicalInputRecentlyActive() {
  const output = await new Promise((resolvePromise, reject) => {
    execFile(
      inputAgeProbe,
      [],
      {
        encoding: 'utf8',
        timeout: 1_000,
      },
      (error, stdout, stderr) => {
        if (error) reject(new Error(stderr || error.message));
        else resolvePromise(stdout.trim());
      },
    );
  });
  const ageSeconds = Number(output);
  if (!Number.isFinite(ageSeconds)) {
    throw new Error(`invalid physical input age: ${output}`);
  }
  return ageSeconds < 1;
}

const backend = createMakaCuBackend({
  binaryPath,
  expectedBinarySha256,
  timeoutMs: 10_000,
  physicalInputRecentlyActive,
  allowCompatibilityInputDispatch: false,
  onTrace(event) {
    traces.push(event);
  },
});

const appSummaries = await backend.listApps(new AbortController().signal);
const fixtureMatches = appSummaries.filter(
  (app) =>
    app.pid === fixturePID &&
    (app.name === 'Codex CUA Lab' ||
      app.windows?.some((window) => window.title === 'Codex CUA Lab')),
);
if (fixtureMatches.length !== 1) {
  throw new Error(`expected one exact fixture app, got ${fixtureMatches.length}`);
}
let fixture = fixtureMatches[0];
const windows = fixture.windows?.filter((window) => window.title === 'Codex CUA Lab') ?? [];
if (windows.length !== 1) {
  throw new Error(`expected one exact fixture window, got ${windows.length}`);
}
let fixtureWindowId = windows[0].windowId;
registerFixtureInstance(fixture, fixtureWindowId);

const instrumentedBackend = {
  ...backend,
  async observeApp(input, signal, context) {
    const observation = await backend.observeApp(input, signal, context);
    if (
      scenario === 'ambiguity' &&
      context.sessionId === 'real-ax-model-e2e' &&
      !ambiguityFixtureMutated
    ) {
      ambiguityFixtureMutated = true;
      const setupContext = {
        sessionId: 'real-ax-model-ambiguity-setup',
        turnId: 'setup',
        toolCallId: 'fixture-mutate-ambiguity',
      };
      const setupObservation = await backend.observeApp(
        {
          app: fixture.appId,
          windowId: fixtureWindowId,
          includeScreenshot: true,
        },
        signal,
        setupContext,
      );
      const mutation = setupObservation.elements.find(
        (element) => element.label === 'CUA Lab Duplicate Stale Target',
      );
      if (!mutation) throw new Error('ambiguity mutation control is missing');
      const setupResult = await backend.runSemantic(
        {
          type: 'click_element',
          observationId: setupObservation.observationId,
          elementId: mutation.elementId,
          elementIdentity: mutation.identity,
        },
        signal,
        setupContext,
      );
      if (!setupResult.outcome.ok) {
        throw new Error(`ambiguity fixture mutation failed: ${setupResult.outcome.message}`);
      }
    }
    if (scenario === 'restart-recovery' && !restartRequested) {
      restartRequested = true;
      await writeFile(
        join(resolvedTemporaryDirectory, 'restart-request.json'),
        `${JSON.stringify({ oldPID: observation.pid })}\n`,
        { flag: 'wx', mode: 0o600 },
      );
      const completePath = join(resolvedTemporaryDirectory, 'restart-complete.json');
      const deadline = Date.now() + 15_000;
      let completed;
      while (Date.now() < deadline) {
        try {
          completed = JSON.parse(await readFile(completePath, 'utf8'));
          break;
        } catch (error) {
          if (error?.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
        }
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
      }
      if (!completed) throw new Error('restart completion timeout');
      const apps = await backend.listApps(signal);
      const currentMatches = apps.filter(
        (app) =>
          app.pid === completed.newPID &&
          (app.name === 'Codex CUA Lab' ||
            app.windows?.some((window) => window.title === 'Codex CUA Lab')),
      );
      if (currentMatches.length !== 1) {
        throw new Error(`expected one restarted fixture, got ${currentMatches.length}`);
      }
      fixture = currentMatches[0];
      const currentWindows =
        fixture.windows?.filter((window) => window.title === 'Codex CUA Lab') ?? [];
      if (currentWindows.length !== 1) {
        throw new Error(`expected one restarted fixture window, got ${currentWindows.length}`);
      }
      fixtureWindowId = currentWindows[0].windowId;
      registerFixtureInstance(fixture, fixtureWindowId);
    }
    return observation;
  },
  async runSemantic(action, signal, context) {
    if (
      scenario === 'intervention-recovery' &&
      action.type === 'set_value' &&
      !injectedIntervention
    ) {
      injectedIntervention = true;
      return {
        outcome: {
          ok: false,
          error: 'user_intervened',
          message: 'synthetic intervention gate requires a fresh observation',
        },
      };
    }
    const result = await backend.runSemantic(action, signal, context);
    semanticOutcomes.push({
      actionType: action.type,
      ok: result.outcome.ok,
      ...(!result.outcome.ok
        ? {
            error: result.outcome.error,
            ambiguous: /ambiguous/i.test(result.outcome.message),
          }
        : {}),
    });
    if (
      scenario === 'restart-recovery' &&
      !result.outcome.ok &&
      result.outcome.error === 'target_missing'
    ) {
      staleRecoveryObserved = true;
    }
    if (
      scenario === 'ambiguity' &&
      action.type === 'click_element' &&
      !result.outcome.ok &&
      result.outcome.error === 'stale_frame' &&
      /ambiguous/.test(result.outcome.message)
    ) {
      ambiguousRecoveryObserved = true;
    }
    if (
      scenario === 'ambiguity' &&
      action.type === 'click_element' &&
      !result.outcome.ok &&
      result.outcome.error === 'target_changed'
    ) {
      semanticStructureChangeRejected = true;
    }
    if (action.type === 'set_value' && result.outcome.ok) {
      const field = result.observation?.elements.find(
        (element) => element.label === 'CUA Lab Set Value Field',
      );
      freshAxValue = result.outcome.evidence?.readbackValue ?? field?.value;
    }
    return result;
  },
};
const [rawComputerTool] = buildComputerUseTools({ backend: instrumentedBackend });
const computerTool = {
  ...rawComputerTool,
  async impl(args, context) {
    const action = typeof args?.action === 'string' ? args.action : 'unknown';
    const allowed =
      scenario === 'observe-only'
        ? new Set(['list_apps', 'observe', 'wait'])
        : scenario === 'ax-click' || scenario === 'ambiguity'
          ? new Set(['list_apps', 'observe', 'click_element', 'wait'])
          : scenario === 'ax-multi-step'
            ? new Set(['list_apps', 'observe', 'set_value', 'click_element', 'wait'])
            : new Set(['list_apps', 'observe', 'set_value', 'wait']);
    const budget = actionBudgetFor(scenario);
    const nextTotal = totalActionAttempts + 1;
    const nextActionCount = (actionAttemptCounts.get(action) ?? 0) + 1;
    totalActionAttempts = nextTotal;
    actionAttemptCounts.set(action, nextActionCount);
    const sourceTarget = observationTargets.get(args?.observation_id);
    const ownedWindows = fixtureInstances.get(sourceTarget?.pid);
    const attempt = {
      action: { type: action },
      toolCallId: context.toolCallId,
      sourceObservationId: args?.observation_id,
      targetPid: sourceTarget?.pid,
      targetWindowId: sourceTarget?.windowId,
      targetOwned: Boolean(ownedWindows?.has(sourceTarget?.windowId)),
      success: false,
      durationMs: 0,
    };
    actions.push(attempt);
    const rejectAttempt = (resultCode, message) => {
      attempt.text = `maka_computer.${action} failed: ${resultCode}`;
      throw new Error(message);
    };
    if (!allowed.has(action)) {
      rejectAttempt(
        'unsupported_action_policy',
        `model action '${action}' is outside the AX-only scenario budget`,
      );
    }
    if (nextTotal > budget.total || nextActionCount > (budget.counts[action] ?? 0)) {
      rejectAttempt('action_budget_exceeded', 'AX-only scenario action budget exceeded');
    }
    if (action === 'observe') {
      // The `computer` tool contract is "observe requires app OR window_id", so a
      // model that supplies only one of them is behaving correctly. Requiring both
      // would fail every compliant model before it ever reaches a dispatch. Assert
      // the real invariant instead: whatever the model did supply must identify the
      // fixture, and must not point at any other target.
      const appProvided = args.app !== undefined;
      const windowProvided = args.window_id !== undefined;
      const appMatches = args.app === fixture.appId;
      const windowMatches = args.window_id === fixtureWindowId;
      const identifiesFixture = (appProvided && appMatches) || (windowProvided && windowMatches);
      const contradictsFixture = (appProvided && !appMatches) || (windowProvided && !windowMatches);
      if (!identifiesFixture || contradictsFixture) {
        rejectAttempt(
          'target_mismatch',
          'model observe target does not match the exact fixture identity',
        );
      }
    }
    const actionStartedAt = Date.now();
    let result;
    try {
      result = await rawComputerTool.impl(args, context);
    } catch (error) {
      const resultCode = typeof error?.code === 'string' ? error.code : 'tool_error';
      attempt.durationMs = Date.now() - actionStartedAt;
      attempt.text = `maka_computer.${action} failed: ${resultCode}`;
      throw error;
    }
    const observation = parseObservation(result?.modelText) ?? parseObservation(result?.text);
    const dispatch = traces.findLast(
      (trace) => trace.type === 'dispatch' && trace.toolCallId === context.toolCallId,
    );
    const resultCode =
      result?.error ??
      (typeof result?.text === 'string'
        ? result.text.match(/\bfailed:\s*([a-z][a-z0-9_]{1,63})\b/i)?.[1]
        : undefined);
    if (observation) {
      observationTargets.set(observation.observation_id, {
        pid: observation.pid,
        windowId: observation.window_id,
      });
    }
    const targetPid = observation?.pid ?? dispatch?.pid ?? sourceTarget?.pid;
    const targetWindowId = observation?.window_id ?? dispatch?.windowId ?? sourceTarget?.windowId;
    const resultOwnedWindows = fixtureInstances.get(targetPid);
    Object.assign(attempt, {
      resultObservationId: observation?.observation_id,
      targetPid,
      targetWindowId,
      targetOwned: Boolean(resultOwnedWindows?.has(targetWindowId)),
      success: !resultCode,
      expectedFailure: qualificationScenario.expectedFailures.some(
        (expected) => expected.action === action && expected.error === resultCode,
      ),
      durationMs: Date.now() - actionStartedAt,
      text:
        result?.text ?? (resultCode ? `maka_computer.${action} failed: ${resultCode}` : undefined),
    });
    return result;
  },
};

const connection = {
  slug: provider === 'anthropic' ? 'coproxy' : 'azure-bridge',
  name: provider === 'anthropic' ? 'Anthropic Coproxy' : 'Azure Bridge',
  providerType: provider,
  baseUrl,
  defaultModel: modelId,
  enabled: true,
  createdAt: 1,
  updatedAt: 1,
};
const task =
  scenario === 'observe-only'
    ? 'Use Maka Computer to inspect "Codex CUA Lab". Start with list_apps, observe ' +
      'the exact app/window, report that "CUA Lab Set Value Field" is visible, ' +
      'do not mutate anything, then finish.'
    : scenario === 'ax-click'
      ? 'Use Maka Computer to click the element labeled "CUA Lab Primary Button" exactly ' +
        'once in "Codex CUA Lab". Start with list_apps and observe, use click_element ' +
        'with IDs from that observation, verify the fresh state, then finish. Never use coordinates.'
      : scenario === 'ax-multi-step'
        ? `Use Maka Computer in "Codex CUA Lab" to complete two semantic actions in order. ` +
          `First set "CUA Lab Set Value Field" to "${targetValue}" with set_value. ` +
          'Then use the fresh observation returned by that action to click ' +
          '"CUA Lab Primary Button" exactly once with click_element. Verify both fresh ' +
          'results, then finish. Never use coordinates, scroll, drag, type, or key actions.'
        : scenario === 'ambiguity'
          ? 'Use Maka Computer to click the observed element labeled "CUA Lab Stale Target" ' +
            'exactly once in "Codex CUA Lab". Start with list_apps and observe, then use ' +
            'click_element with the exact observation_id and element_id. If the tool rejects ' +
            'the target, report the failure and stop rather than guessing or using coordinates.'
          : `Use Maka Computer to set "CUA Lab Set Value Field" in "Codex CUA Lab" ` +
            `to "${targetValue}". Start with list_apps, observe the exact app/window, ` +
            'use set_value with the observation_id and element_id from that observation, ' +
            'verify the fresh observation value, then finish. If user_intervened is returned, ' +
            'observe again before retrying. If target_missing or stale_frame is returned, ' +
            'list apps and observe the current process again before retrying. Never use ' +
            'coordinate, click, scroll, drag, type, or key actions.';
const turnId = 'turn-real-ax-model';
const durableTurn = createDirectRuntimeTurnLedger({
  sessionId: 'real-ax-model-e2e',
  turnId,
  text: task,
  newId: () => `runtime-event-${++nextId}`,
  now: () => ++now,
});
const runtime = new AiSdkBackend({
  sessionId: 'real-ax-model-e2e',
  header: {
    id: 'real-ax-model-e2e',
    workspaceRoot: repoRoot,
    cwd: repoRoot,
    createdAt: now,
    lastUsedAt: now,
    name: 'Real AX Model E2E',
    isFlagged: false,
    labels: [],
    isArchived: false,
    status: 'active',
    statusUpdatedAt: now,
    hasUnread: false,
    backend: 'ai-sdk',
    llmConnectionSlug: connection.slug,
    connectionLocked: true,
    model: modelId,
    permissionMode: 'bypass',
    schemaVersion: 1,
  },
  appendMessage: async (message) => {
    messages.push(message);
  },
  connection,
  apiKey,
  modelId,
  readExecutionBoundary: async () => ({ kind: 'bypass', revision: 0 }),
  modelFactory: (input) => getAIModel(input),
  tools: [computerTool],
  maxSteps: 8,
  loadTurnRuntimeEvents: durableTurn.loadTurnRuntimeEvents,
  newId: () => `id-${++nextId}`,
  now: () => ++now,
  recordToolInvocation: (record) => {
    telemetry.push({
      toolName: record.toolName,
      status: record.status,
      errorClass: record.errorClass,
      argsSummary: record.argsSummary,
    });
  },
});

const events = [];
let terminalEvent;
try {
  for await (const event of runtime.send({
    turnId,
    text: task,
    context: [],
    headAnchorRuntimeEvent: durableTurn.anchor,
  })) {
    durableTurn.record(event);
    events.push(event.type);
    if (event.type === 'complete' || event.type === 'abort' || event.type === 'error') {
      terminalEvent = {
        type: event.type,
        ...(typeof event.stopReason === 'string' ? { stopReason: event.stopReason } : {}),
      };
    }
  }

  const fixtureState = JSON.parse(await readFile(statePath, 'utf8'));
  const setValueDispatches = traces.filter(
    (trace) =>
      trace.type === 'dispatch' && trace.actionType === 'set_value' && trace.address === 'ax',
  );
  const clickDispatches = traces.filter(
    (trace) =>
      trace.type === 'dispatch' && trace.actionType === 'click_element' && trace.address === 'ax',
  );
  const modelClickDispatches = clickDispatches.filter(
    (trace) => trace.toolCallId !== 'fixture-mutate-ambiguity',
  );
  const setupClickDispatches = clickDispatches.filter(
    (trace) => trace.toolCallId === 'fixture-mutate-ambiguity',
  );
  const forbiddenDispatches = traces.filter(
    (trace) => trace.type === 'dispatch' && trace.address === 'px',
  );
  if (
    !['observe-only', 'ax-click', 'ambiguity'].includes(scenario) &&
    freshAxValue !== targetValue
  ) {
    throw new Error(`fresh AX value mismatch: ${String(freshAxValue)}`);
  }
  const expectedSetValueDispatches =
    scenario === 'observe-only' || scenario === 'ax-click' || scenario === 'ambiguity' ? 0 : 1;
  if (setValueDispatches.length !== expectedSetValueDispatches) {
    throw new Error(
      `expected ${expectedSetValueDispatches} AX set_value dispatches, got ${setValueDispatches.length}`,
    );
  }
  const expectedClickDispatches = scenario === 'ax-click' || scenario === 'ax-multi-step' ? 1 : 0;
  if (modelClickDispatches.length !== expectedClickDispatches) {
    throw new Error(
      `expected ${expectedClickDispatches} model AX click dispatches, got ${modelClickDispatches.length}`,
    );
  }
  if (scenario === 'ambiguity' && setupClickDispatches.length !== 1) {
    throw new Error(`expected one ambiguity setup AX dispatch, got ${setupClickDispatches.length}`);
  }
  if (forbiddenDispatches.length !== 0) {
    throw new Error(`forbidden pixel dispatch count: ${forbiddenDispatches.length}`);
  }
  if (scenario === 'restart-recovery' && !staleRecoveryObserved) {
    throw new Error('model restart scenario did not observe target_missing');
  }
  if (scenario === 'restart-recovery') {
    const staleIndex = actions.findIndex(
      (record) =>
        record.action.type === 'set_value' &&
        record.success === false &&
        record.expectedFailure === true,
    );
    const freshIndex = actions.findIndex(
      (record, index) =>
        index > staleIndex &&
        record.action.type === 'observe' &&
        record.success === true &&
        typeof record.resultObservationId === 'string' &&
        record.targetPid === fixture.pid,
    );
    const retry = actions.find(
      (record, index) =>
        index > freshIndex &&
        record.action.type === 'set_value' &&
        record.success === true &&
        record.sourceObservationId === actions[freshIndex]?.resultObservationId &&
        record.targetPid === fixture.pid,
    );
    const retryDispatch =
      retry &&
      setValueDispatches.some(
        (trace) =>
          trace.toolCallId === retry.toolCallId &&
          trace.pid === retry.targetPid &&
          trace.windowId === retry.targetWindowId,
      );
    if (staleIndex < 0 || freshIndex < 0 || !retry || !retryDispatch) {
      throw new Error(
        'restart recovery requires stale target_missing, fresh observation, and successful AX retry',
      );
    }
  }
  if (
    scenario === 'ambiguity' &&
    (!actions.some((record) => record.action.type === 'click_element') ||
      (!ambiguousRecoveryObserved && !semanticStructureChangeRejected))
  ) {
    throw new Error(
      `model ambiguity scenario did not attempt and observe fail-closed rejection: ${JSON.stringify(
        {
          actionTypes: actions.map((record) => record.action.type),
          semanticOutcomes,
          setupClickDispatches: setupClickDispatches.length,
          modelClickDispatches: modelClickDispatches.length,
        },
      )}`,
    );
  }
  if (
    (scenario === 'ax-click' || scenario === 'ax-multi-step') &&
    fixtureState.controls.buttonClickCount !== 1
  ) {
    throw new Error(`primary button count mismatch: ${fixtureState.controls.buttonClickCount}`);
  }
  if (
    scenario === 'ambiguity' &&
    (fixtureState.hierarchy.mode !== 'ambiguous' ||
      fixtureState.hierarchy.staleTargetClickCount !== 0 ||
      fixtureState.hierarchy.wrongTargetClickCount !== 0)
  ) {
    throw new Error(`ambiguous stale target mutated: ${JSON.stringify(fixtureState.hierarchy)}`);
  }
  if (
    fixtureState.synthetic !== true ||
    fixtureState.appPath !== expectedAppPath ||
    fixtureState.oop?.hostPID !== fixture.pid
  ) {
    throw new Error('fixture identity changed during model execution');
  }
  if (terminalEvent?.type !== 'complete' || terminalEvent.stopReason !== 'end_turn') {
    throw new Error(`model Runtime did not complete/end_turn: ${JSON.stringify(terminalEvent)}`);
  }
  if (scenario === 'ax-multi-step') {
    const setIndex = actions.findIndex((record) => record.action.type === 'set_value');
    const clickIndex = actions.findIndex((record) => record.action.type === 'click_element');
    const setAction = actions[setIndex];
    const clickAction = actions[clickIndex];
    if (
      setIndex < 0 ||
      clickIndex <= setIndex ||
      typeof setAction?.resultObservationId !== 'string' ||
      clickAction?.sourceObservationId !== setAction.resultObservationId
    ) {
      throw new Error(
        `multi-step action order or observation lineage mismatch: ${JSON.stringify(
          actions.map((record) => ({
            type: record.action.type,
            sourceObservationId: record.sourceObservationId,
            resultObservationId: record.resultObservationId,
          })),
        )}`,
      );
    }
  }

  const evidenceClass = scenario === 'intervention-recovery' ? 'fault-injection' : 'real-runtime';
  const canonicalFixtureState = {
    target: {
      setValue: fixtureState.controls.setValue,
      buttonClickCount: fixtureState.controls.buttonClickCount,
      hierarchyMode: fixtureState.hierarchy.mode,
      staleTargetClickCount: fixtureState.hierarchy.staleTargetClickCount,
      wrongTargetClickCount: fixtureState.hierarchy.wrongTargetClickCount,
    },
  };
  const fixtureIdentityInstances = [...fixtureInstances.entries()].map(([pid, windowIds]) => ({
    pid,
    windowIds: [...windowIds],
  }));
  const minimumActionsPassed =
    scenario !== 'ambiguity' || actions.some((record) => record.action.type === 'click_element');
  const actionsWithinBudget =
    totalActionAttempts <= actionBudgetFor(scenario).total &&
    [...actionAttemptCounts].every(
      ([action, count]) => count <= (actionBudgetFor(scenario).counts[action] ?? 0),
    );
  const actionResultsPassed = actions.every(
    (record) => record.success === true || record.expectedFailure === true,
  );
  const dispatchPathPassed =
    forbiddenDispatches.length === 0 &&
    setValueDispatches.length === expectedSetValueDispatches &&
    modelClickDispatches.length === expectedClickDispatches;
  const qualified =
    minimumActionsPassed && actionsWithinBudget && actionResultsPassed && dispatchPathPassed;
  const sanitized = sanitizeCuDirectReport({
    schemaVersion: 1,
    ...reportLineage,
    evidenceClass,
    scenarioId:
      scenario === 'observe-only'
        ? 'appkit-ax-observe-only'
        : scenario === 'intervention-recovery'
          ? 'appkit-ax-intervention-recovery'
          : scenario === 'restart-recovery'
            ? 'appkit-ax-restart-recovery'
            : scenario === 'ax-click'
              ? 'appkit-ax-click'
              : scenario === 'ax-multi-step'
                ? 'appkit-ax-multi-step'
                : scenario === 'ambiguity'
                  ? 'appkit-ax-ambiguity'
                  : 'appkit-ax-set-value',
    policyMode: 'enforced',
    qualificationEligible: evidenceClass === 'real-runtime',
    producer: 'computer-use/real-ax',
    transportClass: 'live-network',
    model: modelId,
    provider,
    baseUrl,
    status: qualified ? 'pass' : 'fail',
    terminal: terminalEvent,
    fixtureIdentity: {
      instances: fixtureIdentityInstances,
    },
    ...(evidenceClass === 'fault-injection'
      ? {
          faultInjection: {
            layer: 'runtime',
            kind: 'user_intervened',
          },
        }
      : {}),
    totalLatencyMs: Date.now() - startedAt,
    loopStatus: 'completed',
    state: {
      fixtureIdentityValid: true,
      freshAxValueMatched:
        scenario === 'observe-only' || scenario === 'ax-click' || scenario === 'ambiguity'
          ? undefined
          : freshAxValue === targetValue,
      injectedIntervention,
      staleRecoveryObserved,
      ambiguousRecoveryObserved,
      semanticStructureChangeRejected,
      ambiguityFixtureMutated,
      setValueDispatches: setValueDispatches.length,
      clickDispatches: modelClickDispatches.length,
      setupClickDispatches: setupClickDispatches.length,
      pixelDispatches: forbiddenDispatches.length,
      primaryButtonClicks: fixtureState.controls.buttonClickCount,
      ambiguousClicks: fixtureState.hierarchy.staleTargetClickCount,
      terminalEvent,
      toolCallsPersisted: messages.filter((message) => message.type === 'tool_call').length,
      toolResultsPersisted: messages.filter((message) => message.type === 'tool_result').length,
      telemetrySuccesses: telemetry.filter((record) => record.status === 'success').length,
      telemetryErrors: telemetry.filter((record) => record.status === 'error').length,
      telemetryErrorClasses: [
        ...new Set(
          telemetry
            .filter((record) => record.status === 'error')
            .map((record) => record.errorClass)
            .filter(Boolean),
        ),
      ],
      telemetryErrorActions: telemetry
        .filter((record) => record.status === 'error')
        .flatMap((record) => {
          try {
            const summary = JSON.parse(record.argsSummary ?? '{}');
            return typeof summary.action === 'string' ? [summary.action] : [];
          } catch {
            return [];
          }
        }),
      semanticFailures: semanticOutcomes.filter((outcome) => !outcome.ok).length,
      semanticFailureCode: semanticOutcomes.find((outcome) => !outcome.ok)?.error,
      ambiguousSemanticFailures: semanticOutcomes.filter(
        (outcome) => !outcome.ok && outcome.ambiguous,
      ).length,
    },
    actionAttempts: totalActionAttempts,
    actionCount: actions.length,
    actionCounts: Object.fromEntries(
      actions.reduce((counts, record) => {
        const type = record.action.type;
        counts.set(type, (counts.get(type) ?? 0) + 1);
        return counts;
      }, new Map()),
    ),
    minimumActionsPassed,
    actionsWithinBudget,
    dispatchPathPassed,
    actions,
    fixtureState: canonicalFixtureState,
    expectedState: [
      {
        windowId: 'target',
        path: 'buttonClickCount',
        pass:
          !['ax-click', 'ax-multi-step'].includes(scenario) ||
          fixtureState.controls.buttonClickCount === 1,
        actual: fixtureState.controls.buttonClickCount,
      },
    ],
    forbiddenEffects: {
      status:
        forbiddenDispatches.length === 0 && fixtureState.hierarchy.wrongTargetClickCount === 0
          ? 'pass'
          : 'fail',
      violations: [],
    },
    driverTraces: traces.filter((trace) => trace.toolCallId !== 'fixture-mutate-ambiguity'),
  });
  await writeFile(reportPath, `${JSON.stringify(sanitized, null, 2)}\n`, {
    flag: 'wx',
    mode: 0o600,
  });
  process.stdout.write(`${JSON.stringify(sanitized, null, 2)}\n`);
  if (!qualified) {
    throw new Error('real AX model qualification rejected canonical action evidence');
  }
} finally {
  await runtime.dispose();
  backend.dispose();
}
