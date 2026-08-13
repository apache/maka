// Unit test for the maka-cu CuDispatchBackend. Drives the module against a MOCK
// executor (a small CommonJS node script written to a temp dir) that speaks
// `maka.cu/2` — the real `maka-cu` binary is never spawned, and does not exist
// as a signed artifact yet. The mock records every message it receives to an
// NDJSON log the test inspects, the same way the cua-driver backend test does.
//
// Run (from repo root), after @maka/core + @maka/runtime are built:
//   npm --workspace @maka/computer-use run test
import assert from 'node:assert/strict';
import { chmodSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';

import type { CuaBoundAction } from '@maka/runtime/cua-frame-state';

import type { CuObservation, CuRunContext } from '@maka/runtime/computer-use-types';
import {
  createMakaCuBackend,
  type MakaCuBackendOptions,
  type MakaCuObservation,
} from '../maka-cu-backend.js';
import { parseMakaCuKeyChord } from '../maka-cu-protocol.js';
import { selectComputerUseBackend, DEFAULT_CU_BACKEND_ID } from '../select-backend.js';

const RUN_CONTEXT: CuRunContext = {
  sessionId: 'test-session',
  turnId: 'test-turn',
  toolCallId: 'call-1',
};

// A CommonJS mock maka-cu executor. No backticks / ${} inside → embedded via
// String.raw so escapes survive into the written file.
const MOCK_SRC = String.raw`#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
// The real executable also serves 'doctor', 'list-apps' and 'snapshot' for a
// human, and a bare invocation prints help and exits. The host must ask for
// 'host' by name. Refusing anything else here is what makes a wrong argv a red
// suite rather than a live-machine mystery — it was one, once: the child died
// before the handshake and the host reported an exhausted restart budget.
if (process.argv[2] !== 'host') {
  process.stderr.write('mock maka-cu: expected argv[2] === "host", got ' + JSON.stringify(process.argv[2]) + '\n');
  process.exit(64);
}
const LOG = process.env.MAKACU_MOCK_LOG || '';
const PROTOCOL = process.env.MAKACU_MOCK_PROTOCOL || 'maka.cu/2';
const DISPATCH_ERROR = process.env.MAKACU_MOCK_DISPATCH_ERROR || '';
const TIER = process.env.MAKACU_MOCK_TIER || 'ax';
const PATH_NAME = process.env.MAKACU_MOCK_PATH || 'ax_action';
const BAD_IMAGE_SHA = process.env.MAKACU_MOCK_BAD_IMAGE_SHA === '1';
// A frame past the model-context cap: readable window, unreturnable picture.
const BIG_IMAGE = process.env.MAKACU_MOCK_BIG_IMAGE === '1';
const BARE_IMAGE_SHA = process.env.MAKACU_MOCK_BARE_IMAGE_SHA === '1';
const UNVERIFIED_EFFECT = process.env.MAKACU_MOCK_UNVERIFIED_EFFECT === '1';
const NO_POST_SNAPSHOT = process.env.MAKACU_MOCK_NO_POST_SNAPSHOT === '1';
// The action closed the thing it acted on, so the post-action observation could
// not be taken and never will be.
const POST_WINDOW_GONE = process.env.MAKACU_MOCK_POST_WINDOW_GONE === '1';
// A refusal that carries only 'error', the way the maka.cu/1 executor emitted it.
const BARE_REFUSAL = process.env.MAKACU_MOCK_BARE_REFUSAL === '1';
const REFUSAL_PATH = process.env.MAKACU_MOCK_REFUSAL_PATH || 'none';
// §7.1 — the executor names a route it was not allowed to take. Its absence is
// what separates a policy refusal from an application saying no.
const NO_WOULD_REQUIRE = process.env.MAKACU_MOCK_NO_WOULD_REQUIRE === '1';
const REFUSAL_OUTCOME = process.env.MAKACU_MOCK_REFUSAL_OUTCOME || 'refused';
const OK_OUTCOME = process.env.MAKACU_MOCK_OK_OUTCOME || 'ok';
const SESSION_ERROR = process.env.MAKACU_MOCK_SESSION_ERROR || '';
const WINDOW_LIST_ERROR = process.env.MAKACU_MOCK_WINDOW_LIST_ERROR || '';
const MALFORMED = process.env.MAKACU_MOCK_MALFORMED || '';
const LAUNCH_ERROR = process.env.MAKACU_MOCK_LAUNCH_ERROR || '';
const HANG_OBSERVE = process.env.MAKACU_MOCK_HANG_OBSERVE === '1';
const TRUNCATED = process.env.MAKACU_MOCK_TRUNCATED === '1';
let DIFFERENCE_PRESENTATION = '';
const LAUNCH_TOOK_FOREGROUND = process.env.MAKACU_MOCK_LAUNCH_FOREGROUND === '1';
const WINDOW_ORIGIN_Y = Number(process.env.MAKACU_MOCK_WINDOW_ORIGIN_Y || '25');
const NONCE = crypto.randomBytes(16).toString('hex');
// 1x1 transparent PNG.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);
let imageDir = '';
let snapshotSeq = 0;
function logRec(rec) {
  if (LOG) { try { fs.appendFileSync(LOG, JSON.stringify(rec) + '\n'); } catch (e) {} }
}
logRec({ kind: 'start', pid: process.pid, argv: process.argv.slice(2) });
function send(obj) { process.stdout.write(JSON.stringify(obj) + '\n'); }
function ok(id, fields) { send({ jsonrpc: '2.0', id: id, result: Object.assign({ ok: true }, fields) }); }
function digest(seed) { return 'sha256:' + crypto.createHash('sha256').update(seed).digest('hex'); }
function domainError(id, code, detail, extra) {
  send({ jsonrpc: '2.0', id: id, result: Object.assign({ ok: false }, extra || {}, { error: {
    code: code, message: 'mock refused: ' + code, detail: detail || {} } }) });
}
function writeImage(name) {
  const file = path.join(imageDir, name + '.png');
  const bytes = BIG_IMAGE ? Buffer.alloc(9 * 1024 * 1024, 7) : PNG;
  fs.writeFileSync(file, bytes);
  const hex = crypto.createHash('sha256').update(bytes).digest('hex');
  const sha = BARE_IMAGE_SHA ? hex : 'sha256:' + hex;
  return {
    path: file,
    format: 'png',
    widthPx: 1200,
    heightPx: 800,
    byteLength: bytes.byteLength,
    sha256: BAD_IMAGE_SHA ? digest('a different frame') : sha,
    scale: 2,
  };
}
function element(index, label, focused) {
  return {
    token: 'el_' + index,
    ...(DIFFERENCE_PRESENTATION ? { stableId: index === 1 ? 10 : 12 } : {}),
    parentToken: index === 1 ? null : (MALFORMED === 'numeric_parent' ? 7 : 'el_1'),
    depth: index === 1 ? 0 : 1,
    role: index === 1 ? 'AXWindow' : 'AXButton',
    subrole: index === 2 ? 'AXSecureTextField' : null,
    axIdentifier: 'id_' + index,
    label: label,
    value: null,
    placeholder: index === 2 ? 'Search your files' : null,
    enabled: true,
    focused: !!focused,
    selected: null,
    ...(MALFORMED === 'no_frame' && index === 2 ? {} : { frame: { x: 10 * index, y: 20 * index, width: 72, height: 28 } }),
    actions: index === 2 ? ['press', 'show_menu', 'raise'] : ['press'],
    digest: digest('el_' + index),
    truncated: [],
  };
}
let previousSnapshotId = '';
function snapshot(includeImage) {
  snapshotSeq += 1;
  const id = 'snap_' + NONCE + '_' + snapshotSeq;
  const shot = {
    snapshotId: id,
    capturedAt: Date.now(),
    target: {
      pid: 4711,
      windowId: 90210,
      appId: 'com.example.Fixture',
      appName: 'Fixture',
      title: 'Untitled',
      bounds: { x: 0, y: WINDOW_ORIGIN_Y, width: 600, height: 400 },
      layer: 0,
      zIndex: 3,
      displayId: '69732928',
    },
    windowDigest: digest('window_' + snapshotSeq),
    focusedElementToken: 'el_2',
    selectedText: null,
    image: includeImage ? writeImage(id) : null,
    displays: [{
      displayId: '69732928',
      logicalBounds: { x: 0, y: 0, width: 1512, height: 982 },
      sourceBoundsPx: { x: 0, y: 0, width: 3024, height: 1964 },
      scaleFactor: 2,
    }],
    obscuringRects: [],
    elements: [element(1, 'Fixture Window', false), element(2, 'Send', true)],
    truncated: { elements: TRUNCATED, depth: false },
  };
  if (DIFFERENCE_PRESENTATION && previousSnapshotId) {
    shot.difference = {
      baseSnapshotId: previousSnapshotId,
      presentation: DIFFERENCE_PRESENTATION,
      changes: DIFFERENCE_PRESENTATION === 'difference'
        ? [
            { kind: 'remove', path: [0, 0], stableId: 7, token: null },
            { kind: 'update', path: [0, 1], stableId: 12, token: 'el_2' },
          ]
        : [],
      removedStableIdRanges: DIFFERENCE_PRESENTATION === 'difference'
        ? [{ start: 7, end: 8 }]
        : [],
    };
  }
  previousSnapshotId = id;
  if (MALFORMED === 'no_displays') delete shot.displays;
  if (MALFORMED === 'no_obscuring') shot.obscuringRects = null;
  return shot;
}
function dispatchReply(id, params) {
  if (DISPATCH_ERROR) {
    if (BARE_REFUSAL) { domainError(id, DISPATCH_ERROR, {}); return; }
    domainError(id, DISPATCH_ERROR, NO_WOULD_REQUIRE ? {} : { wouldRequirePath: 'cg_event_global' }, {
      toolCallId: params.toolCallId,
      outcome: REFUSAL_OUTCOME,
      tier: TIER,
      path: REFUSAL_PATH,
      effect: 'unverifiable',
      verification: { method: 'none', observedChange: false },
    });
    return;
  }
  ok(id, {
    toolCallId: params.toolCallId,
    outcome: OK_OUTCOME,
    tier: TIER,
    path: PATH_NAME,
    effect: UNVERIFIED_EFFECT || OK_OUTCOME !== 'ok' ? 'unverifiable' : 'confirmed',
    verification: { method: 'tree_delta', observedChange: true },
    settle: { waitedMs: 12, quiesced: true, reason: 'quiesced' },
    snapshot: NO_POST_SNAPSHOT || POST_WINDOW_GONE ? null : snapshot(true),
    ...(POST_WINDOW_GONE
      ? { postObservationError: { code: 'window_gone', message: 'the target window no longer exists' } }
      : {}),
  });
}
function handle(msg) {
  const id = msg.id;
  const params = msg.params || {};
  switch (msg.method) {
    case 'host.hello':
      if (params.protocol !== PROTOCOL) {
        send({ jsonrpc: '2.0', id: id, error: { code: -32000,
          message: 'protocol_version_mismatch', data: { supported: [PROTOCOL] } } });
        setTimeout(function () { process.exit(78); }, 5);
        return;
      }
      imageDir = params.imageDir;
      const differenceMatch = /-difference-(no-change|difference|full)$/.exec(imageDir);
      DIFFERENCE_PRESENTATION = differenceMatch ? differenceMatch[1] : '';
      ok(id, {
        protocol: PROTOCOL,
        executor: { name: 'maka-cu-mock', version: '0.0.1', commit: 'testing' },
        pid: process.pid,
        capabilities: {
          captureStream: false,
          elementActions: ['click', 'set_value', 'select_text', 'secondary_action', 'scroll'],
          pointActions: ['move', 'left_click', 'right_click', 'middle_click', 'double_click',
            'triple_click', 'mouse_down', 'mouse_up', 'drag', 'scroll'],
          keyActions: ['type', 'key'],
          imageFormats: ['png', 'jpeg'],
        },
        limits: {
          snapshotsPerSession: 8,
          snapshotTtlMs: 120000,
          maxElements: 1500,
          maxDepth: 64,
          maxTextChars: 500,
          maxResponseBytes: 1048576,
          settleCeilingMs: 2500,
          shutdownGraceMs: 3000,
          imageDirBudgetBytes: 268435456,
        },
      });
      return;
    case 'session.begin':
      if (SESSION_ERROR) { domainError(id, SESSION_ERROR, {}); return; }
      ok(id, {});
      return;
    case 'session.end':
      ok(id, { released: { snapshots: 1, images: 1, streams: 0 } });
      return;
    case 'permissions.check':
      ok(id, { accessibility: true, screenRecording: true, screenRecordingProbe: 'capture_succeeded' });
      return;
    case 'apps.list':
      ok(id, { apps: [Object.assign({ appId: 'com.example.Fixture', pid: 4711, name: 'Fixture',
        windowCount: 1, running: true },
        MALFORMED === 'app_no_window_count' ? { windowCount: undefined } : {})] });
      return;
    case 'window.list':
      if (WINDOW_LIST_ERROR) { domainError(id, WINDOW_LIST_ERROR, {}); return; }
      ok(id, { windows: [Object.assign({ pid: 4711, windowId: 90210,
        appId: 'com.example.Fixture', appName: 'Fixture', title: 'Untitled',
        bounds: { x: 0, y: WINDOW_ORIGIN_Y, width: 600, height: 400 }, layer: 0, zIndex: 3,
        onScreen: true, displayId: '69732928' },
        MALFORMED === 'window_no_zindex' ? { zIndex: undefined } : {})] });
      return;
    case 'apps.launch':
      if (LAUNCH_ERROR) { domainError(id, LAUNCH_ERROR, {}); return; }
      ok(id, Object.assign({ pid: 5150, appId: 'com.example.Launched', name: 'Launched',
        foregroundTaken: LAUNCH_TOOK_FOREGROUND, windows: [{ windowId: 77001, title: 'Untitled' }],
        waited: { ms: 3200, reason: 'window_appeared' } },
        MALFORMED === 'launch_no_foreground' ? { foregroundTaken: undefined } : {}));
      return;
    case 'observe':
      // Alive, and simply slower than the host's deadline — the shape a real
      // executor takes while walking a file dialog's accessibility tree.
      if (HANG_OBSERVE) return;
      ok(id, { snapshot: snapshot(params.includeImage !== false) });
      return;
    case 'screen.capture':
      ok(id, { image: writeImage('cap_' + Date.now()), displayId: '69732928', capturedAt: Date.now() });
      return;
    case 'dispatch.element':
    case 'dispatch.key':
    case 'dispatch.point':
      dispatchReply(id, params);
      return;
    default:
      send({ jsonrpc: '2.0', id: id, error: { code: -32601, message: 'unknown_method' } });
  }
}
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', function (chunk) {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    logRec({ kind: 'recv', method: msg.method, id: msg.id, params: msg.params });
    if (typeof msg.id !== 'number') continue;
    handle(msg);
  }
});
`;

let workDir = '';
let mockPath = '';
const disposers: Array<() => void> = [];

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readRecords(logPath: string): Promise<Array<Record<string, any>>> {
  let raw = '';
  try {
    raw = await readFile(logPath, 'utf8');
  } catch {
    return [];
  }
  return raw
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, any>);
}

