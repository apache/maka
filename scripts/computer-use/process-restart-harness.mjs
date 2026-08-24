/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { createMakaCuBackend } from '../../packages/computer-use/dist/index.js';
import { buildComputerUseTools } from '../../packages/runtime/dist/computer-use-tools.js';

const repoRoot = new URL('../..', import.meta.url).pathname;
const binaryPath = join(repoRoot, 'apps/desktop/resources/bin/maka-cu');
const labRoot = '/Users/haoqing/Documents/Learning/codex-computer-use-lab';
const expectedAppPath = join(labRoot, 'test-app/build/Codex CUA Lab.app');
const statePath = join(labRoot, 'test-app/runtime/state.json');
const temporaryDirectory = process.env.MAKA_CU_RESTART_TEMP_DIR;
const oldPID = Number(process.env.MAKA_CU_RESTART_OLD_PID);
const soakRounds = Number(process.env.MAKA_CU_RESTART_SOAK_ROUNDS);
// The digest the manifest pins, rather than a copy of it: a hardcoded digest
// here goes stale the first time the executor is rebuilt, and the failure it
// produces is "refusing to spawn an unrecognized binary", which reads like a
// tampering alarm rather than like a stale constant.
const expectedBinarySha256 = JSON.parse(
  await readFile(join(repoRoot, 'apps', 'desktop', 'bundled-tools.json'), 'utf8'),
).makaCu.binarySha256;

const resolvedTemporaryDirectory = resolve(temporaryDirectory ?? '');
const temporaryRelativePath = relative(resolve(tmpdir()), resolvedTemporaryDirectory);
if (
  !temporaryDirectory ||
  temporaryRelativePath.startsWith('..') ||
  temporaryRelativePath === '' ||
  !Number.isInteger(oldPID) ||
  oldPID <= 0 ||
  !Number.isInteger(soakRounds) ||
  soakRounds < 1 ||
  soakRounds > 20
) {
  throw new Error('process restart E2E requires launcher-owned inputs');
}

const reportPath = join(resolvedTemporaryDirectory, 'report.json');
const restartRequestPath = (round) =>
  join(resolvedTemporaryDirectory, `restart-request-${round}.json`);
const restartCompletePath = (round) =>
  join(resolvedTemporaryDirectory, `restart-complete-${round}.json`);
const delay = (milliseconds) =>
  new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
async function waitForJson(path, label, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      return JSON.parse(await readFile(path, 'utf8'));
    } catch (error) {
      if (error?.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
    }
    await delay(50);
  }
  throw new Error(`${label} timeout`);
}

const traces = [];
const idFlow = [];
let latestObservationGeometry;
const backend = createMakaCuBackend({
  binaryPath,
  expectedBinarySha256,
  timeoutMs: 10_000,
  onTrace(event) {
    traces.push(event);
  },
});
const instrumentedBackend = {
  ...backend,
  async observeApp(input, signal, context) {
    const observation = await backend.observeApp(input, signal, context);
    latestObservationGeometry = {
      windowBounds: observation.windowBounds,
      sourceBoundsPx: observation.sourceBoundsPx,
    };
    idFlow.push({
      phase: 'observe',
      observationId: observation.observationId,
      pid: observation.pid,
      sessionId: context.sessionId,
      turnId: context.turnId,
    });
    return observation;
  },
  async runSemantic(action, signal, context) {
    const result = await backend.runSemantic(action, signal, context);
    idFlow.push({
      phase: 'runSemanticResult',
      toolCallId: context.toolCallId,
      ok: result.outcome.ok,
      ...(!result.outcome.ok
        ? { error: result.outcome.error, message: result.outcome.message }
        : {}),
    });
    return result;
  },
  async run(action, signal, context) {
    const result = await backend.run(action, signal, context);
    idFlow.push({
      phase: 'runResult',
      toolCallId: context.toolCallId,
      ok: result.outcome.ok,
      ...(!result.outcome.ok
        ? { error: result.outcome.error, message: result.outcome.message }
        : {}),
    });
    return result;
  },
};
const tools = buildComputerUseTools({ backend: instrumentedBackend });
const [tool] = tools;
const context = (toolCallId, turnId) => ({
  sessionId: 'process-restart-e2e',
  turnId,
  toolCallId,
  cwd: repoRoot,
  abortSignal: new AbortController().signal,
  emitOutput() {},
});
const call = (input, toolCallId, turnId) => tool.impl(input, context(toolCallId, turnId));
const parseModel = (result) => JSON.parse(result.modelText ?? '{}');
const readState = async () => JSON.parse(await readFile(statePath, 'utf8'));

