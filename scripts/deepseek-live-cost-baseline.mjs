#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AiSdkBackend } from '../packages/runtime/dist/ai-sdk-backend.js';
import { buildBuiltinTools } from '../packages/runtime/dist/builtin-tools.js';
import { estimateTokens } from '../packages/runtime/dist/context-budget.js';
import {
  buildHistoryCompactBlockFromSummary,
  validateHistoryCompactBlockShape,
} from '../packages/runtime/dist/history-compact.js';
import { buildProviderOptions, getAIModel } from '../packages/runtime/dist/model-factory.js';
import { BackendRegistry, SessionManager } from '../packages/runtime/dist/session-manager.js';
import {
  buildSynthesisCacheBlocksFromHydratedArchives,
  validateSynthesisCacheBlockShape,
} from '../packages/runtime/dist/synthesis-cache.js';
import { computeCost, getBuiltinPricing } from '../packages/runtime/dist/telemetry/index.js';
import {
  createSqliteAgentRunStore,
  createSqliteArtifactStore,
  createSessionStore,
  openRuntimeEventPersistence,
} from '../packages/storage/dist/index.js';

const apiKey = process.env.DEEPSEEK_API_KEY;
if (!apiKey) {
  throw new Error(
    'DEEPSEEK_API_KEY is not set. Source your local secret env before running this script.',
  );
}

const repoRoot = resolve(new URL('..', import.meta.url).pathname);
const outputRoot = resolve(
  process.env.MAKA_COST_BASELINE_OUTPUT ?? join(tmpdir(), 'maka-deepseek-cost-baseline'),
);
const runId = new Date().toISOString().replace(/[:.]/g, '-');
const workspaceRoot = join(outputRoot, runId, 'workspace');
await mkdir(workspaceRoot, { recursive: true });

const model = process.env.MAKA_COST_BASELINE_MODEL ?? 'deepseek-chat';
const turnCount = parsePositiveInt(process.env.MAKA_COST_BASELINE_TURNS, 10);
const toolMode = process.env.MAKA_COST_BASELINE_TOOLS ?? 'none';
const seed = process.env.MAKA_COST_BASELINE_SEED ?? runId;
const cwd = resolve(process.env.MAKA_COST_BASELINE_CWD ?? repoRoot);
const contextBudget = buildContextBudgetPolicy();
const stablePolicyLines = parsePositiveInt(process.env.MAKA_COST_BASELINE_STABLE_POLICY_LINES, 140);
const payloadLines = parsePositiveInt(process.env.MAKA_COST_BASELINE_PAYLOAD_LINES, 70);

async function openCanonicalExecutionStores(root) {
  const runStore = createSqliteAgentRunStore(root);
  try {
    await runStore.ready?.();
    const runtimePersistence = await openRuntimeEventPersistence({ workspaceRoot: root });
    return {
      runStore,
      runtimeEventStore: runtimePersistence.runtimeEventStore,
    };
  } catch (error) {
    runStore.close?.();
    throw error;
  }
}

if (process.env.MAKA_COST_BASELINE_PHASE7_TOOL_MATRIX === 'on') {
  const exitCode = await runPhase7ToolMatrix({
    apiKey,
    model,
    repoRoot,
    outputRoot,
    runId,
    seed,
    cwd,
  });
  process.exit(exitCode);
}

if (process.env.MAKA_COST_BASELINE_PHASE8_SYNTHESIS_MATRIX === 'on') {
  const exitCode = await runPhase8SynthesisMatrix({
    apiKey,
    model,
    repoRoot,
    outputRoot,
    runId,
    seed,
    cwd,
  });
  process.exit(exitCode);
}

if (
  process.env.MAKA_COST_BASELINE_PHASE9_SYNTHESIS_LIFECYCLE === 'on' ||
  process.argv.includes('--phase9-synthesis-lifecycle')
) {
  const exitCode = await runPhase9SynthesisLifecycleMatrix({
    apiKey,
    model,
    repoRoot,
    outputRoot,
    runId,
    seed,
    cwd,
  });
  process.exit(exitCode);
}

if (
  process.env.MAKA_COST_BASELINE_PHASE10_HISTORY_COMPACT === 'on' ||
  process.argv.includes('--phase10-history-compact')
) {
  const exitCode = await runPhase10HistoryCompactMatrix({
    apiKey,
    model,
    repoRoot,
    outputRoot,
    runId,
    seed,
    cwd,
  });
  process.exit(exitCode);
}

const sessionStore = createSessionStore(workspaceRoot);
const { runStore, runtimeEventStore } = await openCanonicalExecutionStores(workspaceRoot);
const artifactStore = createSqliteArtifactStore(workspaceRoot);
const backends = new BackendRegistry();
const llmRecords = [];
const runTraceEvents = [];
const tools = toolMode === 'builtin' ? buildBuiltinTools() : [];

const connection = {
  slug: 'deepseek-live-cost-baseline',
  name: 'DeepSeek live cost baseline',
  providerType: 'deepseek',
  baseUrl: 'https://api.deepseek.com',
  defaultModel: model,
  enabled: true,
  createdAt: Date.now(),
  updatedAt: Date.now(),
};

const durablePrefix = [
  'You are a concise Maka runtime cost baseline assistant.',
  `Baseline seed: ${seed}`,
  'Always answer exactly: OK',
  'The following stable policy block is intentionally repeated to make provider prefix caching observable.',
  '<stable-policy>',
  Array.from(
    { length: stablePolicyLines },
    (_, index) =>
      `Stable policy line ${String(index + 1).padStart(3, '0')}: preserve the durable system prefix, avoid unnecessary wording churn, and keep responses short.`,
  ).join('\n'),
  '</stable-policy>',
].join('\n');

function turnTailPrompt() {
  return [
    '<current-session-environment>',
    `cwd: ${cwd}`,
    `git_branch: ${process.env.MAKA_COST_BASELINE_BRANCH ?? 'unknown'}`,
    `calendar_date: ${process.env.MAKA_COST_BASELINE_DATE ?? new Date().toISOString().slice(0, 10)}`,
    '</current-session-environment>',
  ].join('\n');
}

backends.register(
  'ai-sdk',
  async (ctx) =>
    new AiSdkBackend({
      sessionId: ctx.sessionId,
      header: { ...ctx.header, model },
      appendMessage: (message) => ctx.store.appendMessage(ctx.sessionId, message),
      connection,
      apiKey,
      modelId: model,
      readExecutionBoundary: () => ctx.store.readExecutionBoundary(ctx.sessionId),
      modelFactory: getAIModel,
      tools,
      loadTurnRuntimeEvents: ctx.loadTurnRuntimeEvents,
      allowMidTurnHistoryCompaction: ctx.allowMidTurnHistoryCompaction,
      providerOptions: buildProviderOptions(connection, model),
      contextBudget,
      systemPrompt: durablePrefix,
      turnTailPrompt,
      recordLlmCall: (record) => llmRecords.push(record),
      recordRunTrace: (event) => runTraceEvents.push(event),
      archiveToolResult: async (event) => {
        const artifact = await artifactStore.create({
          sessionId: event.sessionId,
          turnId: event.turnId,
          name: `tool-result-${event.runtimeEventId}.json`,
          kind: 'file',
          content: event.serializedResult,
          mimeType: 'application/json',
          source: 'tool_result_archive',
          summary: `Archived ${event.toolName} tool result for DeepSeek cost baseline replay`,
        });
        return { artifactId: artifact.id };
      },
      readToolResultArchive: async (event) => {
        const record = await artifactStore.get(event.artifactId);
        if (!record) return { ok: false, reason: 'not_found' };
        if (record.status === 'deleted') return { ok: false, reason: 'deleted' };
        if (record.source !== 'tool_result_archive')
          return { ok: false, reason: 'source_mismatch' };
        if (record.sessionId !== event.sessionId) return { ok: false, reason: 'session_mismatch' };
        if (record.sizeBytes !== event.originalBytes) return { ok: false, reason: 'size_mismatch' };
        const read = await artifactStore.readText(event.artifactId, {
          maxBytes: event.maxBytes ?? event.originalBytes,
        });
        if (!read.ok) return read;
        if (sha256(read.text) !== event.bodySha256) return { ok: false, reason: 'corrupt' };
        return { ok: true, serializedResult: read.text };
      },
      newId: randomUUID,
      now: Date.now,
      maxSteps: 1,
      streamConnectTimeoutMs: 30_000,
      streamIdleTimeoutMs: 120_000,
    }),
);

const manager = new SessionManager({
  store: sessionStore,
  runStore,
  runtimeEventStore,
  backends,
  newId: randomUUID,
  now: Date.now,
});
const session = await manager.createSession({
  cwd,
  backend: 'ai-sdk',
  llmConnectionSlug: connection.slug,
  model,
  permissionMode: 'explore',
  name: 'DeepSeek live cost baseline',
});

const turns = [];
const repeatedPayload = Array.from(
  { length: payloadLines },
  (_, index) =>
    `baseline fact ${String(index + 1).padStart(2, '0')}: this stable user payload is repeated to expose how much new-tail text becomes cache miss.`,
).join('\n');

for (let i = 1; i <= turnCount; i += 1) {
  const turnId = `cost-turn-${String(i).padStart(2, '0')}`;
  const text = [
    `Turn ${i}. Answer exactly OK.`,
    repeatedPayload,
    `Unique turn marker: ${String(i).padStart(2, '0')}.`,
  ].join('\n');
  const events = [];
  const startedAt = Date.now();
  for await (const event of manager.sendMessage(session.id, { turnId, text })) {
    events.push(event);
  }
  const finishedAt = Date.now();
  const usageEvent = events.find((event) => event.type === 'token_usage');
  const completeEvent = events.find((event) => event.type === 'complete');
  const errorEvent = events.find((event) => event.type === 'error');
  const llmRecord = llmRecords.at(-1);
  const cacheMissInputSource = usageEvent?.cacheMissInputSource ?? llmRecord?.cacheMissInputSource;
  const cacheMissInput = usageEvent?.cacheMissInput ?? llmRecord?.cacheMissInputTokens;
  const contextBudgetDiagnostic = usageEvent?.contextBudget ?? llmRecord?.contextBudget;
  const cost = llmRecord
    ? computeCost(
        {
          inputTokens: llmRecord.inputTokens,
          outputTokens: llmRecord.outputTokens,
          cacheHitInputTokens: llmRecord.cacheHitInputTokens,
          cacheMissInputTokens: llmRecord.cacheMissInputTokens,
          cacheWriteInputTokens: llmRecord.cacheWriteInputTokens,
        },
        getBuiltinPricing(`${connection.providerType}:${model}`),
      )
    : undefined;
  turns.push({
    turn: i,
    turnId,
    durationMs: finishedAt - startedAt,
    eventCount: events.length,
    status: errorEvent ? 'error' : 'ok',
    stopReason: completeEvent?.stopReason,
    prefixChangeReason: usageEvent?.prefixChangeReason,
    prefixHash: usageEvent?.prefixHash,
    requestShapeChangeReason: usageEvent?.requestShapeChangeReason,
    requestShapeHash: usageEvent?.requestShapeHash,
    input: usageEvent?.input ?? llmRecord?.inputTokens,
    cacheHitInput: usageEvent?.cacheHitInput ?? llmRecord?.cacheHitInputTokens,
    cacheMissInput,
    cacheMissInputSource,
    providerExplicitCacheMissInput: cacheMissInputSource === 'explicit' ? cacheMissInput : null,
    locallyDerivedCacheMissInput: cacheMissInputSource === 'derived' ? cacheMissInput : null,
    cacheWriteInput: usageEvent?.cacheWriteInput ?? llmRecord?.cacheWriteInputTokens,
    cacheMissShapeSource: classifyCacheMissShape(
      usageEvent?.prefixChangeReason,
      usageEvent?.requestShapeChangeReason,
    ),
    output: usageEvent?.output ?? llmRecord?.outputTokens,
    total: usageEvent?.total,
    estimatedCostUsd: cost?.totalCost,
    promptSegments: usageEvent?.promptSegments ?? llmRecord?.promptSegments,
    contextBudget: contextBudgetDiagnostic,
    archivePlaceholders: contextBudgetDiagnostic?.archivePlaceholders ?? 0,
    archiveWriteFailures: contextBudgetDiagnostic?.archiveWriteFailures ?? 0,
    archivePlaceholderReasonCounts: contextBudgetDiagnostic?.archivePlaceholderReasonCounts,
    retrievedArchiveToolResults: contextBudgetDiagnostic?.retrievedArchiveToolResults ?? 0,
    retrievedArchiveEstimatedTokens: contextBudgetDiagnostic?.retrievedArchiveEstimatedTokens ?? 0,
    archiveRetrievalSkipped: contextBudgetDiagnostic?.archiveRetrievalSkipped ?? 0,
    archiveRetrievalFailures: contextBudgetDiagnostic?.archiveRetrievalFailures ?? 0,
    archiveRetrievalFailureReasonCounts:
      contextBudgetDiagnostic?.archiveRetrievalFailureReasonCounts,
    errorReason: errorEvent?.reason,
  });
}

const totals = turns.reduce(
  (acc, turn) => {
    acc.input += turn.input ?? 0;
    acc.cacheHitInput += turn.cacheHitInput ?? 0;
    acc.cacheMissInput += turn.cacheMissInput ?? 0;
    acc.cacheWriteInput += turn.cacheWriteInput ?? 0;
    acc.output += turn.output ?? 0;
    acc.estimatedCostUsd += turn.estimatedCostUsd ?? 0;
    if (turn.cacheMissInputSource === 'explicit') acc.explicitCacheMissTurns += 1;
    else if (turn.cacheMissInputSource === 'derived') acc.derivedCacheMissTurns += 1;
    else acc.unknownCacheMissTurns += 1;
    acc.archivePlaceholders += turn.archivePlaceholders ?? 0;
    acc.archiveWriteFailures += turn.archiveWriteFailures ?? 0;
    acc.retrievedArchiveToolResults += turn.retrievedArchiveToolResults ?? 0;
    acc.retrievedArchiveEstimatedTokens += turn.retrievedArchiveEstimatedTokens ?? 0;
    acc.archiveRetrievalSkipped += turn.archiveRetrievalSkipped ?? 0;
    acc.archiveRetrievalFailures += turn.archiveRetrievalFailures ?? 0;
    for (const [reason, count] of Object.entries(turn.archivePlaceholderReasonCounts ?? {})) {
      acc.archivePlaceholderReasonCounts[reason] =
        (acc.archivePlaceholderReasonCounts[reason] ?? 0) + count;
    }
    for (const [reason, count] of Object.entries(turn.archiveRetrievalFailureReasonCounts ?? {})) {
      acc.archiveRetrievalFailureReasonCounts[reason] =
        (acc.archiveRetrievalFailureReasonCounts[reason] ?? 0) + count;
    }
    return acc;
  },
  {
    input: 0,
    cacheHitInput: 0,
    cacheMissInput: 0,
    cacheWriteInput: 0,
    output: 0,
    estimatedCostUsd: 0,
    explicitCacheMissTurns: 0,
    derivedCacheMissTurns: 0,
    unknownCacheMissTurns: 0,
    archivePlaceholders: 0,
    archiveWriteFailures: 0,
    archivePlaceholderReasonCounts: {},
    retrievedArchiveToolResults: 0,
    retrievedArchiveEstimatedTokens: 0,
    archiveRetrievalSkipped: 0,
    archiveRetrievalFailures: 0,
    archiveRetrievalFailureReasonCounts: {},
  },
);