function received(records: Array<Record<string, any>>, method: string): Record<string, any>[] {
  return records.filter((r) => r.kind === 'recv' && r.method === method).map((r) => r.params ?? {});
}

// Same rationale as maka-cu-service.test.ts: the mock appends to its log from
// another process, so a single read races its scheduler. Poll with a bounded
// deadline — a real regression (the record never written) still fails, just
// without depending on which process the scheduler ran first.
async function waitForRecord(
  logPath: string,
  predicate: (record: Record<string, any>) => boolean,
  what: string,
  deadlineMs = 2000,
): Promise<void> {
  const startedAt = Date.now();
  for (;;) {
    const records = await readRecords(logPath);
    if (records.some(predicate)) return;
    if (Date.now() - startedAt >= deadlineMs) {
      assert.fail(`${what} (log after ${deadlineMs}ms: ${JSON.stringify(records)})`);
    }
    await delay(10);
  }
}

function makeBackend(
  opts: {
    protocol?: string;
    dispatchError?: string;
    tier?: string;
    path?: string;
    badImageSha?: boolean;
    bigImage?: boolean;
    bareImageSha?: boolean;
    noPostSnapshot?: boolean;
    unverifiedEffect?: boolean;
    postWindowGone?: boolean;
    bareRefusal?: boolean;
    refusalPath?: string;
    /** Omit `wouldRequirePath`, which is how an application's own refusal looks. */
    noWouldRequirePath?: boolean;
    refusalOutcome?: string;
    okOutcome?: string;
    sessionError?: string;
    windowListError?: string;
    malformed?: string;
    launchError?: string;
    hangObserve?: boolean;
    truncated?: boolean;
    differencePresentation?: 'no-change' | 'difference' | 'full';
    timeoutMs?: number;
    launchTookForeground?: boolean;
    windowOriginY?: number;
    physicalInputRecentlyActive?: MakaCuBackendOptions['physicalInputRecentlyActive'];
    allowCompatibilityInputDispatch?: boolean;
    onTrace?: MakaCuBackendOptions['onTrace'];
  } = {},
): { backend: ReturnType<typeof createMakaCuBackend>; logPath: string; imageDir: string } {
  const logPath = join(workDir, 'log-' + randomUUID() + '.ndjson');
  const imageDir = join(
    workDir,
    'images-' +
      randomUUID() +
      (opts.differencePresentation ? `-difference-${opts.differencePresentation}` : ''),
  );
  process.env.MAKACU_MOCK_LOG = logPath;
  process.env.MAKACU_MOCK_PROTOCOL = opts.protocol ?? 'maka.cu/2';
  process.env.MAKACU_MOCK_DISPATCH_ERROR = opts.dispatchError ?? '';
  process.env.MAKACU_MOCK_TIER = opts.tier ?? 'ax';
  process.env.MAKACU_MOCK_PATH = opts.path ?? 'ax_action';
  process.env.MAKACU_MOCK_BAD_IMAGE_SHA = opts.badImageSha ? '1' : '';
  process.env.MAKACU_MOCK_BIG_IMAGE = opts.bigImage ? '1' : '';
  process.env.MAKACU_MOCK_BARE_IMAGE_SHA = opts.bareImageSha ? '1' : '';
  process.env.MAKACU_MOCK_NO_POST_SNAPSHOT = opts.noPostSnapshot ? '1' : '';
  process.env.MAKACU_MOCK_UNVERIFIED_EFFECT = opts.unverifiedEffect ? '1' : '';
  process.env.MAKACU_MOCK_POST_WINDOW_GONE = opts.postWindowGone ? '1' : '';
  process.env.MAKACU_MOCK_BARE_REFUSAL = opts.bareRefusal ? '1' : '';
  process.env.MAKACU_MOCK_REFUSAL_PATH = opts.refusalPath ?? 'none';
  process.env.MAKACU_MOCK_NO_WOULD_REQUIRE = opts.noWouldRequirePath ? '1' : '';
  process.env.MAKACU_MOCK_REFUSAL_OUTCOME = opts.refusalOutcome ?? 'refused';
  process.env.MAKACU_MOCK_OK_OUTCOME = opts.okOutcome ?? 'ok';
  process.env.MAKACU_MOCK_SESSION_ERROR = opts.sessionError ?? '';
  process.env.MAKACU_MOCK_WINDOW_LIST_ERROR = opts.windowListError ?? '';
  process.env.MAKACU_MOCK_MALFORMED = opts.malformed ?? '';
  process.env.MAKACU_MOCK_LAUNCH_ERROR = opts.launchError ?? '';
  process.env.MAKACU_MOCK_HANG_OBSERVE = opts.hangObserve ? '1' : '';
  process.env.MAKACU_MOCK_TRUNCATED = opts.truncated ? '1' : '';
  process.env.MAKACU_MOCK_LAUNCH_FOREGROUND = opts.launchTookForeground ? '1' : '';
  process.env.MAKACU_MOCK_WINDOW_ORIGIN_Y = String(opts.windowOriginY ?? 25);
  const backend = createMakaCuBackend({
    binaryPath: mockPath,
    imageDir,
    timeoutMs: opts.timeoutMs ?? 5000,
    handshakeTimeoutMs: 5000,
    maxRestartAttempts: 2,
    restartBackoffMs: 5,
    ...(opts.physicalInputRecentlyActive
      ? { physicalInputRecentlyActive: opts.physicalInputRecentlyActive }
      : {}),
    ...(opts.allowCompatibilityInputDispatch === undefined
      ? {}
      : { allowCompatibilityInputDispatch: opts.allowCompatibilityInputDispatch }),
    ...(opts.onTrace ? { onTrace: opts.onTrace } : {}),
  });
  disposers.push(() => backend.dispose());
  return { backend, logPath, imageDir };
}

