import { _electron as electron, chromium } from '@playwright/test';
import electronBinary from 'electron';
import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluateCuE2eScenarioState, getCuE2eScenario } from './cu-e2e-scenarios.mjs';
import { validateRealReport } from './cu-provider-matrix.mjs';
import {
  sanitizeCuActionRecord,
  sanitizeCuReport,
  sanitizeCuTrace,
} from './cu-report-sanitize.mjs';
import {
  createAgentRunStore,
  createConnectionStore,
  createFileCredentialStore,
} from '../packages/storage/dist/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const execFileAsync = promisify(execFile);
const sourceWorkspace = join(
  homedir(),
  'Library',
  'Application Support',
  'Maka',
  'workspaces',
  'default',
);
const scenario = getCuE2eScenario(process.env.MAKA_CU_E2E_SCENARIO ?? 'l0-observe-only');
if (!scenario.realRunEnabled) {
  throw new Error(`scenario ${scenario.id} is not enabled for real-model runs`);
}
if (scenario.runner) {
  throw new Error(`scenario ${scenario.id} requires dedicated runner ${scenario.runner}`);
}
const availableCapabilities = new Set(
  String(process.env.MAKA_CU_EXECUTION_CAPABILITIES ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean),
);
for (const capability of scenario.requiresExecutionCapabilities) {
  if (!availableCapabilities.has(capability)) {
    throw new Error(`scenario ${scenario.id} requires unavailable capability ${capability}`);
  }
}

const timeoutMs = Number(process.env.MAKA_CU_REAL_MODEL_TIMEOUT_MS ?? 180_000);
const keepProfile = process.env.MAKA_CU_KEEP_PROFILE === '1';
const providerOverride = process.env.MAKA_CU_PROVIDER;
const reportPath =
  process.env.MAKA_CU_REAL_MODEL_REPORT ??
  join(repoRoot, '.agents-workspace-data', 'cu-real-model', `report-${Date.now()}.json`);
const runPrompt = 'Use the maka_computer tool to complete this task. ' + scenario.prompt;

async function reportLineage() {
  const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], {
    cwd: repoRoot,
  });
  const generatedAt = new Date().toISOString();
  const gitRevision = stdout.trim();
  return {
    runId: randomUUID(),
    gitRevision,
    generatedAt,
    contentLineage: {
      generator: 'scripts/cu-real-model-launcher.mjs',
      gitRevision,
      generatedAt,
    },
  };
}

async function reservePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise((resolve) => server.close(resolve));
  if (!port) throw new Error('failed to reserve loopback port');
  return port;
}

async function copyProfileFile(name, workspace) {
  await cp(join(sourceWorkspace, name), join(workspace, name), {
    errorOnExist: true,
  });
}

async function prepareProviderProfile(workspace) {
  if (!providerOverride) {
    await Promise.all([
      copyProfileFile('llm-connections.json', workspace),
      copyProfileFile('credentials.json', workspace),
      copyProfileFile('settings.json', workspace),
    ]);
    return;
  }
  if (providerOverride !== 'openai') {
    throw new Error(`unsupported MAKA_CU_PROVIDER ${providerOverride}`);
  }
  await copyProfileFile('settings.json', workspace);
  const connections = createConnectionStore(workspace);
  const credentials = createFileCredentialStore(workspace);
  const slug = 'cu-real-openai';
  await connections.create({
    slug,
    name: 'Computer Use real-model OpenAI',
    providerType: 'openai',
    baseUrl: process.env.MAKA_CU_OPENAI_BASE_URL ?? 'http://127.0.0.1:8538/v1',
    defaultModel: process.env.MAKA_CU_OPENAI_MODEL ?? 'gpt-5.4',
  });
  await credentials.setSecret(
    slug,
    'api_key',
    process.env.MAKA_CU_OPENAI_API_KEY ?? 'local-bridge',
  );
  await connections.setDefault(slug);
}

