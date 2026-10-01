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

/**
 * Controlled real-Chromium regression + baseline replay. No GitHub requests,
 * credentials or LLM calls. Both versions execute their production tool wrappers
 * and the same installed OpenCLI BasePage over a Playwright evaluation transport.
 * Run after build:main. Set BROWSER_CHANNEL=chromium for installed Playwright
 * Chromium, or leave the default chrome to use system Chrome.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { chromium } from '@playwright/test';
import { transformSync } from 'esbuild';
import * as current from '../../dist/main/browser/browser-tools.js';
import { browserObservationJs } from '../../dist/main/browser/browser-observation.js';
import { provideBrowserViewHost } from '../../dist/main/browser/browser-host.js';
import { resetBrowserSessionsForTest, setBridgeFactoryForTest } from '../../dist/main/browser/session.js';
import { withBrowserOriginAdmission } from '../../dist/main/browser/browser-origin-admission.js';
import { BrowserOriginLeaseTracker } from '../../dist/main/browser/browser-origin-lease.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const baselineRef = process.env.BROWSER_BASELINE_REF || '4c79e3910e106c3af589ffb429143dd4de47d7d3';
const trials = Number(process.env.BROWSER_MEASURE_TRIALS || 10);
if (!Number.isInteger(trials) || trials < 1 || trials > 100) throw new Error('BROWSER_MEASURE_TRIALS must be an integer from 1 to 100.');
const opencliVersion = JSON.parse(await readFile(new URL('../../package.json', import.meta.resolve('@jackwener/opencli')), 'utf8')).version;
const legacySource = execFileSync('git', ['show', `${baselineRef}:apps/desktop/src/main/browser/browser-tools.ts`], { cwd: root, encoding: 'utf8' });
const baselinePath = resolve(root, `apps/desktop/dist/main/browser/.observation-baseline-${process.pid}.mjs`);
await writeFile(baselinePath, transformSync(legacySource, { loader: 'ts', format: 'esm', target: 'es2022' }).code);
const legacy = await import(pathToFileURL(baselinePath).href);
const basePath = new URL('./browser/base-page.js', import.meta.resolve('@jackwener/opencli'));
const { BasePage } = await import(basePath.href);
const browser = await chromium.launch({ headless: true, ...(process.env.BROWSER_CHANNEL === 'chromium' ? {} : { channel: process.env.BROWSER_CHANNEL || 'chrome' }) });
const page = await browser.newPage({ viewport: { width: 960, height: 720 } });
const repositories = label => Array.from({ length: 1000 }, (_, i) => `<a href="/repo/${label}/${i}">${label} repository ${i}</a>`).join('');
const html = (await readFile(new URL('./fixture.html', import.meta.url), 'utf8'))
  .replace('__HIDDEN_REPOSITORIES__', repositories('css-hidden'))
  .replace('__CLOSED_REPOSITORIES__', repositories('closed-menu'))
  .replace('__OTHER_SUBMITS__', Array.from({ length: 4 }, (_, i) => `<button type="submit">Other submit ${i}</button>`).join(''));
await page.route('https://fixture.test/**', route => route.fulfill({ contentType: 'text/html', body: html }));
class FixturePage extends BasePage {
  async evaluate(js) { return page.evaluate(js); }
  async goto(url) { await page.goto(url); }
  async getCurrentUrl() { return page.url(); }
}
const adapter = new FixturePage();
const context = { sessionId: 'browser-measure', turnId: 'measure', toolUseId: 'tool', cwd: root, abortSignal: new AbortController().signal, sandboxPolicy: {} };
function install() {
  resetBrowserSessionsForTest();
  const leases = new BrowserOriginLeaseTracker(() => page.url());
  provideBrowserViewHost({
    canDrive: () => true, beginAction: () => undefined, currentUrl: () => page.url(),
    openOriginLease: (_id, approved, kind) => leases.open(approved, kind),
    resolveEndpoint: async () => ({ cdpEndpoint: 'ws://fixture' }),
    releaseSession: async () => {}, disposeSession: async () => {},
  });
  setBridgeFactoryForTest(() => ({ connect: async () => adapter, close: async () => {}, send: async () => {}, waitForEvent: async () => {} }));
}
function invoke(tool, args) {
  return withBrowserOriginAdmission({ sessionId: context.sessionId, url: 'https://fixture.test/pr' }, () => tool.impl(args, context));
}
const median = values => { const sorted = [...values].sort((a, b) => a - b); const mid = Math.floor(sorted.length / 2); return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2; };
let regressionChecks = 0;
function check(condition, message) { assert.ok(condition, message); regressionChecks++; }
async function regressions() {
  install();
  await invoke(current.buildBrowserNavigateTool(), { url: 'https://fixture.test/pr' });
  const snapshot = JSON.parse(await invoke(current.buildBrowserSnapshotTool(), { selector: '#new_pull_request' }));
  check(snapshot.candidates.every(candidate => candidate.visible), 'only visible candidates appear');
  check(!JSON.stringify(snapshot).includes('css-hidden') && !JSON.stringify(snapshot).includes('closed-menu'), 'hidden menus are excluded');
  check(snapshot.candidates.some(candidate => candidate.attributes.id === 'contents-control'), 'display:contents descendants are retained');
  check(!snapshot.candidates.some(candidate => candidate.attributes.id === 'transparent-control'), 'transparent ancestor is excluded');
  check(!JSON.stringify(snapshot).includes('PRIVATE_') && !JSON.stringify(snapshot).includes('private-csrf-identifier'), 'input values and hidden identifiers are absent');
  const observed = JSON.parse(await invoke(current.buildBrowserInspectTool(), { selector: 'button[type="submit"]', scope: '#new_pull_request' }));
  check(observed.matchCount === 5 && observed.visibleMatchCount === 1 && observed.candidates.length === 1, 'all matches counted, visible targets identified');
  const blocked = await invoke(current.buildBrowserClickTool(), { ref: 'form#new_pull_request button[type="submit"]' });
  check(blocked.includes('No action taken') && blocked.includes('"matchCount":5'), 'ambiguous click returns actionable diagnostics');
  check(await page.evaluate('window.submissions') === 0, 'ambiguous click never submits');
  await assert.rejects(invoke(current.buildBrowserExtractTool(), { selector: 'button[type="submit"]' }), /5 elements/); regressionChecks++;
  const same = JSON.parse(await invoke(current.buildBrowserInspectTool(), { selector: 'button[type="submit"]', scope: '#new_pull_request' }));
  check(same.candidates[0].ref === observed.candidates[0].ref, 'inspection preserves existing refs within a document');
  const limited = await page.evaluate(browserObservationJs({ maxElements: 1 }));
  check(limited.candidates.length === 1 && limited.truncated, 'candidate limits report truncation');
  const invalid = await page.evaluate(browserObservationJs({ selector: '#x";window.injected=true;//' }));
  check(Boolean(invalid.error) && !(await page.evaluate('window.injected')), 'selector is a JSON literal, never executable code');
  const hidden = await page.evaluate(browserObservationJs({ selector: 'input[type="hidden"]', visibleOnly: false }));
  check(hidden.matchCount === 1 && hidden.candidates.length === 0, 'invisible inspection never exposes hidden controls');
  const staleRef = observed.candidates[0].ref;
  await invoke(current.buildBrowserNavigateTool(), { url: 'https://fixture.test/pr' });
  const stale = await invoke(current.buildBrowserClickTool(), { ref: staleRef });
  check(stale.includes('No action taken') && stale.includes('stale'), 'refs cannot silently survive navigation');
  check(await page.evaluate('window.submissions') === 0, 'stale refs never submit');
  const controls = await page.evaluate(browserObservationJs({ selector: '#disabled-control' }));
  check(controls.candidates[0].enabled === false, 'disabled state is reported');
  const disabled = await invoke(current.buildBrowserClickTool(), { ref: controls.candidates[0].ref });
  check(disabled.includes('No action taken'), 'disabled target is not acted upon');
  await page.evaluate(() => {
    const parent = document.createElement('div'); parent.style.visibility = 'hidden';
    parent.innerHTML = '<button id="visibility-override" style="visibility:visible">Override</button>';
    document.body.append(parent);
  });
  const override = await page.evaluate(browserObservationJs({ selector: '#visibility-override' }));
  check(override.candidates[0]?.visible, 'a child can override inherited visibility:hidden');
  const freshPrimary = await page.evaluate(browserObservationJs({ selector: '.btn-primary' }));
  await page.evaluate(() => { const target = document.querySelector('.btn-primary'); target.replaceWith(target.cloneNode(true)); });
  const replaced = await invoke(current.buildBrowserClickTool(), { ref: freshPrimary.candidates[0].ref });
  check(replaced.includes('No action taken') && replaced.includes('stale'), 'copied refs cannot silently target a replacement node');
  check(await page.evaluate('window.submissions') === 0, 'replacement refs never submit');
  const old = await invoke(legacy.buildBrowserSnapshotTool(), {});
  check(old.includes('css-hidden repository') && old.includes('closed-menu repository'), 'baseline genuinely reproduces hidden-menu noise');
  const capped = await page.evaluate(browserObservationJs({ selector: 'a', visibleOnly: false, maxElements: 100 }));
  check(JSON.stringify(capped).length <= 16000 && capped.truncated, 'structured result obeys output budget');
  await page.evaluate(() => {
    const parent = document.createElement('div'); parent.hidden = true;
    parent.innerHTML = '<button class="scan-limit">Hidden</button>'.repeat(5001);
    document.body.append(parent);
  });
  const scan = await page.evaluate(browserObservationJs({ selector: '.scan-limit' }));
  check(scan.matchCount === 5001 && scan.scannedCount === 5000 && scan.scanTruncated && scan.visibleMatchCount === null, 'bounded scans do not present partial visible counts as exact');
  const ambiguousScope = await page.evaluate(browserObservationJs({ scope: 'details' }));
  check(Boolean(ambiguousScope.error) && ambiguousScope.candidates.length === 0, 'ambiguous scopes never choose the first region');
}
async function workflow(version) {
  install();
  const records = [];
  async function call(tool, args) {
    const start = performance.now();
    try {
      const output = await invoke(tool, args);
      records.push({ name: tool.name, ms: performance.now() - start, bytes: Buffer.byteLength(output), failure: output.startsWith('No action taken') });
      return output;
    } catch (error) {
      records.push({ name: tool.name, ms: performance.now() - start, bytes: Buffer.byteLength(error.message), failure: true });
      return '';
    }
  }
  const api = version === 'before' ? legacy : current;
  await call(api.buildBrowserNavigateTool(), { url: 'https://fixture.test/pr' });
  let firstObservation;
  if (version === 'before') {
    firstObservation = await call(api.buildBrowserSnapshotTool(), {});
    // Replay the same classes of failed locators seen in the real PR trace.
    await call(api.buildBrowserTypeTool(), { ref: '#pull_request_title', text: 'fixture' });
    await call(api.buildBrowserTypeTool(), { ref: 'input[name="pull_request[title]"]', text: 'fixture' });
    await call(api.buildBrowserTypeTool(), { ref: 'textarea[name="pull_request[body]"]', text: 'description' });
    await call(api.buildBrowserClickTool(), { ref: '.preview-tab' });
    await call(api.buildBrowserExtractTool(), { selector: '.preview-content' });
    await call(api.buildBrowserExtractTool(), { selector: '#preview' });
    await call(api.buildBrowserClickTool(), { ref: '[aria-label="Change pull request type"]' });
    await call(api.buildBrowserExtractTool(), { selector: '.js-create-pull-request' });
    await call(api.buildBrowserClickTool(), { ref: '#pr-type > summary' });
    await call(api.buildBrowserClickTool(), { ref: '[role="menuitemradio"]:first-child' });
    await call(api.buildBrowserClickTool(), { ref: '#draft_off' });
    await call(api.buildBrowserExtractTool(), { selector: 'button[type="submit"]' });
    await call(api.buildBrowserClickTool(), { ref: 'button[type="submit"]' });
    await call(api.buildBrowserClickTool(), { ref: 'button[type="submit"].btn-primary' });
  } else {
    firstObservation = await call(api.buildBrowserSnapshotTool(), {});
    const candidates = JSON.parse(firstObservation).candidates;
    const byName = name => candidates.find(candidate => candidate.name === name).ref;
    await call(api.buildBrowserTypeTool(), { ref: byName('Add a title'), text: 'fixture' });
    await call(api.buildBrowserTypeTool(), { ref: byName('Add a description'), text: 'description' });
    await call(api.buildBrowserClickTool(), { ref: candidates.find(candidate => candidate.name === 'Preview').ref });
    await call(api.buildBrowserExtractTool(), { selector: '#preview' });
    await call(api.buildBrowserClickTool(), { ref: candidates.find(candidate => candidate.name === 'Select a type of pull request').ref });
    const menu = JSON.parse(await call(api.buildBrowserInspectTool(), { selector: 'input[type="radio"]' }));
    await call(api.buildBrowserClickTool(), { ref: menu.candidates.find(candidate => candidate.name.includes('ready for review')).ref });
    await call(api.buildBrowserClickTool(), { ref: candidates.find(candidate => candidate.attributes.type === 'submit').ref });
  }
  await call(api.buildBrowserExtractTool(), { selector: '#result' });
  assert.equal(await page.evaluate('window.submissions'), 1, `${version} must submit exactly once`);
  assert.equal(await page.locator('#draft_off').isChecked(), true, `${version} must choose ready-for-review`);
  assert.equal(await page.locator('#title').inputValue(), 'fixture');
  assert.equal(await page.locator('#body').inputValue(), 'description');
  return { calls: records.length, failures: records.filter(record => record.failure).length, bytes: records.reduce((sum, record) => sum + record.bytes, 0), snapshotBytes: Buffer.byteLength(firstObservation), toolMs: records.reduce((sum, record) => sum + record.ms, 0) };
}
try {
  await regressions();
  await workflow('before'); await workflow('after'); // Warm up both paths.
  const before = [], after = [];
  for (let i = 0; i < trials; i++) {
    // Alternate order to limit warm-cache / scheduling bias.
    if (i % 2 === 0) { before.push(await workflow('before')); after.push(await workflow('after')); }
    else { after.push(await workflow('after')); before.push(await workflow('before')); }
  }
  const summarize = runs => Object.fromEntries(Object.keys(runs[0]).map(key => [key, median(runs.map(run => run[key]))]));
  const report = { baselineRef, opencli: opencliVersion, node: process.version, platform: process.platform, browser: browser.version(), viewport: '960x720', trials, regressionChecks, methodology: 'Production before/after wrappers + unchanged OpenCLI BasePage; local HTTPS fixture; deterministic replay of historical failed-selector classes, not an LLM benchmark.', before: summarize(before), after: summarize(after) };
  console.log(JSON.stringify(report, null, 2));
  if (process.env.BROWSER_MEASURE_OUTPUT) await writeFile(process.env.BROWSER_MEASURE_OUTPUT, JSON.stringify(report, null, 2) + '\n');
} finally {
  resetBrowserSessionsForTest(); setBridgeFactoryForTest(null); provideBrowserViewHost(null);
  await browser.close(); await unlink(baselinePath);
}