function signal(): AbortSignal {
  return new AbortController().signal;
}

const FIXTURE_APP_ID = 'com.example.Fixture';

async function observeFixture(
  backend: ReturnType<typeof createMakaCuBackend>,
): Promise<MakaCuObservation> {
  return backend.observeApp!(
    { app: FIXTURE_APP_ID, includeScreenshot: true },
    signal(),
    RUN_CONTEXT,
  );
}

function boundCoordinate(observation: CuObservation): CuaBoundAction {
  return {
    frameId: observation.observationId,
    epoch: 0,
    actionFingerprint: 'left_click',
    fingerprint: 'bound-coordinate',
    target: {
      pid: observation.pid,
      windowId: observation.windowId,
      appName: observation.appId,
      bounds: observation.windowBounds!,
      sourceBoundsPx: observation.sourceBoundsPx!,
    },
    sourceCoordinate: { x: 400, y: 200 },
    windowCoordinate: { x: 400, y: 200 },
    coordinateSpace: 'window-screenshot-local',
  };
}

before(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'maka-cu-test-'));
  mockPath = join(workDir, 'maka-cu-mock.cjs');
  await writeFile(mockPath, MOCK_SRC, 'utf8');
  chmodSync(mockPath, 0o755);
});

after(async () => {
  for (const dispose of disposers) {
    try {
      dispose();
    } catch {
      /* already gone */
    }
  }
  if (workDir) await rm(workDir, { recursive: true, force: true });
});