async function waitForLine(child, marker, timeout) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${marker}`)), timeout);
    const onData = (chunk) => {
      stdout += String(chunk);
      process.stdout.write(chunk);
      const matched =
        marker === 'CU_FIXTURE_READY'
          ? /^CU_FIXTURE_READY\s+\d+\s*$/m.test(stdout)
          : stdout.includes(marker);
      if (matched) {
        clearTimeout(timer);
        child.stdout.off('data', onData);
        resolve(stdout);
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', (chunk) => process.stderr.write(chunk));
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      reject(new Error(`fixture exited before ready: ${signal ?? `code ${code}`}`));
    });
  });
}

export function parseFixtureReady(text, childPid) {
  const matches =
    typeof text === 'string' ? [...text.matchAll(/^CU_FIXTURE_READY\s+(\d+)\s*$/gm)] : [];
  if (matches.length !== 1) {
    throw new Error('fixture READY identity is missing or ambiguous');
  }
  const readyPid = Number(matches[0][1]);
  if (!Number.isInteger(childPid) || childPid <= 0 || readyPid !== childPid) {
    throw new Error(`fixture READY pid ${readyPid} does not match launcher child pid ${childPid}`);
  }
  return readyPid;
}

export function parseTargetEvidence(text) {
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
        Number.isInteger(value.pid) &&
        Number.isInteger(value.window_id)
      ) {
        return {
          ...(typeof value.observation_id === 'string'
            ? { observationId: value.observation_id }
            : {}),
          pid: value.pid,
          windowId: value.window_id,
        };
      }
    } catch {
      // Continue to the next privacy-safe projection candidate.
    }
  }
  return undefined;
}

export function actionRecords(events) {
  const starts = new Map();
  const records = [];
  for (const event of events) {
    if (event.type === 'tool_start' && event.toolName === 'maka_computer') {
      starts.set(event.toolUseId, event);
    }
    if (event.type === 'tool_result' && starts.has(event.toolUseId)) {
      const start = starts.get(event.toolUseId);
      const text = event.content?.kind === 'text' ? event.content.text : undefined;
      const resultCode =
        typeof text === 'string'
          ? text.match(/\bfailed:\s*([a-z][a-z0-9_]{1,63})\b/i)?.[1]
          : undefined;
      const target = parseTargetEvidence(text);
      records.push(
        sanitizeCuActionRecord({
          action: start.args,
          toolCallId: event.toolUseId,
          sourceObservationId: start.args?.observation_id ?? start.args?.observationId,
          resultObservationId: target?.observationId,
          targetPid: target?.pid,
          targetWindowId: target?.windowId,
          durationMs: event.durationMs,
          text,
          success: event.isError === false && !resultCode,
        }),
      );
    }
  }
  return records;
}

export async function waitForTraceFlush(path, expectedToolCallIds, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const current = await readFile(path, 'utf8').catch((error) => {
      if (error?.code === 'ENOENT') return '';
      throw error;
    });
    const traces = [];
    let incompleteTrace = false;
    for (const line of current.split('\n').filter(Boolean)) {
      try {
        traces.push(JSON.parse(line));
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        incompleteTrace = true;
      }
    }
    const observedToolCallIds = new Set(
      traces.filter((trace) => trace.type === 'dispatch').map((trace) => trace.toolCallId),
    );
    if (
      !incompleteTrace &&
      expectedToolCallIds.every((toolCallId) => observedToolCallIds.has(toolCallId))
    ) {
      return traces;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(
    `timed out waiting for Computer Use dispatch traces: ${expectedToolCallIds.join(',')}`,
  );
}

export async function discoverFixtureIdentity(
  fixturePid,
  windowSpecs,
  { listApps, timeoutMs = 2_000, pollIntervalMs = 50 } = {},
) {
  if (!Number.isInteger(fixturePid) || fixturePid <= 0) {
    throw new Error('fixture discovery requires a valid launcher-owned pid');
  }
  if (typeof listApps !== 'function') {
    throw new Error('fixture discovery requires an independent window lister');
  }
  const expectedTitles = windowSpecs?.map((window) => window.title);
  if (
    !Array.isArray(expectedTitles) ||
    expectedTitles.length === 0 ||
    expectedTitles.some((title) => typeof title !== 'string' || title.length === 0) ||
    new Set(expectedTitles).size !== expectedTitles.length
  ) {
    throw new Error('fixture discovery requires unique expected window titles');
  }

  const deadline = Date.now() + timeoutMs;
  let lastFailure = 'fixture app was not found';
  while (Date.now() < deadline) {
    const apps = await listApps();
    const fixtureApps = Array.isArray(apps)
      ? apps.filter((app) => Number(app?.pid) === fixturePid)
      : [];
    if (fixtureApps.length === 1) {
      const windows = Array.isArray(fixtureApps[0].windows) ? fixtureApps[0].windows : [];
      const windowIds = [];
      let complete = true;
      for (const title of expectedTitles) {
        const matches = windows.filter(
          (window) =>
            window?.title === title && Number.isInteger(window?.windowId) && window.windowId > 0,
        );
        if (matches.length !== 1) {
          complete = false;
          lastFailure = `expected one fixture window "${title}", got ${matches.length}`;
          break;
        }
        windowIds.push(matches[0].windowId);
      }
      if (complete && new Set(windowIds).size === windowIds.length) {
        return {
          instances: [
            {
              pid: fixturePid,
              windowIds,
            },
          ],
        };
      }
      if (complete) lastFailure = 'fixture discovery returned duplicate window ids';
    } else {
      lastFailure = `expected one fixture app for pid ${fixturePid}, got ${fixtureApps.length}`;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, pollIntervalMs));
  }
  throw new Error(`fixture identity discovery failed: ${lastFailure}`);
}

async function discoverLauncherFixtureIdentity(fixturePid, windowSpecs) {
  const [{ createCuaDriverBackend }, manifestText] = await Promise.all([
    import('../packages/computer-use/dist/index.js'),
    readFile(join(repoRoot, 'apps', 'desktop', 'bundled-tools.json'), 'utf8'),
  ]);
  const manifest = JSON.parse(manifestText);
  const expectedBinarySha256 = manifest?.cuaDriver?.binarySha256;
  const expectedServerVersion = manifest?.cuaDriver?.expectedVersion;
  const expectedProtocolVersion = manifest?.cuaDriver?.expectedProtocolVersion;
  if (
    typeof expectedBinarySha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(expectedBinarySha256) ||
    typeof expectedServerVersion !== 'string' ||
    typeof expectedProtocolVersion !== 'string'
  ) {
    throw new Error('fixture discovery cannot verify bundled cua-driver identity');
  }
  const backend = createCuaDriverBackend({
    binaryPath: join(repoRoot, 'apps', 'desktop', 'resources', 'bin', 'cua-driver'),
    hostBundleId: 'com.maka.desktop',
    expectedBinarySha256,
    expectedServerName: 'cua-driver',
    expectedServerVersion,
    expectedProtocolVersion,
    timeoutMs: 10_000,
  });
  try {
    return await discoverFixtureIdentity(fixturePid, windowSpecs, {
      listApps: () => backend.listApps(new AbortController().signal),
      timeoutMs: 5_000,
    });
  } finally {
    backend.dispose();
  }
}

function safeEvent(event) {
  if (event.type === 'tool_start') {
    const safeToolName =
      event.toolName === 'load_tools' || event.toolName === 'maka_computer'
        ? event.toolName
        : 'other';
    return {
      type: event.type,
      toolName: safeToolName,
      ...(event.toolName === 'maka_computer'
        ? { actionType: event.args?.action ?? 'unknown' }
        : {}),
      ts: event.ts,
    };
  }
  if (event.type === 'tool_result') {
    return {
      type: event.type,
      isError: event.isError,
      durationMs: event.durationMs,
      ts: event.ts,
    };
  }
  if (event.type === 'complete' || event.type === 'abort' || event.type === 'error') {
    const safeCode = [event.code, event.reason].find(
      (value) => typeof value === 'string' && /^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/.test(value),
    );
    return {
      type: event.type,
      ...(event.stopReason ? { stopReason: event.stopReason } : {}),
      ...(safeCode ? { code: safeCode } : {}),
      ts: event.ts,
    };
  }
  return null;
}

function safeFailureMetadata(message) {
  if (typeof message !== 'string') return undefined;
  const status = message.match(/\b([45]\d\d)\b/)?.[1];
  const errorName = message.match(/\b([A-Z][A-Za-z]+Error)\b/)?.[1];
  const providerType = message
    .match(
      /\b(api_error|authentication_error|billing_error|invalid_request_error|overloaded_error|permission_error|rate_limit_error)\b/i,
    )?.[1]
    ?.toLowerCase();
  const result = {
    ...(status ? { httpStatus: Number(status) } : {}),
    ...(errorName ? { errorName } : {}),
    ...(providerType ? { providerErrorType: providerType } : {}),
  };
  return Object.keys(result).length > 0 ? result : undefined;
}

async function run() {
  const lineage = await reportLineage();
  const userData = await mkdtemp(join(tmpdir(), 'maka-cu-real-model-'));
  const workspace = join(userData, 'workspaces', 'default');
  const tracePath = join(userData, 'computer-use-trace.jsonl');
  const fixturePort = await reservePort();
  let fixture;
  let desktop;
  let fixtureBrowser;
  try {
    await mkdir(workspace, { recursive: true });
    await mkdir(dirname(reportPath), { recursive: true });
    await prepareProviderProfile(workspace);

    fixture = spawn(
      electronBinary,
      [
        `--remote-debugging-port=${fixturePort}`,
        '--remote-allow-origins=*',
        join(here, 'cu-real-model-fixture.mjs'),
      ],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          MAKA_CU_E2E_SCENARIO: scenario.id,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    const readyOutput = await waitForLine(fixture, 'CU_FIXTURE_READY', 30_000);
    const fixturePid = parseFixtureReady(readyOutput, fixture.pid);
    const fixtureIdentity = await discoverLauncherFixtureIdentity(
      fixturePid,
      activeWindowSpecs(scenario),
    );

    desktop = await electron.launch({
      args: ['apps/desktop'],
      cwd: repoRoot,
      env: {
        ...process.env,
        MAKA_CU_REAL_MODEL_E2E: '1',
        MAKA_E2E_USER_DATA_DIR: userData,
        MAKA_CU_REAL_MODEL_POLICY: JSON.stringify({
          allowedActions: scenario.allowedActions,
          maxTotalActions: scenario.maxTotalActions,
          maxActionCounts:
            scenario.maxActionCounts ??
            Object.fromEntries(
              scenario.allowedActions.map((action) => [action, scenario.maxTotalActions]),
            ),
          allowedApps: activeWindowSpecs(scenario).map((window) => window.title),
        }),
        MAKA_CU_REAL_MODEL_TRACE: tracePath,
      },
      timeout: 30_000,
    });
    const page = await desktop.firstWindow();
    await page.waitForFunction(() => Boolean(window.maka?.sessions));

    const runResult = await page.evaluate(
      async ({ prompt, timeout }) => {
        const connections = await window.maka.connections.list();
        const defaultSlug = await window.maka.connections.getDefault();
        const connection = connections.find((entry) => entry.slug === defaultSlug);
        if (!connection?.defaultModel) {
          throw new Error('isolated profile has no ready default model');
        }
        const session = await window.maka.sessions.create({
          backend: 'ai-sdk',
          llmConnectionSlug: connection.slug,
          model: connection.defaultModel,
          permissionMode: 'bypass',
          name: 'Computer Use real-model E2E',
          labels: ['computer-use', 'real-model-e2e'],
        });
        const events = [];
        const terminal = new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('real-model turn timed out')), timeout);
          const unsubscribe = window.maka.sessions.subscribeEvents(session.id, (event) => {
            events.push(event);
            if (event.type === 'complete' || event.type === 'abort' || event.type === 'error') {
              clearTimeout(timer);
              unsubscribe();
              resolve(event);
            }
          });
        });
        const turnId = crypto.randomUUID();
        await window.maka.sessions.send(session.id, {
          type: 'send',
          turnId,
          text: prompt,
        });
        const terminalEvent = await terminal;
        return {
          connection: {
            slug: connection.slug,
            providerType: connection.providerType,
            model: connection.defaultModel,
          },
          sessionId: session.id,
          turnId,
          events,
          terminalEvent,
        };
      },
      { prompt: runPrompt, timeout: timeoutMs },
    );

    fixtureBrowser = await chromium.connectOverCDP(`http://127.0.0.1:${fixturePort}`);
    const fixturePages = fixtureBrowser.contexts().flatMap((context) => context.pages());
    const fixtureState = {};
    for (const windowSpec of activeWindowSpecs(scenario)) {
      const pageForTitle = await Promise.all(
        fixturePages.map(async (candidate) => ({
          candidate,
          title: await candidate.title(),
        })),
      ).then((entries) => entries.find((entry) => entry.title === windowSpec.title)?.candidate);
      if (!pageForTitle) throw new Error(`missing fixture page ${windowSpec.title}`);
      fixtureState[windowSpec.id] = await pageForTitle.evaluate(
        () => globalThis.__makaCuFixtureState?.() ?? null,
      );
    }
    const evaluation = evaluateCuE2eScenarioState(scenario, fixtureState);
    const events = runResult.events.map(safeEvent).filter(Boolean);
    const rawActions = actionRecords(runResult.events);
    const expectedDispatchToolCallIds = rawActions
      .filter(
        (action) =>
          action.success === true &&
          !['list_apps', 'observe', 'screenshot', 'cursor_position', 'zoom', 'wait'].includes(
            action.type,
          ),
      )
      .map((action) => action.toolCallId)
      .filter((toolCallId) => typeof toolCallId === 'string');
    const driverTraces = await waitForTraceFlush(tracePath, expectedDispatchToolCallIds);
    const actions = bindActionTargets(rawActions, driverTraces, fixtureIdentity);
    const runStore = createAgentRunStore(workspace);
    const runHeader = await waitForRunHeader(runStore, runResult.sessionId, runResult.turnId);
    const qualifyingActions = actions.filter(
      (action) =>
        action.success === true &&
        action.targetOwned === true &&
        scenario.allowedActions.includes(action.type),
    );
    const actionCounts = Object.fromEntries(
      actions.reduce((counts, action) => {
        counts.set(action.type, (counts.get(action.type) ?? 0) + 1);
        return counts;
      }, new Map()),
    );
    const qualifyingActionCounts = Object.fromEntries(
      scenario.allowedActions.map((action) => [
        action,
        qualifyingActions.filter((record) => record.type === action).length,
      ]),
    );
    const minimumActionsPassed = Object.entries(scenario.minimumActionCounts ?? {}).every(
      ([action, minimum]) => (qualifyingActionCounts[action] ?? 0) >= minimum,
    );
    const terminalPassed =
      runResult.terminalEvent.type === 'complete' &&
      runResult.terminalEvent.stopReason === 'end_turn';
    const actionsWithinBudget =
      actions.length <= scenario.maxTotalActions &&
      actions.every((action) => scenario.allowedActions.includes(action.type)) &&
      Object.entries(scenario.maxActionCounts ?? {}).every(
        ([action, maximum]) => actions.filter((record) => record.type === action).length <= maximum,
      );
    const dispatchPathPassed = requiredDispatchPathPassed(scenario, driverTraces);
    const ownershipPassed = allActionTargetsOwned(actions);
    const localChecksPassed =
      terminalPassed &&
      minimumActionsPassed &&
      actionsWithinBudget &&
      dispatchPathPassed &&
      ownershipPassed &&
      evaluation.pass;
    const reportInput = {
      schemaVersion: 1,
      ...lineage,
      evidenceClass: 'real-runtime',
      policyMode: 'bypassed',
      qualificationEligible: true,
      toolExposure: 'direct-e2e',
      scenarioId: scenario.id,
      producer: 'cu-real-model-launcher',
      transportClass: 'live-network',
      provider: runResult.connection.providerType,
      model: runResult.connection.model,
      fixtureIdentity,
      terminal: safeEvent(runResult.terminalEvent),
      run: runHeader
        ? {
            status: runHeader.status,
            failureClass: runHeader.failureClass,
            failure: safeFailureMetadata(runHeader.failureMessage),
            durationMs:
              runHeader.completedAt !== undefined
                ? Math.max(0, runHeader.completedAt - runHeader.createdAt)
                : undefined,
          }
        : undefined,
      actionAttempts: actions.length,
      actionCount: actions.length,
      actionCounts,
      minimumActionsPassed,
      actionsWithinBudget,
      dispatchPathPassed,
      actions,
      fixtureState,
      expectedState: evaluation.expected,
      forbiddenEffects: {
        status: evaluation.forbidden.every((entry) => entry.pass) ? 'pass' : 'fail',
        violations: evaluation.forbidden.filter((entry) => !entry.pass),
      },
      status: localChecksPassed
        ? 'pass'
        : terminalPassed && minimumActionsPassed
          ? 'fail'
          : 'inconclusive',
      traces: events.map(sanitizeCuTrace).filter(Boolean),
      driverTraces: driverTraces.map(sanitizeCuTrace).filter(Boolean),
    };
    const provider = {
      id: runResult.connection.providerType,
      producer: 'cu-real-model-launcher',
      model: runResult.connection.model,
    };
    const provisionalReport = sanitizeCuReport(reportInput);
    const qualificationErrors = validateRealReport(
      { ...provisionalReport, status: 'pass' },
      provider,
      scenario,
    );
    const report = sanitizeCuReport({
      ...reportInput,
      status: qualificationErrors.length === 0 ? 'pass' : 'fail',
    });
    const validationErrors = validateRealReport(report, provider, scenario);
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, {
      flag: 'wx',
      mode: 0o600,
    });
    process.stdout.write(`Real-model Computer Use report: ${reportPath}\n`);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (validationErrors.length > 0) {
      process.stderr.write(
        `Real-model Computer Use qualification failed: ${validationErrors.join('; ')}\n`,
      );
      process.exitCode = 1;
    }
  } finally {
    await fixtureBrowser?.close().catch(() => {});
    await desktop?.close().catch(() => {});
    if (fixture && fixture.exitCode === null) fixture.kill('SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 250));
    if (fixture && fixture.exitCode === null) fixture.kill('SIGKILL');
    if (keepProfile) {
      process.stderr.write(`Retained isolated debug profile: ${userData}\n`);
    } else {
      await rm(userData, { recursive: true, force: true });
    }
  }
}

