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

import type { CDPSession, Page } from '@playwright/test';
import { PROMPT_RAIL_PROMPT_COUNT } from '../src/main/e2e-fixture/seed-helpers';
import * as transcriptContract from '../src/preload/transcript-contract';
import { ensureSidebarExpanded, expect, test } from './fixtures';

const PERF_ENABLED = process.env.MAKA_TRANSCRIPT_PERF === '1';
const STRESS_ENABLED = process.env.MAKA_TRANSCRIPT_STRESS === '1';
const SCROLLER = '[data-chat-scroll-container="true"]';

interface BrowserCounters {
  heapBytes: number;
  nodes: number;
  documents: number;
  jsEventListeners: number;
}

interface FrameSample {
  intervals: number[];
  loafDurations: number[];
  loafSupported: boolean;
}

interface StressSample extends BrowserCounters {
  sweep: number;
  iteration: number;
  firstTurnId: string | null;
  lastTurnId: string | null;
  mountedTurns: number;
}

interface StressSweep {
  sweep: number;
  successfulPages: number;
  samples: StressSample[];
}

interface HeapGrowth {
  endpointRatio: number;
  slopeBytesPerPage: number;
  projectedRatio: number;
}

/** The predeclared secondary heap/DOM release gate permits at most 10% growth. */
const SECONDARY_RESOURCE_GROWTH_RATIO = 0.1;

function positiveHeapGrowth(samples: readonly StressSample[]): HeapGrowth {
  const first = samples[0]!;
  const last = samples.at(-1)!;
  const meanIteration = samples.reduce((sum, sample) => sum + sample.iteration, 0)
    / samples.length;
  const meanHeap = samples.reduce((sum, sample) => sum + sample.heapBytes, 0)
    / samples.length;
  const slopeNumerator = samples.reduce(
    (sum, sample) => sum + (sample.iteration - meanIteration) * (sample.heapBytes - meanHeap),
    0,
  );
  const slopeDenominator = samples.reduce(
    (sum, sample) => sum + (sample.iteration - meanIteration) ** 2,
    0,
  );
  const slopeBytesPerPage = slopeDenominator === 0 ? 0 : slopeNumerator / slopeDenominator;
  const iterationSpan = last.iteration - first.iteration;
  return {
    endpointRatio: Math.max(0, last.heapBytes - first.heapBytes) / first.heapBytes,
    slopeBytesPerPage,
    projectedRatio: Math.max(0, slopeBytesPerPage * iterationSpan) / first.heapBytes,
  };
}

function percentile(values: readonly number[], probability: number): number {
  if (values.length === 0) return 0;
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.min(ordered.length - 1, Math.ceil(probability * ordered.length) - 1)]!;
}

async function collectGarbage(cdp: CDPSession): Promise<void> {
  await cdp.send('HeapProfiler.enable');
  await cdp.send('HeapProfiler.collectGarbage');
}

async function browserCounters(cdp: CDPSession): Promise<BrowserCounters> {
  const [heap, dom] = await Promise.all([
    cdp.send('Runtime.getHeapUsage'),
    cdp.send('Memory.getDOMCounters'),
  ]);
  return {
    heapBytes: heap.usedSize,
    nodes: dom.nodes,
    documents: dom.documents,
    jsEventListeners: dom.jsEventListeners,
  };
}

async function performanceMetrics(cdp: CDPSession): Promise<Map<string, number>> {
  const result = await cdp.send('Performance.getMetrics');
  return new Map(result.metrics.map(({ name, value }) => [name, value]));
}

function metricDelta(
  before: ReadonlyMap<string, number>,
  after: ReadonlyMap<string, number>,
  name: string,
): number {
  return (after.get(name) ?? 0) - (before.get(name) ?? 0);
}

async function prepareFrameRecorder(page: Page): Promise<void> {
  await page.evaluate(() => {
    const state: FrameSample & { lastFrame: number | null; running: boolean } = {
      intervals: [],
      loafDurations: [],
      loafSupported: PerformanceObserver.supportedEntryTypes
        .includes('long-animation-frame'),
      lastFrame: null,
      running: false,
    };
    Object.assign(window, { __makaTranscriptPerf: state });
    if (state.loafSupported) {
      try {
        const observer = new PerformanceObserver((list) => {
          if (!state.running) return;
          state.loafDurations.push(...list.getEntries().map((entry) => entry.duration));
        });
        observer.observe({ type: 'long-animation-frame', buffered: false });
      } catch {
        state.loafSupported = false;
      }
    }
  });
}