function freshObservationFrom(result) {
  const marker = '\nFresh observation:\n';
  const markerIndex = result.modelText?.indexOf(marker) ?? -1;
  if (markerIndex < 0) return undefined;
  return JSON.parse(result.modelText.slice(markerIndex + marker.length));
}

async function observe(pid, toolCallId, turnId) {
  const result = await call(
    {
      action: 'observe',
      app: `pid:${pid}`,
      include_screenshot: true,
    },
    toolCallId,
    turnId,
  );
  if (result.error || !result.modelText) {
    throw new Error(`observe failed: ${result.error ?? result.text}`);
  }
  return {
    result,
    model: parseModel(result),
    persisted: JSON.parse(result.text),
    geometry: latestObservationGeometry,
  };
}

async function observeUntilElement(pid, label, toolCallPrefix, turnId, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  let lastObserved;
  let lastObservationError;
  while (Date.now() < deadline) {
    try {
      lastObserved = await observe(pid, `${toolCallPrefix}-${Date.now()}`, turnId);
      lastObservationError = undefined;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/invalidApp: no visible window matched/.test(message)) throw error;
      lastObservationError = message;
      await delay(200);
      continue;
    }
    const matches = lastObserved.model.elements
      .filter((element) => element.label === label)
      .sort((left, right) => Number(left.element_id) - Number(right.element_id));
    if (matches.length > 0) {
      return {
        observed: lastObserved,
        element: matches[0],
        candidateCount: matches.length,
      };
    }
    await delay(200);
  }
  const labels =
    lastObserved?.model.elements
      ?.map((element) => element.label)
      .filter(Boolean)
      .slice(0, 30) ?? [];
  throw new Error(
    `${label} did not appear before timeout; ` +
      `lastObservationError=${lastObservationError ?? 'none'}; ` +
      `labels=${JSON.stringify(labels)}`,
  );
}

async function writeReport(report) {
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, {
    flag: 'wx',
    mode: 0o600,
  });
}

const report = {
  schemaVersion: 1,
  soakRounds,
  fixture: {
    bundleIdentifier: 'com.openai.codex.cualab',
    canonicalAppPath: expectedAppPath,
    oldPID,
  },
  cases: [],
};