async function handleRunFailure(error) {
  const lineage = await reportLineage().catch(() => undefined);
  const failure = sanitizeCuReport({
    schemaVersion: 1,
    ...lineage,
    evidenceClass: 'real-runtime',
    scenarioId: scenario.id,
    producer: 'cu-real-model-launcher',
    status: 'inconclusive',
    terminal: { type: 'error' },
    run: {
      status: 'failed',
      failureClass:
        typeof error?.code === 'string'
          ? error.code
          : error instanceof Error
            ? error.name
            : 'unknown',
    },
  });
  await mkdir(dirname(reportPath), { recursive: true }).catch(() => {});
  await writeFile(reportPath, `${JSON.stringify(failure, null, 2)}\n`, {
    flag: 'wx',
    mode: 0o600,
  }).catch(() => {});
  console.error('Real-model Computer Use E2E failed');
  process.exitCode = 1;
}

function requiredDispatchPathPassed(scenario, traces) {
  const mutationActions = scenario.allowedActions.filter(
    (action) =>
      !['list_apps', 'observe', 'screenshot', 'cursor_position', 'zoom', 'wait'].includes(action),
  );
  if (mutationActions.length === 0) return true;
  return traces.some(
    (trace) =>
      trace.type === 'dispatch' && (trace.address === 'ax' || trace.address === 'semantic'),
  );
}