const report = {
  sourceRef: process.env.MAKA_COST_BASELINE_SOURCE_REF ?? 'local-build',
  scenario: buildScenario(contextBudget),
  repoRoot,
  workspaceRoot,
  model,
  seed,
  toolMode,
  toolCount: tools.length,
  turnCount,
  stablePolicyLines,
  payloadLines,
  contextBudget,
  sessionId: session.id,
  totals,
  turns,
  runTracePrefixEvents: runTraceEvents
    .filter(
      (event) =>
        event.data?.prefixHash ||
        event.data?.prefixChangeReason ||
        event.data?.requestShapeHash ||
        event.data?.requestShapeChangeReason,
    )
    .map((event) => ({
      phase: event.phase,
      type: event.type,
      prefixHash: event.data?.prefixHash,
      prefixChangeReason: event.data?.prefixChangeReason,
      requestShapeHash: event.data?.requestShapeHash,
      requestShapeChangeReason: event.data?.requestShapeChangeReason,
      promptSegments: event.data?.promptSegments,
      contextBudget: event.data?.contextBudget,
    })),
};

const outputDir = join(outputRoot, runId);
await mkdir(outputDir, { recursive: true });
const jsonPath = join(outputDir, 'deepseek-live-cost-baseline.json');
const markdownPath = join(outputDir, 'deepseek-live-cost-baseline.md');
await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
await writeFile(markdownPath, renderMarkdown(report, jsonPath), 'utf8');
console.log(
  JSON.stringify({ jsonPath, markdownPath, totals, turnCount, toolMode, contextBudget }, null, 2),
);

async function runPhase7ToolMatrix(input) {
  const matrixOutputRoot = join(input.outputRoot, input.runId, 'phase7-tool-matrix');
  await mkdir(matrixOutputRoot, { recursive: true });
  const sentinel =
    process.env.MAKA_COST_BASELINE_PHASE7_SENTINEL ??
    `PHASE7_SENTINEL_${sha256(`${input.seed}:phase7`).slice(0, 16)}`;
  const lookupKey = process.env.MAKA_COST_BASELINE_PHASE7_LOOKUP_KEY ?? 'phase7-live-key';
  const resultLines = parsePositiveInt(process.env.MAKA_COST_BASELINE_PHASE7_RESULT_LINES, 220);
  const noisyArchiveCount = parsePositiveInt(
    process.env.MAKA_COST_BASELINE_PHASE7_NOISY_ARCHIVES,
    8,
  );
  const cases = [];
  for (const matrixCase of [
    { name: 'single_archive_recovery', noiseArchiveCount: 0 },
    { name: 'multi_archive_selectivity', noiseArchiveCount: noisyArchiveCount },
  ]) {
    const scenarios = [];
    for (const mode of ['full', 'prune', 'eager', 'gated']) {
      scenarios.push(
        await runPhase7ToolScenario({
          ...input,
          matrixOutputRoot: join(matrixOutputRoot, matrixCase.name),
          matrixCase: matrixCase.name,
          mode,
          sentinel,
          lookupKey,
          resultLines,
          noiseArchiveCount: matrixCase.noiseArchiveCount,
        }),
      );
    }
    cases.push({
      name: matrixCase.name,
      noiseArchiveCount: matrixCase.noiseArchiveCount,
      archiveCount: matrixCase.noiseArchiveCount + 1,
      scenarios,
    });
  }
  const scenarios = cases[0]?.scenarios ?? [];
  const invariantFailures = validatePhase7ToolMatrix(cases, sentinel);

  const report = {
    sourceRef: process.env.MAKA_COST_BASELINE_SOURCE_REF ?? 'local-build',
    scenario: {
      name: 'phase7_tool_archive_retrieval_matrix',
      cases: cases.map((matrixCase) => matrixCase.name),
      modes: scenarios.map((scenario) => scenario.mode),
    },
    passed: invariantFailures.length === 0,
    invariantFailures,
    repoRoot: input.repoRoot,
    outputRoot: matrixOutputRoot,
    model: input.model,
    seed: input.seed,
    lookupKey,
    sentinelSha256: sha256(sentinel),
    resultLines,
    noisyArchiveCount,
    cases,
    scenarios,
  };
  const jsonPath = resolve(
    process.env.MAKA_COST_BASELINE_PHASE7_MATRIX_JSON ??
      join(matrixOutputRoot, 'phase7-tool-live-matrix.json'),
  );
  await mkdir(resolve(jsonPath, '..'), { recursive: true });
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(
    JSON.stringify(
      {
        jsonPath,
        model: input.model,
        scenario: report.scenario.name,
        cases: cases.map((matrixCase) => ({
          name: matrixCase.name,
          modes: matrixCase.scenarios.map((scenario) => ({
            mode: scenario.mode,
            recoveredSentinel: scenario.recoveredSentinel,
            finalAnswerExactlySentinel: scenario.finalAnswerExactlySentinel,
            archivedToolResultsRead: scenario.archivedToolResultsRead,
            finalArchivedToolResultsRead: scenario.finalArchivedToolResultsRead,
            finalUsage: scenario.finalUsage,
            scenarioUsageTotals: scenario.scenarioUsageTotals,
            toolCalls: scenario.toolCalls.length,
          })),
        })),
        invariantFailures,
      },
      null,
      2,
    ),
  );
  if (invariantFailures.length > 0) {
    console.error(
      [
        'Phase 7 tool matrix invariant failures:',
        ...invariantFailures.map((failure) => `- ${failure}`),
      ].join('\n'),
    );
    return 1;
  }
  return 0;
}