try {
  const seenHostPIDs = new Set();
  const seenWebContentPIDs = new Set();
  let currentPID = oldPID;
  let serviceGeneration;
  for (let round = 1; round <= soakRounds; round += 1) {
    const currentState = await readState();
    if (
      currentState.synthetic !== true ||
      currentState.syntheticMarker !== 'CUA Lab Synthetic Surface' ||
      currentState.appPath !== expectedAppPath ||
      currentState.oop.hostPID !== currentPID ||
      !Number.isInteger(currentState.oop.webContentPID) ||
      currentState.oop.webContentPID <= 0
    ) {
      throw new Error(`round ${round} fixture provenance mismatch`);
    }
    const currentWebContentPID = currentState.oop.webContentPID;
    if (seenHostPIDs.has(currentPID) || seenWebContentPIDs.has(currentWebContentPID)) {
      throw new Error(`round ${round} reused a prior process identity`);
    }
    seenHostPIDs.add(currentPID);
    seenWebContentPIDs.add(currentWebContentPID);

    const oldReady = await observeUntilElement(
      currentPID,
      'CUA Lab Set Value Field',
      `observe-old-process-r${round}`,
      `turn-old-r${round}`,
    );
    const oldObserved = oldReady.observed;
    await writeFile(
      restartRequestPath(round),
      `${JSON.stringify({
        round,
        oldPID: currentPID,
        oldWebContentPID: currentWebContentPID,
        observationId: oldObserved.model.observation_id,
        candidateCount: oldReady.candidateCount,
      })}\n`,
      { flag: 'wx', mode: 0o600 },
    );

    const restart = await waitForJson(restartCompletePath(round), `fixture restart ${round}`);
    const newPID = restart.newPID;
    const newWebContentPID = restart.newWebContentPID;
    if (
      restart.round !== round ||
      restart.oldPID !== currentPID ||
      !Number.isInteger(newPID) ||
      newPID <= 0 ||
      currentPID === newPID ||
      !Number.isInteger(newWebContentPID) ||
      newWebContentPID <= 0 ||
      currentWebContentPID === newWebContentPID ||
      seenHostPIDs.has(newPID) ||
      seenWebContentPIDs.has(newWebContentPID)
    ) {
      throw new Error(`round ${round} restart identity did not advance`);
    }

    const staleToolCallId = `old-observation-after-restart-r${round}`;
    const staleAttempt = await call(
      {
        action: 'set_value',
        observation_id: oldObserved.model.observation_id,
        element_id: oldReady.element.element_id,
        value: `stale-value-r${round}`,
      },
      staleToolCallId,
      `turn-old-r${round}`,
    );
    await delay(150);
    const newState = await readState();
    const oldRunResult = idFlow.find(
      (event) => event.phase === 'runSemanticResult' && event.toolCallId === staleToolCallId,
    );
    const staleDispatch = traces.find(
      (event) => event.type === 'dispatch' && event.toolCallId === staleToolCallId,
    );
    if (
      oldRunResult?.error !== 'target_missing' ||
      !/target_missing/.test(staleAttempt.modelText ?? '') ||
      staleDispatch ||
      newState.controls.setValue !== ''
    ) {
      throw new Error(`round ${round} old observation crossed process restart`);
    }

    tools.clearSession('process-restart-e2e');
    const freshReady = await observeUntilElement(
      newPID,
      'CUA Lab Set Value Field',
      `observe-new-process-r${round}`,
      `turn-new-r${round}`,
    );
    const freshValue = `fresh-value-r${round}`;
    const freshToolCallId = `fresh-process-set-value-r${round}`;
    const freshAction = await call(
      {
        action: 'set_value',
        observation_id: freshReady.observed.model.observation_id,
        element_id: freshReady.element.element_id,
        value: freshValue,
      },
      freshToolCallId,
      `turn-new-r${round}`,
    );
    await delay(150);
    const newStateAfterAction = await readState();
    const dispatch = traces.find(
      (event) => event.type === 'dispatch' && event.toolCallId === freshToolCallId,
    );
    const freshRunResult = idFlow.find(
      (event) => event.phase === 'runSemanticResult' && event.toolCallId === freshToolCallId,
    );
    const freshObservation = freshObservationFrom(freshAction);
    const freshField = freshObservation?.elements?.find(
      (element) => element.label === 'CUA Lab Set Value Field',
    );
    const freshOccluded = freshRunResult?.error === 'target_occluded';
    const freshSucceeded = !freshAction.error && freshField?.value === freshValue;
    if (
      (!freshSucceeded && !freshOccluded) ||
      (freshOccluded && (dispatch || freshField?.value === freshValue)) ||
      newStateAfterAction.oop.hostPID !== newPID ||
      newStateAfterAction.oop.webContentPID !== newWebContentPID
    ) {
      throw new Error(`round ${round} fresh process action violated its oracle`);
    }

    // maka-cu is one child, not the two roles cua-driver split action and
    // capture across, so this reads one snapshot and compares one generation.
    // It was still shaped like the old backend: `backend.serviceState()` does
    // not exist, so this threw a TypeError on round 1 — inside the try, after
    // the real work had already succeeded, so the harness wrote an ok:false
    // report for a passing real-machine run.
    const executorState = backend.executorState();
    if (executorState.restartAttempts !== 0) {
      throw new Error(`round ${round} executor consumed restart budget`);
    }
    const generation = executorState.generation;
    if (serviceGeneration === undefined) {
      serviceGeneration = generation;
    } else if (generation !== serviceGeneration) {
      throw new Error(`round ${round} unexpectedly restarted the maka-cu executor`);
    }

    report.cases.push({
      round,
      oldPID: currentPID,
      oldWebContentPID: currentWebContentPID,
      newPID,
      newWebContentPID,
      stale: {
        error: oldRunResult.error,
        mutation: ['', newState.controls.setValue],
        dispatch: false,
      },
      fresh: {
        outcome: freshOccluded ? 'fail_closed_occluded' : 'ax_set_value_succeeded',
        mutation: ['', freshField?.value],
      },
      executorGeneration: generation,
    });
    currentPID = newPID;
    tools.clearSession('process-restart-e2e');
  }

  report.ok = true;
  report.claim =
    'old observations never cross repeated real app-process restarts; fresh AX set_value actions target only the new process or fail occluded without side effects';
  report.evidence = {
    seenHostPIDs: [...seenHostPIDs],
    seenWebContentPIDs: [...seenWebContentPIDs],
    executorGeneration: serviceGeneration,
    idFlow,
    traceTypes: traces.map((event) => event.type),
  };
  await writeReport(report);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} catch (error) {
  const failureReport = {
    ...report,
    ok: false,
    failure: error instanceof Error ? error.message : String(error),
    evidence: { idFlow, traces },
  };
  await writeReport(failureReport).catch(() => {});
  process.stderr.write(`${JSON.stringify(failureReport, null, 2)}\n`);
  throw error;
} finally {
  tools.clearSession('process-restart-e2e');
  backend.dispose();
}