async function scrollGesture(page: Page, delta: number, frames = 240): Promise<FrameSample> {
  return page.evaluate(async ({ selector, delta, frames }) => {
    type Recorder = FrameSample & { lastFrame: number | null; running: boolean };
    const root = document.querySelector<HTMLElement>(selector);
    const recorder = (window as Window & { __makaTranscriptPerf?: Recorder })
      .__makaTranscriptPerf;
    if (!root || !recorder) throw new Error('the transcript performance probe is missing');
    recorder.intervals.length = 0;
    recorder.loafDurations.length = 0;
    recorder.lastFrame = null;
    recorder.running = true;
    const start = root.scrollTop;
    await new Promise<void>((resolve) => {
      let completed = 0;
      const tick = (now: number) => {
        if (recorder.lastFrame !== null) recorder.intervals.push(now - recorder.lastFrame);
        recorder.lastFrame = now;
        completed += 1;
        root.scrollTop = start + (delta * completed) / frames;
        if (completed >= frames) {
          resolve();
          return;
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    recorder.running = false;
    return {
      intervals: [...recorder.intervals],
      loafDurations: [...recorder.loafDurations],
      loafSupported: recorder.loafSupported,
    };
  }, { selector: SCROLLER, delta, frames });
}

async function moveToTail(page: Page): Promise<void> {
  await page.evaluate((selector) => {
    const root = document.querySelector<HTMLElement>(selector);
    if (!root) throw new Error('the chat scroll container is missing');
    root.scrollTop = root.scrollHeight;
  }, SCROLLER);
}

async function returnToLatest(page: Page): Promise<void> {
  const returnLatest = page.getByRole('button', {
    name: /^(?:返回最新消息|Return to latest)$/,
  });
  if (await returnLatest.isVisible()) await returnLatest.click();
  else await page.locator('.maka-prompt-rail-tick').last().click({ force: true });
}

async function traverseFullHistoryAndReturnToTail(page: Page): Promise<void> {
  for (let iteration = 0; iteration < PROMPT_RAIL_PROMPT_COUNT; iteration += 1) {
    const firstBefore = await page.locator('[data-turn-id]').first().getAttribute('data-turn-id');
    if (firstBefore?.endsWith('-1')) break;
    await page.evaluate((selector) => {
      const root = document.querySelector<HTMLElement>(selector);
      if (!root) throw new Error('the chat scroll container is missing');
      root.scrollTop = 0;
      root.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, bubbles: true }));
    }, SCROLLER);
    await expect.poll(async () =>
      page.locator('[data-turn-id]').first().getAttribute('data-turn-id'),
    ).not.toBe(firstBefore);
  }
  await expect(page.locator('[data-turn-id="turn-prompt-rail-1"]')).toHaveCount(1);
  await returnToLatest(page);
  await expect(page.locator(`[data-turn-id="turn-prompt-rail-${PROMPT_RAIL_PROMPT_COUNT}"]`))
    .toHaveCount(1);
}

async function measureSessionSwitch(page: Page): Promise<number> {
  await ensureSidebarExpanded(page);
  const rows = page.locator('.maka-session-row');
  const selected = rows.locator('button.astryx-side-nav-item.selected');
  const originalId = await selected.evaluate((button) =>
    button.closest('.maka-session-row')?.getAttribute('data-session-id'),
  );
  if (!originalId) throw new Error('the prompt-rail Session is not selected');
  const otherId = await rows.evaluateAll(
    (elements, current) => elements
      .map((element) => element.getAttribute('data-session-id'))
      .find((sessionId) => sessionId !== current) ?? null,
    originalId,
  );
  if (!otherId) throw new Error('the fixture has no second Session');
  const start = performance.now();
  await page.locator(`.maka-session-row[data-session-id=${JSON.stringify(otherId)}] button`)
    .first()
    .click();
  await expect(page.locator(
    `.maka-session-row[data-session-id=${JSON.stringify(otherId)}] button.selected`,
  )).toHaveCount(1);
  await page.locator(`.maka-session-row[data-session-id=${JSON.stringify(originalId)}] button`)
    .first()
    .click();
  await expect(page.locator('[data-turn-id="turn-prompt-rail-120"]')).toHaveCount(1);
  return performance.now() - start;
}

test('LoAF capability is explicit when Chromium cannot measure it', async ({
  promptRailWindow: page,
}) => {
  test.skip(!PERF_ENABLED, 'manual same-build CDP A/B harness');
  await page.evaluate(() => {
    Object.defineProperty(PerformanceObserver, 'supportedEntryTypes', {
      configurable: true,
      value: [],
    });
  });
  await prepareFrameRecorder(page);
  const frames = await scrollGesture(page, -1, 2);
  expect(frames.loafSupported).toBe(false);
});

test('warm native transcript scroll metrics', async ({ promptRailWindow: page }) => {
  test.skip(!PERF_ENABLED, 'manual same-build CDP A/B harness');
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1_000, height: 700 });
  await expect(page.locator('[data-turn-id="turn-prompt-rail-120"]')).toHaveCount(1);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Performance.enable');
  await prepareFrameRecorder(page);
  await traverseFullHistoryAndReturnToTail(page);
  await moveToTail(page);

  // Warm Chromium, React and the transcript path in both directions before sampling.
  await scrollGesture(page, -600, 120);
  await scrollGesture(page, 600, 120);
  await moveToTail(page);
  await collectGarbage(cdp);
  await page.evaluate(() => new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  ));
  const before = await performanceMetrics(cdp);
  const frames = await scrollGesture(page, -600);
  expect(
    frames.loafSupported,
    'Chromium does not support the long-animation-frame release metric',
  ).toBe(true);
  const after = await performanceMetrics(cdp);
  await collectGarbage(cdp);
  const counters = await browserCounters(cdp);
  const sourceTurns = await page.locator('[data-turn-source-count]').first()
    .getAttribute('data-turn-source-count');
  const mountedTurns = await page.locator('[data-turn-id]').count();
  const domElements = await page.locator('*').count();
  const sessionSwitchMs = await measureSessionSwitch(page);
  const result = {
    sourceTurns: Number(sourceTurns),
    mountedTurns,
    domElements,
    taskMs: metricDelta(before, after, 'TaskDuration') * 1_000,
    scriptMs: metricDelta(before, after, 'ScriptDuration') * 1_000,
    layoutMs: metricDelta(before, after, 'LayoutDuration') * 1_000,
    recalcStyleMs: metricDelta(before, after, 'RecalcStyleDuration') * 1_000,
    heapBytes: counters.heapBytes,
    nodes: counters.nodes,
    documents: counters.documents,
    jsEventListeners: counters.jsEventListeners,
    frameCount: frames.intervals.length,
    frameP95Ms: percentile(frames.intervals, 0.95),
    frameP99Ms: percentile(frames.intervals, 0.99),
    frameMaxMs: Math.max(...frames.intervals),
    framesOver12_5Ms: frames.intervals.filter((duration) => duration > 12.5).length,
    loafOver50Ms: frames.loafDurations.filter((duration) => duration > 50).length,
    loafMaxMs: Math.max(0, ...frames.loafDurations),
    loafSupported: frames.loafSupported,
    sessionSwitchMs,
  };
  console.log(`TRANSCRIPT_PERF ${JSON.stringify(result)}`);
});