describe('maka-cu backend', () => {
  it('opens with host.hello and refuses to move the system cursor', async () => {
    const { backend, logPath } = makeBackend();
    const permissions = await backend.preflight(signal());
    assert.deepEqual(permissions, { accessibility: true, screenRecording: true });

    const records = await readRecords(logPath);
    const hello = received(records, 'host.hello')[0];
    assert.equal(hello?.protocol, 'maka.cu/2');
    assert.equal(hello?.hostPid, process.pid);
    assert.equal(hello?.allowGlobalPointer, false);
    assert.equal(typeof hello?.imageDir, 'string');
    // §2: the first message on the connection, before anything else.
    assert.equal(records.filter((r) => r.kind === 'recv')[0]?.method, 'host.hello');
    assert.deepEqual(received(records, 'permissions.check')[0], { prompt: false });
  });

  it('keeps routine preflight quiet and exposes an explicit Accessibility prompt request', async () => {
    const { backend, logPath } = makeBackend();

    await backend.preflight(signal());
    await backend.requestAccessibilityPermission(signal());

    const checks = received(await readRecords(logPath), 'permissions.check');
    assert.deepEqual(checks, [{ prompt: false }, { prompt: true }]);
  });

  it('fails loudly on a protocol version mismatch and does not retry', async () => {
    const { backend, logPath } = makeBackend({ protocol: 'maka.cu/99' });
    await assert.rejects(backend.preflight(signal()), /service_mismatch/);
    // §2: a mismatch is fatal. One spawn, no restart budget spent on an
    // executor that already declared it cannot talk this protocol. The read
    // below is causally ordered, not timed: a wrongly-retried spawn writes its
    // `start` before replying to the handshake the awaited preflight consumed
    // (and would surface as restart_exhausted, failing the rejects matcher).
    const records = await readRecords(logPath);
    assert.equal(records.filter((r) => r.kind === 'start').length, 1);
    assert.equal(received(records, 'session.begin').length, 0);
  });

  it('carries the snapshot id and element tokens into the observation identity', async () => {
    const traces: any[] = [];
    const { backend, logPath } = makeBackend({ onTrace: (event) => traces.push(event) });
    const observation = await observeFixture(backend);

    assert.match(observation.observationId, /^snap_/);
    assert.equal(observation.pid, 4711);
    assert.equal(observation.windowId, 90210);
    assert.equal(observation.appId, FIXTURE_APP_ID);
    // §4.3: the window digest already is the content fingerprint.
    assert.match(observation.contentFingerprint!, /^sha256:[0-9a-f]{64}$/);
    const button = observation.elements.find((element) => element.role === 'AXButton');
    // The model quotes `elementId` back, so it is short. The real token stays in
    // `identity`, and the backend maps between them at dispatch — the executor
    // never sees the short form, which is what the protocol's rule is about.
    //
    // The token was the elementId until a real model run: 53 characters, 45 of
    // them a prefix shared by every element in the snapshot. The model failed
    // four calls with "arguments failed validation" and explained itself with
    // 「看起来我漏掉了 element_id 参数」. It had not missed it; it could not copy it.
    assert.equal(button?.elementId, '1');
    assert.equal(button?.identity?.token, 'el_2');
    // The parent is named in the same space as `elementId`, not in the wire
    // space `identity.token` lives in. This assertion used to say `'el_1'`,
    // which was the defect written down as a rule: a child the model can quote
    // pointing at a parent it has never been shown.
    assert.equal(button?.parentElementId, '0');
    // §5.3: the wire frame is window-local and CuObservedElement.frame is screen
    // logical points, so the observed rectangle is the element's plus the
    // window's origin — the fixture window starts at y: 25.
    assert.deepEqual(button?.frame, { x: 20, y: 65, width: 72, height: 28 });
    assert.equal(observation.screenshot?.mimeType, 'image/png');
    assert.equal(observation.screenshot?.widthPx, 1200);
    assert.deepEqual(observation.displays?.[0]?.sourceBoundsPx, {
      x: 0,
      y: 0,
      width: 3024,
      height: 1964,
    });

    const records = await readRecords(logPath);
    const observeParams = received(records, 'observe')[0];
    assert.equal(observeParams?.session, RUN_CONTEXT.sessionId);
    // §5.2: a tagged union, never app + windowId as two optional fields, and the
    // app string travels unaltered — the executor resolves it (§5.1), so the
    // host never touches window.list to do it.
    assert.deepEqual(observeParams?.target, { kind: 'app', app: FIXTURE_APP_ID });
    assert.equal(received(records, 'window.list').length, 0);
    // §5: bounds are omitted so the executor applies the ones it declared.
    assert.equal(observeParams?.maxElements, undefined);
    assert.equal(received(records, 'session.begin').length, 1);
    // §7.4 bounds reach the host even though CuObservation has no field for them.
    assert.equal(traces.find((event) => event.type === 'observe')?.truncatedElements, false);
  });

  it('uses stable ids while an explicit observation still renders the full tree', async () => {
    const { backend } = makeBackend({ differencePresentation: 'no-change' });
    const first = await observeFixture(backend);
    assert.deepEqual(
      first.elements.map((element) => element.elementId),
      ['10', '12'],
    );
    assert.equal(first.difference, undefined);

    const second = await observeFixture(backend);
    assert.equal(second.difference?.baseObservationId, first.observationId);
    assert.equal(second.difference?.presentation, 'no-change');
    assert.equal(second.renderDifference, undefined);
  });

  it('renders the declared difference only on the observation returned by an action', async () => {
    const { backend } = makeBackend({ differencePresentation: 'difference' });
    const observation = await observeFixture(backend);
    const button = observation.elements.find((element) => element.role === 'AXButton');
    assert.equal(button?.elementId, '12');

    const result = await backend.runSemantic!(
      {
        type: 'click_element',
        observationId: observation.observationId,
        elementId: button!.elementId,
      },
      signal(),
      RUN_CONTEXT,
    );

    assert.equal(result.outcome.ok, true);
    assert.equal(result.observation?.renderDifference, true);
    assert.deepEqual(result.observation?.difference, {
      baseObservationId: observation.observationId,
      presentation: 'difference',
      changes: [
        { kind: 'remove', path: [0, 0], stableId: 7 },
        { kind: 'update', path: [0, 1], stableId: 12, elementId: '12' },
      ],
      removedStableIdRanges: [{ start: 7, end: 8 }],
    });
  });

  it('echoes the element digest and returns the frame that superseded the quoted one', async () => {
    const { backend, logPath } = makeBackend();
    const observation = await observeFixture(backend);
    const result = await backend.runSemantic!(
      {
        type: 'click_element',
        observationId: observation.observationId,
        elementId: 'el_2',
        elementIdentity: { token: 'el_2', role: 'AXButton' },
      },
      signal(),
      RUN_CONTEXT,
    );

    assert.equal(result.outcome.ok, true);
    assert.equal(result.outcome.ok && result.outcome.tier, 'ax');
    // §6.5: verified is host-derived from effect, and is not a wire field.
    assert.equal(result.outcome.ok && result.outcome.verified, true);
    assert.equal(result.outcome.evidence?.path, 'ax_action');
    assert.equal(result.outcome.evidence?.effect, 'confirmed');
    assert.ok(result.observation, 'a fresh observation came back with the dispatch');
    assert.notEqual(result.observation!.observationId, observation.observationId);
    // Whether a frame comes back is the mock's choice here; what this pins is
    // that the dispatch stopped asking for one (see the observeAfter assertion
    // below). The mirror's frame comes from the host's own captureObservation,
    // which is allowed to be slow because nothing is waiting on it.

    const dispatch = received(await readRecords(logPath), 'dispatch.element')[0];
    assert.equal(dispatch?.snapshotId, observation.observationId);
    assert.equal(dispatch?.elementToken, 'el_2');
    // §4.3: echoing the digest catches a host that mixed up two snapshots.
    assert.match(dispatch?.expectElementDigest, /^sha256:[0-9a-f]{64}$/);
    assert.equal(dispatch?.strictness, 'element');
    // §6.1: a semantic dispatch addresses an element, not a pixel.
    assert.equal(dispatch?.occlusionPolicy, 'same_app');
    assert.deepEqual(dispatch?.action, { kind: 'click', button: 'left', count: 1 });
    assert.deepEqual(dispatch?.observeAfter, { includeImage: false, settle: 'quiesce' });
  });

  it('refuses a dispatch against a spent snapshot as a duplicate action', async () => {
    const { backend } = makeBackend({ dispatchError: 'snapshot_spent' });
    const observation = await observeFixture(backend);
    const result = await backend.runSemantic!(
      { type: 'click_element', observationId: observation.observationId, elementId: 'el_2' },
      signal(),
      RUN_CONTEXT,
    );
    // §7.1 maps snapshot_spent to duplicate_action, not to a generic failure.
    assert.equal(result.outcome.ok, false);
    assert.equal(!result.outcome.ok && result.outcome.error, 'duplicate_action');

    // §4.1: the spent frame is gone, so quoting it again is a stale frame.
    const again = await backend.runSemantic!(
      { type: 'click_element', observationId: observation.observationId, elementId: 'el_2' },
      signal(),
      RUN_CONTEXT,
    );
    assert.equal(!again.outcome.ok && again.outcome.error, 'stale_frame');
  });

  it('reports an element whose reference died as target_missing and keeps the frame live', async () => {
    const { backend } = makeBackend({ dispatchError: 'element_released' });
    const observation = await observeFixture(backend);
    const result = await backend.runSemantic!(
      { type: 'click_element', observationId: observation.observationId, elementId: 'el_2' },
      signal(),
      RUN_CONTEXT,
    );
    assert.equal(!result.outcome.ok && result.outcome.error, 'target_missing');

    // §4.1: a refused dispatch does not spend its snapshot — the host may fix
    // the argument and retry against the same frame.
    const retry = await backend.runSemantic!(
      { type: 'click_element', observationId: observation.observationId, elementId: 'el_1' },
      signal(),
      RUN_CONTEXT,
    );
    assert.equal(!retry.outcome.ok && retry.outcome.error, 'target_missing');
  });

  it('refuses an element token that was never in the quoted snapshot', async () => {
    const { backend, logPath } = makeBackend();
    const observation = await observeFixture(backend);
    const result = await backend.runSemantic!(
      { type: 'click_element', observationId: observation.observationId, elementId: 'el_404' },
      signal(),
      RUN_CONTEXT,
    );
    assert.equal(!result.outcome.ok && result.outcome.error, 'stale_frame');
    // Nothing reached the executor: there was no digest to echo.
    assert.equal(received(await readRecords(logPath), 'dispatch.element').length, 0);
  });

  it('rejects a tier/path pair outside the declared table instead of coercing it', async () => {
    const traces: any[] = [];
    const { backend } = makeBackend({
      tier: 'ax',
      path: 'cg_event_pid',
      onTrace: (event) => traces.push(event),
    });
    const observation = await observeFixture(backend);
    const result = await backend.runSemantic!(
      { type: 'click_element', observationId: observation.observationId, elementId: 'el_2' },
      signal(),
      RUN_CONTEXT,
    );
    assert.equal(!result.outcome.ok && result.outcome.error, 'service_mismatch');
    // Which pair was wrong is a fact about two implementations disagreeing, in
    // wire vocabulary the tool surface does not have. It goes to the trace; the
    // model reads the one thing that changes what it does next.
    assert.match(
      traces.find((event) => event.type === 'protocol_violation')?.reason ?? '',
      /does not permit path/,
    );
    const message = result.outcome.ok ? '' : result.outcome.message;
    assert.doesNotMatch(message, /tier|path|maka\.cu/);
    assert.match(message, /restarted|another way/);
  });

  it('treats a global-pointer path as a compromised session', async () => {
    const traces: any[] = [];
    const { backend } = makeBackend({
      tier: 'coordinate-background',
      path: 'cg_event_global',
      allowCompatibilityInputDispatch: true,
      onTrace: (event) => traces.push(event),
    });
    const observation = await observeFixture(backend);
    const result = await backend.run(
      { type: 'left_click', coordinate: { x: 400, y: 200 } },
      signal(),
      { ...RUN_CONTEXT, boundAction: boundCoordinate(observation) },
    );
    // §6.3: the executor states the path and the host verifies it. A path that
    // was never permitted at handshake means the system cursor moved.
    assert.equal(!result.outcome.ok && result.outcome.error, 'service_mismatch');
    assert.ok(traces.some((event) => event.type === 'protocol_violation'));
    assert.match(
      traces.find((event) => event.type === 'protocol_violation')?.reason ?? '',
      /moves the system cursor/,
    );
  });

  it('anchors a coordinate dispatch to the window digest in image pixels', async () => {
    const { backend, logPath } = makeBackend({
      tier: 'coordinate-background',
      path: 'cg_event_pid',
      allowCompatibilityInputDispatch: true,
    });
    const observation = await observeFixture(backend);
    const result = await backend.run(
      { type: 'left_click', coordinate: { x: 400, y: 200 } },
      signal(),
      { ...RUN_CONTEXT, boundAction: boundCoordinate(observation) },
    );
    assert.equal(result.outcome.ok, true);
    assert.equal(result.outcome.ok && result.outcome.tier, 'coordinate-background');

    const dispatch = received(await readRecords(logPath), 'dispatch.point')[0];
    assert.equal(dispatch?.snapshotId, observation.observationId);
    // §6.3: a point has no element to anchor to, so the window is the anchor.
    assert.equal(dispatch?.expectWindowDigest, observation.contentFingerprint);
    assert.equal(dispatch?.space, 'image_px');
    assert.equal(dispatch?.occlusionPolicy, 'any');
    assert.deepEqual(dispatch?.point, { x: 400, y: 200 });
  });

  it('keeps coordinate dispatch closed unless the host policy opens it', async () => {
    const { backend, logPath } = makeBackend({
      tier: 'coordinate-background',
      path: 'cg_event_pid',
    });
    const observation = await observeFixture(backend);
    const result = await backend.run(
      { type: 'left_click', coordinate: { x: 400, y: 200 } },
      signal(),
      { ...RUN_CONTEXT, boundAction: boundCoordinate(observation) },
    );
    assert.equal(!result.outcome.ok && result.outcome.error, 'unsupported_action');
    assert.equal(received(await readRecords(logPath), 'dispatch.point').length, 0);
  });

  it('lets an element action through while the user is physically active', async () => {
    // The guard protects the one pointer and the one keyboard the user also
    // has. An element action names an element and lets the accessibility API
    // actuate it, so it competes for neither. Fencing it here is what turned
    // "the user is at their keyboard" into "Computer Use does not work" on a
    // real matrix run — two scenarios spent 22 and 26 calls being refused.
    const { backend, logPath } = makeBackend({ physicalInputRecentlyActive: () => true });
    const observation = await observeFixture(backend);
    const result = await backend.runSemantic!(
      { type: 'click_element', observationId: observation.observationId, elementId: 'el_2' },
      signal(),
      RUN_CONTEXT,
    );
    assert.equal(result.outcome.ok, true);
    assert.equal(received(await readRecords(logPath), 'dispatch.element').length, 1);
  });

  it('still fences synthesized input while the user is physically active', async () => {
    const { backend, logPath } = makeBackend({
      allowCompatibilityInputDispatch: true,
      physicalInputRecentlyActive: () => true,
    });
    const observation = await observeFixture(backend);
    const result = await backend.run({ type: 'key', text: 'cmd+a' }, signal(), {
      ...RUN_CONTEXT,
      boundAction: boundCoordinate(observation),
    });
    assert.equal(!result.outcome.ok && result.outcome.error, 'user_intervened');
    assert.equal(received(await readRecords(logPath), 'dispatch.key').length, 0);
  });

  // §5.7 — apps.launch.

  it('launches an app in the background and reports the resolved id', async () => {
    const { backend, logPath } = makeBackend({});
    const launched = await backend.launchApp!({ app: 'Launched' }, signal(), RUN_CONTEXT);
    // §5.1: the request may carry a display name because an app that is not
    // running has no appId to quote; the result carries the resolved one, and
    // that is what every later call uses.
    assert.equal(launched.bundleId, 'com.example.Launched');
    assert.equal(launched.pid, 5150);
    // The executor waits for the window rather than reporting the empty array
    // it sees at launch time, so the model is not sent back to observe for it.
    assert.deepEqual(launched.windows, [{ windowId: 77001, title: 'Untitled' }]);
    assert.equal(launched.focusHeld, true);
    const call = received(await readRecords(logPath), 'apps.launch')[0];
    assert.equal(call?.app, 'Launched');
    assert.equal(call?.waitForWindowMs, 8_000);
  });

  it('reports a launch that took the foreground instead of hiding it', async () => {
    // It happened; hiding it does not un-happen it. `focusHeld` is the host's
    // inversion of a field the executor declares, never an absent third value.
    const { backend } = makeBackend({ launchTookForeground: true });
    const launched = await backend.launchApp!({ app: 'Launched' }, signal(), RUN_CONTEXT);
    assert.equal(launched.focusHeld, false);
  });

  it('says the host deadline killed the executor, not that it exited on its own', async () => {
    // The host kills the child on its own deadline as well as on a crash, and
    // both used to say "exited after request delivery" — which reads as a
    // dead executor and sends the reader to the wrong side. Observing an app
    // whose front window is a file dialog costs about eighteen seconds against
    // a twenty-second deadline, so this is the message a busy machine makes.
    //
    // That distinction is for the person reading the trace. The model reads
    // what it can act on, and what it must not do is repeat an action whose
    // fate is unknown.
    const traces: any[] = [];
    const { backend } = makeBackend({
      hangObserve: true,
      timeoutMs: 300,
      onTrace: (event) => traces.push(event),
    });
    await assert.rejects(
      backend.captureObservation!({ windowId: 90210, includeScreenshot: true }, signal(), {
        ...RUN_CONTEXT,
      }),
      /outcome_unknown/,
    );
    const hostError = traces.find((event) => event.type === 'host_error');
    assert.equal(hostError?.kind, 'executor_stopped_mid_action');
    assert.match(hostError?.detail ?? '', /host deadline/);
  });

  it('keeps executor diagnostics out of what the model reads', async () => {
    // `maka-cu dispatch.element: Invalid params (-32602)` was reaching the
    // model: a wire method it cannot call, a JSON-RPC number it cannot act on,
    // and no next move. Raw failure text — RPC bodies, stderr tails, error
    // codes this build has never heard of — goes to the trace, and the model
    // gets a sentence written for it.
    const traces: any[] = [];
    const { backend } = makeBackend({
      dispatchError: 'wormhole_collapsed',
      onTrace: (event) => traces.push(event),
    });
    const observation = await observeFixture(backend);
    const result = await backend.runSemantic!(
      { type: 'click_element', observationId: observation.observationId, elementId: 'el_2' },
      signal(),
      RUN_CONTEXT,
    );
    assert.equal(!result.outcome.ok && result.outcome.error, 'service_mismatch');
    const message = result.outcome.ok ? '' : result.outcome.message;
    // No wire method, no error code, no protocol name, and a next move.
    assert.doesNotMatch(
      message,
      /dispatch\.element|maka-cu|maka\.cu|wormhole_collapsed|-?32\d\d\d/,
    );
    assert.match(message, /different action/);
    const hostError = traces.find((event) => event.type === 'host_error');
    assert.equal(hostError?.kind, 'unknown_refusal');
    assert.match(hostError?.detail ?? '', /wormhole_collapsed/);
  });

  it('reports a refused launch with its mapped code, not a raw executor refusal', async () => {
    const { backend } = makeBackend({ launchError: 'app_not_found' });
    await assert.rejects(
      backend.launchApp!({ app: 'Nothing' }, signal(), RUN_CONTEXT),
      /target_missing/,
    );
  });

  it('treats a launch result missing foregroundTaken as version skew', async () => {
    const { backend } = makeBackend({ malformed: 'launch_no_foreground' });
    await assert.rejects(
      backend.launchApp!({ app: 'Launched' }, signal(), RUN_CONTEXT),
      /service_mismatch|foregroundTaken/,
    );
  });

  it('says an occluded target is what driving from behind looks like, and names the way out', async () => {
    // The refusal a model actually hits. Asked to move a window it reached for
    // `left_click_drag` on the title bar — the only way to move one — and every
    // attempt came back "another window covers the target". It could not have
    // succeeded: Computer Use drives what is not in front, so the target is
    // behind something by construction, and a coordinate action needs the pixel
    // it aims at. The two constraints are in tension by design.
    const { backend } = makeBackend({ dispatchError: 'window_occluded' });
    const observation = await observeFixture(backend);
    const result = await backend.runSemantic!(
      { type: 'click_element', observationId: observation.observationId, elementId: 'el_2' },
      signal(),
      RUN_CONTEXT,
    );
    assert.equal(!result.outcome.ok && result.outcome.error, 'target_occluded');
    assert.match(
      (!result.outcome.ok && result.outcome.message) || '',
      /not in front|element action/,
    );
  });

  it('says a refused accessibility action will not start working, so it is not retried', async () => {
    // Measured: a model read `+raise` off an observation, used it exactly as
    // advertised, and got "the action was attempted and refused, and nothing
    // happened" — a true sentence with no next move in it. It sent the same
    // call fourteen times. §6.5's `delivered == 0` is the executor's own test
    // for "not one of them landed", and an element that advertises an action
    // and then declines it is a property of that application.
    // The executor reports `path: "none"` for this — a first-press failure
    // reached nothing — and no `wouldRequirePath`, because it was allowed to
    // try and did.
    const { backend } = makeBackend({
      dispatchError: 'dispatch_refused',
      refusalPath: 'none',
      refusalOutcome: 'failed',
      noWouldRequirePath: true,
    });
    const observation = await observeFixture(backend);
    const result = await backend.runSemantic!(
      { type: 'click_element', observationId: observation.observationId, elementId: 'el_2' },
      signal(),
      RUN_CONTEXT,
    );
    assert.equal(!result.outcome.ok && result.outcome.error, 'dispatch_refused');
    const message = (!result.outcome.ok && result.outcome.message) || '';
    assert.match(message, /will not start working|different control|different route/);
    // And it must not read as a permission problem. Telling a model nothing was
    // *permitted* sends it looking for permission it already has — the
    // application declined an action it advertises, and no route around this
    // executor changes that.
    assert.doesNotMatch(message, /permitted/);
  });

  it('separates an application saying no from a route this executor may not take', async () => {
    // Both arrive as `path: "none"`, and they need opposite next moves. The
    // executor names the route it was not allowed to take; that name is the
    // whole difference, so it is what this reads rather than the path.
    const { backend } = makeBackend({
      dispatchError: 'dispatch_refused',
      refusalPath: 'none',
      refusalOutcome: 'refused',
    });
    const observation = await observeFixture(backend);
    const result = await backend.runSemantic!(
      { type: 'click_element', observationId: observation.observationId, elementId: 'el_2' },
      signal(),
      RUN_CONTEXT,
    );
    const message = (!result.outcome.ok && result.outcome.message) || '';
    assert.match(message, /permitted/);
    assert.doesNotMatch(message, /advertises this action/);
    // The route it would have needed still travels as evidence.
    assert.equal(result.outcome.evidence?.reason, 'would_require:cg_event_global');
  });

  it('carries a cut tree through as cut, instead of only into the trace', async () => {
    // A bounded walk that arrives looking complete is the worse failure: the
    // model concludes the control is not there. An open/save panel reaches the
    // executor's bound as a matter of course, so this is the normal case now.
    const { backend } = makeBackend({ truncated: true });
    const observation = await observeFixture(backend);
    assert.equal(observation.truncated, true);

    const again = await observeFixture(backend);
    assert.equal(again.truncated, true, 'a second observation of the same window agrees');
  });

  it('reads an element with no rectangle instead of refusing the whole window', async () => {
    // §5 declares `frame` optional. Reading it as required cost a whole
    // application: one element without one in System Settings turned every
    // observation of that window into a protocol violation, so the app could
    // not be looked at at all. An element with no rectangle is still
    // addressable — semantic dispatch names it rather than aiming at it.
    const { backend } = makeBackend({ malformed: 'no_frame' });
    const observation = await observeFixture(backend);
    assert.equal(observation.elements.length, 2, 'the tree still arrives');
    const boxless = observation.elements.find((e) => e.frame === undefined);
    assert.ok(boxless, 'the element with no frame is present and carries none');
    assert.ok(boxless.elementId, 'and is still addressable');
  });

  it('carries the subrole, which is how a password field is knowable at all', async () => {
    // The tool description told the model a password field could not be told
    // apart "because the executor reports no subrole". The executor was sending
    // it; this backend was dropping it. A promise the model was asked to keep
    // on its own is one the observation should have been keeping for it.
    const { backend } = makeBackend({});
    const observation = await observeFixture(backend);
    const secure = observation.elements.find((e) => e.subrole === 'AXSecureTextField');
    assert.ok(secure, 'the fixture element carrying a subrole reaches the observation');
    const plain = observation.elements.find((e) => e.role === 'AXWindow');
    assert.equal(plain?.subrole, undefined, 'an element without one carries nothing');
  });

  it('names a parent in the id space the model reads, not the wire token', async () => {
    // These were two namespaces: the child's id is the short one the model
    // quotes, the parent pointer was the executor's token. On a real Calculator
    // that dangled for 64 of 65 elements, so an indented observation had no
    // containment to indent by — a flat list wearing a tree's field names.
    const { backend } = makeBackend({});
    const observation = await observeFixture(backend);
    const ids = new Set(observation.elements.map((element) => element.elementId));
    const parents = observation.elements
      .map((element) => element.parentElementId)
      .filter((id): id is string => typeof id === 'string');
    assert.ok(parents.length > 0, 'the fixture tree has a parent to check');
    for (const parent of parents) {
      assert.ok(ids.has(parent), `parent ${parent} is not an element id in this observation`);
    }
    // The root keeps no parent rather than pointing at itself.
    const root = observation.elements.find((element) => element.role === 'AXWindow');
    assert.equal(root?.parentElementId, undefined);
  });

  it('rejects a frame whose bytes do not match the declared digest', async () => {
    const { backend } = makeBackend({ badImageSha: true });
    // §8: the host verifies, so a stale path can never return a previous
    // frame's pixels under a fresh snapshot's name.
    await assert.rejects(observeFixture(backend), /sha256|digest/);
  });

  it('reports a delivered dispatch with no fresh frame as outcome_unknown', async () => {
    // Nothing checked whether this landed, and no frame came back to check it
    // against, so the outcome really is unknown.
    const { backend } = makeBackend({ noPostSnapshot: true, unverifiedEffect: true });
    const observation = await observeFixture(backend);
    const result = await backend.runSemantic!(
      { type: 'click_element', observationId: observation.observationId, elementId: 'el_2' },
      signal(),
      RUN_CONTEXT,
    );
    assert.equal(!result.outcome.ok && result.outcome.error, 'outcome_unknown');
    assert.equal(result.outcome.evidence?.effect, 'unverifiable');
  });

  it('reports an effect the executor confirmed as done, even with no fresh frame', async () => {
    // The frame after the action is what could not be read; whether the action
    // happened was already answered. `confirmed` means the executor compared
    // the tree before and after and saw the change, and a screenshot timing out
    // afterwards does not retract that.
    //
    // Measured on a real cross-application run: four element dispatches came
    // back `outcome: ok, effect: confirmed, verificationMethod: tree_delta`,
    // all four were reported to the model as failures, and the next observation
    // showed every one had landed. The cost was not the four calls — it was
    // that the model then held a wrong picture of the screen, and the honest
    // `target_missing` three calls later was the child of this dishonest
    // `outcome_unknown`.
    const { backend } = makeBackend({ noPostSnapshot: true });
    const observation = await observeFixture(backend);
    const result = await backend.runSemantic!(
      { type: 'click_element', observationId: observation.observationId, elementId: 'el_2' },
      signal(),
      RUN_CONTEXT,
    );
    assert.equal(result.outcome.ok, true);
    assert.equal(result.outcome.evidence?.effect, 'confirmed');
    assert.equal(result.outcome.evidence?.reason, 'dispatch.element:confirmed_without_frame');
  });

  it('reports an action that closed its own target as done, not as unknown', async () => {
    // Closing a dialog, dismissing a sheet and closing a window all end with
    // the acted-on window gone, so no post-action observation is possible.
    // Calling that `outcome_unknown` tells the model it does not know whether
    // the action worked, and the obvious response to not knowing is to repeat
    // it — which for a close is a second close, aimed at whatever took the
    // window's place. Measured on the CUA Lab fixture: pressing its modal's own
    // close button reported `outcome_unknown` on an action that had plainly
    // succeeded.
    const { backend } = makeBackend({ postWindowGone: true });
    const observation = await observeFixture(backend);
    const result = await backend.runSemantic!(
      { type: 'click_element', observationId: observation.observationId, elementId: 'el_2' },
      signal(),
      RUN_CONTEXT,
    );
    assert.equal(result.outcome.ok, true);
    assert.equal(result.outcome.evidence?.reason, 'dispatch.element:target_closed');
    // Still honest about what was not checked: nothing read the effect back.
    assert.equal(result.outcome.verified, true);
  });

  it('ends the executor session when the host clears it', async () => {
    const { backend, logPath } = makeBackend();
    await observeFixture(backend);
    // clearSession fires session.end without exposing the round-trip, so wait
    // on the delivered record itself instead of guessing scheduler timing.
    backend.clearSession(RUN_CONTEXT.sessionId);
    await waitForRecord(
      logPath,
      (r) => r.kind === 'recv' && r.method === 'session.end',
      'the executor never received session.end after clearSession',
    );
    const records = await readRecords(logPath);
    assert.deepEqual(received(records, 'session.end')[0], { session: RUN_CONTEXT.sessionId });
  });

  it('maps apps.list onto CuAppSummary without a rendered catalogue', async () => {
    const { backend } = makeBackend();
    const apps = await backend.listApps!(signal());
    assert.deepEqual(apps, [
      { appId: 'com.example.Fixture', pid: 4711, name: 'Fixture', windowCount: 1 },
    ]);
  });

  // §5.1 — one namespace for naming an app.

  it('serves the {app, windowId} pair every fresh full observation asks for', async () => {
    const { backend, logPath } = makeBackend();
    const observation = await observeFixture(backend);
    // This is the exact call the runtime makes after a mutating action
    // (computer-use-tools.ts freshFullObservation): the appId it hands back is
    // the one the observation carried.
    const again = await backend.captureObservation!(
      { app: observation.appId, windowId: observation.windowId, includeScreenshot: true },
      signal(),
      RUN_CONTEXT,
    );
    assert.equal(again.appId, FIXTURE_APP_ID);

    // The window id was joined to its pid through window.list (§5.4) and the
    // pair resolved into the exact arm of the union.
    const observes = received(await readRecords(logPath), 'observe');
    assert.deepEqual(observes[1]?.target, { kind: 'window', pid: 4711, windowId: 90210 });
  });

  it('refuses an {app, windowId} pair no window satisfies as target_missing', async () => {
    const { backend } = makeBackend();
    await assert.rejects(
      backend.captureObservation!(
        { app: 'com.example.Other', windowId: 90210, includeScreenshot: true },
        signal(),
        RUN_CONTEXT,
      ),
      /target_missing/,
    );
  });

  it('matches an app string against appId only, never against a display name', async () => {
    const { backend } = makeBackend();
    // `Fixture` is `appName` on both window.list and snapshot.target. It is a
    // display string (§1.2) and is never a key, so it matches nothing.
    await assert.rejects(
      backend.captureObservation!(
        { app: 'Fixture', windowId: 90210, includeScreenshot: true },
        signal(),
        RUN_CONTEXT,
      ),
      /target_missing/,
    );
  });

  // §5.3 — coordinate space.

  it('converts every element frame into screen points once, by the window origin', async () => {
    const { backend } = makeBackend({ windowOriginY: 300 });
    const observation = await observeFixture(backend);
    const button = observation.elements.find((element) => element.role === 'AXButton');
    const root = observation.elements.find((element) => element.role === 'AXWindow');
    // Window-local (20, 40) inside a window whose origin is (0, 300).
    assert.deepEqual(button?.frame, { x: 20, y: 340, width: 72, height: 28 });
    assert.deepEqual(root?.frame, { x: 10, y: 320, width: 72, height: 28 });
    // The occlusion check compares this centre against the window bounds in
    // screen space; an unconverted frame is inside a window that starts 300
    // points lower, so the element reads as outside it.
    assert.equal(observation.windowBounds?.y, 300);
  });

  // §6.4 — the host parses the key string.

  it('asks the executor to take focus when the model named the control', async () => {
    const { backend, logPath } = makeBackend({ allowCompatibilityInputDispatch: true });
    const observation = await observeFixture(backend);
    // el_1 is the window, not the focused element — exactly the case the
    // promise covers: name a control and it is focused before the key lands.
    const result = await backend.runSemantic!(
      {
        type: 'press_key',
        observationId: observation.observationId,
        key: 'Tab',
        elementId: 'el_1',
      },
      signal(),
      RUN_CONTEXT,
    );
    assert.equal(result.outcome.ok, true);
    const dispatch = received(await readRecords(logPath), 'dispatch.key')[0];
    assert.equal(dispatch?.focusToken, 'el_1');
    assert.equal(dispatch?.focusPolicy, 'acquire');
  });

  it('verifies rather than takes focus when the model named no control', async () => {
    const { backend, logPath } = makeBackend({ allowCompatibilityInputDispatch: true });
    const observation = await observeFixture(backend);
    const result = await backend.runSemantic!(
      { type: 'press_key', observationId: observation.observationId, key: 'Tab' },
      signal(),
      RUN_CONTEXT,
    );
    assert.equal(result.outcome.ok, true);
    const dispatch = received(await readRecords(logPath), 'dispatch.key')[0];
    // The frame's own focused element, and no policy field: absent means
    // `require`, which is the strict check the frame binding already earns.
    assert.equal(dispatch?.focusToken, 'el_2');
    assert.equal(dispatch?.focusPolicy, undefined);
  });

  it('refuses a key aimed at a control outside the quoted frame', async () => {
    const { backend, logPath } = makeBackend({ allowCompatibilityInputDispatch: true });
    const observation = await observeFixture(backend);
    const result = await backend.runSemantic!(
      {
        type: 'press_key',
        observationId: observation.observationId,
        key: 'Tab',
        elementId: 'el_404',
      },
      signal(),
      RUN_CONTEXT,
    );
    assert.equal(!result.outcome.ok && result.outcome.error, 'stale_frame');
    // The same sentence a refused element action gets: the id that failed, and
    // the one thing that produces a working one.
    const message = result.outcome.ok ? '' : result.outcome.message;
    assert.match(message, /'el_404'/);
    assert.match(message, /observe the window again/i);
    assert.equal(received(await readRecords(logPath), 'dispatch.key').length, 0);
  });

  it('parses a key combination into the wire closed sets before sending it', async () => {
    const { backend, logPath } = makeBackend({ allowCompatibilityInputDispatch: true });
    const observation = await observeFixture(backend);
    const result = await backend.run({ type: 'key', text: 'cmd+a' }, signal(), {
      ...RUN_CONTEXT,
      boundAction: boundCoordinate(observation),
    });
    assert.equal(result.outcome.ok, true);
    const dispatch = received(await readRecords(logPath), 'dispatch.key')[0];
    // The raw xdotool-flavoured string never reaches the wire; `key` is one
    // member of the closed set and the modifiers travel in their own array.
    assert.deepEqual(dispatch?.action, { kind: 'key', key: 'a', modifiers: ['command'] });
  });

  it('sends nothing for a key string it cannot parse', async () => {
    for (const key of ['delete', 'del', 'cmd+', 'a+b', 'hyper+a']) {
      const { backend, logPath } = makeBackend({ allowCompatibilityInputDispatch: true });
      const observation = await observeFixture(backend);
      const result = await backend.runSemantic!(
        { type: 'press_key', observationId: observation.observationId, key },
        signal(),
        RUN_CONTEXT,
      );
      // §6.4: no dropped modifier, no nearest match, and no raw string sent down
      // for the executor to answer -32602 — which would have reached the model
      // as `service_mismatch`, blaming the executor's version for Cmd+A.
      assert.equal(!result.outcome.ok && result.outcome.error, 'unsupported_action', key);
      assert.ok(
        !result.outcome.ok && result.outcome.message.includes(`'${key}'`),
        `the message names the string it could not parse: ${key}`,
      );
      assert.equal(received(await readRecords(logPath), 'dispatch.key').length, 0, key);
    }
  });

  // §1.1 / §6.5 — refusals carry the declared fields.

  it('accepts a refusal that carries the four declared fields and keeps the executor', async () => {
    const traces: any[] = [];
    const { backend } = makeBackend({
      dispatchError: 'window_occluded',
      onTrace: (event) => traces.push(event),
    });
    const observation = await observeFixture(backend);
    const result = await backend.runSemantic!(
      { type: 'click_element', observationId: observation.observationId, elementId: 'el_2' },
      signal(),
      RUN_CONTEXT,
    );
    assert.equal(!result.outcome.ok && result.outcome.error, 'target_occluded');
    assert.equal(result.outcome.evidence?.path, 'none');
    assert.equal(result.outcome.evidence?.effect, 'unverifiable');
    // §1.1: a refusal is an outcome, not a protocol violation. The maka.cu/1
    // host SIGKILLed the child for any non-`ok` outcome.
    assert.ok(!traces.some((event) => event.type === 'protocol_violation'));
    assert.equal(backend.executorState().state, 'ready');
    assert.equal(traces.find((event) => event.type === 'refusal')?.outcome, 'refused');
  });

  it('rejects a refusal that carries only an error object', async () => {
    const { backend } = makeBackend({ dispatchError: 'window_occluded', bareRefusal: true });
    const observation = await observeFixture(backend);
    const result = await backend.runSemantic!(
      { type: 'click_element', observationId: observation.observationId, elementId: 'el_2' },
      signal(),
      RUN_CONTEXT,
    );
    // §6.5: the four fields are required on every dispatch result, this arm
    // included, so a bare refusal is version skew rather than an outcome.
    assert.equal(!result.outcome.ok && result.outcome.error, 'service_mismatch');
  });

  it('rejects an ok result that declares a refusal', async () => {
    const traces: any[] = [];
    const { backend } = makeBackend({
      okOutcome: 'refused',
      onTrace: (event) => traces.push(event),
    });
    const observation = await observeFixture(backend);
    const result = await backend.runSemantic!(
      { type: 'click_element', observationId: observation.observationId, elementId: 'el_2' },
      signal(),
      RUN_CONTEXT,
    );
    // §6.5: `outcome` selects the arm, so the two can never disagree.
    assert.equal(!result.outcome.ok && result.outcome.error, 'service_mismatch');
    assert.match(
      traces.find((event) => event.type === 'protocol_violation')?.reason ?? '',
      /contradicts the ok:true arm/,
    );
  });

  // §7.1 — refused, not unsupported.

  it('tells the model a dispatch was refused, and leaves the frame it quoted live', async () => {
    const { backend } = makeBackend({ dispatchError: 'dispatch_refused' });
    const observation = await observeFixture(backend);
    const result = await backend.runSemantic!(
      { type: 'click_element', observationId: observation.observationId, elementId: 'el_2' },
      signal(),
      RUN_CONTEXT,
    );
    // Not `capture_failed` (the wrong subsystem) and not `unsupported_action`
    // (which is decided before anything is dispatched).
    assert.equal(!result.outcome.ok && result.outcome.error, 'dispatch_refused');
    assert.equal(result.outcome.evidence?.reason, 'would_require:cg_event_global');

    // §4.1: a refusal does not spend its snapshot, so the model may retry
    // against the same frame with different arguments.
    const retry = await backend.runSemantic!(
      { type: 'click_element', observationId: observation.observationId, elementId: 'el_1' },
      signal(),
      RUN_CONTEXT,
    );
    assert.equal(!retry.outcome.ok && retry.outcome.error, 'dispatch_refused');
  });

  it('discards the frame when the echoed digest was not the recorded one', async () => {
    const { backend } = makeBackend({ dispatchError: 'element_digest_mismatch' });
    const observation = await observeFixture(backend);
    const result = await backend.runSemantic!(
      { type: 'click_element', observationId: observation.observationId, elementId: 'el_2' },
      signal(),
      RUN_CONTEXT,
    );
    assert.equal(!result.outcome.ok && result.outcome.error, 'stale_frame');
    // §6.2: this host paired a token with a digest from another frame, so
    // re-sending against the same frame cannot help.
    const again = await backend.runSemantic!(
      { type: 'click_element', observationId: observation.observationId, elementId: 'el_2' },
      signal(),
      RUN_CONTEXT,
    );
    assert.equal(!again.outcome.ok && again.outcome.error, 'stale_frame');
    assert.match(again.outcome.ok ? '' : again.outcome.message, /observe the window again/i);
  });

  // §1.3 — one way to write a hash.

  it('rejects a bare-hex image digest instead of comparing against it', async () => {
    const traces: any[] = [];
    const { backend } = makeBackend({ bareImageSha: true, onTrace: (event) => traces.push(event) });
    // §1.3: the host prefixes its own digest and never strips the executor's.
    // Accepting both spellings is what let the two ends disagree; comparing
    // bare hex against a prefixed value made every frame mismatch, and a
    // mismatched frame is teardown.
    await assert.rejects(observeFixture(backend), /service_mismatch/);
    assert.match(
      traces.find((event) => event.type === 'protocol_violation')?.reason ?? '',
      /"sha256:" lowercase-hex digest/,
    );
  });

  // §5.2 / §5.4 / §5.5 — declared fields are not optional.

  it('refuses a snapshot missing a declared array rather than reading it as empty', async () => {
    for (const malformed of ['no_displays', 'no_obscuring', 'numeric_parent']) {
      const { backend } = makeBackend({ malformed });
      await assert.rejects(observeFixture(backend), /service_mismatch/, malformed);
    }
  });

  it('refuses a window list entry with no zIndex rather than sorting it as 0', async () => {
    const traces: any[] = [];
    const { backend } = makeBackend({
      malformed: 'window_no_zindex',
      onTrace: (event) => traces.push(event),
    });
    // §5.4: the executor MUST NOT emit ties, and a defaulted 0 manufactures
    // them in the sort that picks the target window.
    await assert.rejects(
      backend.captureObservation!({ windowId: 90210, includeScreenshot: true }, signal(), {
        ...RUN_CONTEXT,
      }),
      /service_mismatch/,
    );
    assert.match(
      traces.find((event) => event.type === 'protocol_violation')?.reason ?? '',
      /window\.zIndex/,
    );
  });

  it('refuses an apps.list entry with no windowCount rather than reporting zero', async () => {
    const traces: any[] = [];
    const { backend } = makeBackend({
      malformed: 'app_no_window_count',
      onTrace: (event) => traces.push(event),
    });
    await assert.rejects(backend.listApps!(signal()), /service_mismatch/);
    assert.match(
      traces.find((event) => event.type === 'protocol_violation')?.reason ?? '',
      /app\.windowCount/,
    );
  });

  // §1.1 — a refusal from a helper is still an outcome.

  it('maps a refused session.begin instead of letting it escape as an exception', async () => {
    const { backend } = makeBackend({ sessionError: 'permission_missing' });
    const result = await backend.run({ type: 'screenshot' }, signal(), RUN_CONTEXT);
    // The tool implementation gets a CuRunResult the model can read, not a
    // thrown Error from inside the backend.
    assert.equal(!result.outcome.ok && result.outcome.error, 'permission_missing');
  });

  it('maps a refused window.list the same way', async () => {
    const { backend } = makeBackend({ windowListError: 'permission_missing' });
    await assert.rejects(
      backend.captureObservation!({ windowId: 90210, includeScreenshot: true }, signal(), {
        ...RUN_CONTEXT,
      }),
      /permission_missing/,
    );
  });
});