async function runPhase7ToolScenario(input) {
  const workspaceRoot = join(input.matrixOutputRoot, input.mode, 'workspace');
  await mkdir(workspaceRoot, { recursive: true });
  const sessionStore = createSessionStore(workspaceRoot);
  const { runStore, runtimeEventStore } = await openCanonicalExecutionStores(workspaceRoot);
  const artifactStore = createSqliteArtifactStore(workspaceRoot);
  const backends = new BackendRegistry();
  const llmRecords = [];
  const runTraceEvents = [];
  const archiveReads = [];
  let activeTurnId;
  const tools = [buildPhase7LookupTool(input)];
  const connection = {
    slug: `deepseek-live-phase7-${input.mode}`,
    name: `DeepSeek live Phase 7 ${input.mode}`,
    providerType: 'deepseek',
    baseUrl: 'https://api.deepseek.com',
    defaultModel: input.model,
    enabled: true,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  const contextBudget = buildPhase7ContextBudgetPolicy(input.mode);
  const systemPrompt = [
    'You are a Maka Phase 7 live harness assistant.',
    `Lookup key: ${input.lookupKey}`,
    'When asked to store the Phase 7 lookup, call Phase7Lookup exactly once with the lookup key.',
    'After the tool result is available, answer exactly STORED.',
    'Do not include the sentinel value in the storage acknowledgement.',
    'When later asked to recover the sentinel, answer only the sentinel value found in prior tool results.',
    'Do not call Phase7Lookup during sentinel recovery; recovery must use prior context only.',
  ].join('\n');

  backends.register(
    'ai-sdk',
    async (ctx) =>
      new AiSdkBackend({
        sessionId: ctx.sessionId,
        header: { ...ctx.header, model: input.model },
        appendMessage: (message) => ctx.store.appendMessage(ctx.sessionId, message),
        connection,
        apiKey: input.apiKey,
        modelId: input.model,
        readExecutionBoundary: () => ctx.store.readExecutionBoundary(ctx.sessionId),
        modelFactory: getAIModel,
        tools,
        loadTurnRuntimeEvents: ctx.loadTurnRuntimeEvents,
        allowMidTurnHistoryCompaction: ctx.allowMidTurnHistoryCompaction,
        providerOptions: buildProviderOptions(connection, input.model),
        contextBudget,
        systemPrompt,
        turnTailPrompt: phase7TurnTailPrompt(input.cwd),
        recordLlmCall: (record) => llmRecords.push(record),
        recordRunTrace: (event) => runTraceEvents.push(event),
        archiveToolResult: async (event) => {
          const artifact = await artifactStore.create({
            sessionId: event.sessionId,
            turnId: event.turnId,
            name: `phase7-tool-result-${event.runtimeEventId}.json`,
            kind: 'file',
            content: event.serializedResult,
            mimeType: 'application/json',
            source: 'tool_result_archive',
            summary: `Archived ${event.toolName} Phase 7 tool result for ${input.mode}`,
          });
          return { artifactId: artifact.id };
        },
        readToolResultArchive: async (event) => {
          archiveReads.push({
            requestTurnId: activeTurnId,
            runtimeEventId: event.runtimeEventId,
            turnId: event.turnId,
            artifactId: event.artifactId,
          });
          const record = await artifactStore.get(event.artifactId);
          if (!record) return { ok: false, reason: 'not_found' };
          if (record.status === 'deleted') return { ok: false, reason: 'deleted' };
          if (record.source !== 'tool_result_archive')
            return { ok: false, reason: 'source_mismatch' };
          if (record.sessionId !== event.sessionId)
            return { ok: false, reason: 'session_mismatch' };
          if (record.sizeBytes !== event.originalBytes)
            return { ok: false, reason: 'size_mismatch' };
          const read = await artifactStore.readText(event.artifactId, {
            maxBytes: event.maxBytes ?? event.originalBytes,
          });
          if (!read.ok) return read;
          if (sha256(read.text) !== event.bodySha256) return { ok: false, reason: 'corrupt' };
          return { ok: true, serializedResult: read.text };
        },
        newId: randomUUID,
        now: Date.now,
        maxSteps: 4,
        streamConnectTimeoutMs: 30_000,
        streamIdleTimeoutMs: 120_000,
      }),
  );

  const manager = new SessionManager({
    store: sessionStore,
    runStore,
    runtimeEventStore,
    backends,
    newId: randomUUID,
    now: Date.now,
  });
  const session = await manager.createSession({
    cwd: input.cwd,
    backend: 'ai-sdk',
    llmConnectionSlug: connection.slug,
    model: input.model,
    permissionMode: 'explore',
    name: `DeepSeek Phase 7 ${input.mode}`,
  });

  const storeSpecs = buildPhase7StoreSpecs(input);
  const storeTurns = [];
  for (const storeSpec of storeSpecs) {
    storeTurns.push({
      ...storeSpec,
      ...(await sendPhase7ScenarioTurn(
        manager,
        session.id,
        storeSpec.turnId,
        [
          `Store the Phase 7 lookup for key ${storeSpec.key}.`,
          'Call Phase7Lookup, then acknowledge with exactly STORED.',
          'Do not repeat any sentinel value.',
        ].join('\n'),
        (turnId) => {
          activeTurnId = turnId;
        },
      )),
    });
  }
  const fillerTurn = await sendPhase7ScenarioTurn(
    manager,
    session.id,
    'phase7-filler',
    'Answer exactly OK. This turn exists so the old tool result becomes stale for pruning.',
    (turnId) => {
      activeTurnId = turnId;
    },
  );
  const recoverTurn = await sendPhase7ScenarioTurn(
    manager,
    session.id,
    'phase7-recover',
    `Recover the sentinel for lookup key ${input.lookupKey} from the archived Phase 7 tool result. Do not call tools. Answer only the sentinel.`,
    (turnId) => {
      activeTurnId = turnId;
    },
  );
  activeTurnId = undefined;
  const finalUsage = recoverTurn.events.find((event) => event.type === 'token_usage');
  const storageAnswerIncludedSentinel = storeTurns.some((turn) =>
    turn.assistantText.includes(input.sentinel),
  );
  const finalArchiveReads = archiveReads.filter((read) => read.requestTurnId === 'phase7-recover');
  const pricingId = `${connection.providerType}:${input.model}`;
  return {
    matrixCase: input.matrixCase,
    mode: input.mode,
    contextBudget,
    sessionId: session.id,
    storeTurns: storeTurns.map((turn) => ({
      turnId: turn.turnId,
      key: turn.key,
      target: turn.target,
      assistantText: turn.assistantText,
    })),
    expectedToolCallTurns: storeSpecs.map((spec) => spec.turnId),
    targetToolCallTurnId: storeSpecs.find((spec) => spec.target)?.turnId,
    toolCalls: [
      ...storeTurns.flatMap((turn) => turn.events),
      ...fillerTurn.events,
      ...recoverTurn.events,
    ]
      .filter((event) => event.type === 'tool_start')
      .map((event) => ({ turnId: event.turnId, toolName: event.toolName })),
    storageAnswerIncludedSentinel,
    finalAnswer: recoverTurn.assistantText,
    recoveredSentinel: recoverTurn.assistantText.includes(input.sentinel),
    finalAnswerExactlySentinel: recoverTurn.assistantText.trim() === input.sentinel,
    archivedToolResultsRead: archiveReads.length,
    archiveReads,
    finalArchivedToolResultsRead: finalArchiveReads.length,
    finalArchiveReads,
    finalContextBudget: finalUsage?.contextBudget,
    finalUsage: usageSummary(finalUsage, llmRecords.at(-1), pricingId),
    scenarioUsageTotals: usageTotals(llmRecords, pricingId),
    requestShapeTrace: runTraceEvents
      .filter(
        (event) =>
          event.data?.requestShapeHash ||
          event.data?.requestShapeChangeReason ||
          event.data?.contextBudget,
      )
      .map((event) => ({
        phase: event.phase,
        type: event.type,
        requestShapeHash: event.data?.requestShapeHash,
        requestShapeChangeReason: event.data?.requestShapeChangeReason,
        contextBudget: event.data?.contextBudget,
      })),
  };
}

async function runPhase8SynthesisMatrix(input) {
  const matrixOutputRoot = join(input.outputRoot, input.runId, 'phase8-synthesis-matrix');
  await mkdir(matrixOutputRoot, { recursive: true });
  const sentinel =
    process.env.MAKA_COST_BASELINE_PHASE7_SENTINEL ??
    `PHASE7_SENTINEL_${sha256(`${input.seed}:phase7`).slice(0, 16)}`;
  const lookupKey = process.env.MAKA_COST_BASELINE_PHASE7_LOOKUP_KEY ?? 'phase7-live-key';
  const resultLines = parsePositiveInt(process.env.MAKA_COST_BASELINE_PHASE7_RESULT_LINES, 220);
  const noisyArchiveCount = parsePositiveInt(
    process.env.MAKA_COST_BASELINE_PHASE7_NOISY_ARCHIVES,
    8,
  );
  const cases = [];
  for (const matrixCase of [
    { name: 'single_archive_recovery', noiseArchiveCount: 0 },
    { name: 'multi_archive_selectivity', noiseArchiveCount: noisyArchiveCount },
  ]) {
    const scenarios = [];
    for (const mode of ['full', 'gated', 'synthesis_gated']) {
      scenarios.push(
        await runPhase8SynthesisScenario({
          ...input,
          matrixOutputRoot: join(matrixOutputRoot, matrixCase.name),
          matrixCase: matrixCase.name,
          mode,
          sentinel,
          lookupKey,
          resultLines,
          noiseArchiveCount: matrixCase.noiseArchiveCount,
        }),
      );
    }
    cases.push({
      name: matrixCase.name,
      noiseArchiveCount: matrixCase.noiseArchiveCount,
      archiveCount: matrixCase.noiseArchiveCount + 1,
      scenarios,
    });
  }
  const invariantFailures = validatePhase8SynthesisMatrix(cases, sentinel);
  const scenarios = cases[0]?.scenarios ?? [];
  const report = {
    sourceRef: process.env.MAKA_COST_BASELINE_SOURCE_REF ?? 'local-build',
    scenario: {
      name: 'phase8_synthesis_cache_high_water_matrix',
      cases: cases.map((matrixCase) => matrixCase.name),
      modes: scenarios.map((scenario) => scenario.mode),
    },
    passed: invariantFailures.length === 0,
    invariantFailures,
    repoRoot: input.repoRoot,
    outputRoot: matrixOutputRoot,
    model: input.model,
    seed: input.seed,
    lookupKey,
    sentinelSha256: sha256(sentinel),
    resultLines,
    noisyArchiveCount,
    cases,
    scenarios,
  };
  const jsonPath = resolve(
    process.env.MAKA_COST_BASELINE_PHASE8_MATRIX_JSON ??
      join(matrixOutputRoot, 'phase8-synthesis-live-matrix.json'),
  );
  await mkdir(resolve(jsonPath, '..'), { recursive: true });
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(
    JSON.stringify(
      {
        jsonPath,
        model: input.model,
        scenario: report.scenario.name,
        cases: cases.map((matrixCase) => ({
          name: matrixCase.name,
          modes: matrixCase.scenarios.map((scenario) => ({
            mode: scenario.mode,
            recoveryArchivedToolResultsRead: scenario.recoveryArchivedToolResultsRead,
            repeatedAnswerExactlySentinel: scenario.repeatedAnswerExactlySentinel,
            repeatedArchivedToolResultsRead: scenario.repeatedArchivedToolResultsRead,
            rawEvidenceArchivedToolResultsRead: scenario.rawEvidenceArchivedToolResultsRead,
            noiseCoverageArchivedToolResultsRead: scenario.noiseCoverageArchivedToolResultsRead,
            selectedSynthesisBlockIds: scenario.repeatedContextBudget?.synthesisCacheBlockIds ?? [],
            noiseSynthesisSelected:
              scenario.noiseCoverageContextBudget?.synthesisCacheBlocksSelected ?? 0,
            recoveryUsage: scenario.recoveryUsage,
            repeatedUsage: scenario.repeatedUsage,
            scenarioUsageTotals: scenario.scenarioUsageTotals,
          })),
        })),
        invariantFailures,
      },
      null,
      2,
    ),
  );
  if (invariantFailures.length > 0) {
    console.error(
      [
        'Phase 8 synthesis matrix invariant failures:',
        ...invariantFailures.map((failure) => `- ${failure}`),
      ].join('\n'),
    );
    return 1;
  }
  return 0;
}

async function runPhase9SynthesisLifecycleMatrix(input) {
  const matrixOutputRoot = join(input.outputRoot, input.runId, 'phase9-synthesis-lifecycle');
  await mkdir(matrixOutputRoot, { recursive: true });
  const sentinel =
    process.env.MAKA_COST_BASELINE_PHASE7_SENTINEL ??
    `PHASE9_SENTINEL_${sha256(`${input.seed}:phase9`).slice(0, 16)}`;
  const lookupKey = process.env.MAKA_COST_BASELINE_PHASE7_LOOKUP_KEY ?? 'phase9-live-key';
  const resultLines = parsePositiveInt(process.env.MAKA_COST_BASELINE_PHASE7_RESULT_LINES, 220);
  const noisyArchiveCount = parsePositiveInt(
    process.env.MAKA_COST_BASELINE_PHASE7_NOISY_ARCHIVES,
    8,
  );
  const cases = [];
  for (const matrixCase of [
    { name: 'generated_block_reuse', noiseArchiveCount: 0 },
    { name: 'bounded_budget_and_fallbacks', noiseArchiveCount: noisyArchiveCount },
  ]) {
    const scenarios = [];
    for (const mode of ['full', 'gated', 'synthesis_read_write']) {
      scenarios.push(
        await runPhase8SynthesisScenario({
          ...input,
          matrixOutputRoot: join(matrixOutputRoot, matrixCase.name),
          matrixCase: matrixCase.name,
          mode,
          sentinel,
          lookupKey,
          resultLines,
          noiseArchiveCount: matrixCase.noiseArchiveCount,
        }),
      );
    }
    cases.push({
      name: matrixCase.name,
      noiseArchiveCount: matrixCase.noiseArchiveCount,
      archiveCount: matrixCase.noiseArchiveCount + 1,
      scenarios,
    });
  }
  const invariantFailures = validatePhase9SynthesisLifecycleMatrix(cases, sentinel);
  const scenarios = cases[0]?.scenarios ?? [];
  const report = {
    sourceRef: process.env.MAKA_COST_BASELINE_SOURCE_REF ?? 'local-build',
    scenario: {
      name: 'phase9_synthesis_cache_lifecycle_matrix',
      cases: cases.map((matrixCase) => matrixCase.name),
      modes: scenarios.map((scenario) => scenario.mode),
    },
    passed: invariantFailures.length === 0,
    invariantFailures,
    repoRoot: input.repoRoot,
    outputRoot: matrixOutputRoot,
    model: input.model,
    seed: input.seed,
    lookupKey,
    sentinelSha256: sha256(sentinel),
    resultLines,
    noisyArchiveCount,
    cases,
    scenarios,
  };
  const jsonPath = resolve(
    process.env.MAKA_COST_BASELINE_PHASE9_MATRIX_JSON ??
      join(matrixOutputRoot, 'phase9-synthesis-lifecycle-matrix.json'),
  );
  await mkdir(resolve(jsonPath, '..'), { recursive: true });
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(
    JSON.stringify(
      {
        jsonPath,
        model: input.model,
        scenario: report.scenario.name,
        cases: cases.map((matrixCase) => ({
          name: matrixCase.name,
          modes: matrixCase.scenarios.map((scenario) => ({
            mode: scenario.mode,
            writesAttempted: scenario.recoveryContextBudget?.synthesisCacheWritesAttempted ?? 0,
            blocksWritten: scenario.recoveryContextBudget?.synthesisCacheBlocksWritten ?? 0,
            artifactBackedWrites:
              scenario.synthesisCacheWrites?.reduce(
                (total, write) => total + (write.blockIds?.length ?? 0),
                0,
              ) ?? 0,
            persistedArtifacts: scenario.persistedSynthesisArtifactIds?.length ?? 0,
            repeatedLoadedBlocks: scenario.repeatedContextBudget?.synthesisCacheBlocksLoaded ?? 0,
            repeatedSelectedBlocks:
              scenario.repeatedContextBudget?.synthesisCacheBlocksSelected ?? 0,
            repeatedArchivedToolResultsRead: scenario.repeatedArchivedToolResultsRead,
            rawEvidenceArchivedToolResultsRead: scenario.rawEvidenceArchivedToolResultsRead,
            recoveryUsage: scenario.recoveryUsage,
            repeatedUsage: scenario.repeatedUsage,
          })),
        })),
        invariantFailures,
      },
      null,
      2,
    ),
  );
  if (invariantFailures.length > 0) {
    console.error(
      [
        'Phase 9 synthesis lifecycle matrix invariant failures:',
        ...invariantFailures.map((failure) => `- ${failure}`),
      ].join('\n'),
    );
    return 1;
  }
  return 0;
}

async function runPhase10HistoryCompactMatrix(input) {
  const matrixOutputRoot = join(input.outputRoot, input.runId, 'phase10-history-compact');
  await mkdir(matrixOutputRoot, { recursive: true });
  const sentinel =
    process.env.MAKA_COST_BASELINE_PHASE10_SENTINEL ??
    `PHASE10_SENTINEL_${sha256(`${input.seed}:phase10`).slice(0, 16)}`;
  const payloadLines = parsePositiveInt(process.env.MAKA_COST_BASELINE_PHASE10_PAYLOAD_LINES, 120);
  const matrixCase = {
    name: 'text_history_recovery',
    oldTurnCount: 1,
    payloadLines,
  };
  const scenarios = [];
  for (const mode of ['full', 'deterministic', 'history_compact_read_write']) {
    scenarios.push(
      await runPhase10HistoryCompactScenario({
        ...input,
        matrixOutputRoot: join(matrixOutputRoot, matrixCase.name),
        matrixCase: matrixCase.name,
        mode,
        sentinel,
        payloadLines,
      }),
    );
  }
  const cases = [
    {
      ...matrixCase,
      scenarios,
    },
  ];
  const invariantFailures = validatePhase10HistoryCompactMatrix(cases, sentinel);
  const byMode = new Map(scenarios.map((scenario) => [scenario.mode, scenario]));
  const full = byMode.get('full');
  const deterministic = byMode.get('deterministic');
  const readWrite = byMode.get('history_compact_read_write');
  const report = {
    sourceRef: process.env.MAKA_COST_BASELINE_SOURCE_REF ?? 'local-build',
    scenario: {
      name: 'phase10_history_compact_matrix',
      cases: cases.map((item) => item.name),
      modes: scenarios.map((scenario) => scenario.mode),
    },
    passed: invariantFailures.length === 0,
    invariantFailures,
    repoRoot: input.repoRoot,
    outputRoot: matrixOutputRoot,
    model: input.model,
    seed: input.seed,
    sentinelSha256: sha256(sentinel),
    payloadLines,
    comparisons: {
      deterministicRepeatedVsFull: usageDelta(full?.repeatedUsage, deterministic?.repeatedUsage),
      readWriteRepeatedVsFull: usageDelta(full?.repeatedUsage, readWrite?.repeatedUsage),
      readWriteRepeatedVsDeterministic: usageDelta(
        deterministic?.repeatedUsage,
        readWrite?.repeatedUsage,
      ),
    },
    cases,
    scenarios,
  };
  const jsonPath = resolve(
    process.env.MAKA_COST_BASELINE_PHASE10_MATRIX_JSON ??
      join(matrixOutputRoot, 'phase10-history-compact-live-matrix.json'),
  );
  await mkdir(resolve(jsonPath, '..'), { recursive: true });
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(
    JSON.stringify(
      {
        jsonPath,
        model: input.model,
        scenario: report.scenario.name,
        cases: cases.map((item) => ({
          name: item.name,
          modes: item.scenarios.map((scenario) => ({
            mode: scenario.mode,
            recoveryAnswerExactlySentinel: scenario.recoveryAnswerExactlySentinel,
            repeatedAnswerExactlySentinel: scenario.repeatedAnswerExactlySentinel,
            recoveryHistoryCompactSelected:
              scenario.recoveryContextBudget?.historyCompactBlocksSelected ?? 0,
            recoveryHistoryCompactWritten:
              scenario.recoveryContextBudget?.historyCompactBlocksWritten ?? 0,
            repeatedHistoryCompactLoaded:
              scenario.repeatedContextBudget?.historyCompactBlocksLoaded ?? 0,
            repeatedHistoryCompactSelected:
              scenario.repeatedContextBudget?.historyCompactBlocksSelected ?? 0,
            repeatedHistoryCompactWriteAttempts:
              scenario.repeatedContextBudget?.historyCompactWritesAttempted ?? 0,
            persistedBlockArtifacts: scenario.persistedHistoryCompactArtifactIds?.length ?? 0,
            persistedSourceArtifacts:
              scenario.persistedHistoryCompactSourceArtifactIds?.length ?? 0,
            recoveryUsage: scenario.recoveryUsage,
            repeatedUsage: scenario.repeatedUsage,
            scenarioUsageTotals: scenario.scenarioUsageTotals,
          })),
        })),
        comparisons: report.comparisons,
        invariantFailures,
      },
      null,
      2,
    ),
  );
  if (invariantFailures.length > 0) {
    console.error(
      [
        'Phase 10 history compact matrix invariant failures:',
        ...invariantFailures.map((failure) => `- ${failure}`),
      ].join('\n'),
    );
    return 1;
  }
  return 0;
}

async function loadPersistedHistoryCompactBlocksFromArtifacts(artifactStore, input) {
  const maxBlocks = input.maxBlocks ?? 1;
  const maxEstimatedTokens = input.maxEstimatedTokens ?? 2_048;
  const maxBytes = input.maxBytes ?? maxEstimatedTokens * 4;
  const skippedReasonCounts = {};
  const blocks = [];
  const records = await artifactStore.list(input.sessionId, { includeDeleted: true });
  for (const record of records) {
    if (record.status !== 'live') {
      incrementCount(skippedReasonCounts, 'deleted');
      continue;
    }
    if (record.source !== 'history_compact_block' || record.kind !== 'file') {
      continue;
    }
    if (record.sessionId !== input.sessionId) {
      incrementCount(skippedReasonCounts, 'session_mismatch');
      continue;
    }
    if (blocks.length >= maxBlocks) {
      incrementCount(skippedReasonCounts, 'max_blocks');
      continue;
    }
    if (record.sizeBytes > maxBytes) {
      incrementCount(skippedReasonCounts, 'max_bytes');
      continue;
    }
    const read = await artifactStore.readText(record.id, { maxBytes });
    if (!read.ok) {
      incrementCount(skippedReasonCounts, read.reason);
      continue;
    }
    let parsed;
    try {
      parsed = JSON.parse(read.text);
    } catch {
      incrementCount(skippedReasonCounts, 'invalid_json');
      continue;
    }
    if (
      parsed &&
      typeof parsed === 'object' &&
      typeof parsed.sessionId === 'string' &&
      parsed.sessionId !== input.sessionId
    ) {
      incrementCount(skippedReasonCounts, 'session_mismatch');
      continue;
    }
    if (!validateHistoryCompactBlockShape(parsed, input.sessionId)) {
      incrementCount(skippedReasonCounts, 'invalid_schema_version');
      continue;
    }
    const estimatedTokens = parsed.estimatedTokens ?? estimateTokens(read.text.length, 4);
    if (estimatedTokens > maxEstimatedTokens) {
      incrementCount(skippedReasonCounts, 'max_total_tokens');
      continue;
    }
    blocks.push({ ...parsed, estimatedTokens });
  }
  const skipped = Object.values(skippedReasonCounts).reduce((total, count) => total + count, 0);
  return {
    blocks,
    ...(skipped > 0 ? { skipped } : {}),
    ...(skipped > 0 ? { skippedReasonCounts } : {}),
  };
}

async function persistPhase10HistoryCompactBlocksToArtifacts(artifactStore, event, input) {
  const now = Date.now();
  const sourceArchiveRefs = [];
  const sourceArtifactIds = [];
  const blockArtifactIds = [];
  for (const runtimeEvent of event.source.foldedRuntimeEvents) {
    const serializedBody = serializeHistoryCompactSourceBody(runtimeEvent.content ?? {});
    const artifact = await artifactStore.create({
      sessionId: event.sessionId,
      turnId: runtimeEvent.turnId,
      name: `phase10-history-compact-source-${runtimeEvent.id}.json`,
      kind: 'file',
      content: JSON.stringify(runtimeEvent, null, 2),
      mimeType: 'application/json',
      source: 'history_compact_source',
      summary: 'Archived RuntimeEvent source for Phase 10 history compact replay',
    });
    sourceArtifactIds.push(artifact.id);
    sourceArchiveRefs.push({
      runtimeEventId: runtimeEvent.id,
      artifactId: artifact.id,
      bodySha256: sha256(serializedBody),
      originalEstimatedTokens: estimateTokens(serializedBody.length, event.limits.charsPerToken),
      originalBytes: Buffer.byteLength(serializedBody, 'utf8'),
    });
  }
  const block = buildHistoryCompactBlockFromSummary({
    sessionId: event.sessionId,
    foldedRuntimeEvents: event.source.foldedRuntimeEvents,
    summary: buildPhase10HostHistoryCompactSummary(input, event),
    highWaterName: event.source.draftBlock.highWaterName,
    highWaterSeq: event.source.draftBlock.highWaterSeq,
    maxSummaryEstimatedTokens: event.limits.maxBlockEstimatedTokens,
    sourceArchiveRefs,
    requestShapeHashBefore: event.requestShapeHashBefore,
    requestShapeHashAfter: event.requestShapeHashAfter,
    now,
    charsPerToken: event.limits.charsPerToken,
  });
  if ((block.estimatedTokens ?? 0) > event.limits.maxBlockEstimatedTokens) {
    return {
      blocks: [],
      skipped: 1,
      skippedReasonCounts: { max_block_tokens: 1 },
      sourceArtifactIds,
      blockArtifactIds,
    };
  }
  if ((block.estimatedTokens ?? 0) > event.limits.maxEstimatedTokens) {
    return {
      blocks: [],
      skipped: 1,
      skippedReasonCounts: { max_total_tokens: 1 },
      sourceArtifactIds,
      blockArtifactIds,
    };
  }
  const artifact = await artifactStore.create({
    sessionId: event.sessionId,
    turnId: event.turnId,
    name: `phase10-history-compact-${block.blockId}.json`,
    kind: 'file',
    content: JSON.stringify(block, null, 2),
    mimeType: 'application/json',
    source: 'history_compact_block',
    summary: 'Phase 10 history compact block for context budget replay',
  });
  blockArtifactIds.push(artifact.id);
  return {
    blocks: [block],
    sourceArtifactIds,
    blockArtifactIds,
  };
}

async function runPhase10HistoryCompactScenario(input) {
  const workspaceRoot = join(input.matrixOutputRoot, input.mode, 'workspace');
  await mkdir(workspaceRoot, { recursive: true });
  const sessionStore = createSessionStore(workspaceRoot);
  const { runStore, runtimeEventStore } = await openCanonicalExecutionStores(workspaceRoot);
  const artifactStore = createSqliteArtifactStore(workspaceRoot);
  const backends = new BackendRegistry();
  const llmRecords = [];
  const runTraceEvents = [];
  const historyCompactLoads = [];
  const historyCompactWrites = [];
  const persistedHistoryCompactArtifactIds = [];
  const persistedHistoryCompactSourceArtifactIds = [];
  let activeTurnId;
  const connection = {
    slug: `deepseek-live-phase10-${input.mode}`,
    name: `DeepSeek live Phase 10 ${input.mode}`,
    providerType: 'deepseek',
    baseUrl: 'https://api.deepseek.com',
    defaultModel: input.model,
    enabled: true,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  const contextBudget = buildPhase10ContextBudgetPolicy(input.mode);
  const systemPrompt = [
    'You are a Maka Phase 10 live harness assistant.',
    'For Phase 10 storage turns, answer exactly STORED and do not repeat the sentinel.',
    'When asked to recover the Phase 10 sentinel, answer only the sentinel value from prior context or a <maka_history_compact_block>.',
    'Never call tools for this harness.',
  ].join('\n');

  backends.register(
    'ai-sdk',
    async (ctx) =>
      new AiSdkBackend({
        sessionId: ctx.sessionId,
        header: { ...ctx.header, model: input.model },
        appendMessage: (message) => ctx.store.appendMessage(ctx.sessionId, message),
        connection,
        apiKey: input.apiKey,
        modelId: input.model,
        readExecutionBoundary: () => ctx.store.readExecutionBoundary(ctx.sessionId),
        modelFactory: getAIModel,
        tools: [],
        loadTurnRuntimeEvents: ctx.loadTurnRuntimeEvents,
        allowMidTurnHistoryCompaction: ctx.allowMidTurnHistoryCompaction,
        providerOptions: buildProviderOptions(connection, input.model),
        contextBudget,
        systemPrompt,
        turnTailPrompt: phase7TurnTailPrompt(input.cwd),
        recordLlmCall: (record) => llmRecords.push(record),
        recordRunTrace: (event) => runTraceEvents.push(event),
        loadHistoryCompact: async (event) => {
          const loaded = await loadPersistedHistoryCompactBlocksFromArtifacts(artifactStore, event);
          historyCompactLoads.push({
            requestTurnId: activeTurnId,
            blockIds: loaded.blocks.map((block) => block.blockId),
            skipped: loaded.skipped ?? 0,
            skippedReasonCounts: loaded.skippedReasonCounts ?? {},
          });
          return loaded;
        },
        writeHistoryCompact: async (event) => {
          const persisted = await persistPhase10HistoryCompactBlocksToArtifacts(
            artifactStore,
            event,
            input,
          );
          persistedHistoryCompactArtifactIds.push(...(persisted.blockArtifactIds ?? []));
          persistedHistoryCompactSourceArtifactIds.push(...(persisted.sourceArtifactIds ?? []));
          historyCompactWrites.push({
            requestTurnId: activeTurnId,
            blockIds: persisted.blocks.map((block) => block.blockId),
            blockArtifactIds: persisted.blockArtifactIds ?? [],
            sourceArtifactIds: persisted.sourceArtifactIds ?? [],
            skipped: persisted.skipped ?? 0,
            skippedReasonCounts: persisted.skippedReasonCounts ?? {},
          });
          return {
            blocks: persisted.blocks,
            ...(persisted.skipped > 0 ? { skipped: persisted.skipped } : {}),
            ...(persisted.skippedReasonCounts
              ? { skippedReasonCounts: persisted.skippedReasonCounts }
              : {}),
          };
        },
        newId: randomUUID,
        now: Date.now,
        maxSteps: 1,
        streamConnectTimeoutMs: 30_000,
        streamIdleTimeoutMs: 120_000,
      }),
  );

  const manager = new SessionManager({
    store: sessionStore,
    runStore,
    runtimeEventStore,
    backends,
    newId: randomUUID,
    now: Date.now,
  });
  const session = await manager.createSession({
    cwd: input.cwd,
    backend: 'ai-sdk',
    llmConnectionSlug: connection.slug,
    model: input.model,
    permissionMode: 'explore',
    name: `DeepSeek Phase 10 ${input.mode}`,
  });

  async function sendRecordedTurn(turnId, text) {
    activeTurnId = turnId;
    const recordIndex = llmRecords.length;
    try {
      const turn = await sendPhase7Turn(manager, session.id, turnId, text);
      return {
        ...turn,
        usageEvent: turn.events.find((event) => event.type === 'token_usage'),
        llmRecord: llmRecords[recordIndex] ?? llmRecords.at(-1),
      };
    } finally {
      activeTurnId = undefined;
    }
  }

  const storeTurn = await sendRecordedTurn('phase10-store-old', buildPhase10StoragePrompt(input));
  const fillerTurn = await sendRecordedTurn(
    'phase10-filler',
    'Answer exactly OK. This small turn keeps the large Phase 10 memory outside the retained tail during recovery.',
  );
  const recoveryTurn = await sendRecordedTurn(
    'phase10-recovery',
    'Recover the Phase 10 sentinel from prior context. Do not explain. Answer only the sentinel.',
  );
  const repeatedTurn = await sendRecordedTurn(
    'phase10-repeated-recovery',
    'Recover the Phase 10 sentinel again from prior context. Do not explain. Answer only the sentinel.',
  );

  const pricingId = `${connection.providerType}:${input.model}`;
  return {
    matrixCase: input.matrixCase,
    mode: input.mode,
    contextBudget,
    sessionId: session.id,
    storageAnswer: storeTurn.assistantText,
    storageAnswerIncludedSentinel: storeTurn.assistantText.includes(input.sentinel),
    fillerAnswer: fillerTurn.assistantText,
    recoveryAnswer: recoveryTurn.assistantText,
    recoveryRecoveredSentinel: recoveryTurn.assistantText.includes(input.sentinel),
    recoveryAnswerExactlySentinel: recoveryTurn.assistantText.trim() === input.sentinel,
    repeatedAnswer: repeatedTurn.assistantText,
    repeatedRecoveredSentinel: repeatedTurn.assistantText.includes(input.sentinel),
    repeatedAnswerExactlySentinel: repeatedTurn.assistantText.trim() === input.sentinel,
    historyCompactLoads,
    historyCompactWrites,
    persistedHistoryCompactArtifactIds,
    persistedHistoryCompactSourceArtifactIds,
    recoveryContextBudget: recoveryTurn.usageEvent?.contextBudget,
    repeatedContextBudget: repeatedTurn.usageEvent?.contextBudget,
    recoveryUsage: usageSummary(recoveryTurn.usageEvent, recoveryTurn.llmRecord, pricingId),
    repeatedUsage: usageSummary(repeatedTurn.usageEvent, repeatedTurn.llmRecord, pricingId),
    scenarioUsageTotals: usageTotals(llmRecords, pricingId),
    requestShapeTrace: runTraceEvents
      .filter(
        (event) =>
          event.data?.requestShapeHash ||
          event.data?.requestShapeChangeReason ||
          event.data?.contextBudget,
      )
      .map((event) => ({
        phase: event.phase,
        type: event.type,
        requestShapeHash: event.data?.requestShapeHash,
        requestShapeChangeReason: event.data?.requestShapeChangeReason,
        contextBudget: event.data?.contextBudget,
      })),
  };
}

async function loadPersistedSynthesisCacheBlocksFromArtifacts(artifactStore, input) {
  const maxBlocks = input.maxBlocks ?? 1;
  const maxEstimatedTokens = input.maxEstimatedTokens ?? 2_048;
  const maxBytes = input.maxBytes ?? maxEstimatedTokens * 4;
  const skippedReasonCounts = {};
  const blocks = [];
  const records = await artifactStore.list(input.sessionId, { includeDeleted: true });
  for (const record of records) {
    if (record.status !== 'live') {
      incrementCount(skippedReasonCounts, 'deleted');
      continue;
    }
    if (record.source !== 'synthesis_cache_block' || record.kind !== 'file') {
      continue;
    }
    if (record.sessionId !== input.sessionId) {
      incrementCount(skippedReasonCounts, 'session_mismatch');
      continue;
    }
    if (blocks.length >= maxBlocks) {
      incrementCount(skippedReasonCounts, 'max_blocks');
      continue;
    }
    if (record.sizeBytes > maxBytes) {
      incrementCount(skippedReasonCounts, 'max_bytes');
      continue;
    }
    const read = await artifactStore.readText(record.id, { maxBytes });
    if (!read.ok) {
      incrementCount(skippedReasonCounts, read.reason);
      continue;
    }
    let parsed;
    try {
      parsed = JSON.parse(read.text);
    } catch {
      incrementCount(skippedReasonCounts, 'invalid_json');
      continue;
    }
    if (
      parsed &&
      typeof parsed === 'object' &&
      typeof parsed.sessionId === 'string' &&
      parsed.sessionId !== input.sessionId
    ) {
      incrementCount(skippedReasonCounts, 'session_mismatch');
      continue;
    }
    if (!validateSynthesisCacheBlockShape(parsed, input.sessionId)) {
      incrementCount(skippedReasonCounts, 'invalid_schema_version');
      continue;
    }
    const estimatedTokens = parsed.estimatedTokens ?? estimateTokens(read.text.length, 4);
    if (estimatedTokens > maxEstimatedTokens) {
      incrementCount(skippedReasonCounts, 'max_total_tokens');
      continue;
    }
    blocks.push({
      ...parsed,
      estimatedTokens,
    });
  }
  const skipped = Object.values(skippedReasonCounts).reduce((total, count) => total + count, 0);
  return {
    blocks,
    ...(skipped > 0 ? { skipped } : {}),
    ...(skipped > 0 ? { skippedReasonCounts } : {}),
  };
}

async function runPhase8SynthesisScenario(input) {
  const workspaceRoot = join(input.matrixOutputRoot, input.mode, 'workspace');
  await mkdir(workspaceRoot, { recursive: true });
  const sessionStore = createSessionStore(workspaceRoot);
  const { runStore, runtimeEventStore } = await openCanonicalExecutionStores(workspaceRoot);
  const artifactStore = createSqliteArtifactStore(workspaceRoot);
  const backends = new BackendRegistry();
  const llmRecords = [];
  const runTraceEvents = [];
  const archiveReads = [];
  const archiveRefsByRuntimeEventId = new Map();
  const synthesisBlocks = [];
  const persistedSynthesisArtifactIds = [];
  const synthesisCacheLoads = [];
  const synthesisCacheWrites = [];
  let activeTurnId;
  const tools = [buildPhase7LookupTool(input)];
  const connection = {
    slug: `deepseek-live-phase8-${input.mode}`,
    name: `DeepSeek live Phase 8 ${input.mode}`,
    providerType: 'deepseek',
    baseUrl: 'https://api.deepseek.com',
    defaultModel: input.model,
    enabled: true,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  const contextBudget = buildPhase8ContextBudgetPolicy(input.mode, synthesisBlocks);
  const systemPrompt = [
    'You are a Maka Phase 8 live harness assistant.',
    `Lookup key: ${input.lookupKey}`,
    'When asked to store the Phase 8 lookup, call Phase7Lookup exactly once with the lookup key.',
    'After the tool result is available, answer exactly STORED.',
    'Do not include the sentinel value in the storage acknowledgement.',
    'When later asked to recover the sentinel, answer only the sentinel value found in prior tool results or a source-bearing synthesis cache block.',
    'Do not call Phase7Lookup during sentinel recovery; recovery must use prior context only.',
  ].join('\n');

  backends.register(
    'ai-sdk',
    async (ctx) =>
      new AiSdkBackend({
        sessionId: ctx.sessionId,
        header: { ...ctx.header, model: input.model },
        appendMessage: (message) => ctx.store.appendMessage(ctx.sessionId, message),
        connection,
        apiKey: input.apiKey,
        modelId: input.model,
        readExecutionBoundary: () => ctx.store.readExecutionBoundary(ctx.sessionId),
        modelFactory: getAIModel,
        tools,
        loadTurnRuntimeEvents: ctx.loadTurnRuntimeEvents,
        allowMidTurnHistoryCompaction: ctx.allowMidTurnHistoryCompaction,
        providerOptions: buildProviderOptions(connection, input.model),
        contextBudget,
        systemPrompt,
        turnTailPrompt: phase7TurnTailPrompt(input.cwd),
        recordLlmCall: (record) => llmRecords.push(record),
        recordRunTrace: (event) => runTraceEvents.push(event),
        archiveToolResult: async (event) => {
          const cached = archiveRefsByRuntimeEventId.get(event.runtimeEventId);
          if (
            cached &&
            cached.bodySha256 === event.bodySha256 &&
            cached.originalBytes === event.originalBytes &&
            cached.originalEstimatedTokens === event.originalEstimatedTokens
          ) {
            return { artifactId: cached.artifactId };
          }
          const artifact = await artifactStore.create({
            sessionId: event.sessionId,
            turnId: event.turnId,
            name: `phase8-tool-result-${event.runtimeEventId}.json`,
            kind: 'file',
            content: event.serializedResult,
            mimeType: 'application/json',
            source: 'tool_result_archive',
            summary: `Archived ${event.toolName} Phase 8 tool result for ${input.mode}`,
          });
          archiveRefsByRuntimeEventId.set(event.runtimeEventId, {
            sessionId: event.sessionId,
            turnId: event.turnId,
            runtimeEventId: event.runtimeEventId,
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            artifactId: artifact.id,
            bodySha256: event.bodySha256,
            originalEstimatedTokens: event.originalEstimatedTokens,
            originalBytes: event.originalBytes,
            placeholderReason: event.reason,
          });
          return { artifactId: artifact.id };
        },
        readToolResultArchive: async (event) => {
          archiveReads.push({
            requestTurnId: activeTurnId,
            runtimeEventId: event.runtimeEventId,
            turnId: event.turnId,
            artifactId: event.artifactId,
          });
          const record = await artifactStore.get(event.artifactId);
          if (!record) return { ok: false, reason: 'not_found' };
          if (record.status === 'deleted') return { ok: false, reason: 'deleted' };
          if (record.source !== 'tool_result_archive')
            return { ok: false, reason: 'source_mismatch' };
          if (record.sessionId !== event.sessionId)
            return { ok: false, reason: 'session_mismatch' };
          if (record.sizeBytes !== event.originalBytes)
            return { ok: false, reason: 'size_mismatch' };
          const read = await artifactStore.readText(event.artifactId, {
            maxBytes: event.maxBytes ?? event.originalBytes,
          });
          if (!read.ok) return read;
          if (sha256(read.text) !== event.bodySha256) return { ok: false, reason: 'corrupt' };
          return { ok: true, serializedResult: read.text };
        },
        loadSynthesisCache: async (event) => {
          const loaded = await loadPersistedSynthesisCacheBlocksFromArtifacts(artifactStore, event);
          synthesisCacheLoads.push({
            requestTurnId: activeTurnId,
            blockIds: loaded.blocks.map((block) => block.blockId),
            skipped: loaded.skipped ?? 0,
            skippedReasonCounts: loaded.skippedReasonCounts ?? {},
          });
          return loaded;
        },
        writeSynthesisCache: async (event) => {
          const built = buildSynthesisCacheBlocksFromHydratedArchives({
            sessionId: event.sessionId,
            query: event.source.query,
            hydratedRuntimeEvents: event.source.hydratedRuntimeEvents,
            retrievedArchiveRefs: event.source.retrievedArchiveRefs,
            archiveRetrievalMode: event.source.archiveRetrievalMode,
            limits: event.limits,
            ...(event.requestShapeHashBefore
              ? { requestShapeHashBefore: event.requestShapeHashBefore }
              : {}),
            ...(event.requestShapeHashAfter
              ? { requestShapeHashAfter: event.requestShapeHashAfter }
              : {}),
            now: Date.now(),
          });
          const artifactIds = [];
          for (const block of built.blocks) {
            const artifact = await artifactStore.create({
              sessionId: event.sessionId,
              turnId: event.turnId,
              name: `phase9-synthesis-cache-${block.blockId}.json`,
              kind: 'file',
              content: JSON.stringify(block, null, 2),
              mimeType: 'application/json',
              source: 'synthesis_cache_block',
              summary: `Phase 9 synthesis cache block for ${input.mode}`,
            });
            persistedSynthesisArtifactIds.push(artifact.id);
            artifactIds.push(artifact.id);
          }
          synthesisCacheWrites.push({
            requestTurnId: activeTurnId,
            blockIds: built.blocks.map((block) => block.blockId),
            artifactIds,
            skipped: built.skipped ?? 0,
            skippedReasonCounts: built.skippedReasonCounts ?? {},
          });
          return {
            blocks: built.blocks,
            ...(built.skipped > 0 ? { skipped: built.skipped } : {}),
            ...(built.skippedReasonCounts
              ? { skippedReasonCounts: built.skippedReasonCounts }
              : {}),
          };
        },
        newId: randomUUID,
        now: Date.now,
        maxSteps: 4,
        streamConnectTimeoutMs: 30_000,
        streamIdleTimeoutMs: 120_000,
      }),
  );

  const manager = new SessionManager({
    store: sessionStore,
    runStore,
    runtimeEventStore,
    backends,
    newId: randomUUID,
    now: Date.now,
  });
  const session = await manager.createSession({
    cwd: input.cwd,
    backend: 'ai-sdk',
    llmConnectionSlug: connection.slug,
    model: input.model,
    permissionMode: 'explore',
    name: `DeepSeek Phase 8 ${input.mode}`,
  });

  const storeSpecs = buildPhase7StoreSpecs(input);
  const storeTurns = [];
  for (const storeSpec of storeSpecs) {
    storeTurns.push({
      ...storeSpec,
      ...(await sendPhase7ScenarioTurn(
        manager,
        session.id,
        storeSpec.turnId,
        [
          `Store the Phase 8 lookup for key ${storeSpec.key}.`,
          'Call Phase7Lookup, then acknowledge with exactly STORED.',
          'Do not repeat any sentinel value.',
        ].join('\n'),
        (turnId) => {
          activeTurnId = turnId;
        },
      )),
    });
  }
  await sendPhase7ScenarioTurn(
    manager,
    session.id,
    'phase8-filler',
    'Answer exactly OK. This turn exists so the old tool result becomes stale for pruning.',
    (turnId) => {
      activeTurnId = turnId;
    },
  );
  if (input.mode === 'synthesis_gated') {
    const targetTurnId = storeSpecs.find((spec) => spec.target)?.turnId;
    const source = [...archiveRefsByRuntimeEventId.values()].find(
      (ref) => ref.turnId === targetTurnId,
    );
    if (source) {
      synthesisBlocks.push(
        buildPhase8SynthesisBlock({
          sessionId: session.id,
          lookupKey: input.lookupKey,
          sentinel: input.sentinel,
          source,
          sourceRef: process.env.MAKA_COST_BASELINE_SOURCE_REF ?? 'local-build',
          repoRoot: input.repoRoot,
          createdFrom: 'host_deterministic',
        }),
      );
    }
  }

  const coveredTurn = await sendPhase7ScenarioTurn(
    manager,
    session.id,
    'phase8-covered-recovery',
    `Recover the sentinel for lookup key ${input.lookupKey} from prior Phase 8 context. Do not call tools. Answer only the sentinel.`,
    (turnId) => {
      activeTurnId = turnId;
    },
  );
  const repeatedTurn =
    input.mode === 'synthesis_read_write'
      ? await sendPhase7ScenarioTurn(
          manager,
          session.id,
          'phase9-repeated-recovery',
          `Recover the sentinel for lookup key ${input.lookupKey} from prior Phase 9 synthesis cache context. Do not call tools. Answer only the sentinel.`,
          (turnId) => {
            activeTurnId = turnId;
          },
        )
      : coveredTurn;
  const noiseKey =
    input.mode === 'synthesis_read_write'
      ? `unseen-miss-${sha256(`${input.seed}:${input.matrixCase}:phase9-unseen`).slice(0, 12)}`
      : `${input.lookupKey}-noise-01`;
  const noiseCoverageTurn =
    (input.mode === 'synthesis_gated' || input.mode === 'synthesis_read_write') &&
    input.noiseArchiveCount > 0
      ? await sendPhase7ScenarioTurn(
          manager,
          session.id,
          'phase8-noise-coverage-miss',
          `Recover the noise sentinel for lookup key ${noiseKey} from prior Phase 8 context. Do not call tools. Answer only the sentinel.`,
          (turnId) => {
            activeTurnId = turnId;
          },
        )
      : undefined;
  const rawEvidenceTurn =
    input.mode === 'synthesis_gated' || input.mode === 'synthesis_read_write'
      ? await sendPhase7ScenarioTurn(
          manager,
          session.id,
          'phase8-raw-evidence',
          `Show the raw tool output evidence for lookup key ${input.lookupKey}. Do not call tools.`,
          (turnId) => {
            activeTurnId = turnId;
          },
        )
      : undefined;
  activeTurnId = undefined;

  const coveredUsageEvent = coveredTurn.events.find((event) => event.type === 'token_usage');
  const repeatedUsageEvent = repeatedTurn.events.find((event) => event.type === 'token_usage');
  const noiseCoverageUsageEvent = noiseCoverageTurn?.events.find(
    (event) => event.type === 'token_usage',
  );
  const rawEvidenceUsageEvent = rawEvidenceTurn?.events.find(
    (event) => event.type === 'token_usage',
  );
  const pricingId = `${connection.providerType}:${input.model}`;
  const coveredRecordOffset =
    input.mode === 'synthesis_read_write'
      ? rawEvidenceTurn
        ? noiseCoverageTurn
          ? -4
          : -3
        : noiseCoverageTurn
          ? -3
          : -2
      : rawEvidenceTurn
        ? noiseCoverageTurn
          ? -3
          : -2
        : noiseCoverageTurn
          ? -2
          : -1;
  const repeatedRecordOffset = rawEvidenceTurn
    ? noiseCoverageTurn
      ? -3
      : -2
    : noiseCoverageTurn
      ? -2
      : -1;
  const noiseRecordOffset = rawEvidenceTurn ? -2 : -1;
  return {
    matrixCase: input.matrixCase,
    mode: input.mode,
    contextBudget,
    sessionId: session.id,
    synthesisBlocksCreated: synthesisBlocks,
    persistedSynthesisArtifactIds,
    synthesisCacheLoads,
    synthesisCacheWrites,
    storeTurns: storeTurns.map((turn) => ({
      turnId: turn.turnId,
      key: turn.key,
      target: turn.target,
      assistantText: turn.assistantText,
    })),
    recoveryAnswer: coveredTurn.assistantText,
    recoveryArchivedToolResultsRead: archiveReads.filter(
      (read) => read.requestTurnId === 'phase8-covered-recovery',
    ).length,
    recoveryContextBudget: coveredUsageEvent?.contextBudget,
    repeatedAnswer: repeatedTurn.assistantText,
    repeatedRecoveredSentinel: repeatedTurn.assistantText.includes(input.sentinel),
    repeatedAnswerExactlySentinel: repeatedTurn.assistantText.trim() === input.sentinel,
    archiveReads,
    repeatedArchivedToolResultsRead: archiveReads.filter(
      (read) =>
        read.requestTurnId ===
        (input.mode === 'synthesis_read_write'
          ? 'phase9-repeated-recovery'
          : 'phase8-covered-recovery'),
    ).length,
    noiseCoverageAnswer: noiseCoverageTurn?.assistantText,
    noiseCoverageArchivedToolResultsRead: archiveReads.filter(
      (read) => read.requestTurnId === 'phase8-noise-coverage-miss',
    ).length,
    noiseCoverageContextBudget: noiseCoverageUsageEvent?.contextBudget,
    rawEvidenceArchivedToolResultsRead: archiveReads.filter(
      (read) => read.requestTurnId === 'phase8-raw-evidence',
    ).length,
    repeatedContextBudget: repeatedUsageEvent?.contextBudget,
    rawEvidenceContextBudget: rawEvidenceUsageEvent?.contextBudget,
    recoveryUsage: usageSummary(coveredUsageEvent, llmRecords.at(coveredRecordOffset), pricingId),
    repeatedUsage: usageSummary(repeatedUsageEvent, llmRecords.at(repeatedRecordOffset), pricingId),
    noiseCoverageUsage: noiseCoverageTurn
      ? usageSummary(noiseCoverageUsageEvent, llmRecords.at(noiseRecordOffset), pricingId)
      : undefined,
    rawEvidenceUsage: rawEvidenceTurn
      ? usageSummary(rawEvidenceUsageEvent, llmRecords.at(-1), pricingId)
      : undefined,
    scenarioUsageTotals: usageTotals(llmRecords, pricingId),
    requestShapeTrace: runTraceEvents
      .filter(
        (event) =>
          event.data?.requestShapeHash ||
          event.data?.requestShapeChangeReason ||
          event.data?.contextBudget,
      )
      .map((event) => ({
        phase: event.phase,
        type: event.type,
        requestShapeHash: event.data?.requestShapeHash,
        requestShapeChangeReason: event.data?.requestShapeChangeReason,
        contextBudget: event.data?.contextBudget,
      })),
  };
}

function buildPhase7LookupTool(input) {
  return {
    name: 'Phase7Lookup',
    description:
      'Deterministic Phase 7 harness tool. Use only when asked to store the Phase 7 lookup key.',
    parameters: z.object({
      key: z.string().describe('The lookup key requested by the user.'),
    }),
    permissionRequired: false,
    impl: ({ key }) => {
      const target = key === input.lookupKey;
      const sentinel = target
        ? input.sentinel
        : `PHASE7_NOISE_${sha256(`${input.seed}:${input.matrixCase}:${key}`).slice(0, 16)}`;
      return {
        key,
        target,
        sentinel,
        rows: Array.from({ length: input.resultLines }, (_, index) => ({
          index,
          text: `phase7 archived payload row ${String(index + 1).padStart(3, '0')} for ${key}`,
        })),
      };
    },
  };
}

function buildPhase7StoreSpecs(input) {
  const noiseSpecs = Array.from({ length: input.noiseArchiveCount ?? 0 }, (_, index) => ({
    turnId: `phase7-store-noise-${String(index + 1).padStart(2, '0')}`,
    key: `${input.lookupKey}-noise-${String(index + 1).padStart(2, '0')}`,
    target: false,
  }));
  const targetTurnId = noiseSpecs.length === 0 ? 'phase7-store' : 'phase7-store-target';
  return [
    ...noiseSpecs,
    {
      turnId: targetTurnId,
      key: input.lookupKey,
      target: true,
    },
  ];
}

function buildPhase7ContextBudgetPolicy(mode) {
  if (mode === 'full') return undefined;
  const base = {
    name: `phase7-${mode}`,
    minRecentTurns: 1,
    charsPerToken: 4,
    staleToolResultPrune: {
      enabled: true,
      maxResultEstimatedTokens: parsePositiveInt(
        process.env.MAKA_CONTEXT_STALE_TOOL_RESULT_MAX_TOKENS,
        128,
      ),
      minRecentTurnsFull: 0,
    },
  };
  if (mode === 'prune') return base;
  const archiveRetrieval = {
    enabled: true,
    mode: mode === 'gated' ? 'history_search_gated' : 'eager',
    maxResults: 4,
    maxEstimatedTokens: parsePositiveInt(
      process.env.MAKA_CONTEXT_ARCHIVE_RETRIEVAL_MAX_TOKENS,
      16_384,
    ),
    maxBytes: parsePositiveInt(
      process.env.MAKA_CONTEXT_ARCHIVE_RETRIEVAL_MAX_BYTES,
      2 * 1024 * 1024,
    ),
    order: 'newest_first',
  };
  if (mode === 'gated') {
    return {
      ...base,
      archiveRetrieval,
      historySearch: {
        enabled: true,
        maxResults: 1,
        around: 0,
        maxEstimatedTokens: 4096,
      },
    };
  }
  return {
    ...base,
    archiveRetrieval,
  };
}

function buildPhase8ContextBudgetPolicy(mode, synthesisBlocks) {
  if (mode === 'full') return undefined;
  const gated = buildPhase7ContextBudgetPolicy('gated');
  if (mode === 'synthesis_read_write') {
    return {
      ...gated,
      name: 'phase9-synthesis-read-write',
      synthesisCache: {
        enabled: true,
        mode: 'read_write',
        blocks: synthesisBlocks,
        maxBlocks: parsePositiveInt(process.env.MAKA_CONTEXT_SYNTHESIS_CACHE_MAX_BLOCKS, 1),
        maxEstimatedTokens: parsePositiveInt(
          process.env.MAKA_CONTEXT_SYNTHESIS_CACHE_MAX_TOKENS,
          2048,
        ),
        maxBlockEstimatedTokens: parsePositiveInt(
          process.env.MAKA_CONTEXT_SYNTHESIS_CACHE_MAX_BLOCK_TOKENS,
          1024,
        ),
        invalidateOnNewToolResult: true,
        schemaVersion: 1,
      },
    };
  }
  if (mode !== 'synthesis_gated') return gated;
  return {
    ...gated,
    name: 'phase8-synthesis-gated',
    synthesisCache: {
      enabled: true,
      blocks: synthesisBlocks,
      maxBlocks: 1,
    },
  };
}

function buildPhase8SynthesisBlock(input) {
  return {
    kind: 'maka.synthesis_cache_block',
    version: 1,
    blockId: `phase8-synth-${sha256(`${input.sessionId}:${input.lookupKey}`).slice(0, 16)}`,
    sessionId: input.sessionId,
    createdAt: Date.now(),
    highWaterName: `phase8-after-gated-${input.lookupKey}`,
    highWaterSeq: 1,
    sourceRef: {
      sourceRef: input.sourceRef,
      repoRoot: input.repoRoot,
      harnessRunId: process.env.MAKA_COST_BASELINE_RUN_ID,
    },
    coverage: {
      queryKeys: [input.lookupKey],
      turnIds: [input.source.turnId],
      runtimeEventIds: [input.source.runtimeEventId],
      toolNames: [input.source.toolName],
      toolCallIds: [input.source.toolCallId],
      artifactIds: [input.source.artifactId],
      bodySha256: [input.source.bodySha256],
    },
    summary: `For lookup key ${input.lookupKey}, the recoverable sentinel is ${input.sentinel}.`,
    limitations: [
      'Does not include raw tool output.',
      'Does not cover noise lookup keys or changed archive bodies.',
    ],
    sourceRefs: [
      {
        kind: 'archived_tool_result',
        sessionId: input.sessionId,
        turnId: input.source.turnId,
        runtimeEventId: input.source.runtimeEventId,
        toolCallId: input.source.toolCallId,
        toolName: input.source.toolName,
        artifactId: input.source.artifactId,
        bodySha256: input.source.bodySha256,
        originalEstimatedTokens: input.source.originalEstimatedTokens,
        originalBytes: input.source.originalBytes,
        placeholderReason: input.source.placeholderReason,
      },
    ],
    createdFrom: input.createdFrom ?? 'gated_archive_retrieval',
  };
}

function buildPhase10ContextBudgetPolicy(mode) {
  if (mode === 'full') return undefined;
  const compactMode = mode === 'history_compact_read_write' ? 'read_write' : 'deterministic';
  return {
    name: `phase10-history-compact-${compactMode}`,
    maxHistoryEstimatedTokens: parsePositiveInt(
      process.env.MAKA_CONTEXT_HISTORY_BUDGET_TOKENS,
      1600,
    ),
    minRecentTurns: 1,
    charsPerToken: parsePositiveInt(process.env.MAKA_CONTEXT_CHARS_PER_TOKEN, 1),
    historyCompact: {
      enabled: true,
      mode: compactMode,
      highWaterRatio: parseRatio(process.env.MAKA_CONTEXT_HISTORY_COMPACT_HIGH_WATER_RATIO, 0.5),
      forceRatio: parseRatio(process.env.MAKA_CONTEXT_HISTORY_COMPACT_FORCE_RATIO, 0.9),
      targetRatio: parseRatio(process.env.MAKA_CONTEXT_HISTORY_COMPACT_TARGET_RATIO, 0.25),
      tailEstimatedTokens: parsePositiveInt(
        process.env.MAKA_CONTEXT_HISTORY_COMPACT_TAIL_TOKENS,
        400,
      ),
      minRecentTurns: parsePositiveInt(
        process.env.MAKA_CONTEXT_HISTORY_COMPACT_MIN_RECENT_TURNS,
        1,
      ),
      maxSummaryEstimatedTokens: parsePositiveInt(
        process.env.MAKA_CONTEXT_HISTORY_COMPACT_MAX_SUMMARY_TOKENS,
        512,
      ),
      maxBlocks: parsePositiveInt(process.env.MAKA_CONTEXT_HISTORY_COMPACT_MAX_BLOCKS, 1),
      maxEstimatedTokens: parsePositiveInt(
        process.env.MAKA_CONTEXT_HISTORY_COMPACT_MAX_TOKENS,
        8192,
      ),
      maxBlockEstimatedTokens: parsePositiveInt(
        process.env.MAKA_CONTEXT_HISTORY_COMPACT_MAX_BLOCK_TOKENS,
        4096,
      ),
      highWaterName: `phase10-history-compact-${compactMode}`,
    },
  };
}

function buildPhase10StoragePrompt(input) {
  const payload = Array.from(
    { length: input.payloadLines },
    (_, index) =>
      `phase10 old payload line ${String(index + 1).padStart(3, '0')}: stable filler for live cost accounting and prompt-cache measurement.`,
  ).join('\n');
  return [
    'Store the Phase 10 memory. Answer exactly STORED and do not repeat the sentinel.',
    '<phase10_memory>',
    `sentinel: ${input.sentinel}`,
    `seed: ${input.seed}`,
    'purpose: exercise history compact replay and artifact-backed host summary loading.',
    payload,
    '</phase10_memory>',
  ].join('\n');
}

function buildPhase10HostHistoryCompactSummary(input, event) {
  const foldedTurnIds = [
    ...new Set(event.source.foldedRuntimeEvents.map((runtimeEvent) => runtimeEvent.turnId)),
  ];
  return [
    'Phase 10 host history compact summary.',
    `Recoverable sentinel: ${input.sentinel}`,
    `Covered older turn ids: ${foldedTurnIds.join(', ')}`,
    `Folded runtime event count: ${event.source.foldedRuntimeEvents.length}`,
    'Use this summary for sentinel recovery. Raw old payload lines are preserved separately as source artifacts.',
  ].join('\n');
}

function phase7TurnTailPrompt(cwd) {
  return [
    '<current-session-environment>',
    `cwd: ${cwd}`,
    `calendar_date: ${process.env.MAKA_COST_BASELINE_DATE ?? new Date().toISOString().slice(0, 10)}`,
    '</current-session-environment>',
  ].join('\n');
}

async function sendPhase7Turn(manager, sessionId, turnId, text) {
  const events = [];
  for await (const event of manager.sendMessage(sessionId, { turnId, text })) {
    events.push(event);
  }
  return {
    events,
    assistantText: events
      .filter((event) => event.type === 'text_complete')
      .map((event) => event.text)
      .join('\n'),
  };
}

async function sendPhase7ScenarioTurn(manager, sessionId, turnId, text, setActiveTurnId) {
  setActiveTurnId(turnId);
  try {
    return await sendPhase7Turn(manager, sessionId, turnId, text);
  } finally {
    setActiveTurnId(undefined);
  }
}

function usageSummary(usageEvent, llmRecord, pricingId) {
  const cost = llmRecord ? costForLlmRecord(llmRecord, pricingId) : undefined;
  return {
    input: usageEvent?.input ?? llmRecord?.inputTokens,
    output: usageEvent?.output ?? llmRecord?.outputTokens,
    cacheHitInput: usageEvent?.cacheHitInput ?? llmRecord?.cacheHitInputTokens,
    cacheMissInput: usageEvent?.cacheMissInput ?? llmRecord?.cacheMissInputTokens,
    cacheWriteInput: usageEvent?.cacheWriteInput ?? llmRecord?.cacheWriteInputTokens,
    estimatedCostUsd: cost?.totalCost,
    requestShapeChangeReason:
      usageEvent?.requestShapeChangeReason ?? llmRecord?.requestShapeChangeReason,
    contextBudget: usageEvent?.contextBudget ?? llmRecord?.contextBudget,
  };
}

function usageTotals(llmRecords, pricingId) {
  return llmRecords.reduce(
    (acc, record) => {
      const cost = costForLlmRecord(record, pricingId);
      acc.calls += 1;
      acc.input += record.inputTokens ?? 0;
      acc.output += record.outputTokens ?? 0;
      acc.cacheHitInput += record.cacheHitInputTokens ?? 0;
      acc.cacheMissInput += record.cacheMissInputTokens ?? 0;
      acc.cacheWriteInput += record.cacheWriteInputTokens ?? 0;
      acc.estimatedCostUsd += cost?.totalCost ?? 0;
      return acc;
    },
    {
      calls: 0,
      input: 0,
      output: 0,
      cacheHitInput: 0,
      cacheMissInput: 0,
      cacheWriteInput: 0,
      estimatedCostUsd: 0,
    },
  );
}

function usageDelta(base, candidate) {
  if (!base || !candidate) return undefined;
  return {
    input: numericDelta(base.input, candidate.input),
    output: numericDelta(base.output, candidate.output),
    cacheHitInput: numericDelta(base.cacheHitInput, candidate.cacheHitInput),
    cacheMissInput: numericDelta(base.cacheMissInput, candidate.cacheMissInput),
    cacheWriteInput: numericDelta(base.cacheWriteInput, candidate.cacheWriteInput),
    estimatedCostUsd: numericDelta(base.estimatedCostUsd, candidate.estimatedCostUsd),
  };
}

function numericDelta(base, candidate) {
  return typeof base === 'number' && typeof candidate === 'number' ? candidate - base : undefined;
}

function costForLlmRecord(record, pricingId) {
  return computeCost(
    {
      inputTokens: record.inputTokens,
      outputTokens: record.outputTokens,
      cacheHitInputTokens: record.cacheHitInputTokens,
      cacheMissInputTokens: record.cacheMissInputTokens,
      cacheWriteInputTokens: record.cacheWriteInputTokens,
    },
    getBuiltinPricing(pricingId),
  );
}

function validatePhase7ToolMatrix(cases, sentinel) {
  const failures = [];
  for (const matrixCase of cases) {
    const byMode = new Map(matrixCase.scenarios.map((scenario) => [scenario.mode, scenario]));
    for (const mode of ['full', 'prune', 'eager', 'gated']) {
      const scenario = byMode.get(mode);
      if (!scenario) {
        failures.push(`${matrixCase.name}: missing ${mode} scenario`);
        continue;
      }
      if (scenario.storageAnswerIncludedSentinel) {
        failures.push(
          `${matrixCase.name}: ${mode} scenario repeated sentinel in storage acknowledgement`,
        );
      }
      const expectedTurnCounts = new Map(
        scenario.expectedToolCallTurns.map((turnId) => [turnId, 0]),
      );
      for (const call of scenario.toolCalls) {
        if (call.toolName !== 'Phase7Lookup') {
          failures.push(
            `${matrixCase.name}: ${mode} scenario unexpected tool call ${call.toolName}`,
          );
        }
        if (!expectedTurnCounts.has(call.turnId)) {
          failures.push(
            `${matrixCase.name}: ${mode} scenario unexpected tool call on ${call.turnId}`,
          );
        } else {
          expectedTurnCounts.set(call.turnId, expectedTurnCounts.get(call.turnId) + 1);
        }
      }
      for (const [turnId, count] of expectedTurnCounts.entries()) {
        if (count !== 1) {
          failures.push(
            `${matrixCase.name}: ${mode} scenario expected one Phase7Lookup call on ${turnId}, saw ${count}`,
          );
        }
      }
      if (scenario.toolCalls.length !== scenario.expectedToolCallTurns.length) {
        failures.push(
          `${matrixCase.name}: ${mode} scenario expected ${scenario.expectedToolCallTurns.length} tool calls, saw ${scenario.toolCalls.length}`,
        );
      }
    }

    const full = byMode.get('full');
    const prune = byMode.get('prune');
    const eager = byMode.get('eager');
    const gated = byMode.get('gated');
    if (full && !full.recoveredSentinel)
      failures.push(`${matrixCase.name}: full scenario did not recover sentinel`);
    if (prune?.recoveredSentinel)
      failures.push(
        `${matrixCase.name}: prune scenario recovered sentinel without archive retrieval`,
      );
    if (prune && prune.archivedToolResultsRead !== 0)
      failures.push(`${matrixCase.name}: prune scenario unexpectedly read archives`);
    if (eager && !eager.recoveredSentinel)
      failures.push(`${matrixCase.name}: eager scenario did not recover sentinel`);
    if (eager && eager.archivedToolResultsRead < 1)
      failures.push(`${matrixCase.name}: eager scenario did not read any archive`);
    if (eager?.finalContextBudget?.archiveRetrievalMode !== 'eager') {
      failures.push(`${matrixCase.name}: eager scenario did not report eager retrieval mode`);
    }
    if ((eager?.finalContextBudget?.retrievedArchiveToolResults ?? 0) < 1) {
      failures.push(`${matrixCase.name}: eager scenario final turn did not retrieve an archive`);
    }
    if (gated && !gated.recoveredSentinel)
      failures.push(`${matrixCase.name}: gated scenario did not recover sentinel`);
    if (gated && gated.archivedToolResultsRead < 1)
      failures.push(`${matrixCase.name}: gated scenario did not read any archive`);
    if (gated?.finalContextBudget?.archiveRetrievalMode !== 'history_search_gated') {
      failures.push(
        `${matrixCase.name}: gated scenario did not report history_search_gated retrieval mode`,
      );
    }
    if ((gated?.finalContextBudget?.retrievedArchiveToolResults ?? 0) < 1) {
      failures.push(`${matrixCase.name}: gated scenario final turn did not retrieve an archive`);
    }
    if ((gated?.finalContextBudget?.archiveRetrievalEligibleTurns ?? 0) < 1) {
      failures.push(
        `${matrixCase.name}: gated scenario did not report any archive retrieval eligible turns`,
      );
    }
    if ((gated?.finalContextBudget?.historySearchMatches ?? 0) < 1) {
      failures.push(`${matrixCase.name}: gated scenario did not report a history search match`);
    }
    if (matrixCase.name === 'multi_archive_selectivity') {
      if ((gated?.finalArchivedToolResultsRead ?? 0) !== 1) {
        failures.push(
          `${matrixCase.name}: gated scenario final turn should read exactly one matching archive, saw ${gated?.finalArchivedToolResultsRead ?? 0}`,
        );
      }
      if ((gated?.finalContextBudget?.retrievedArchiveToolResults ?? 0) !== 1) {
        failures.push(
          `${matrixCase.name}: gated scenario should inject exactly one matching archive, saw ${gated?.finalContextBudget?.retrievedArchiveToolResults ?? 0}`,
        );
      }
      if (
        (eager?.finalArchivedToolResultsRead ?? 0) <= (gated?.finalArchivedToolResultsRead ?? 0)
      ) {
        failures.push(
          `${matrixCase.name}: eager scenario final turn did not read more archives than gated`,
        );
      }
      if (
        (eager?.finalContextBudget?.retrievedArchiveToolResults ?? 0) <=
        (gated?.finalContextBudget?.retrievedArchiveToolResults ?? 0)
      ) {
        failures.push(`${matrixCase.name}: eager scenario did not inject more archives than gated`);
      }
      if (
        (eager?.finalContextBudget?.retrievedArchiveEstimatedTokens ?? 0) <=
        (gated?.finalContextBudget?.retrievedArchiveEstimatedTokens ?? 0)
      ) {
        failures.push(
          `${matrixCase.name}: eager scenario did not report higher retrieved archive token volume than gated`,
        );
      }
    }
  }
  return failures;
}

function validatePhase8SynthesisMatrix(cases, sentinel) {
  const failures = [];
  for (const matrixCase of cases) {
    const byMode = new Map(matrixCase.scenarios.map((scenario) => [scenario.mode, scenario]));
    for (const mode of ['full', 'gated', 'synthesis_gated']) {
      const scenario = byMode.get(mode);
      if (!scenario) {
        failures.push(`${matrixCase.name}: missing ${mode} scenario`);
        continue;
      }
      if (!scenario.repeatedRecoveredSentinel || !scenario.repeatedAnswerExactlySentinel) {
        failures.push(
          `${matrixCase.name}: ${mode} repeated turn did not recover exactly ${sentinel}`,
        );
      }
      if ((scenario.repeatedUsage?.cacheMissInput ?? 0) < 0) {
        failures.push(`${matrixCase.name}: ${mode} repeated cacheMissInput was not measurable`);
      }
      if (typeof scenario.repeatedUsage?.estimatedCostUsd !== 'number') {
        failures.push(`${matrixCase.name}: ${mode} repeated estimatedCostUsd was not measurable`);
      }
    }
    const gated = byMode.get('gated');
    const synthesis = byMode.get('synthesis_gated');
    if (gated && (gated.recoveryArchivedToolResultsRead ?? 0) < 1) {
      failures.push(`${matrixCase.name}: gated covered turn did not read the target archive`);
    }
    if (gated && (gated.recoveryContextBudget?.retrievedArchiveToolResults ?? 0) < 1) {
      failures.push(`${matrixCase.name}: gated covered turn did not report archive retrieval`);
    }
    if (gated && (gated.repeatedArchivedToolResultsRead ?? 0) < 1) {
      failures.push(`${matrixCase.name}: gated comparison turn did not read the target archive`);
    }
    if (synthesis) {
      if ((synthesis.synthesisBlocksCreated?.length ?? 0) !== 1) {
        failures.push(`${matrixCase.name}: synthesis_gated did not create one synthesis block`);
      }
      if ((synthesis.repeatedArchivedToolResultsRead ?? 0) !== 0) {
        failures.push(`${matrixCase.name}: synthesis_gated repeated turn read archives`);
      }
      if ((synthesis.repeatedContextBudget?.synthesisCacheBlocksSelected ?? 0) !== 1) {
        failures.push(`${matrixCase.name}: synthesis_gated repeated turn did not select synthesis`);
      }
      if (
        gated &&
        typeof gated.repeatedUsage?.input === 'number' &&
        typeof synthesis.repeatedUsage?.input === 'number' &&
        synthesis.repeatedUsage.input >= gated.repeatedUsage.input
      ) {
        failures.push(`${matrixCase.name}: synthesis_gated comparison input was not below gated`);
      }
      if (
        gated &&
        typeof gated.repeatedUsage?.estimatedCostUsd === 'number' &&
        typeof synthesis.repeatedUsage?.estimatedCostUsd === 'number' &&
        synthesis.repeatedUsage.estimatedCostUsd >= gated.repeatedUsage.estimatedCostUsd
      ) {
        failures.push(`${matrixCase.name}: synthesis_gated comparison cost was not below gated`);
      }
      if ((synthesis.rawEvidenceArchivedToolResultsRead ?? 0) < 1) {
        failures.push(
          `${matrixCase.name}: synthesis_gated raw evidence turn did not fall back to archive retrieval`,
        );
      }
      if ((synthesis.rawEvidenceContextBudget?.retrievedArchiveToolResults ?? 0) < 1) {
        failures.push(
          `${matrixCase.name}: synthesis_gated raw evidence turn did not report archive retrieval`,
        );
      }
      if (matrixCase.name === 'multi_archive_selectivity') {
        if ((synthesis.repeatedContextBudget?.synthesisCacheBlocksSelected ?? 0) !== 1) {
          failures.push(
            `${matrixCase.name}: synthesis_gated selected more or fewer than one block`,
          );
        }
        if ((synthesis.repeatedContextBudget?.archiveRetrievalSkipped ?? 0) > 0) {
          failures.push(
            `${matrixCase.name}: synthesis_gated repeated turn should skip archive retrieval entirely`,
          );
        }
        if ((synthesis.noiseCoverageContextBudget?.synthesisCacheBlocksSelected ?? 0) !== 0) {
          failures.push(
            `${matrixCase.name}: synthesis_gated noise query selected target synthesis`,
          );
        }
        if (
          (synthesis.noiseCoverageContextBudget?.synthesisCacheSkippedReasonCounts?.coverage_miss ??
            0) < 1
        ) {
          failures.push(
            `${matrixCase.name}: synthesis_gated noise query did not report coverage miss`,
          );
        }
      }
    }
  }
  return failures;
}

function validatePhase9SynthesisLifecycleMatrix(cases, sentinel) {
  const failures = [];
  for (const matrixCase of cases) {
    const byMode = new Map(matrixCase.scenarios.map((scenario) => [scenario.mode, scenario]));
    const gated = byMode.get('gated');
    const lifecycle = byMode.get('synthesis_read_write');
    for (const mode of ['full', 'gated', 'synthesis_read_write']) {
      const scenario = byMode.get(mode);
      if (!scenario) {
        failures.push(`${matrixCase.name}: missing ${mode} scenario`);
        continue;
      }
      if (!scenario.repeatedRecoveredSentinel || !scenario.repeatedAnswerExactlySentinel) {
        failures.push(
          `${matrixCase.name}: ${mode} repeated turn did not recover exactly ${sentinel}`,
        );
      }
      if (typeof scenario.repeatedUsage?.estimatedCostUsd !== 'number') {
        failures.push(`${matrixCase.name}: ${mode} repeated estimatedCostUsd was not measurable`);
      }
    }
    if (gated && (gated.repeatedArchivedToolResultsRead ?? 0) < 1) {
      failures.push(`${matrixCase.name}: gated comparison turn did not read archives`);
    }
    if (!lifecycle) continue;
    const writtenBlockCount =
      lifecycle.synthesisCacheWrites?.reduce(
        (total, write) => total + (write.blockIds?.length ?? 0),
        0,
      ) ?? 0;
    if (writtenBlockCount < 1) {
      failures.push(`${matrixCase.name}: lifecycle did not write any synthesis blocks`);
    }
    if ((lifecycle.persistedSynthesisArtifactIds?.length ?? 0) < 1) {
      failures.push(`${matrixCase.name}: lifecycle did not create any synthesis artifacts`);
    }
    if ((lifecycle.repeatedContextBudget?.synthesisCacheBlocksLoaded ?? 0) !== 1) {
      failures.push(
        `${matrixCase.name}: lifecycle repeated turn did not load one synthesis block from artifacts`,
      );
    }
    if ((lifecycle.repeatedContextBudget?.synthesisCacheBlocksSelected ?? 0) !== 1) {
      failures.push(
        `${matrixCase.name}: lifecycle repeated turn did not select one synthesis block`,
      );
    }
    const repeatedLoads = lifecycle.synthesisCacheLoads?.find(
      (load) => load.requestTurnId === 'phase9-repeated-recovery',
    );
    if ((repeatedLoads?.blockIds?.length ?? 0) !== 1) {
      failures.push(
        `${matrixCase.name}: lifecycle repeated turn did not prove artifact-backed synthesis load`,
      );
    }
    if ((lifecycle.repeatedArchivedToolResultsRead ?? 0) !== 0) {
      failures.push(`${matrixCase.name}: lifecycle repeated turn read archives`);
    }
    if ((lifecycle.rawEvidenceArchivedToolResultsRead ?? 0) < 1) {
      failures.push(
        `${matrixCase.name}: lifecycle raw-evidence turn did not fall back to archive retrieval`,
      );
    }
    if (
      (lifecycle.rawEvidenceContextBudget?.synthesisCacheWriteSkippedReasonCounts
        ?.raw_evidence_requested ?? 0) < 1
    ) {
      failures.push(`${matrixCase.name}: lifecycle raw-evidence turn did not skip synthesis write`);
    }
    if (matrixCase.name === 'bounded_budget_and_fallbacks') {
      if ((lifecycle.noiseCoverageContextBudget?.synthesisCacheBlocksSelected ?? 0) !== 0) {
        failures.push(`${matrixCase.name}: lifecycle noise query selected target synthesis`);
      }
      if (
        (lifecycle.noiseCoverageContextBudget?.synthesisCacheSkippedReasonCounts?.coverage_miss ??
          0) < 1
      ) {
        failures.push(`${matrixCase.name}: lifecycle noise query did not report coverage miss`);
      }
    }
    if (
      gated &&
      typeof gated.repeatedUsage?.input === 'number' &&
      typeof lifecycle.repeatedUsage?.input === 'number' &&
      lifecycle.repeatedUsage.input >= gated.repeatedUsage.input
    ) {
      failures.push(`${matrixCase.name}: lifecycle repeated input was not below gated`);
    }
    if (
      gated &&
      typeof gated.repeatedUsage?.estimatedCostUsd === 'number' &&
      typeof lifecycle.repeatedUsage?.estimatedCostUsd === 'number' &&
      lifecycle.repeatedUsage.estimatedCostUsd >= gated.repeatedUsage.estimatedCostUsd
    ) {
      failures.push(`${matrixCase.name}: lifecycle repeated cost was not below gated`);
    }
  }
  return failures;
}

function validatePhase10HistoryCompactMatrix(cases, sentinel) {
  const failures = [];
  for (const matrixCase of cases) {
    const byMode = new Map(matrixCase.scenarios.map((scenario) => [scenario.mode, scenario]));
    for (const mode of ['full', 'deterministic', 'history_compact_read_write']) {
      const scenario = byMode.get(mode);
      if (!scenario) {
        failures.push(`${matrixCase.name}: missing ${mode} scenario`);
        continue;
      }
      if (scenario.storageAnswerIncludedSentinel) {
        failures.push(`${matrixCase.name}: ${mode} scenario repeated sentinel during storage`);
      }
      if (!scenario.recoveryRecoveredSentinel || !scenario.recoveryAnswerExactlySentinel) {
        failures.push(
          `${matrixCase.name}: ${mode} recovery turn did not recover exactly ${sentinel}`,
        );
      }
      if (!scenario.repeatedRecoveredSentinel || !scenario.repeatedAnswerExactlySentinel) {
        failures.push(
          `${matrixCase.name}: ${mode} repeated turn did not recover exactly ${sentinel}`,
        );
      }
      if (typeof scenario.repeatedUsage?.estimatedCostUsd !== 'number') {
        failures.push(`${matrixCase.name}: ${mode} repeated estimatedCostUsd was not measurable`);
      }
    }

    const deterministic = byMode.get('deterministic');
    if (deterministic) {
      if ((deterministic.recoveryContextBudget?.historyCompactBlocksSelected ?? 0) !== 1) {
        failures.push(
          `${matrixCase.name}: deterministic recovery did not select one history compact block`,
        );
      }
      if ((deterministic.repeatedContextBudget?.historyCompactBlocksSelected ?? 0) !== 1) {
        failures.push(
          `${matrixCase.name}: deterministic repeated turn did not select one history compact block`,
        );
      }
      if ((deterministic.repeatedContextBudget?.historyCompactBlocksLoaded ?? 0) !== 0) {
        failures.push(
          `${matrixCase.name}: deterministic repeated turn unexpectedly loaded persisted history compact blocks`,
        );
      }
    }

    const readWrite = byMode.get('history_compact_read_write');
    if (readWrite) {
      if ((readWrite.recoveryContextBudget?.historyCompactBlocksSelected ?? 0) !== 1) {
        failures.push(
          `${matrixCase.name}: read_write recovery did not select one history compact draft`,
        );
      }
      if ((readWrite.recoveryContextBudget?.historyCompactWritesAttempted ?? 0) !== 1) {
        failures.push(
          `${matrixCase.name}: read_write recovery did not attempt one history compact write`,
        );
      }
      if ((readWrite.recoveryContextBudget?.historyCompactBlocksWritten ?? 0) !== 1) {
        failures.push(
          `${matrixCase.name}: read_write recovery did not write one host history compact block`,
        );
      }
      if ((readWrite.persistedHistoryCompactArtifactIds?.length ?? 0) !== 1) {
        failures.push(
          `${matrixCase.name}: read_write did not persist one history compact block artifact`,
        );
      }
      if ((readWrite.persistedHistoryCompactSourceArtifactIds?.length ?? 0) < 1) {
        failures.push(
          `${matrixCase.name}: read_write did not persist source RuntimeEvent artifacts`,
        );
      }
      if ((readWrite.repeatedContextBudget?.historyCompactBlocksLoaded ?? 0) !== 1) {
        failures.push(
          `${matrixCase.name}: read_write repeated turn did not load one persisted history compact block`,
        );
      }
      if ((readWrite.repeatedContextBudget?.historyCompactBlocksSelected ?? 0) !== 1) {
        failures.push(
          `${matrixCase.name}: read_write repeated turn did not select one persisted history compact block`,
        );
      }
      if ((readWrite.repeatedContextBudget?.historyCompactWritesAttempted ?? 0) > 0) {
        failures.push(
          `${matrixCase.name}: read_write repeated turn rewrote a loaded history compact block`,
        );
      }
      const repeatedLoad = readWrite.historyCompactLoads?.find(
        (load) => load.requestTurnId === 'phase10-repeated-recovery',
      );
      if ((repeatedLoad?.blockIds?.length ?? 0) !== 1) {
        failures.push(
          `${matrixCase.name}: read_write repeated turn did not prove artifact-backed history compact load`,
        );
      }
    }

    const full = byMode.get('full');
    if (
      full &&
      readWrite &&
      typeof full.repeatedUsage?.input === 'number' &&
      typeof readWrite.repeatedUsage?.input === 'number' &&
      readWrite.repeatedUsage.input >= full.repeatedUsage.input
    ) {
      failures.push(`${matrixCase.name}: read_write repeated input was not below full history`);
    }
  }
  return failures;
}

function buildScenario(policy) {
  const explicitName = process.env.MAKA_COST_BASELINE_SCENARIO;
  if (explicitName) {
    return {
      name: explicitName,
      contextBudgetMode: contextBudgetMode(policy),
      archivePruneEnabled: policy?.staleToolResultPrune?.enabled === true,
      historyTokenCap: policy?.maxHistoryEstimatedTokens ?? null,
      historyTurnCap: policy?.maxHistoryTurns ?? null,
      archiveRetrievalEnabled: policy?.archiveRetrieval?.enabled === true,
    };
  }
  return {
    name: scenarioNameForPolicy(policy),
    contextBudgetMode: contextBudgetMode(policy),
    archivePruneEnabled: policy?.staleToolResultPrune?.enabled === true,
    historyTokenCap: policy?.maxHistoryEstimatedTokens ?? null,
    historyTurnCap: policy?.maxHistoryTurns ?? null,
    archiveRetrievalEnabled: policy?.archiveRetrieval?.enabled === true,
  };
}

function scenarioNameForPolicy(policy) {
  if (!policy) return 'budget_off';
  if (policy.historyCompact?.enabled === true) {
    return policy.historyCompact.mode === 'read_write'
      ? 'history_compact_read_write'
      : `history_compact_${policy.historyCompact.mode ?? 'deterministic'}`;
  }
  if (
    policy.staleToolResultPrune?.enabled === true &&
    !policy.maxHistoryEstimatedTokens &&
    !policy.maxHistoryTurns
  ) {
    if (policy.archiveRetrieval?.enabled === true) {
      return policy.archiveRetrieval.mode === 'history_search_gated'
        ? 'archive_prune_on_retrieval_history_search_gated'
        : 'archive_prune_on_retrieval_on';
    }
    return 'archive_prune_on_retrieval_off';
  }
  if (policy.historyRewrite?.enabled === true) return 'named_history_rewrite';
  if (policy.archiveRetrieval?.enabled === true) {
    return policy.archiveRetrieval.mode === 'history_search_gated'
      ? 'emergency_history_cap_archive_retrieval_history_search_gated'
      : 'emergency_history_cap_archive_retrieval_on';
  }
  return 'emergency_history_cap';
}

function contextBudgetMode(policy) {
  if (!policy) return 'off';
  if (policy.synthesisCache?.enabled === true) {
    return policy.synthesisCache.mode === 'read_write'
      ? 'synthesis_read_write'
      : 'synthesis_lookup';
  }
  if (policy.historyCompact?.enabled === true) {
    if (policy.historyCompact.mode === 'read_write') return 'history_compact_read_write';
    if (policy.historyCompact.mode === 'lookup') return 'history_compact_lookup';
    return 'history_compact_deterministic';
  }
  if (
    policy.staleToolResultPrune?.enabled === true &&
    !policy.maxHistoryEstimatedTokens &&
    !policy.maxHistoryTurns
  ) {
    if (policy.archiveRetrieval?.enabled === true) {
      return policy.archiveRetrieval.mode === 'history_search_gated'
        ? 'archive_prune_plus_history_search_gated_retrieval'
        : 'archive_prune_plus_retrieval';
    }
    return 'archive_prune_only';
  }
  return 'emergency_cap';
}

function buildContextBudgetPolicy() {
  if (process.env.MAKA_CONTEXT_BUDGET === 'off') return undefined;
  const maxHistoryEstimatedTokens = parseOptionalPositiveInt(
    process.env.MAKA_CONTEXT_HISTORY_BUDGET_TOKENS,
  );
  const maxHistoryTurns = parseOptionalPositiveInt(process.env.MAKA_CONTEXT_HISTORY_BUDGET_TURNS);
  const staleToolResultPrune = buildStaleToolResultPrunePolicy();
  const archiveRetrieval = buildArchiveRetrievalPolicy();
  const historySearch = buildHistorySearchPolicy();
  const historyRewrite = buildHistoryRewriteGatePolicy();
  const historyCompact = buildHistoryCompactPolicy();
  if (
    maxHistoryEstimatedTokens === undefined &&
    maxHistoryTurns === undefined &&
    !staleToolResultPrune &&
    !archiveRetrieval &&
    !historySearch &&
    !historyRewrite &&
    !historyCompact
  ) {
    return undefined;
  }
  return {
    name: process.env.MAKA_CONTEXT_BUDGET_NAME ?? 'cost-baseline-history-budget',
    minRecentTurns: parsePositiveInt(process.env.MAKA_CONTEXT_MIN_RECENT_TURNS, 2),
    ...(maxHistoryEstimatedTokens !== undefined ? { maxHistoryEstimatedTokens } : {}),
    ...(staleToolResultPrune ? { staleToolResultPrune } : {}),
    ...(archiveRetrieval ? { archiveRetrieval } : {}),
    ...(historySearch ? { historySearch } : {}),
    ...(historyRewrite ? { historyRewrite } : {}),
    ...(historyCompact ? { historyCompact } : {}),
    ...(maxHistoryTurns !== undefined ? { maxHistoryTurns } : {}),
  };
}

function buildStaleToolResultPrunePolicy() {
  if (process.env.MAKA_CONTEXT_STALE_TOOL_RESULT_PRUNE !== 'on') return undefined;
  return {
    enabled: true,
    maxResultEstimatedTokens: parsePositiveInt(
      process.env.MAKA_CONTEXT_STALE_TOOL_RESULT_MAX_TOKENS,
      2048,
    ),
    minRecentTurnsFull: parsePositiveInt(
      process.env.MAKA_CONTEXT_STALE_TOOL_RESULT_MIN_RECENT_TURNS,
      parsePositiveInt(process.env.MAKA_CONTEXT_MIN_RECENT_TURNS, 2),
    ),
  };
}

function buildArchiveRetrievalPolicy() {
  if (process.env.MAKA_CONTEXT_ARCHIVE_RETRIEVAL !== 'on') return undefined;
  const mode = parseArchiveRetrievalMode(process.env.MAKA_CONTEXT_ARCHIVE_RETRIEVAL_MODE);
  return {
    enabled: true,
    ...(mode ? { mode } : {}),
    maxResults: parsePositiveInt(process.env.MAKA_CONTEXT_ARCHIVE_RETRIEVAL_MAX_RESULTS, 3),
    maxEstimatedTokens: parsePositiveInt(
      process.env.MAKA_CONTEXT_ARCHIVE_RETRIEVAL_MAX_TOKENS,
      8192,
    ),
    maxBytes: parsePositiveInt(process.env.MAKA_CONTEXT_ARCHIVE_RETRIEVAL_MAX_BYTES, 1024 * 1024),
    order: 'newest_first',
  };
}

function buildHistorySearchPolicy() {
  if (process.env.MAKA_CONTEXT_HISTORY_SEARCH !== 'on') return undefined;
  return {
    enabled: true,
    maxResults: parsePositiveInt(process.env.MAKA_CONTEXT_HISTORY_SEARCH_MAX_RESULTS, 5),
    around: parsePositiveInt(process.env.MAKA_CONTEXT_HISTORY_SEARCH_AROUND, 1),
    maxEstimatedTokens: parsePositiveInt(process.env.MAKA_CONTEXT_HISTORY_SEARCH_MAX_TOKENS, 4096),
  };
}

function buildHistoryRewriteGatePolicy() {
  if (process.env.MAKA_CONTEXT_HISTORY_REWRITE !== 'on') return undefined;
  return {
    enabled: true,
    name: process.env.MAKA_CONTEXT_HISTORY_REWRITE_NAME ?? 'baseline-history-rewrite',
    historyRewriteVersion: process.env.MAKA_CONTEXT_HISTORY_REWRITE_VERSION ?? 'phase6-v1',
    resetReason:
      process.env.MAKA_CONTEXT_HISTORY_REWRITE_RESET_REASON ??
      'operator_enabled_history_rewrite_gate',
  };
}

function buildHistoryCompactPolicy() {
  if (process.env.MAKA_CONTEXT_HISTORY_COMPACT !== 'on') return undefined;
  return {
    enabled: true,
    mode: parseHistoryCompactMode(process.env.MAKA_CONTEXT_HISTORY_COMPACT_MODE),
    highWaterRatio: parseRatio(process.env.MAKA_CONTEXT_HISTORY_COMPACT_HIGH_WATER_RATIO, 0.8),
    forceRatio: parseRatio(process.env.MAKA_CONTEXT_HISTORY_COMPACT_FORCE_RATIO, 0.9),
    targetRatio: parseRatio(process.env.MAKA_CONTEXT_HISTORY_COMPACT_TARGET_RATIO, 0.5),
    ...(parseOptionalPositiveInt(process.env.MAKA_CONTEXT_HISTORY_COMPACT_TAIL_TOKENS) !== undefined
      ? {
          tailEstimatedTokens: parseOptionalPositiveInt(
            process.env.MAKA_CONTEXT_HISTORY_COMPACT_TAIL_TOKENS,
          ),
        }
      : {}),
    minRecentTurns: parsePositiveInt(
      process.env.MAKA_CONTEXT_HISTORY_COMPACT_MIN_RECENT_TURNS,
      parsePositiveInt(process.env.MAKA_CONTEXT_MIN_RECENT_TURNS, 2),
    ),
    maxSummaryEstimatedTokens: parsePositiveInt(
      process.env.MAKA_CONTEXT_HISTORY_COMPACT_MAX_SUMMARY_TOKENS,
      768,
    ),
    maxBlocks: parsePositiveInt(process.env.MAKA_CONTEXT_HISTORY_COMPACT_MAX_BLOCKS, 1),
    maxEstimatedTokens: parsePositiveInt(process.env.MAKA_CONTEXT_HISTORY_COMPACT_MAX_TOKENS, 2048),
    maxBlockEstimatedTokens: parsePositiveInt(
      process.env.MAKA_CONTEXT_HISTORY_COMPACT_MAX_BLOCK_TOKENS,
      1024,
    ),
    highWaterName:
      process.env.MAKA_CONTEXT_HISTORY_COMPACT_HIGH_WATER_NAME ?? 'cost-baseline-history-compact',
  };
}

function parsePositiveInt(value, fallback) {
  return parseOptionalPositiveInt(value) ?? fallback;
}

function parseOptionalPositiveInt(value) {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function incrementCount(counts, reason) {
  counts[reason] = (counts[reason] ?? 0) + 1;
}

function parseRatio(value, fallback) {
  return parseOptionalRatio(value) ?? fallback;
}

function parseOptionalRatio(value) {
  if (!value) return undefined;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed > 0 && parsed <= 1 ? parsed : undefined;
}

function parseArchiveRetrievalMode(value) {
  if (!value || value === 'eager') return undefined;
  if (value === 'history_search_gated') return value;
  throw new Error(`Unsupported MAKA_CONTEXT_ARCHIVE_RETRIEVAL_MODE: ${value}`);
}

function parseHistoryCompactMode(value) {
  if (!value || value === 'deterministic') return 'deterministic';
  if (value === 'lookup' || value === 'read_write') return value;
  throw new Error(`Unsupported MAKA_CONTEXT_HISTORY_COMPACT_MODE: ${value}`);
}

function classifyCacheMissShape(prefixChangeReason, requestShapeChangeReason) {
  if (!prefixChangeReason && !requestShapeChangeReason) return undefined;
  if (prefixChangeReason === 'first_turn') return 'first_turn';
  if (prefixChangeReason && prefixChangeReason !== 'stable')
    return 'explicit_durable_prefix_change';
  if (requestShapeChangeReason && requestShapeChangeReason !== 'stable')
    return 'derived_request_shape_change';
  return 'stable_shape';
}

function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

function serializeHistoryCompactSourceBody(value) {
  if (value === undefined) return '';
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return String(value);
  }
}

function renderMarkdown(report, jsonPath) {
  const lines = [
    '# DeepSeek Live Cost Baseline',
    '',
    `JSON: \`${jsonPath}\``,
    `Model: \`${report.model}\``,
    `Scenario: \`${report.scenario.name}\` (${report.scenario.contextBudgetMode})`,
    `Turns: ${report.turnCount}`,
    `Tools: ${report.toolMode} (${report.toolCount})`,
    `Stable policy lines: ${report.stablePolicyLines}`,
    `Payload lines: ${report.payloadLines}`,
    `Context budget: ${report.contextBudget ? JSON.stringify(report.contextBudget) : 'off'}`,
    '',
    '## Totals',
    '',
    `- input: ${report.totals.input}`,
    `- cacheHitInput: ${report.totals.cacheHitInput}`,
    `- cacheMissInput: ${report.totals.cacheMissInput}`,
    `- cacheWriteInput: ${report.totals.cacheWriteInput}`,
    `- output: ${report.totals.output}`,
    `- estimatedCostUsd: ${report.totals.estimatedCostUsd}`,
    `- cacheMissSourceTurns: explicit=${report.totals.explicitCacheMissTurns}, derived=${report.totals.derivedCacheMissTurns}, unknown=${report.totals.unknownCacheMissTurns}`,
    `- archivePlaceholders: ${report.totals.archivePlaceholders}`,
    `- archiveWriteFailures: ${report.totals.archiveWriteFailures}`,
    `- archivePlaceholderReasonCounts: ${JSON.stringify(report.totals.archivePlaceholderReasonCounts)}`,
    `- retrievedArchiveToolResults: ${report.totals.retrievedArchiveToolResults}`,
    `- retrievedArchiveEstimatedTokens: ${report.totals.retrievedArchiveEstimatedTokens}`,
    `- archiveRetrievalSkipped: ${report.totals.archiveRetrievalSkipped}`,
    `- archiveRetrievalFailures: ${report.totals.archiveRetrievalFailures}`,
    `- archiveRetrievalFailureReasonCounts: ${JSON.stringify(report.totals.archiveRetrievalFailureReasonCounts)}`,
    '',
    '## Turns',
    '',
    '| turn | input | hit | miss | write | output | prefix reason | request reason | miss source | archive | retrieved | retrieval fail | prior history est | budget after |',
    '| ---: | ---: | ---: | ---: | ---: | ---: | --- | --- | --- | ---: | ---: | ---: | ---: | ---: |',
  ];
  for (const turn of report.turns) {
    const prior = turn.promptSegments?.find((segment) => segment.kind === 'prior_history');
    lines.push(
      [
        `| ${turn.turn}`,
        turn.input ?? 0,
        turn.cacheHitInput ?? 0,
        turn.cacheMissInput ?? 0,
        turn.cacheWriteInput ?? 0,
        turn.output ?? 0,
        turn.prefixChangeReason ?? '',
        turn.requestShapeChangeReason ?? '',
        turn.cacheMissShapeSource ?? turn.cacheMissInputSource ?? '',
        turn.archivePlaceholders ?? 0,
        turn.retrievedArchiveToolResults ?? 0,
        turn.archiveRetrievalFailures ?? 0,
        prior?.estimatedTokens ?? 0,
        turn.contextBudget?.estimatedTokensAfter ?? 0,
      ].join(' | ') + ' |',
    );
  }
  lines.push('');
  return `${lines.join('\n')}\n`;
}