function fixtureOwnsTarget(fixtureIdentity, pid, windowId) {
  return (
    fixtureIdentity?.instances?.some(
      (instance) => instance.pid === pid && instance.windowIds?.includes(windowId),
    ) === true
  );
}

export function bindActionTargets(actions, traces, fixtureIdentity) {
  const dispatches = traces.filter(
    (trace) =>
      trace.type === 'dispatch' && (trace.address === 'ax' || trace.address === 'semantic'),
  );
  const observationTargets = new Map(
    actions.flatMap((action) =>
      (action.type === 'observe' || action.type === 'screenshot') &&
      typeof action.resultObservationId === 'string' &&
      Number.isInteger(action.targetPid) &&
      Number.isInteger(action.targetWindowId)
        ? [
            [
              action.resultObservationId,
              {
                pid: action.targetPid,
                windowId: action.targetWindowId,
              },
            ],
          ]
        : [],
    ),
  );
  const consumed = new Set();
  return actions.map((action) => {
    if (['list_apps', 'wait', 'cursor_position'].includes(action.type)) {
      return { ...action, targetOwned: false };
    }
    const index = dispatches.findIndex(
      (trace, traceIndex) =>
        !consumed.has(traceIndex) &&
        trace.toolCallId === action.toolCallId &&
        trace.actionType === action.type,
    );
    if (index >= 0) consumed.add(index);
    const dispatch = index >= 0 ? dispatches[index] : undefined;
    const sourceTarget =
      typeof action.sourceObservationId === 'string'
        ? observationTargets.get(action.sourceObservationId)
        : undefined;
    const directResultTarget =
      ['observe', 'screenshot', 'zoom'].includes(action.type) &&
      Number.isInteger(action.targetPid) &&
      Number.isInteger(action.targetWindowId)
        ? { pid: action.targetPid, windowId: action.targetWindowId }
        : undefined;
    const target = dispatch
      ? { pid: dispatch.pid, windowId: dispatch.windowId }
      : sourceTarget
        ? sourceTarget
        : directResultTarget;
    return {
      ...action,
      targetOwned: target ? fixtureOwnsTarget(fixtureIdentity, target.pid, target.windowId) : false,
      ...(target
        ? {
            targetPid: target.pid,
            targetWindowId: target.windowId,
          }
        : {}),
    };
  });
}

export function allActionTargetsOwned(actions) {
  return actions.every(
    (action) =>
      ['list_apps', 'wait', 'cursor_position'].includes(action.type) || action.targetOwned === true,
  );
}

function activeWindowSpecs(scenario) {
  const specs = new Map(scenario.fixtureSetup.windows.map((window) => [window.id, window]));
  for (const transition of scenario.fixtureSetup.transitions ?? []) {
    specs.delete(transition.removeWindowId);
    specs.set(transition.addWindow.id, transition.addWindow);
  }
  return [...specs.values()];
}

async function waitForRunHeader(store, sessionId, turnId) {
  const deadline = Date.now() + 2_000;
  let latest;
  do {
    latest = (await store.listSessionRuns(sessionId)).find((entry) => entry.turnId === turnId);
    if (
      latest &&
      latest.status !== 'created' &&
      latest.status !== 'running' &&
      latest.status !== 'waiting_permission'
    )
      return latest;
    await new Promise((resolve) => setTimeout(resolve, 50));
  } while (Date.now() < deadline);
  return latest;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  run().catch(handleRunFailure);
}