describe('maka-cu backend selection', () => {
  it('is reached by being named, and refuses without a pinned digest', () => {
    if (process.platform !== 'darwin') return;
    let made = 0;
    const stub = () => ({
      preflight: async () => ({ accessibility: false, screenRecording: false }),
    });
    const createBackend = () => {
      made += 1;
      return stub() as never;
    };

    const selected = selectComputerUseBackend({
      backendId: 'maka-cu',
      binaryPath: '/tmp/does-not-matter',
      expectedBinarySha256: 'deadbeef',
      createBackend,
    });
    assert.equal(selected.backendId, 'maka-cu');
    assert.equal(made, 1);

    // No digest, no executor — and `'none'` rather than a backend that would
    // spawn whatever happens to be at that path.
    const unpinned = selectComputerUseBackend({
      backendId: 'maka-cu',
      binaryPath: '/tmp/does-not-matter',
      createBackend,
    });
    assert.equal(unpinned.backendId, 'none');
    assert.equal(made, 1);
  });

  it('is what a caller that names nothing gets', () => {
    // The default, and the only reason this assertion is worth writing down:
    // "which executor runs" is a decision the selector owns, and a host that
    // names nothing must land on the same one the constant names. If the two
    // ever disagree, a machine runs an executor nobody chose.
    if (process.platform !== 'darwin') return;
    assert.equal(DEFAULT_CU_BACKEND_ID, 'maka-cu');
    let made = 0;
    const selected = selectComputerUseBackend({
      binaryPath: '/tmp/does-not-matter',
      expectedBinarySha256: 'deadbeef',
      createBackend: () => {
        made += 1;
        return {
          preflight: async () => ({ accessibility: false, screenRecording: false }),
        } as never;
      },
    });
    assert.equal(selected.backendId, 'maka-cu');
    assert.equal(made, 1);
  });
});

describe('maka-cu key chord parsing', () => {
  it('cannot be spelled with an Object.prototype member', () => {
    // Both alias tables are indexed with a caller-supplied string. Read off a
    // plain object literal, `constructor` answered with a function and
    // `__proto__` with an object, so `parseMakaCuKeyChord('constructor')`
    // returned a chord whose key was not a string, and `'constructor+a'`
    // returned `modifiers: [null]`. Either goes on the wire, the executor
    // answers -32602, and the host tells the model the executor is the wrong
    // version rather than that it asked for something unparseable.
    for (const spelling of ['constructor', '__proto__', 'constructor+a', 'cmd+constructor']) {
      assert.equal(
        parseMakaCuKeyChord(spelling),
        undefined,
        `${spelling} must be unparseable, not a chord`,
      );
    }
  });
});