test('600+ Turn repeated paging keeps the active range on a memory plateau', async ({
  promptRailWindow: page,
}) => {
  test.skip(!STRESS_ENABLED, 'manual 600+ Turn stress harness');
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1_000, height: 700 });
  const cdp = await page.context().newCDPSession(page);
  expect(PROMPT_RAIL_PROMPT_COUNT).toBeGreaterThanOrEqual(600);
  const sweeps: StressSweep[] = [];
  const heapGrowth: Array<HeapGrowth & { sweep: number }> = [];
  const captureSample = async (sweep: number, iteration: number): Promise<StressSample> => {
    await collectGarbage(cdp);
    const counters = await browserCounters(cdp);
    const sample = {
      sweep,
      iteration,
      firstTurnId: await page.locator('[data-turn-id]').first().getAttribute('data-turn-id'),
      lastTurnId: await page.locator('[data-turn-id]').last().getAttribute('data-turn-id'),
      mountedTurns: await page.locator('[data-turn-id]').count(),
      ...counters,
    };
    return sample;
  };

  // Warm the paging composition once, independent of the fixture's history depth.
  const latestFirstTurn = await page.locator('[data-turn-id]').first().getAttribute('data-turn-id');
  await page.evaluate((selector) => {
    const root = document.querySelector<HTMLElement>(selector);
    if (!root) throw new Error('the chat scroll container is missing');
    root.scrollTop = 0;
    root.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, bubbles: true }));
  }, SCROLLER);
  await expect.poll(async () =>
    page.locator('[data-turn-id]').first().getAttribute('data-turn-id'),
  ).not.toBe(latestFirstTurn);
  await returnToLatest(page);
  await expect(page.locator(`[data-turn-id="turn-prompt-rail-${PROMPT_RAIL_PROMPT_COUNT}"]`))
    .toHaveCount(1);

  for (let sweep = 1; sweep <= 2; sweep += 1) {
    const samples: StressSample[] = [await captureSample(sweep, 0)];
    let successfulPages = 0;
    for (let iteration = 1; iteration <= PROMPT_RAIL_PROMPT_COUNT; iteration += 1) {
      const firstBefore = await page.locator('[data-turn-id]').first().getAttribute('data-turn-id');
      if (firstBefore?.endsWith('-1')) break;
      await page.evaluate((selector) => {
        const root = document.querySelector<HTMLElement>(selector);
        if (!root) throw new Error('the chat scroll container is missing');
        root.scrollTop = 0;
        root.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, bubbles: true }));
      }, SCROLLER);
      await expect.poll(async () =>
        page.locator('[data-turn-id]').first().getAttribute('data-turn-id'),
      ).not.toBe(firstBefore);
      successfulPages += 1;
      if (iteration % 10 !== 0) continue;
      samples.push(await captureSample(sweep, iteration));
    }
    await expect(page.locator('[data-turn-id]').first())
      .toHaveAttribute('data-turn-id', 'turn-prompt-rail-1');
    if (samples.at(-1)!.iteration !== successfulPages) {
      samples.push(await captureSample(sweep, successfulPages));
    }
    sweeps.push({ sweep, successfulPages, samples });
    const growth = { sweep, ...positiveHeapGrowth(samples) };
    heapGrowth.push(growth);
    console.log(`TRANSCRIPT_STRESS_SWEEP ${JSON.stringify({
      sweep,
      successfulPages,
      samples,
      heapGrowth: growth,
    })}`);
    expect(growth.endpointRatio).toBeLessThanOrEqual(SECONDARY_RESOURCE_GROWTH_RATIO);
    expect(growth.projectedRatio).toBeLessThanOrEqual(SECONDARY_RESOURCE_GROWTH_RATIO);
    if (sweep < 2) {
      await returnToLatest(page);
      await expect(page.locator(`[data-turn-id="turn-prompt-rail-${PROMPT_RAIL_PROMPT_COUNT}"]`))
        .toHaveCount(1);
    }
  }

  const firstSweep = sweeps[0]!;
  const secondSweep = sweeps[1]!;
  expect(firstSweep.successfulPages).toBeGreaterThan(0);
  expect(secondSweep.successfulPages).toBeGreaterThan(0);
  const firstNodesByIteration = new Map(
    firstSweep.samples.map((sample) => [sample.iteration, sample.nodes]),
  );
  let nodeMaxSecondToFirstRatio = 0;
  for (const [index, sample] of secondSweep.samples.entries()) {
    const firstNodes = index === secondSweep.samples.length - 1
      ? firstSweep.samples.at(-1)!.nodes
      : firstNodesByIteration.get(sample.iteration);
    expect(firstNodes).toBeDefined();
    const ratio = sample.nodes / firstNodes!;
    nodeMaxSecondToFirstRatio = Math.max(nodeMaxSecondToFirstRatio, ratio);
  }

  const allSamples = sweeps.flatMap((sweep) => sweep.samples);
  const mountedMax = Math.max(...allSamples.map((sample) => sample.mountedTurns));
  console.log(`TRANSCRIPT_STRESS ${JSON.stringify({
    fixtureTurns: PROMPT_RAIL_PROMPT_COUNT,
    sweeps,
    mountedMax,
    nodeMin: Math.min(...allSamples.map((sample) => sample.nodes)),
    nodeMax: Math.max(...allSamples.map((sample) => sample.nodes)),
    nodeMaxSecondToFirstRatio,
    heapGrowth,
  })}`);
  expect(mountedMax).toBeLessThanOrEqual(
    transcriptContract.DESKTOP_TRANSCRIPT_ACTIVE_RANGE_MAX_TURNS,
  );
  expect(nodeMaxSecondToFirstRatio).toBeLessThanOrEqual(
    1 + SECONDARY_RESOURCE_GROWTH_RATIO,
  );
});
