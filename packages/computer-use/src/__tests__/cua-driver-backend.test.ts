// Unit test for the cua-driver CuDispatchBackend (Tier-2). Drives the module
// against a MOCK cua-driver child (a tiny node script written to a temp dir) —
// the real binary is never spawned. The mock speaks the same line-delimited
// JSON-RPC 2.0 the driver does and records every message (plus its own
// pid/argv/selected-env) to an NDJSON log the test inspects.
//
// Run (from repo root), after @maka/core + @maka/runtime are built:
//   npm --workspace @maka/desktop run clean:main \
//     && npm --workspace @maka/desktop run build:main \
//     && node --test apps/desktop/dist/main/__tests__/cua-driver-backend.test.js
// or simply: npm --workspace @maka/desktop test  (builds main + runs all).
import assert from 'node:assert/strict';
import { chmodSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';

import type { ComputerUsePageIdentity, CuAction } from '@maka/core';
import type {
  CuaBoundAction,
  CuObservation,
  CuRunContext,
  CuRunResult,
  CuSemanticAction,
} from '@maka/runtime';
import type { CuaResolvedPageTextTarget } from '../cua-driver-page-target.js';
import {
  createCuaDriverBackend,
  type CuaDriverBackendOptions,
  type CuaDriverTraceEvent,
} from '../cua-driver-backend.js';

const HOST_BUNDLE_ID = 'com.maka.test';
const DEFAULT_RUN_CONTEXT: CuRunContext = {
  sessionId: 'test-session',
  turnId: 'test-turn',
  toolCallId: 'test-tool',
};

function testPageTarget(): CuaResolvedPageTextTarget {
  return {
    port: 9333,
    pageTargetId: 'window-a',
    pageUrl: 'data:text/html,window-a',
    targetUrlContains: 'data:text/html,window-a',
  };
}

function boundElementAction(observation: CuObservation, elementId: string): CuaBoundAction {
  return {
    frameId: observation.observationId,
    epoch: 0,
    actionFingerprint: `click:${elementId}`,
    fingerprint: `bound:${observation.observationId}:${elementId}`,
    target: {
      pid: observation.pid,
      windowId: observation.windowId,
      appName: observation.appId,
      ...(observation.windowTitle ? { title: observation.windowTitle } : {}),
      ...(observation.windowBounds ? { bounds: observation.windowBounds } : {}),
      ...(observation.sourceBoundsPx ? { sourceBoundsPx: observation.sourceBoundsPx } : {}),
      ...(observation.zIndex !== undefined ? { zIndex: observation.zIndex } : {}),
      ...(observation.page ? { page: observation.page } : {}),
    },
    display: observation.displays?.[0],
    elementId,
  };
}

function boundCoordinateAction(
  input: {
    pid?: number;
    windowId?: number;
    bounds?: { x: number; y: number; width: number; height: number };
    sourceBoundsPx?: { x: number; y: number; width: number; height: number };
    coordinate?: { x: number; y: number };
    startCoordinate?: { x: number; y: number };
    zIndex?: number;
    page?: ComputerUsePageIdentity;
  } = {},
): CuaBoundAction {
  const pid = input.pid ?? 4242;
  const windowId = input.windowId ?? 77;
  const bounds = input.bounds ?? { x: 100, y: 100, width: 600, height: 400 };
  const sourceBoundsPx = input.sourceBoundsPx ?? { x: 0, y: 0, width: 1200, height: 800 };
  const coordinate = input.coordinate ?? { x: 400, y: 200 };
  const startCoordinate = input.startCoordinate;
  return {
    frameId: 'frame-coordinate',
    epoch: 0,
    actionFingerprint: 'left_click',
    fingerprint: 'bound-coordinate',
    target: {
      pid,
      windowId,
      appName: pid === 4242 ? 'Fixture' : `pid:${pid}`,
      title: pid === 4242 ? 'Fixture Window' : undefined,
      bounds,
      sourceBoundsPx,
      zIndex: input.zIndex ?? 5,
      contentFingerprint: 'test-content-fingerprint',
      ...(input.page ? { page: input.page } : {}),
    },
    ...(startCoordinate
      ? {
          sourceStartCoordinate: startCoordinate,
          windowStartCoordinate: startCoordinate,
        }
      : {}),
    sourceCoordinate: coordinate,
    windowCoordinate: coordinate,
    coordinateSpace: 'window-screenshot-local',
  };
}

// A CommonJS mock cua-driver. No backticks / ${} inside → embedded via
// String.raw so \n survives as a literal escape in the written file.
const MOCK_SRC = String.raw`#!/usr/bin/env node
'use strict';
const fs = require('fs');
const LOG = process.env.CUA_MOCK_LOG || '';
const HANG_TOOL = process.env.CUA_MOCK_HANG_TOOL || '';
const HANG_ONCE_TOOL = process.env.CUA_MOCK_HANG_ONCE_TOOL || '';
const HANG_ONCE_MARKER = process.env.CUA_MOCK_HANG_ONCE_MARKER || '';
const DELAY_TOOL = process.env.CUA_MOCK_DELAY_TOOL || '';
const DELAY_MS = Number(process.env.CUA_MOCK_DELAY_MS || 0);
const ERR_TOOL = process.env.CUA_MOCK_RPCERR_TOOL || '';
const ERR_AFTER_TOOL = process.env.CUA_MOCK_RPCERR_AFTER_TOOL || '';
const ERR_AFTER_COUNT = Number(process.env.CUA_MOCK_RPCERR_AFTER_COUNT || 0);
const TOOL_CALL_COUNTS = new Map();
const EMPTY_AX = process.env.CUA_MOCK_EMPTY_AX === '1';
const AX_ROLE = process.env.CUA_MOCK_AX_ROLE || 'AXTextArea';
const AX_LABEL = process.env.CUA_MOCK_AX_LABEL || '';
const SEMANTIC_OCCLUDED = process.env.CUA_MOCK_SEMANTIC_OCCLUDED === '1';
const PAGE_EXEC_RESULT = process.env.CUA_MOCK_PAGE_EXEC_RESULT || '';
const PAGE_READBACK_VALUE = process.env.CUA_MOCK_PAGE_READBACK_VALUE || '';
const NATIVE_READBACK_VALUE = process.env.CUA_MOCK_NATIVE_READBACK_VALUE || '';
const MALFORMED_AX_AFTER = Number(process.env.CUA_MOCK_MALFORMED_AX_AFTER || 0);
const PAGE_DOCUMENT_MARKER = process.env.CUA_MOCK_PAGE_DOCUMENT_MARKER || 'document-a';
let PAGE_FIELD_VALUE = process.env.CUA_MOCK_PAGE_FIELD_VALUE || '';
let PAGE_INSERTED = false;
const FIELD_VALUES = new Map();
const SNAPSHOT_DELAY_MS = Number(process.env.CUA_MOCK_SNAPSHOT_DELAY_MS || 0);
const REFETCH_MODE = process.env.CUA_MOCK_REFETCH_MODE || '';
let WINDOW_STATE_CALLS = 0;
// 1x1 transparent PNG (tiny, well under the frame cap).
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
// A "big" frame (~1.9MB decoded) to exercise the compression threshold path.
const BIG_IMG = process.env.CUA_MOCK_BIG_IMAGE === '1' ? 'A'.repeat(2600000) : '';
function logRec(rec) { if (LOG) { try { fs.appendFileSync(LOG, JSON.stringify(rec) + '\n'); } catch (e) {} } }
logRec({
  kind: 'start',
  pid: process.pid,
  home: process.env.HOME,
  argv: process.argv.slice(2),
  env: {
    CUA_DRIVER_EMBEDDED: process.env.CUA_DRIVER_EMBEDDED,
    CUA_DRIVER_HOST_BUNDLE_ID: process.env.CUA_DRIVER_HOST_BUNDLE_ID,
    CUA_DRIVER_RS_TELEMETRY_ENABLED: process.env.CUA_DRIVER_RS_TELEMETRY_ENABLED,
    CUA_DRIVER_RS_UPDATE_CHECK: process.env.CUA_DRIVER_RS_UPDATE_CHECK,
  },
});
function send(obj) { process.stdout.write(JSON.stringify(obj) + '\n'); }
function reply(id, result) { send({ jsonrpc: '2.0', id: id, result: result }); }
function handle(msg) {
  const id = msg.id;
  const method = msg.method;
  const params = msg.params || {};
  if (method === 'initialize') {
    reply(id, { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'mock', version: '0' } });
    return;
  }
  if (method === 'tools/call') {
    const name = params.name;
    const toolCallCount = (TOOL_CALL_COUNTS.get(name) || 0) + 1;
    TOOL_CALL_COUNTS.set(name, toolCallCount);
    if (name === HANG_TOOL) { return; } // never respond → exercises abort/kill/handshake-timeout
    if (name === HANG_ONCE_TOOL && HANG_ONCE_MARKER) {
      try {
        fs.writeFileSync(HANG_ONCE_MARKER, '1', { flag: 'wx' });
        logRec({ kind: 'blocked', tool: name });
        return;
      } catch (e) {}
    }
    if (name === ERR_TOOL) { send({ jsonrpc: '2.0', id: id, error: { code: -32000, message: 'mock rpc error' } }); return; }
    if (name === ERR_AFTER_TOOL && toolCallCount >= ERR_AFTER_COUNT) {
      send({ jsonrpc: '2.0', id: id, error: { code: -32000, message: 'mock rpc error' } });
      return;
    }
    const sendToolReply = (result) => {
      if (name === DELAY_TOOL && DELAY_MS > 0) {
        setTimeout(() => reply(id, result), DELAY_MS);
      } else {
        reply(id, result);
      }
    };
    switch (name) {
      case 'set_config':
        reply(id, { content: [], structuredContent: {} });
        return;
      case 'check_permissions':
        reply(id, { content: [], structuredContent: { accessibility: true, screen_recording_capturable: true } });
        return;
      case 'get_desktop_state':
        reply(id, {
          content: [{ type: 'image', data: BIG_IMG || PNG, mimeType: 'image/png' }],
          structuredContent: { screenshot_width: 1440, screenshot_height: 900 },
        });
        return;
      case 'get_window_state':
        WINDOW_STATE_CALLS += 1;
        const snapshotWindowId = Number(params.arguments?.window_id);
        const snapshotFrame = snapshotWindowId === 88
          ? { x: 100, y: 650, w: 800, h: 200 }
          : { x: 250, y: 150, w: 200, h: 120 };
        const baseElement = {
          element_index: 7,
          element_token: 'snapshot:7',
          role: AX_ROLE,
          label: AX_LABEL || undefined,
          value: FIELD_VALUES.has(snapshotWindowId)
            ? NATIVE_READBACK_VALUE || FIELD_VALUES.get(snapshotWindowId) || ''
            : '',
          frame: snapshotFrame,
        };
        const refetchedElements = WINDOW_STATE_CALLS === 2 && REFETCH_MODE === 'replacement'
          ? [{ ...baseElement, element_index: 9, element_token: 'snapshot:9' }]
          : WINDOW_STATE_CALLS === 2 && REFETCH_MODE === 'moved'
            ? [{
                ...baseElement,
                element_index: 9,
                element_token: 'snapshot:9',
                frame: { ...snapshotFrame, x: snapshotFrame.x + 40 },
              }]
          : WINDOW_STATE_CALLS === 2 && REFETCH_MODE === 'missing'
            ? []
            : WINDOW_STATE_CALLS === 2 && REFETCH_MODE === 'ambiguous'
              ? [
                  { ...baseElement, element_index: 9, element_token: 'snapshot:9' },
                  {
                    ...baseElement,
                    element_index: 10,
                    element_token: 'snapshot:10',
                    frame: { ...snapshotFrame, x: snapshotFrame.x + 40 },
                  },
                ]
              : [baseElement];
        setTimeout(() => reply(id, {
            content: [{
              type: 'image',
              data: BIG_IMG || PNG,
              mimeType: 'image/png',
            }],
            structuredContent: {
              screenshot_width: 1200,
              screenshot_height: 800,
              elements: MALFORMED_AX_AFTER > 0 && WINDOW_STATE_CALLS >= MALFORMED_AX_AFTER
                ? { malformed: true }
                : EMPTY_AX ? [] : refetchedElements,
            },
          }), SNAPSHOT_DELAY_MS);
        return;
      case 'click':
        sendToolReply({
          content: [{ type: 'text', text: 'clicked' }],
          structuredContent: params.arguments?.element_index !== undefined
            ? { path: 'ax', verified: true, effect: 'confirmed' }
            : { path: 'cgevent', verified: false, effect: 'unverifiable' },
        });
        return;
      case 'double_click':
        sendToolReply({
          content: [{ type: 'text', text: 'double-clicked' }],
          structuredContent: params.arguments?.element_index !== undefined
            ? {}
            : { path: 'cgevent', verified: false, effect: 'unverifiable' },
        });
        return;
      case 'scroll':
        reply(id, { content: [{ type: 'text', text: 'scrolled' }], structuredContent: {} });
        return;
      case 'drag':
        reply(id, { content: [{ type: 'text', text: 'dragged' }], structuredContent: {} });
        return;
      case 'zoom':
        reply(id, {
          content: [
            { type: 'image', data: 'SlBFRw==', mimeType: 'image/jpeg' },
            { type: 'text', text: 'zoomed' },
          ],
          structuredContent: { width: 320, height: 180, format: 'jpeg', mime_type: 'image/jpeg' },
        });
        return;
      case 'get_screen_size':
        reply(id, { content: [], structuredContent: { width: 1512, height: 982, scale_factor: 2 } });
        return;
      case 'get_cursor_position':
        reply(id, { content: [], structuredContent: { x: 321, y: 654 } });
        return;
      case 'list_windows':
        // Two layer-0 windows. Win 77 covers screen-points (100,100)-(700,500).
        // Win 88 sits at (100,600)-(400,900) — disjoint from win 77 and from every
        // existing test's probe point, used only to exercise cross-window drag.
        // Wins 91-94 overlap ONLY at a fresh probe point screen (1000,200) that no
        // other test touches — they exercise the z-order tiebreak (92 z9 beats 91 z2)
        // and the eligibility filter (93 is layer!=0, 94 is off-screen → both excluded
        // despite the highest z / covering the point).
        reply(id, { content: [], structuredContent: { windows: [
          { window_id: 77, pid: 4242, app_name: 'Fixture', title: 'Fixture Window', layer: 0, is_on_screen: true, z_index: 5, bounds: { x: 100, y: 100, width: 600, height: 400 } },
          { window_id: 88, pid: 4242, layer: 0, is_on_screen: true, z_index: 3, bounds: { x: 100, y: 600, width: 300, height: 300 } },
          { window_id: 91, pid: 5001, layer: 0, is_on_screen: true, z_index: 2, bounds: { x: 900, y: 100, width: 400, height: 300 } },
          { window_id: 92, pid: 5002, layer: 0, is_on_screen: true, z_index: 9, bounds: { x: 950, y: 150, width: 300, height: 200 } },
          { window_id: 93, pid: 5003, layer: 3, is_on_screen: true, z_index: 99, bounds: { x: 900, y: 100, width: 400, height: 300 } },
          { window_id: 94, pid: 5004, layer: 0, is_on_screen: false, z_index: 50, bounds: { x: 900, y: 100, width: 400, height: 300 } },
          ...(SEMANTIC_OCCLUDED
            ? [{ window_id: 95, pid: 5005, layer: 0, is_on_screen: true, z_index: 20, bounds: { x: 300, y: 180, width: 100, height: 100 } }]
            : []),
        ] } });
        return;
      case 'list_apps':
        // No frontmost app → the backend cannot resolve a target pid.
        reply(id, { content: [], structuredContent: { apps: [{ pid: 4242, frontmost: false }] } });
        return;
      case 'set_value':
        FIELD_VALUES.set(
          Number(params.arguments?.window_id),
          String(params.arguments?.value ?? ''),
        );
        reply(id, { content: [{ type: 'text', text: 'value set' }], structuredContent: {} });
        return;
      case 'select_text':
      case 'perform_secondary_action':
      case 'press_key':
        reply(id, {
          content: [{ type: 'text', text: name + ' ok' }],
          structuredContent: { path: 'ax', verified: true, effect: 'confirmed' },
        });
        return;
      case 'page':
        const pageAction = params.arguments?.action;
        const pageJavascript = String(params.arguments?.javascript || '');
        const pageText = pageAction === 'execute_javascript'
          ? pageJavascript.includes('performance.timeOrigin')
            ? PAGE_DOCUMENT_MARKER
            : pageJavascript.includes('__makaComputerUseReadElement')
            ? JSON.stringify({
                editable: true,
                value: PAGE_INSERTED && PAGE_READBACK_VALUE
                  ? PAGE_READBACK_VALUE
                  : PAGE_FIELD_VALUE,
                tagName: 'textarea',
                inputType: '',
              })
            : PAGE_EXEC_RESULT
          : 'inserted through CDP';
        if (pageAction === 'insert_text') {
          PAGE_FIELD_VALUE = String(params.arguments?.text || '');
          PAGE_INSERTED = true;
        }
        reply(id, {
          content: [{
            type: 'text',
            text: pageText,
          }],
          structuredContent: {},
        });
        return;
      default:
        reply(id, { content: [{ type: 'text', text: 'unknown tool' }], isError: true, structuredContent: {} });
        return;
    }
  }
  reply(id, {});
}
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', function (chunk) {
  buf += chunk;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch (e) { continue; }
    logRec({ kind: 'recv', method: msg.method, id: msg.id, params: msg.params });
    if (typeof msg.id !== 'number') continue; // notification: record only
    handle(msg);
  }
});
`;

let workDir = '';
let mockPath = '';
const backends: Array<{ dispose: () => void }> = [];

type TestBackend = Omit<ReturnType<typeof createCuaDriverBackend>, 'run'> & {
  run(action: CuAction, signal: AbortSignal, context?: CuRunContext): Promise<CuRunResult>;
};

function delay(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
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
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as Record<string, any>);
}

/** recv methods in order, with tool name inlined for tools/call. */
function methodTrace(records: Array<Record<string, any>>): string[] {
  return records
    .filter((r) => r.kind === 'recv')
    .map((r) =>
      r.method === 'tools/call' ? 'tools/call:' + (r.params && r.params.name) : r.method,
    );
}

function toolCall(
  records: Array<Record<string, any>>,
  name: string,
): Record<string, any> | undefined {
  const rec = records.find(
    (r) => r.kind === 'recv' && r.method === 'tools/call' && r.params && r.params.name === name,
  );
  return rec && rec.params ? (rec.params.arguments as Record<string, any>) : undefined;
}

function toolCalls(records: Array<Record<string, any>>, name: string): Array<Record<string, any>> {
  return records
    .filter((r) => r.kind === 'recv' && r.method === 'tools/call' && r.params?.name === name)
    .map((r) => r.params.arguments as Record<string, any>);
}

function businessPageCalls(records: Array<Record<string, any>>): Array<Record<string, any>> {
  return toolCalls(records, 'page').filter(
    (call) => !String(call.javascript ?? '').includes('performance.timeOrigin'),
  );
}

async function waitForRecord(
  logPath: string,
  predicate: (record: Record<string, any>) => boolean,
  timeoutMs = 2000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await readRecords(logPath)).some(predicate)) return;
    await delay(10);
  }
  assert.fail('timed out waiting for mock record');
}

/**
 * Create a backend pointed at the mock. The module captures process.env at
 * spawn time, so we set the per-child log path (and optional hang tool) right
 * before returning — tests run sequentially, so there is no env interleave.
 */
function makeBackend(
  opts: {
    hangTool?: string;
    hangOnceTool?: string;
    delayTool?: string;
    delayMs?: number;
    rpcErrTool?: string;
    rpcErrAfterTool?: string;
    rpcErrAfterCount?: number;
    handshakeTimeoutMs?: number;
    bigImage?: boolean;
    emptyAx?: boolean;
    axRole?: string;
    axLabel?: string;
    semanticOccluded?: boolean;
    processKind?: 'electron' | 'native' | 'unknown';
    pageTarget?: CuaResolvedPageTextTarget;
    pageFieldValue?: string;
    pageReadbackValue?: string;
    nativeReadbackValue?: string;
    malformedAxAfter?: number;
    pageDocumentMarker?: string;
    resolvePageDocumentFingerprint?: CuaDriverBackendOptions['resolvePageDocumentFingerprint'];
    resolveContentFingerprint?: CuaDriverBackendOptions['resolveContentFingerprint'];
    semanticPointerResult?: Record<string, unknown>;
    refetchMode?: 'replacement' | 'moved' | 'missing' | 'ambiguous';
    resolveDisplays?: CuaDriverBackendOptions['resolveDisplays'];
    physicalInputRecentlyActive?: CuaDriverBackendOptions['physicalInputRecentlyActive'];
    onTrace?: CuaDriverBackendOptions['onTrace'];
    allowCompatibilityInputDispatch?: boolean;
    snapshotDelayMs?: number;
    compressFrame?: (
      b: string,
      m: string,
    ) => { base64: string; mimeType: 'image/png' | 'image/jpeg' };
    onSessionInvalidated?: CuaDriverBackendOptions['onSessionInvalidated'];
  } = {},
): { backend: TestBackend; logPath: string } {
  const logPath = join(workDir, 'log-' + randomUUID() + '.ndjson');
  const hangOnceMarker = join(workDir, 'hang-once-' + randomUUID());
  process.env.CUA_MOCK_LOG = logPath;
  process.env.CUA_MOCK_HANG_TOOL = opts.hangTool ?? '';
  process.env.CUA_MOCK_HANG_ONCE_TOOL = opts.hangOnceTool ?? '';
  process.env.CUA_MOCK_HANG_ONCE_MARKER = hangOnceMarker;
  process.env.CUA_MOCK_DELAY_TOOL = opts.delayTool ?? '';
  process.env.CUA_MOCK_DELAY_MS = String(opts.delayMs ?? 0);
  process.env.CUA_MOCK_RPCERR_TOOL = opts.rpcErrTool ?? '';
  process.env.CUA_MOCK_RPCERR_AFTER_TOOL = opts.rpcErrAfterTool ?? '';
  process.env.CUA_MOCK_RPCERR_AFTER_COUNT = String(opts.rpcErrAfterCount ?? 0);
  process.env.CUA_MOCK_BIG_IMAGE = opts.bigImage ? '1' : '';
  process.env.CUA_MOCK_EMPTY_AX = opts.emptyAx ? '1' : '';
  process.env.CUA_MOCK_AX_ROLE = opts.axRole ?? 'AXTextArea';
  process.env.CUA_MOCK_AX_LABEL = opts.axLabel ?? '';
  process.env.CUA_MOCK_SEMANTIC_OCCLUDED = opts.semanticOccluded ? '1' : '';
  process.env.CUA_MOCK_PAGE_EXEC_RESULT = opts.semanticPointerResult
    ? JSON.stringify(opts.semanticPointerResult)
    : '';
  process.env.CUA_MOCK_PAGE_FIELD_VALUE = opts.pageFieldValue ?? '';
  process.env.CUA_MOCK_PAGE_READBACK_VALUE = opts.pageReadbackValue ?? '';
  process.env.CUA_MOCK_NATIVE_READBACK_VALUE = opts.nativeReadbackValue ?? '';
  process.env.CUA_MOCK_MALFORMED_AX_AFTER = String(opts.malformedAxAfter ?? 0);
  process.env.CUA_MOCK_PAGE_DOCUMENT_MARKER = opts.pageDocumentMarker ?? 'document-a';
  process.env.CUA_MOCK_SNAPSHOT_DELAY_MS = String(opts.snapshotDelayMs ?? 0);
  process.env.CUA_MOCK_REFETCH_MODE = opts.refetchMode ?? '';
  const rawBackend = createCuaDriverBackend({
    binaryPath: mockPath,
    hostBundleId: HOST_BUNDLE_ID,
    timeoutMs: 5000,
    ...(opts.compressFrame ? { compressFrame: opts.compressFrame } : {}),
    ...(opts.handshakeTimeoutMs !== undefined
      ? { handshakeTimeoutMs: opts.handshakeTimeoutMs }
      : {}),
    classifyProcess: async () => opts.processKind ?? 'native',
    resolvePageTextTarget: async () => opts.pageTarget,
    ...(opts.resolvePageDocumentFingerprint
      ? { resolvePageDocumentFingerprint: opts.resolvePageDocumentFingerprint }
      : {}),
    resolveContentFingerprint: opts.resolveContentFingerprint ?? (() => 'test-content-fingerprint'),
    ...(opts.resolveDisplays ? { resolveDisplays: opts.resolveDisplays } : {}),
    ...(opts.physicalInputRecentlyActive
      ? { physicalInputRecentlyActive: opts.physicalInputRecentlyActive }
      : {}),
    ...(opts.onTrace ? { onTrace: opts.onTrace } : {}),
    allowCompatibilityInputDispatch: opts.allowCompatibilityInputDispatch ?? true,
    ...(opts.onSessionInvalidated ? { onSessionInvalidated: opts.onSessionInvalidated } : {}),
  });
  const backend: TestBackend = {
    preflight: (signal) => rawBackend.preflight(signal),
    listApps: (signal) => rawBackend.listApps!(signal),
    observeApp: (input, signal, context) => rawBackend.observeApp!(input, signal, context),
    runSemantic: (action, signal, context) => rawBackend.runSemantic!(action, signal, context),
    inspectWindowAt: (point, signal) => rawBackend.inspectWindowAt(point, signal),
    run: (action, signal, context = DEFAULT_RUN_CONTEXT) => rawBackend.run(action, signal, context),
    serviceState: () => rawBackend.serviceState(),
    clearSession: (sessionId) => rawBackend.clearSession(sessionId),
    dispose: () => rawBackend.dispose(),
  };
  backends.push(backend);
  return { backend, logPath };
}

before(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'cua-driver-test-'));
  // Redirect HOME so the module's best-effort ~/.cua-driver/.installation_recorded
  // pre-seed writes into the temp dir, not the real home.
  process.env.HOME = workDir;
  mockPath = join(workDir, 'cua-mock.cjs');
  await writeFile(mockPath, MOCK_SRC, 'utf8');
  chmodSync(mockPath, 0o755);
});

after(async () => {
  for (const b of backends) {
    try {
      b.dispose();
    } catch {
      /* already gone */
    }
  }
  if (workDir) await rm(workDir, { recursive: true, force: true });
});

describe('cua-driver backend', () => {
  it('performs the initialize → initialized → set_config{window} action-client handshake and spawns with the right env/args', async () => {
    const { backend, logPath } = makeBackend();
    // Any call triggers lazy spawn + handshake.
    const pf = await backend.preflight(new AbortController().signal);
    assert.deepEqual(pf, { accessibility: true, screenRecording: true });

    const records = await readRecords(logPath);

    // Handshake ordering.
    const trace = methodTrace(records);
    assert.deepEqual(trace.slice(0, 3), [
      'initialize',
      'notifications/initialized',
      'tools/call:set_config',
    ]);
    assert.equal(toolCall(records, 'set_config')?.capture_scope, 'window');

    // Spawn contract: args + env.
    const start = records.find((r) => r.kind === 'start');
    assert.ok(start, 'mock recorded a start line');
    assert.deepEqual(start!.argv, [
      'mcp',
      '--embedded',
      '--no-daemon-relaunch',
      '--no-overlay',
      '--host-bundle-id',
      HOST_BUNDLE_ID,
    ]);
    assert.equal(start!.env.CUA_DRIVER_EMBEDDED, '1');
    assert.equal(start!.env.CUA_DRIVER_RS_TELEMETRY_ENABLED, 'false');
    assert.equal(start!.env.CUA_DRIVER_RS_UPDATE_CHECK, 'false');
    assert.equal(start!.env.CUA_DRIVER_HOST_BUNDLE_ID, HOST_BUNDLE_ID);
  });

  it('preflight maps check_permissions{prompt:false} to {accessibility, screenRecording}', async () => {
    const { backend, logPath } = makeBackend();
    const pf = await backend.preflight(new AbortController().signal);
    assert.deepEqual(pf, { accessibility: true, screenRecording: true });
    const records = await readRecords(logPath);
    assert.deepEqual(toolCall(records, 'check_permissions'), { prompt: false });
  });

  it('inspectWindowAt resolves without dispatching pointer input', async () => {
    const { backend, logPath } = makeBackend();
    const target = await backend.inspectWindowAt({ x: 600, y: 400 }, new AbortController().signal);

    assert.equal(target?.pid, 4242);
    assert.equal(target?.windowId, 77);
    const records = await readRecords(logPath);
    assert.equal(toolCalls(records, 'list_windows').length, 1);
    assert.equal(toolCalls(records, 'click').length, 0);
    assert.equal(toolCalls(records, 'double_click').length, 0);
    assert.equal(toolCalls(records, 'drag').length, 0);
  });

  it('isolates desktop capture and window actions into separate children and homes', async () => {
    const { backend, logPath } = makeBackend();
    const sig = new AbortController().signal;

    await backend.run({ type: 'screenshot' } as CuAction, sig, {
      sessionId: 's1',
      turnId: 't1',
      toolCallId: 'shot',
    });
    await backend.run({ type: 'left_click', coordinate: { x: 600, y: 400 } } as CuAction, sig, {
      sessionId: 's1',
      turnId: 't1',
      toolCallId: 'click',
    });

    const records = await readRecords(logPath);
    const starts = records.filter((record) => record.kind === 'start');
    assert.equal(starts.length, 2, 'capture and action clients spawn distinct children');
    assert.notEqual(starts[0]!.pid, starts[1]!.pid);
    assert.notEqual(starts[0]!.home, starts[1]!.home);
    const scopes = records
      .filter(
        (record) =>
          record.kind === 'recv' &&
          record.method === 'tools/call' &&
          record.params?.name === 'set_config',
      )
      .map((record) => record.params.arguments.capture_scope)
      .sort();
    assert.deepEqual(scopes, ['desktop', 'window']);
  });

  it('screenshot maps get_desktop_state → {base64, mimeType, widthPx, heightPx}', async () => {
    const { backend } = makeBackend();
    const res = await backend.run({ type: 'screenshot' } as CuAction, new AbortController().signal);
    assert.deepEqual(res.outcome, { ok: true, tier: 'coordinate-background' });
    assert.ok(res.screenshot, 'screenshot present');
    assert.equal(res.screenshot!.mimeType, 'image/png');
    assert.equal(res.screenshot!.widthPx, 1440);
    assert.equal(res.screenshot!.heightPx, 900);
    assert.ok(res.screenshot!.base64.length > 0);
    assert.ok(Buffer.from(res.screenshot!.base64, 'base64').byteLength > 0);
  });

  it('lists apps and observes a unique app window with indexed AX elements', async () => {
    const { backend } = makeBackend({ axRole: 'AXButton' });
    const signal = new AbortController().signal;
    const context = { sessionId: 's1', turnId: 't1', toolCallId: 'observe' };

    const apps = await backend.listApps?.(signal);
    assert.deepEqual(
      apps?.find((app) => app.appId === 'Fixture'),
      {
        appId: 'Fixture',
        pid: 4242,
        name: 'Fixture',
        windowCount: 1,
        windows: [{ windowId: 77, title: 'Fixture Window' }],
      },
    );
    const observation = await backend.observeApp?.(
      {
        app: 'Fixture Window',
        includeScreenshot: true,
      },
      signal,
      context,
    );

    assert.ok(observation?.observationId);
    assert.equal(observation?.appId, 'Fixture');
    assert.equal(observation?.windowId, 77);
    assert.deepEqual(observation?.elements, [
      {
        elementId: '7',
        role: 'AXButton',
        value: '',
        frame: { x: 250, y: 150, width: 200, height: 120 },
        identity: {
          token: 'snapshot:7',
          role: 'AXButton',
          value: '',
        },
      },
    ]);
    assert.equal(observation?.screenshot?.mimeType, 'image/png');
  });

  it('executes an observed element once and returns a fresh observation', async () => {
    const { backend, logPath } = makeBackend({ axRole: 'AXButton' });
    const signal = new AbortController().signal;
    const context = { sessionId: 's1', turnId: 't1', toolCallId: 'semantic' };
    const observation = await backend.observeApp?.(
      {
        app: 'Fixture Window',
        includeScreenshot: false,
      },
      signal,
      context,
    );
    assert.ok(observation);

    const result = await backend.runSemantic?.(
      {
        type: 'click_element',
        observationId: observation!.observationId,
        elementId: '7',
      },
      signal,
      context,
    );
    assert.equal(result?.outcome.ok, true);
    assert.ok(result?.observation?.observationId);
    assert.notEqual(result?.observation?.observationId, observation!.observationId);
    assert.equal(result?.observation?.windowId, 77);
    assert.deepEqual(result?.resolvedScreenPoint, { x: 350, y: 210 });

    const click = toolCall(await readRecords(logPath), 'click');
    assert.equal(click?.pid, 4242);
    assert.equal(click?.window_id, 77);
    assert.equal(click?.element_index, 7);
    assert.equal(click?.element_token, 'snapshot:7');

    const replay = await backend.runSemantic?.(
      {
        type: 'click_element',
        observationId: observation!.observationId,
        elementId: '7',
      },
      signal,
      context,
    );
    assert.equal(replay?.outcome.ok, false);
    assert.equal(replay?.outcome.ok, false);
    if (replay && !replay.outcome.ok) {
      assert.equal(replay.outcome.error, 'stale_frame');
    }
  });

  it('allows AX semantic input while physical user input is active', async () => {
    const { backend, logPath } = makeBackend({
      axRole: 'AXButton',
      physicalInputRecentlyActive: () => true,
    });
    const signal = new AbortController().signal;
    const context = {
      sessionId: 's1',
      turnId: 't1',
      toolCallId: 'semantic-guard',
    };
    const observation = await backend.observeApp!(
      {
        app: 'Fixture Window',
        includeScreenshot: false,
      },
      signal,
      context,
    );
    const result = await backend.runSemantic!(
      {
        type: 'click_element',
        observationId: observation.observationId,
        elementId: '7',
      },
      signal,
      context,
    );
    assert.equal(result.outcome.ok, true);
    assert.equal(toolCalls(await readRecords(logPath), 'click').length, 1);
  });

  it('press_key uses the freshly refetched exact element token in the background', async () => {
    const traces: CuaDriverTraceEvent[] = [];
    const { backend, logPath } = makeBackend({
      axRole: 'AXButton',
      axLabel: 'Commit',
      physicalInputRecentlyActive: () => true,
      onTrace: (event) => traces.push(event),
    });
    const signal = new AbortController().signal;
    const context = {
      sessionId: 'press-session',
      turnId: 'press-turn',
      toolCallId: 'press-key',
    };
    const observation = await backend.observeApp!(
      { app: 'Fixture Window', includeScreenshot: false },
      signal,
      context,
    );
    const result = await backend.runSemantic!(
      {
        type: 'press_key',
        observationId: observation.observationId,
        elementId: '7',
        key: 'Return',
        elementIdentity: observation.elements[0]!.identity,
      },
      signal,
      { ...context, boundAction: boundElementAction(observation, '7') },
    );

    assert.equal(result.outcome.ok, true);
    assert.deepEqual(result.resolvedScreenPoint, { x: 350, y: 210 });
    const call = toolCall(await readRecords(logPath), 'press_key');
    assert.equal(call?.pid, 4242);
    assert.equal(call?.window_id, 77);
    assert.equal(call?.element_index, 7);
    assert.equal(call?.element_token, 'snapshot:7');
    assert.equal(call?.key, 'Return');
    assert.equal(
      traces.some(
        (event) =>
          event.type === 'dispatch' &&
          event.toolCallId === 'press-key' &&
          event.actionType === 'press_key' &&
          event.address === 'ax',
      ),
      true,
    );
  });

  it('refetches a unique labeled element when the ephemeral token changes', async () => {
    const { backend, logPath } = makeBackend({
      axRole: 'AXButton',
      axLabel: 'Continue',
      refetchMode: 'replacement',
    });
    const signal = new AbortController().signal;
    const context = { sessionId: 's1', turnId: 't1', toolCallId: 'semantic' };
    const observation = await backend.observeApp!(
      {
        app: 'Fixture Window',
        includeScreenshot: true,
      },
      signal,
      context,
    );
    const result = await backend.runSemantic!(
      {
        type: 'click_element',
        observationId: observation.observationId,
        elementId: '7',
        elementIdentity: observation.elements[0]!.identity,
      },
      signal,
      { ...context, boundAction: boundElementAction(observation, '7') },
    );

    assert.equal(result.outcome.ok, true);
    const click = toolCall(await readRecords(logPath), 'click');
    assert.equal(click?.element_index, 9);
    assert.equal(click?.element_token, 'snapshot:9');
  });

  it('does not treat a reused token as cross-snapshot semantic identity', async () => {
    const { backend, logPath } = makeBackend({
      axRole: 'AXButton',
      axLabel: 'Continue',
      refetchMode: 'missing',
    });
    const signal = new AbortController().signal;
    const context = { sessionId: 's1', turnId: 't1', toolCallId: 'semantic' };
    const observation = await backend.observeApp!(
      {
        app: 'Fixture Window',
        includeScreenshot: true,
      },
      signal,
      context,
    );
    const result = await backend.runSemantic!(
      {
        type: 'click_element',
        observationId: observation.observationId,
        elementId: '7',
        elementIdentity: observation.elements[0]!.identity,
      },
      signal,
      { ...context, boundAction: boundElementAction(observation, '7') },
    );

    assert.equal(result.outcome.ok, false);
    if (!result.outcome.ok) assert.match(result.outcome.message, /missing/);
    assert.equal(toolCalls(await readRecords(logPath), 'click').length, 0);
  });

  it('refetches a tokenless element by one unique role and label match', async () => {
    const { backend, logPath } = makeBackend({
      axRole: 'AXButton',
      axLabel: 'Continue',
      refetchMode: 'replacement',
    });
    const signal = new AbortController().signal;
    const context = { sessionId: 's1', turnId: 't1', toolCallId: 'semantic' };
    const observation = await backend.observeApp!(
      {
        app: 'Fixture Window',
        includeScreenshot: true,
      },
      signal,
      context,
    );
    const result = await backend.runSemantic!(
      {
        type: 'click_element',
        observationId: observation.observationId,
        elementId: '7',
        elementIdentity: { role: 'AXButton', label: 'Continue' },
      },
      signal,
      { ...context, boundAction: boundElementAction(observation, '7') },
    );

    assert.equal(result.outcome.ok, true);
    const click = toolCall(await readRecords(logPath), 'click');
    assert.equal(click?.element_index, 9);
    assert.equal(click?.element_token, 'snapshot:9');
  });

  it('rejects a same-label replacement that moved before semantic dispatch', async () => {
    const { backend, logPath } = makeBackend({
      axRole: 'AXButton',
      axLabel: 'Continue',
      refetchMode: 'moved',
    });
    const signal = new AbortController().signal;
    const context = { sessionId: 's1', turnId: 't1', toolCallId: 'semantic' };
    const observation = await backend.observeApp!(
      {
        app: 'Fixture Window',
        includeScreenshot: true,
      },
      signal,
      context,
    );
    const result = await backend.runSemantic!(
      {
        type: 'click_element',
        observationId: observation.observationId,
        elementId: '7',
        elementIdentity: observation.elements[0]!.identity,
      },
      signal,
      { ...context, boundAction: boundElementAction(observation, '7') },
    );

    assert.equal(result.outcome.ok, false);
    if (!result.outcome.ok) assert.equal(result.outcome.error, 'stale_frame');
    assert.equal(toolCalls(await readRecords(logPath), 'click').length, 0);
  });

  it('refetches an unlabeled element by unique structural identity', async () => {
    const { backend, logPath } = makeBackend({
      axRole: 'AXButton',
      refetchMode: 'replacement',
    });
    const signal = new AbortController().signal;
    const context = { sessionId: 's1', turnId: 't1', toolCallId: 'semantic' };
    const observation = await backend.observeApp!(
      {
        app: 'Fixture Window',
        includeScreenshot: true,
      },
      signal,
      context,
    );
    const result = await backend.runSemantic!(
      {
        type: 'click_element',
        observationId: observation.observationId,
        elementId: '7',
        elementIdentity: observation.elements[0]!.identity,
      },
      signal,
      { ...context, boundAction: boundElementAction(observation, '7') },
    );

    assert.equal(result.outcome.ok, true);
    assert.equal(toolCalls(await readRecords(logPath), 'click').length, 1);
  });

  for (const refetchMode of ['missing', 'ambiguous'] as const) {
    it(`rejects a ${refetchMode} refetched element without dispatch`, async () => {
      const { backend, logPath } = makeBackend({
        axRole: 'AXButton',
        axLabel: 'Continue',
        refetchMode,
      });
      const signal = new AbortController().signal;
      const context = { sessionId: 's1', turnId: 't1', toolCallId: 'semantic' };
      const observation = await backend.observeApp!(
        {
          app: 'Fixture Window',
          includeScreenshot: true,
        },
        signal,
        context,
      );
      const result = await backend.runSemantic!(
        {
          type: 'click_element',
          observationId: observation.observationId,
          elementId: '7',
          elementIdentity: observation.elements[0]!.identity,
        },
        signal,
        { ...context, boundAction: boundElementAction(observation, '7') },
      );

      assert.equal(result.outcome.ok, false);
      if (!result.outcome.ok) assert.equal(result.outcome.error, 'stale_frame');
      assert.equal(toolCalls(await readRecords(logPath), 'click').length, 0);
    });
  }

  it('declares app observations in capture-local window screenshot space', async () => {
    let desktopResolverCalls = 0;
    const { backend } = makeBackend({
      resolveDisplays: async () => {
        desktopResolverCalls += 1;
        return [];
      },
    });
    const observation = await backend.observeApp!(
      {
        app: 'Fixture Window',
        includeScreenshot: true,
      },
      new AbortController().signal,
      DEFAULT_RUN_CONTEXT,
    );

    assert.equal(desktopResolverCalls, 0);
    assert.deepEqual(observation.sourceBoundsPx, {
      x: 0,
      y: 0,
      width: 1200,
      height: 800,
    });
    assert.deepEqual(observation.displays, [
      {
        displayId: 'window:4242:77',
        logicalBounds: { x: 0, y: 0, width: 1200, height: 800 },
        sourceBoundsPx: { x: 0, y: 0, width: 1200, height: 800 },
        scaleFactor: 1,
      },
    ]);
  });

  it('fails closed for semantic actions absent from the pinned driver registry', async () => {
    for (const action of [
      { type: 'select_text', text: 'target' },
      { type: 'secondary_action', action: 'Increment' },
    ] as const) {
      const { backend, logPath } = makeBackend({ axRole: 'AXTextField' });
      const context = {
        sessionId: `s-${action.type}`,
        turnId: 't1',
        toolCallId: action.type,
      };
      const observation = await backend.observeApp!(
        {
          app: 'Fixture Window',
          includeScreenshot: true,
        },
        new AbortController().signal,
        context,
      );
      const semanticAction: CuSemanticAction =
        action.type === 'select_text'
          ? {
              type: 'select_text',
              observationId: observation.observationId,
              elementId: '7',
              text: action.text,
              elementIdentity: observation.elements[0]!.identity,
            }
          : {
              type: 'secondary_action',
              observationId: observation.observationId,
              elementId: '7',
              action: action.action,
              elementIdentity: observation.elements[0]!.identity,
            };
      const result = await backend.runSemantic!(semanticAction, new AbortController().signal, {
        ...context,
        boundAction: boundElementAction(observation, '7'),
      });

      assert.equal(result.outcome.ok, false);
      if (!result.outcome.ok) assert.equal(result.outcome.error, 'unsupported_action');
      assert.equal(toolCalls(await readRecords(logPath), 'select_text').length, 0);
      assert.equal(toolCalls(await readRecords(logPath), 'perform_secondary_action').length, 0);
    }
  });

  it('evicts old unconsumed observations within a long-lived session', async () => {
    const { backend } = makeBackend({ axRole: 'AXButton' });
    const signal = new AbortController().signal;
    const context = { sessionId: 'long-session', turnId: 't1', toolCallId: 'observe' };
    const observations: CuObservation[] = [];
    for (let index = 0; index < 17; index += 1) {
      observations.push(
        await backend.observeApp!(
          {
            app: 'Fixture Window',
            includeScreenshot: false,
          },
          signal,
          { ...context, toolCallId: `observe-${index}` },
        ),
      );
    }

    const result = await backend.runSemantic!(
      {
        type: 'click_element',
        observationId: observations[0]!.observationId,
        elementId: '7',
      },
      signal,
      { ...context, toolCallId: 'old-action' },
    );
    assert.equal(result.outcome.ok, false);
    if (!result.outcome.ok) assert.equal(result.outcome.error, 'stale_frame');
  });

  it('window_id disambiguates multiple visible windows from the same app', async () => {
    const { backend } = makeBackend({ axRole: 'AXButton' });
    const observation = await backend.observeApp?.(
      {
        app: 'pid:4242',
        windowId: 88,
        includeScreenshot: false,
      },
      new AbortController().signal,
      {
        sessionId: 's1',
        turnId: 't1',
        toolCallId: 'observe-window',
      },
    );
    assert.equal(observation?.windowId, 88);
  });

  it('rejects observations from another turn before dispatch', async () => {
    const { backend, logPath } = makeBackend({ axRole: 'AXButton' });
    const signal = new AbortController().signal;
    const observation = await backend.observeApp?.(
      {
        app: 'Fixture Window',
        includeScreenshot: false,
      },
      signal,
      { sessionId: 's1', turnId: 't1', toolCallId: 'observe' },
    );
    assert.ok(observation);

    const result = await backend.runSemantic?.(
      {
        type: 'set_value',
        observationId: observation!.observationId,
        elementId: '7',
        value: 'hello',
      },
      signal,
      { sessionId: 's1', turnId: 't2', toolCallId: 'act' },
    );
    assert.equal(result?.outcome.ok, false);
    assert.match(
      result?.outcome.ok === false ? result.outcome.message : '',
      /another session or turn/,
    );
    assert.equal(toolCalls(await readRecords(logPath), 'set_value').length, 0);
  });

  it('large frame → compressFrame applied (JPEG); small frame → untouched (PNG)', async () => {
    let calls = 0;
    const compressFrame = (_b: string, _m: string) => {
      calls += 1;
      return { base64: 'anVzdGpwZWc=', mimeType: 'image/jpeg' as const };
    };

    // Big frame (~1.9 MB decoded > 1.5 MB threshold) → compressed to JPEG.
    const big = makeBackend({ bigImage: true, compressFrame });
    const bigRes = await big.backend.run(
      { type: 'screenshot' } as CuAction,
      new AbortController().signal,
    );
    assert.equal(calls, 1, 'compressFrame called for a large frame');
    assert.equal(bigRes.screenshot!.mimeType, 'image/jpeg');
    assert.equal(bigRes.screenshot!.base64, 'anVzdGpwZWc=');

    // Small frame (tiny PNG < threshold) → compressor NOT called, stays PNG.
    const small = makeBackend({ bigImage: false, compressFrame });
    const smallRes = await small.backend.run(
      { type: 'screenshot' } as CuAction,
      new AbortController().signal,
    );
    assert.equal(calls, 1, 'compressFrame NOT called for a small frame');
    assert.equal(smallRes.screenshot!.mimeType, 'image/png');
  });

  it('applies the same compression policy to window observations', async () => {
    let calls = 0;
    const { backend } = makeBackend({
      bigImage: true,
      compressFrame: () => {
        calls += 1;
        return { base64: 'anVzdGpwZWc=', mimeType: 'image/jpeg' };
      },
    });
    const observation = await backend.observeApp!(
      {
        app: 'Fixture Window',
        includeScreenshot: true,
      },
      new AbortController().signal,
      DEFAULT_RUN_CONTEXT,
    );

    assert.equal(calls, 1);
    assert.equal(observation.screenshot?.mimeType, 'image/jpeg');
    assert.equal(observation.screenshot?.base64, 'anVzdGpwZWc=');
  });

  it('click on an app window with no AX element → same-snapshot pixel path, NEVER scope:desktop', async () => {
    const { backend, logPath } = makeBackend({ emptyAx: true });
    const sig = new AbortController().signal;
    // scale=2; window covers screen-points (100,100)-(700,500). Device (600,400) →
    // screen (300,200) is inside → resolves. window-local device = (600-200, 400-200).
    const res = await backend.run(
      { type: 'left_click', coordinate: { x: 600, y: 400 } } as CuAction,
      sig,
    );
    assert.equal(res.outcome.ok, true, 'click on a window succeeds');
    if (res.outcome.ok) {
      assert.equal(res.outcome.tier, 'coordinate-background');
      assert.equal(res.outcome.verified, false);
    }

    const records = await readRecords(logPath);
    const click = toolCall(records, 'click');
    assert.ok(click, 'click was sent to cua-driver');
    // The non-negotiable invariant: pid+window_id present (forces post_to_pid, no warp),
    // and NO scope:desktop (the warping path) anywhere.
    assert.equal(click!.pid, 4242);
    assert.equal(click!.window_id, 77);
    assert.equal(click!.x, 400);
    assert.equal(click!.y, 200);
    assert.equal(
      click!.scope,
      undefined,
      'must NOT use scope:desktop (that warps the real cursor)',
    );
    assert.equal(
      click!.delivery_mode,
      undefined,
      'must NOT force foreground on click (default Background = no warp / no z-order change)',
    );
  });

  it('rejects a moved bound window before pointer dispatch', async () => {
    const { backend, logPath } = makeBackend();
    const result = await backend.run(
      { type: 'left_click', coordinate: { x: 400, y: 200 } } as CuAction,
      new AbortController().signal,
      {
        ...DEFAULT_RUN_CONTEXT,
        boundAction: boundCoordinateAction({
          bounds: { x: 101, y: 100, width: 600, height: 400 },
        }),
      },
    );

    assert.equal(result.outcome.ok, false);
    if (!result.outcome.ok) assert.equal(result.outcome.error, 'target_changed');
    assert.equal(toolCalls(await readRecords(logPath), 'click').length, 0);
  });

  it('rejects a replaced native element structure before pointer dispatch', async () => {
    let reads = 0;
    const { backend, logPath } = makeBackend({
      resolveContentFingerprint: () => (reads++ === 0 ? 'structure-a' : 'structure-b'),
    });
    const signal = new AbortController().signal;
    const context = {
      sessionId: 's1',
      turnId: 't1',
      toolCallId: 'native-replacement',
    };
    const observation = await backend.observeApp!(
      {
        app: 'Fixture Window',
        includeScreenshot: true,
      },
      signal,
      context,
    );
    assert.equal(observation.contentFingerprint, 'structure-a');

    const result = await backend.run(
      { type: 'left_click', coordinate: { x: 400, y: 200 } },
      signal,
      {
        ...context,
        boundAction: {
          ...boundCoordinateAction(),
          target: {
            ...boundCoordinateAction().target,
            contentFingerprint: observation.contentFingerprint,
          },
        },
      },
    );

    assert.equal(result.outcome.ok, false);
    if (!result.outcome.ok) assert.equal(result.outcome.error, 'target_changed');
    assert.equal(toolCalls(await readRecords(logPath), 'click').length, 0);
  });

  it('ignores ephemeral AX indexes and tokens in structural fingerprints', async () => {
    let read = 0;
    const { backend } = makeBackend({
      resolveContentFingerprint: undefined,
    });
    const signal = new AbortController().signal;
    const observation = await backend.observeApp?.(
      {
        app: 'Fixture',
        windowId: 77,
        includeScreenshot: true,
      },
      signal,
      DEFAULT_RUN_CONTEXT,
    );
    assert.ok(observation?.contentFingerprint);
    read += 1;
    const result = await backend.run(
      { type: 'left_click', coordinate: { x: 400, y: 200 } },
      signal,
      {
        ...DEFAULT_RUN_CONTEXT,
        boundAction: {
          ...boundCoordinateAction(),
          target: {
            ...boundCoordinateAction().target,
            contentFingerprint: observation.contentFingerprint,
          },
        },
      },
    );
    assert.equal(read, 1);
    assert.notEqual(result.outcome.ok ? undefined : result.outcome.error, 'target_changed');
  });

  it('does not treat omitted no-screenshot dimensions as a layout change', async () => {
    const { backend, logPath } = makeBackend({ emptyAx: true });
    const result = await backend.run(
      { type: 'left_click', coordinate: { x: 400, y: 200 } },
      new AbortController().signal,
      {
        ...DEFAULT_RUN_CONTEXT,
        boundAction: boundCoordinateAction(),
      },
    );
    assert.notEqual(
      result.outcome.ok ? undefined : result.outcome.message,
      'window screenshot scale or layout changed after observation',
    );
    assert.ok(toolCalls(await readRecords(logPath), 'get_window_state').length > 0);
  });

  it('keeps an explicit coordinate click on the pixel path over an AX element', async () => {
    const { backend, logPath } = makeBackend({ axRole: 'AXButton' });
    const result = await backend.run(
      { type: 'left_click', coordinate: { x: 400, y: 200 } },
      new AbortController().signal,
      {
        ...DEFAULT_RUN_CONTEXT,
        boundAction: boundCoordinateAction(),
      },
    );

    assert.equal(result.outcome.ok, true);
    const click = toolCall(await readRecords(logPath), 'click');
    assert.equal(click?.pid, 4242);
    assert.equal(click?.window_id, 77);
    assert.equal(typeof click?.x, 'number');
    assert.equal(typeof click?.y, 'number');
    assert.equal(click?.element_index, undefined);
    assert.equal(click?.element_token, undefined);
  });

  it('rejects a bound coordinate occluded by a higher z-order window', async () => {
    const { backend, logPath } = makeBackend();
    const result = await backend.run(
      { type: 'left_click', coordinate: { x: 100, y: 100 } } as CuAction,
      new AbortController().signal,
      {
        ...DEFAULT_RUN_CONTEXT,
        boundAction: boundCoordinateAction({
          pid: 5001,
          windowId: 91,
          bounds: { x: 900, y: 100, width: 400, height: 300 },
          sourceBoundsPx: { x: 0, y: 0, width: 1200, height: 800 },
          coordinate: { x: 300, y: 267 },
          zIndex: 2,
        }),
      },
    );

    assert.equal(result.outcome.ok, false);
    if (!result.outcome.ok) assert.equal(result.outcome.error, 'target_occluded');
    assert.equal(toolCalls(await readRecords(logPath), 'click').length, 0);
  });

  it('allows observed AX semantic actions behind another foreground window', async () => {
    const { backend, logPath } = makeBackend({
      axRole: 'AXButton',
      axLabel: 'Continue',
      semanticOccluded: true,
    });
    const signal = new AbortController().signal;
    const context = { sessionId: 's1', turnId: 't1', toolCallId: 'semantic' };
    const observation = await backend.observeApp!(
      {
        app: 'Fixture Window',
        includeScreenshot: true,
      },
      signal,
      context,
    );
    const result = await backend.runSemantic!(
      {
        type: 'click_element',
        observationId: observation.observationId,
        elementId: '7',
        elementIdentity: observation.elements[0]!.identity,
      },
      signal,
      { ...context, boundAction: boundElementAction(observation, '7') },
    );

    assert.equal(result.outcome.ok, true);
    const click = toolCall(await readRecords(logPath), 'click');
    assert.equal(click?.pid, 4242);
    assert.equal(click?.window_id, 77);
    assert.equal(click?.element_index, 7);
    assert.equal(click?.element_token, 'snapshot:7');
  });

  it('allows semantic actions on a visible background window', async () => {
    const { backend, logPath } = makeBackend({
      axRole: 'AXButton',
      axLabel: 'Continue',
    });
    const signal = new AbortController().signal;
    const context = { sessionId: 's1', turnId: 't1', toolCallId: 'semantic' };
    const observation = await backend.observeApp!(
      {
        app: 'Fixture Window',
        includeScreenshot: true,
      },
      signal,
      context,
    );
    const result = await backend.runSemantic!(
      {
        type: 'click_element',
        observationId: observation.observationId,
        elementId: '7',
        elementIdentity: observation.elements[0]!.identity,
      },
      signal,
      { ...context, boundAction: boundElementAction(observation, '7') },
    );

    assert.equal(result.outcome.ok, true);
    assert.equal(toolCalls(await readRecords(logPath), 'click').length, 1);
  });

  it('rejects a changed Electron page target without pixel fallback', async () => {
    const currentPage = testPageTarget();
    const boundPage = {
      cdpPort: currentPage.port,
      pageTargetId: 'old-page',
      pageUrl: 'data:text/html,old-page',
      targetUrlContains: 'data:text/html,old-page',
    };
    const { backend, logPath } = makeBackend({
      processKind: 'electron',
      pageTarget: currentPage,
    });
    const result = await backend.run(
      { type: 'left_click', coordinate: { x: 400, y: 200 } } as CuAction,
      new AbortController().signal,
      {
        ...DEFAULT_RUN_CONTEXT,
        boundAction: boundCoordinateAction({ page: boundPage }),
      },
    );

    assert.equal(result.outcome.ok, false);
    if (!result.outcome.ok) assert.equal(result.outcome.error, 'page_target_changed');
    const records = await readRecords(logPath);
    assert.equal(businessPageCalls(records).length, 0);
    assert.ok(toolCalls(records, 'page').length <= 1);
    assert.equal(toolCalls(records, 'click').length, 0);
  });

  it('rejects a replaced Electron document with the same target id and URL', async () => {
    let reads = 0;
    const pageTarget = testPageTarget();
    const { backend, logPath } = makeBackend({
      processKind: 'electron',
      pageTarget,
      resolvePageDocumentFingerprint: async () => (reads++ === 0 ? 'document-a' : 'document-b'),
    });
    const signal = new AbortController().signal;
    const context = {
      sessionId: 's1',
      turnId: 't1',
      toolCallId: 'document-replacement',
    };
    const observation = await backend.observeApp!(
      {
        app: 'Fixture Window',
        includeScreenshot: true,
      },
      signal,
      context,
    );
    assert.equal(observation.page?.documentFingerprint, 'document-a');

    const result = await backend.run(
      { type: 'left_click', coordinate: { x: 400, y: 200 } },
      signal,
      {
        ...context,
        boundAction: boundCoordinateAction({ page: observation.page }),
      },
    );

    assert.equal(result.outcome.ok, false);
    if (!result.outcome.ok) {
      assert.equal(result.outcome.error, 'page_target_changed');
    }
    const records = await readRecords(logPath);
    assert.equal(toolCalls(records, 'click').length, 0);
  });

  it('coordinate click stays on fresh same-snapshot pixels over an actionable control', async () => {
    const { backend, logPath } = makeBackend({ axRole: 'AXButton' });
    const res = await backend.run(
      { type: 'left_click', coordinate: { x: 600, y: 400 } } as CuAction,
      new AbortController().signal,
    );
    assert.deepEqual(res.resolvedScreenPoint, { x: 300, y: 200 });

    assert.equal(res.outcome.ok, true);
    if (res.outcome.ok) {
      assert.equal(res.outcome.tier, 'coordinate-background');
      assert.equal(res.outcome.verified, false);
    }
    const records = await readRecords(logPath);
    const trace = methodTrace(records);
    assert.ok(
      trace.indexOf('tools/call:get_window_state') < trace.indexOf('tools/call:click'),
      'fresh window snapshot precedes the coordinate action',
    );
    const click = toolCall(records, 'click');
    assert.ok(click);
    assert.equal(click!.pid, 4242);
    assert.equal(click!.window_id, 77);
    assert.equal(click!.element_index, undefined);
    assert.equal(click!.element_token, undefined);
    assert.equal(typeof click!.x, 'number');
    assert.equal(typeof click!.y, 'number');
  });

  it('refuses coordinate input while physical user input is active', async () => {
    const traces: CuaDriverTraceEvent[] = [];
    const { backend, logPath } = makeBackend({
      axRole: 'AXButton',
      physicalInputRecentlyActive: () => true,
      onTrace: (event) => traces.push(event),
    });
    const result = await backend.run(
      { type: 'left_click', coordinate: { x: 600, y: 400 } } as CuAction,
      new AbortController().signal,
    );
    assert.equal(result.outcome.ok, false);
    if (!result.outcome.ok) assert.equal(result.outcome.error, 'user_intervened');
    assert.equal(toolCalls(await readRecords(logPath), 'click').length, 0);
    assert.equal(
      traces.some((event) => event.type === 'dispatch'),
      false,
    );
  });

  it('disables compatibility event dispatch by default', async () => {
    const { backend, logPath } = makeBackend({
      allowCompatibilityInputDispatch: false,
    });
    const signal = new AbortController().signal;
    for (const action of [
      { type: 'left_click', coordinate: { x: 600, y: 400 } },
      {
        type: 'scroll',
        coordinate: { x: 600, y: 400 },
        scrollDirection: 'down',
        scrollAmount: 3,
      },
      {
        type: 'left_click_drag',
        startCoordinate: { x: 600, y: 400 },
        coordinate: { x: 800, y: 600 },
      },
    ] as CuAction[]) {
      const result = await backend.run(action, signal);
      assert.equal(result.outcome.ok, false);
      if (!result.outcome.ok) {
        assert.equal(result.outcome.error, 'unsupported_action');
      }
    }
    const records = await readRecords(logPath);
    assert.equal(toolCalls(records, 'click').length, 0);
    assert.equal(toolCalls(records, 'scroll').length, 0);
    assert.equal(toolCalls(records, 'drag').length, 0);
  });

  it('keeps Electron semantic click available while compatibility input is disabled', async () => {
    const traces: CuaDriverTraceEvent[] = [];
    const { backend, logPath } = makeBackend({
      allowCompatibilityInputDispatch: false,
      processKind: 'electron',
      pageTarget: testPageTarget(),
      semanticPointerResult: {
        supported: true,
        ok: true,
        kind: 'left_click',
        editable: true,
        tagName: 'input',
        focusChanged: true,
      },
      onTrace: (event) => traces.push(event),
    });

    const result = await backend.run(
      { type: 'left_click', coordinate: { x: 600, y: 400 } } as CuAction,
      new AbortController().signal,
    );

    assert.equal(result.outcome.ok, true);
    if (result.outcome.ok) assert.equal(result.outcome.tier, 'semantic-background');
    const records = await readRecords(logPath);
    assert.equal(businessPageCalls(records).length, 1);
    assert.equal(toolCalls(records, 'click').length, 0);
    assert.equal(
      traces.some(
        (event) =>
          event.type === 'dispatch' && event.tool === 'page' && event.address === 'semantic',
      ),
      true,
    );
  });

  it('traces native semantic dispatch without exposing element content', async () => {
    const traces: CuaDriverTraceEvent[] = [];
    const { backend } = makeBackend({
      axRole: 'AXTextField',
      axLabel: 'Private field label',
      onTrace: (event) => traces.push(event),
    });
    const signal = new AbortController().signal;
    const context = {
      sessionId: 'trace-session',
      turnId: 'trace-turn',
      toolCallId: 'native-set-value',
    };
    const observed = await backend.observeApp!(
      {
        app: 'Fixture Window',
        includeScreenshot: false,
      },
      signal,
      context,
    );

    await backend.runSemantic!(
      {
        type: 'set_value',
        observationId: observed.observationId,
        elementId: '7',
        value: 'private value',
        elementIdentity: observed.elements[0]!.identity,
      },
      signal,
      {
        ...context,
        boundAction: boundElementAction(observed, '7'),
      },
    );

    const dispatch = traces.find(
      (event) => event.type === 'dispatch' && event.toolCallId === 'native-set-value',
    );
    assert.deepEqual(dispatch, {
      type: 'dispatch',
      toolCallId: 'native-set-value',
      actionType: 'set_value',
      tool: 'set_value',
      pid: 4242,
      windowId: 77,
      address: 'ax',
    });
    assert.doesNotMatch(JSON.stringify(traces), /Private field label|private value/);
  });

  it('fails set_value as outcome_unknown when fresh AX readback does not match', async () => {
    const { backend } = makeBackend({
      axRole: 'AXTextField',
      axLabel: 'Fixture field',
      nativeReadbackValue: 'stale value',
    });
    const signal = new AbortController().signal;
    const context = {
      sessionId: 'readback-session',
      turnId: 'readback-turn',
      toolCallId: 'native-set-value-readback',
    };
    const observed = await backend.observeApp!(
      { app: 'Fixture Window', includeScreenshot: false },
      signal,
      context,
    );

    const result = await backend.runSemantic!(
      {
        type: 'set_value',
        observationId: observed.observationId,
        elementId: '7',
        value: 'requested value',
        elementIdentity: observed.elements[0]!.identity,
      },
      signal,
      {
        ...context,
        boundAction: boundElementAction(observed, '7'),
      },
    );

    assert.equal(result.outcome.ok, false);
    if (!result.outcome.ok) {
      assert.equal(result.outcome.error, 'outcome_unknown');
      assert.equal(result.outcome.evidence?.path, 'ax');
    }
    assert.equal(result.observation?.elements[0]?.value, 'stale value');
  });

  it('fails closed when the physical-input guard cannot be read', async () => {
    const { backend, logPath } = makeBackend({
      axRole: 'AXButton',
      physicalInputRecentlyActive() {
        throw new Error('idle signal unavailable');
      },
    });
    const result = await backend.run(
      { type: 'left_click', coordinate: { x: 600, y: 400 } } as CuAction,
      new AbortController().signal,
    );
    assert.equal(result.outcome.ok, false);
    if (!result.outcome.ok) assert.equal(result.outcome.error, 'user_intervened');
    assert.equal(toolCalls(await readRecords(logPath), 'click').length, 0);
  });

  it('click uses same-snapshot pixels to focus an editable control', async () => {
    const { backend, logPath } = makeBackend();
    const res = await backend.run(
      { type: 'left_click', coordinate: { x: 600, y: 400 } } as CuAction,
      new AbortController().signal,
    );

    assert.equal(res.outcome.ok, true);
    const click = toolCall(await readRecords(logPath), 'click');
    assert.ok(click);
    assert.equal(click!.pid, 4242);
    assert.equal(click!.window_id, 77);
    assert.equal(click!.element_index, undefined);
    assert.equal(click!.element_token, undefined);
    assert.equal(click!.x, 400);
    assert.equal(click!.y, 200);
  });

  it('double_click uses the dedicated driver pixel path so evidence is never omitted', async () => {
    const { backend, logPath } = makeBackend();
    const res = await backend.run(
      { type: 'double_click', coordinate: { x: 600, y: 400 } } as CuAction,
      new AbortController().signal,
    );

    assert.equal(res.outcome.ok, true);
    const records = await readRecords(logPath);
    const call = toolCall(records, 'double_click');
    assert.ok(call);
    assert.equal(call!.pid, 4242);
    assert.equal(call!.window_id, 77);
    assert.equal(call!.element_index, undefined);
    assert.equal(call!.element_token, undefined);
    assert.equal(call!.x, 400);
    assert.equal(call!.y, 200);
    assert.equal(call!.count, undefined);
    assert.equal(toolCalls(records, 'click').length, 0);
    assert.deepEqual(res.outcome, {
      ok: true,
      tier: 'coordinate-background',
      verified: false,
      evidence: { path: 'cgevent', effect: 'unverifiable' },
    });
  });

  it('serializes same-window mutations across sessions', async () => {
    const { backend, logPath } = makeBackend({ snapshotDelayMs: 120 });
    const signal = new AbortController().signal;
    const first = backend.run(
      { type: 'left_click', coordinate: { x: 600, y: 400 } } as CuAction,
      signal,
      { sessionId: 's1', turnId: 't1', toolCallId: 'first' },
    );
    await delay(20);
    const second = backend.run(
      { type: 'left_click', coordinate: { x: 600, y: 400 } } as CuAction,
      signal,
      { sessionId: 's2', turnId: 't1', toolCallId: 'second' },
    );
    await Promise.all([first, second]);

    const trace = methodTrace(await readRecords(logPath));
    const snapshots = trace
      .map((method, index) => ({ method, index }))
      .filter(({ method }) => method === 'tools/call:get_window_state');
    const clicks = trace
      .map((method, index) => ({ method, index }))
      .filter(({ method }) => method === 'tools/call:click');
    assert.equal(snapshots.length, 2);
    assert.equal(clicks.length, 2);
    assert.ok(snapshots[0]!.index < clicks[0]!.index);
    assert.ok(clicks[0]!.index < snapshots[1]!.index, `trace=${trace.join(' -> ')}`);
  });

  it('returns the read-only cua-driver cursor position without pointer dispatch', async () => {
    const { backend, logPath } = makeBackend();
    const result = await backend.run(
      { type: 'cursor_position' },
      new AbortController().signal,
      DEFAULT_RUN_CONTEXT,
    );

    assert.deepEqual(result, {
      outcome: { ok: true, tier: 'coordinate-background' },
      resolvedScreenPoint: { x: 321, y: 654 },
    });
    const records = await readRecords(logPath);
    assert.equal(toolCalls(records, 'get_cursor_position').length, 1);
    assert.equal(toolCalls(records, 'click').length, 0);
  });

  it('click on empty desktop (no window) fails closed — never warps', async () => {
    const { backend, logPath } = makeBackend();
    const sig = new AbortController().signal;
    // Device (2000,2000) → screen (1000,1000): outside the mock window → no window.
    const res = await backend.run(
      { type: 'left_click', coordinate: { x: 2000, y: 2000 } } as CuAction,
      sig,
    );
    assert.equal(res.outcome.ok, false);
    if (res.outcome.ok === false) assert.equal(res.outcome.error, 'unsupported_action');
    const trace = methodTrace(await readRecords(logPath));
    assert.ok(!trace.includes('tools/call:click'), 'no click sent when no window (would warp)');
  });

  it('after a desktop screenshot, window input uses the fresh window snapshot pixel space', async () => {
    const { backend, logPath } = makeBackend();
    const sig = new AbortController().signal;
    // A screenshot sets lastFrameWidthPx=1440; get_screen_size.width=1512. So the
    // PRIMARY scale is 1440/1512 (≈0.952), NOT scale_factor=2. This is the path that
    // matters in the real app (scale_factor was observed lying as 1 on a Retina display
    // → clicks flew off-screen); every OTHER coordinate test exercises only the
    // pre-screenshot scale_factor fallback, so this locks the production path.
    await backend.run({ type: 'screenshot' } as CuAction, sig);
    const res = await backend.run(
      { type: 'left_click', coordinate: { x: 600, y: 400 } } as CuAction,
      sig,
    );
    assert.equal(res.outcome.ok, true);

    const click = toolCall(await readRecords(logPath), 'click');
    assert.ok(click);
    assert.equal(click!.pid, 4242);
    assert.equal(click!.window_id, 77, 'device (600,400) ÷ 0.952 = screen (630,420) ∈ win 77');
    // Declared (600,400) → logical screen (630,420) using the desktop frame
    // width. Window 77 bounds=(100,100,600,400); its fresh snapshot is 1200x800.
    assert.equal(click!.x, 1060);
    assert.equal(click!.y, 640);
  });

  it('resolveWindowAt picks the highest z-order eligible window; excludes layer!=0 and off-screen', async () => {
    const { backend, logPath } = makeBackend();
    const sig = new AbortController().signal;
    // scale_factor=2 (no screenshot). Device (2000,400) → screen (1000,200), covered by
    // win 91 (z2), 92 (z9), 93 (layer 3), 94 (off-screen). Eligible = {91,92}; highest
    // z_index wins → 92. 93/94 are excluded despite covering the point and outranking on z.
    const res = await backend.run(
      { type: 'left_click', coordinate: { x: 2000, y: 400 } } as CuAction,
      sig,
    );
    assert.equal(res.outcome.ok, true);

    const click = toolCall(await readRecords(logPath), 'click');
    assert.ok(click);
    assert.equal(click!.window_id, 92, 'highest-z eligible window wins the tiebreak (not 91)');
    assert.equal(
      click!.pid,
      5002,
      'winner is 92, and the excluded 93 (layer!=0) / 94 (off-screen) were NOT chosen',
    );
    // Logical target (1000,200) inside win 92 bounds=(950,150,300,200),
    // mapped into the fresh 1200x800 window screenshot.
    assert.equal(click!.x, 200);
    assert.equal(click!.y, 200);
  });

  it('scroll on an app window → pid+window_id (no warp); empty desktop fails closed', async () => {
    const { backend, logPath } = makeBackend();
    const sig = new AbortController().signal;
    // On a window: device (600,400) → screen (300,200) is inside the mock window.
    const onWin = await backend.run(
      {
        type: 'scroll',
        coordinate: { x: 600, y: 400 },
        scrollDirection: 'down',
        scrollAmount: 3,
      } as CuAction,
      sig,
    );
    assert.equal(onWin.outcome.ok, true);
    const scroll = toolCall(await readRecords(logPath), 'scroll');
    assert.ok(scroll, 'scroll sent when a window is under the point');
    assert.equal(scroll!.pid, 4242);
    assert.equal(scroll!.window_id, 77);
    assert.equal(scroll!.scope, undefined, 'must NOT use scope:desktop');
    assert.equal(scroll!.direction, 'down');
    assert.equal(scroll!.amount, 3);
    assert.equal(scroll!.delivery_mode, undefined, 'must NOT force foreground on scroll');

    // Empty desktop → fail closed (device (5,5) → screen (2.5,2.5), outside window).
    const empty = await backend.run(
      {
        type: 'scroll',
        coordinate: { x: 5, y: 5 },
        scrollDirection: 'down',
        scrollAmount: 3,
      } as CuAction,
      sig,
    );
    assert.equal(empty.outcome.ok, false);
  });

  it('left_click_drag within one window → drag via pid+window_id (no warp), window-local coords', async () => {
    const { backend, logPath } = makeBackend();
    const sig = new AbortController().signal;
    // scale=2. start device (600,400) → screen (300,200) ∈ win 77;
    //           end  device (800,600) → screen (400,300) ∈ win 77. Same window.
    const res = await backend.run(
      {
        type: 'left_click_drag',
        startCoordinate: { x: 600, y: 400 },
        coordinate: { x: 800, y: 600 },
      } as CuAction,
      sig,
    );
    assert.deepEqual(res.resolvedScreenPoint, { x: 400, y: 300 });
    assert.equal(res.outcome.ok, true, 'same-window drag succeeds');
    const drag = toolCall(await readRecords(logPath), 'drag');
    assert.ok(drag, 'drag sent to cua-driver');
    assert.equal(drag!.pid, 4242);
    assert.equal(drag!.window_id, 77);
    // window-local device px = model device − window origin(100) * scale(2) = 200.
    assert.equal(drag!.from_x, 400); // 600-200
    assert.equal(drag!.from_y, 200); // 400-200
    assert.equal(drag!.to_x, 600); // 800-200
    assert.equal(drag!.to_y, 400); // 600-200
    assert.equal(drag!.scope, undefined, 'must NOT use scope:desktop (the warping path)');
    assert.equal(
      drag!.delivery_mode,
      undefined,
      'must NOT force foreground; default Background is no-warp + no z-order disturbance',
    );
  });

  it('refuses scroll and drag while physical user input is active', async () => {
    const { backend, logPath } = makeBackend({
      physicalInputRecentlyActive: () => true,
    });
    const signal = new AbortController().signal;
    const scroll = await backend.run(
      {
        type: 'scroll',
        coordinate: { x: 600, y: 400 },
        scrollDirection: 'down',
        scrollAmount: 3,
      } as CuAction,
      signal,
    );
    assert.equal(scroll.outcome.ok, false);
    if (!scroll.outcome.ok) assert.equal(scroll.outcome.error, 'user_intervened');
    const drag = await backend.run(
      {
        type: 'left_click_drag',
        startCoordinate: { x: 600, y: 400 },
        coordinate: { x: 800, y: 600 },
      } as CuAction,
      signal,
    );
    assert.equal(drag.outcome.ok, false);
    if (!drag.outcome.ok) assert.equal(drag.outcome.error, 'user_intervened');
    const records = await readRecords(logPath);
    assert.equal(toolCalls(records, 'scroll').length, 0);
    assert.equal(toolCalls(records, 'drag').length, 0);
  });

  it('left_click_drag with an endpoint on empty desktop fails closed — never posts a drag', async () => {
    const { backend, logPath } = makeBackend();
    const sig = new AbortController().signal;
    // start device (5,5) → screen (2.5,2.5): outside every window ⇒ no pid to post to.
    const res = await backend.run(
      {
        type: 'left_click_drag',
        startCoordinate: { x: 5, y: 5 },
        coordinate: { x: 600, y: 400 },
      } as CuAction,
      sig,
    );
    assert.equal(res.outcome.ok, false);
    if (res.outcome.ok === false) assert.equal(res.outcome.error, 'unsupported_action');
    const trace = methodTrace(await readRecords(logPath));
    assert.ok(!trace.includes('tools/call:drag'), 'no drag sent when an endpoint has no window');
  });

  it('left_click_drag across two different windows fails closed — no cross-window drag', async () => {
    const { backend, logPath } = makeBackend();
    const sig = new AbortController().signal;
    // start device (600,400) → screen (300,200) ∈ win 77;
    //  end  device (400,1400) → screen (200,700) ∈ win 88. Different windows.
    const res = await backend.run(
      {
        type: 'left_click_drag',
        startCoordinate: { x: 600, y: 400 },
        coordinate: { x: 400, y: 1400 },
      } as CuAction,
      sig,
    );
    assert.equal(res.outcome.ok, false);
    if (res.outcome.ok === false) assert.equal(res.outcome.error, 'unsupported_action');
    const trace = methodTrace(await readRecords(logPath));
    assert.ok(!trace.includes('tools/call:drag'), 'no drag sent when endpoints span windows');
  });

  it('zoom within one window → window-local crop and JPEG screenshot result', async () => {
    const { backend, logPath } = makeBackend();
    const sig = new AbortController().signal;
    const res = await backend.run(
      { type: 'zoom', region: { x1: 600, y1: 400, x2: 800, y2: 600 } } as CuAction,
      sig,
    );

    assert.deepEqual(res.outcome, {
      ok: true,
      tier: 'coordinate-background',
      verified: false,
      evidence: { path: 'screenshot-detail', effect: 'unverifiable' },
    });
    assert.equal(res.screenshot?.mimeType, 'image/png');
    assert.equal(res.screenshot?.widthPx, 1200);
    assert.equal(res.screenshot?.heightPx, 800);
    assert.ok(res.observation?.observationId);
    const zoom = toolCall(await readRecords(logPath), 'zoom');
    assert.ok(zoom);
    assert.equal(zoom!.pid, 4242);
    assert.equal(zoom!.window_id, 77);
    assert.equal(zoom!.x1, 400);
    assert.equal(zoom!.y1, 200);
    assert.equal(zoom!.x2, 600);
    assert.equal(zoom!.y2, 400);
  });

  it('bound zoom captures an occluded background window without z-order rejection', async () => {
    const { backend, logPath } = makeBackend({ semanticOccluded: true });
    const res = await backend.run(
      { type: 'zoom', region: { x1: 400, y1: 200, x2: 800, y2: 600 } } as CuAction,
      new AbortController().signal,
      {
        ...DEFAULT_RUN_CONTEXT,
        boundAction: boundCoordinateAction({
          startCoordinate: { x: 400, y: 200 },
          coordinate: { x: 800, y: 600 },
        }),
      },
    );

    assert.equal(res.outcome.ok, true);
    const zoom = toolCall(await readRecords(logPath), 'zoom');
    assert.equal(zoom?.pid, 4242);
    assert.equal(zoom?.window_id, 77);
  });

  it('zoom spanning windows fails closed and never calls cua-driver zoom', async () => {
    const { backend, logPath } = makeBackend();
    const res = await backend.run(
      { type: 'zoom', region: { x1: 600, y1: 400, x2: 400, y2: 1400 } } as CuAction,
      new AbortController().signal,
    );

    assert.equal(res.outcome.ok, false);
    if (!res.outcome.ok) assert.equal(res.outcome.error, 'unsupported_action');
    assert.ok(!methodTrace(await readRecords(logPath)).includes('tools/call:zoom'));
  });

  it('mouse_move validates its bound window without injecting real input', async () => {
    const { backend, logPath } = makeBackend();
    const res = await backend.run(
      { type: 'mouse_move', coordinate: { x: 400, y: 200 } } as CuAction,
      new AbortController().signal,
      {
        ...DEFAULT_RUN_CONTEXT,
        boundAction: boundCoordinateAction(),
      },
    );
    assert.equal(res.outcome.ok, true);
    assert.deepEqual(res.resolvedScreenPoint, { x: 300, y: 200 });
    const trace = methodTrace(await readRecords(logPath));
    assert.ok(
      !trace.some((m) => m.startsWith('tools/call:click') || m.startsWith('tools/call:move')),
      'mouse_move must not inject real input',
    );
  });

  it('keyboard with NO prior click fails closed — never guesses a target, never injects', async () => {
    const { backend, logPath } = makeBackend();
    const sig = new AbortController().signal;

    const typeRes = await backend.run({ type: 'type', text: 'hello' } as CuAction, sig);
    assert.equal(typeRes.outcome.ok, false);
    if (typeRes.outcome.ok === false) assert.equal(typeRes.outcome.error, 'unsupported_action');

    const keyRes = await backend.run({ type: 'key', text: 'Return' } as CuAction, sig);
    assert.equal(keyRes.outcome.ok, false);
    if (keyRes.outcome.ok === false) assert.equal(keyRes.outcome.error, 'unsupported_action');

    // The non-negotiable invariant: with no agent-established target, the backend
    // must NEVER resolve a frontmost pid (list_apps) or emit any keystroke. It is
    // the ONLY safe answer — guessing frontmost = typing into the user's window.
    const trace = methodTrace(await readRecords(logPath));
    assert.ok(
      !trace.includes('tools/call:list_apps'),
      'list_apps must not be queried (no frontmost routing)',
    );
    assert.ok(
      !trace.includes('tools/call:type_text'),
      'type_text must never be sent without a target',
    );
    assert.ok(
      !trace.includes('tools/call:press_key'),
      'press_key must never be sent without a target',
    );
  });

  it('keyboard target is isolated by session and turn', async () => {
    const { backend, logPath } = makeBackend();
    const sig = new AbortController().signal;
    await backend.run({ type: 'left_click', coordinate: { x: 600, y: 400 } } as CuAction, sig, {
      sessionId: 'session-a',
      turnId: 'turn-1',
      toolCallId: 'click-a',
    });

    const otherSession = await backend.run(
      { type: 'type', text: 'must-not-land' } as CuAction,
      sig,
      { sessionId: 'session-b', turnId: 'turn-1', toolCallId: 'type-b' },
    );
    assert.equal(otherSession.outcome.ok, false);
    const otherTurn = await backend.run({ type: 'type', text: 'must-not-land' } as CuAction, sig, {
      sessionId: 'session-a',
      turnId: 'turn-2',
      toolCallId: 'type-a2',
    });
    assert.equal(otherTurn.outcome.ok, false);

    const trace = methodTrace(await readRecords(logPath));
    assert.ok(!trace.includes('tools/call:type_text'));
  });

  it('clearSession removes keyboard ownership immediately', async () => {
    const { backend, logPath } = makeBackend();
    const signal = new AbortController().signal;
    const context = { sessionId: 'session-a', turnId: 'turn-1', toolCallId: 'click' };
    await backend.run(
      { type: 'left_click', coordinate: { x: 600, y: 400 } } as CuAction,
      signal,
      context,
    );
    backend.clearSession('session-a');
    const typed = await backend.run({ type: 'type', text: 'must-not-land' } as CuAction, signal, {
      ...context,
      toolCallId: 'type',
    });

    assert.equal(typed.outcome.ok, false);
    assert.ok(!methodTrace(await readRecords(logPath)).includes('tools/call:type_text'));
  });

  it('failed click does not establish a keyboard target', async () => {
    const { backend, logPath } = makeBackend();
    const sig = new AbortController().signal;
    const context = { sessionId: 'session-a', turnId: 'turn-1', toolCallId: 'click-fail' };
    const click = await backend.run(
      { type: 'left_click', coordinate: { x: 5, y: 5 } } as CuAction,
      sig,
      context,
    );
    assert.equal(click.outcome.ok, false);
    const typed = await backend.run({ type: 'type', text: 'must-not-land' } as CuAction, sig, {
      ...context,
      toolCallId: 'type-after-fail',
    });
    assert.equal(typed.outcome.ok, false);
    assert.ok(!methodTrace(await readRecords(logPath)).includes('tools/call:type_text'));
  });

  it('a failed left-click attempt revokes an existing keyboard target', async () => {
    const { backend, logPath } = makeBackend();
    const sig = new AbortController().signal;
    const context = { sessionId: 'session-a', turnId: 'turn-1', toolCallId: 'click-ok' };
    const first = await backend.run(
      { type: 'left_click', coordinate: { x: 600, y: 400 } } as CuAction,
      sig,
      context,
    );
    assert.equal(first.outcome.ok, true);

    const failed = await backend.run(
      { type: 'left_click', coordinate: { x: 5, y: 5 } } as CuAction,
      sig,
      { ...context, toolCallId: 'click-fail' },
    );
    assert.equal(failed.outcome.ok, false);

    const typed = await backend.run({ type: 'type', text: 'must-not-land' } as CuAction, sig, {
      ...context,
      toolCallId: 'type-after-fail',
    });
    assert.equal(typed.outcome.ok, false);
    assert.equal(toolCalls(await readRecords(logPath), 'type_text').length, 0);
  });

  it('scroll and drag do not establish a keyboard target', async () => {
    const { backend, logPath } = makeBackend();
    const sig = new AbortController().signal;
    const context = { sessionId: 'session-a', turnId: 'turn-1', toolCallId: 'pointer' };
    await backend.run(
      {
        type: 'scroll',
        coordinate: { x: 600, y: 400 },
        scrollDirection: 'down',
        scrollAmount: 2,
      } as CuAction,
      sig,
      context,
    );
    const afterScroll = await backend.run(
      { type: 'type', text: 'must-not-land' } as CuAction,
      sig,
      { ...context, toolCallId: 'type-after-scroll' },
    );
    assert.equal(afterScroll.outcome.ok, false);

    await backend.run(
      {
        type: 'left_click_drag',
        startCoordinate: { x: 600, y: 400 },
        coordinate: { x: 800, y: 600 },
      } as CuAction,
      sig,
      { ...context, toolCallId: 'drag' },
    );
    const afterDrag = await backend.run({ type: 'type', text: 'must-not-land' } as CuAction, sig, {
      ...context,
      toolCallId: 'type-after-drag',
    });
    assert.equal(afterDrag.outcome.ok, false);
    assert.ok(!methodTrace(await readRecords(logPath)).includes('tools/call:type_text'));
  });

  it('type after an editable native click uses AXValue and verifies a fresh snapshot', async () => {
    const { backend, logPath } = makeBackend();
    const sig = new AbortController().signal;
    // Establish the target: click win 77 (device 600,400 → screen 300,200 ∈ win 77).
    const click = await backend.run(
      { type: 'left_click', coordinate: { x: 600, y: 400 } } as CuAction,
      sig,
    );
    assert.equal(click.outcome.ok, true);

    const typed = await backend.run({ type: 'type', text: 'hello world' } as CuAction, sig);
    assert.equal(typed.outcome.ok, true, 'type succeeds once a target is established');

    const records = await readRecords(logPath);
    const call = toolCall(records, 'set_value');
    assert.ok(call, 'set_value sent to the agent-clicked native field');
    assert.equal(call!.pid, 4242);
    assert.equal(call!.window_id, 77);
    assert.equal(call!.element_index, 7);
    assert.equal(call!.element_token, 'snapshot:7');
    assert.equal(call!.value, 'hello world');
    assert.equal(toolCalls(records, 'type_text').length, 0);
    assert.equal(toolCalls(records, 'press_key').length, 0);
    // Red line: the target came from the click, never from a frontmost lookup.
    assert.ok(
      !methodTrace(records).includes('tools/call:list_apps'),
      'must never resolve a frontmost pid to type into',
    );
  });

  it('parallel click then type waits for the new click target instead of using the old window', async () => {
    const { backend, logPath } = makeBackend({ delayTool: 'click', delayMs: 120 });
    const sig = new AbortController().signal;
    const context = { sessionId: 'session-a', turnId: 'turn-1', toolCallId: 'old-click' };
    await backend.run(
      { type: 'left_click', coordinate: { x: 600, y: 400 } } as CuAction,
      sig,
      context,
    );

    const clickNew = backend.run(
      { type: 'left_click', coordinate: { x: 400, y: 1400 } } as CuAction,
      sig,
      { ...context, toolCallId: 'new-click' },
    );
    await waitForRecord(
      logPath,
      (record) =>
        record.kind === 'recv' &&
        record.params?.name === 'click' &&
        record.params?.arguments?.window_id === 88,
    );
    const typeNew = backend.run({ type: 'type', text: 'new-window' } as CuAction, sig, {
      ...context,
      toolCallId: 'type-new',
    });
    const [clicked, typed] = await Promise.all([clickNew, typeNew]);
    assert.equal(clicked.outcome.ok, true);
    assert.equal(typed.outcome.ok, true);

    const setCalls = toolCalls(await readRecords(logPath), 'set_value');
    assert.equal(setCalls.length, 1);
    assert.equal(setCalls[0]!.window_id, 88);
  });

  it('type with no AX-addressable editable field fails before any keyboard dispatch', async () => {
    const { backend, logPath } = makeBackend({ emptyAx: true });
    const sig = new AbortController().signal;
    await backend.run({ type: 'left_click', coordinate: { x: 600, y: 400 } } as CuAction, sig);

    const typed = await backend.run({ type: 'type', text: 'pixel fallback' } as CuAction, sig);
    assert.equal(typed.outcome.ok, false);
    if (!typed.outcome.ok) {
      assert.equal(typed.outcome.error, 'unsupported_action');
    }
    const records = await readRecords(logPath);
    assert.equal(toolCalls(records, 'type_text').length, 0);
    assert.equal(toolCalls(records, 'set_value').length, 0);
    assert.equal(toolCalls(records, 'press_key').length, 0);
  });

  it('key chords fail closed before any key event is posted', async () => {
    const { backend, logPath } = makeBackend();
    const sig = new AbortController().signal;
    await backend.run({ type: 'left_click', coordinate: { x: 600, y: 400 } } as CuAction, sig);

    const res = await backend.run({ type: 'key', text: 'cmd+a' } as CuAction, sig);
    assert.equal(res.outcome.ok, false);
    if (!res.outcome.ok) {
      assert.equal(res.outcome.error, 'unsupported_action');
    }
    assert.equal(toolCalls(await readRecords(logPath), 'press_key').length, 0);
  });

  it('plain named keys also fail before driver dispatch', async () => {
    const { backend, logPath } = makeBackend();
    const sig = new AbortController().signal;
    await backend.run({ type: 'left_click', coordinate: { x: 600, y: 400 } } as CuAction, sig);

    const res = await backend.run({ type: 'key', text: 'Return' } as CuAction, sig);
    assert.equal(res.outcome.ok, false);
    if (!res.outcome.ok) assert.equal(res.outcome.error, 'unsupported_action');
    assert.equal(toolCalls(await readRecords(logPath), 'press_key').length, 0);
  });

  it('Electron targets refuse type before AXValue or key-event dispatch', async () => {
    const { backend, logPath } = makeBackend({ processKind: 'electron' });
    const sig = new AbortController().signal;
    await backend.run({ type: 'left_click', coordinate: { x: 600, y: 400 } } as CuAction, sig);

    const typed = await backend.run({ type: 'type', text: 'must-not-land' } as CuAction, sig);
    assert.equal(typed.outcome.ok, false);
    if (!typed.outcome.ok) assert.equal(typed.outcome.error, 'unsupported_action');
    const records = await readRecords(logPath);
    assert.equal(toolCalls(records, 'set_value').length, 0);
    assert.equal(toolCalls(records, 'type_text').length, 0);
    assert.equal(toolCalls(records, 'press_key').length, 0);
  });

  it('Electron text uses a uniquely resolved cua-driver page target and DOM readback', async () => {
    const pageTarget = testPageTarget();
    const { backend, logPath } = makeBackend({
      processKind: 'electron',
      pageTarget,
      emptyAx: true,
      semanticPointerResult: {
        supported: true,
        ok: true,
        kind: 'left_click',
        editable: true,
        tagName: 'textarea',
        clickEvents: 1,
      },
    });
    const sig = new AbortController().signal;
    await backend.run({ type: 'left_click', coordinate: { x: 600, y: 400 } } as CuAction, sig);

    const typed = await backend.run({ type: 'type', text: 'semantic text' } as CuAction, sig);
    assert.deepEqual(typed.outcome, {
      ok: true,
      tier: 'semantic-background',
      verified: true,
      evidence: { path: 'cdp', effect: 'confirmed' },
    });
    const records = await readRecords(logPath);
    const page = toolCall(records, 'page');
    const pageCalls = businessPageCalls(records);
    assert.equal(pageCalls.length, 4);
    assert.equal(pageCalls[0]!.action, 'execute_javascript');
    assert.match(String(pageCalls[0]!.javascript), /elementFromPoint/);
    assert.ok(page);
    assert.deepEqual(page, {
      pid: 4242,
      window_id: 77,
      action: 'execute_javascript',
      javascript: page.javascript,
      cdp_port: 9333,
      target_url_contains: 'data:text/html,window-a',
    });
    assert.deepEqual(pageCalls[2], {
      pid: 4242,
      window_id: 77,
      action: 'insert_text',
      text: 'semantic text',
      cdp_port: 9333,
      target_url_contains: 'data:text/html,window-a',
    });
    assert.equal(pageCalls[3]!.action, 'execute_javascript');
    assert.match(String(pageCalls[3]!.javascript), /__makaComputerUseReadElement/);
    assert.equal(toolCalls(records, 'type_text').length, 0);
    assert.equal(toolCalls(records, 'press_key').length, 0);
  });

  it('Electron semantic pointer actions use page and skip pixel dispatch', async () => {
    const pageTarget = testPageTarget();
    const click = makeBackend({
      processKind: 'electron',
      pageTarget,
      semanticPointerResult: {
        supported: true,
        ok: true,
        kind: 'left_click',
        editable: false,
        tagName: 'button',
        clickEvents: 1,
      },
    });
    const result = await click.backend.run(
      { type: 'left_click', coordinate: { x: 600, y: 400 } } as CuAction,
      new AbortController().signal,
    );
    assert.deepEqual(result.outcome, {
      ok: true,
      tier: 'semantic-background',
      verified: true,
      evidence: { path: 'cdp', effect: 'confirmed' },
    });
    assert.deepEqual(result.resolvedScreenPoint, { x: 300, y: 200 });
    const records = await readRecords(click.logPath);
    const pageCall = toolCall(records, 'page');
    assert.deepEqual(pageCall, {
      pid: 4242,
      window_id: 77,
      action: 'execute_javascript',
      javascript: pageCall?.javascript,
      cdp_port: 9333,
      target_url_contains: 'data:text/html,window-a',
    });
    assert.equal(toolCalls(records, 'click').length, 0);

    const drag = makeBackend({
      processKind: 'electron',
      pageTarget,
      semanticPointerResult: {
        supported: true,
        ok: true,
        kind: 'range_drag',
        tagName: 'input',
        inputEvents: 1,
        changeEvents: 1,
        value: '80',
      },
    });
    const dragResult = await drag.backend.run(
      {
        type: 'left_click_drag',
        startCoordinate: { x: 600, y: 400 },
        coordinate: { x: 800, y: 600 },
      } as CuAction,
      new AbortController().signal,
    );
    assert.equal(dragResult.outcome.ok, true);
    const dragRecords = await readRecords(drag.logPath);
    assert.equal(businessPageCalls(dragRecords).length, 1);
    assert.equal(toolCalls(dragRecords, 'drag').length, 0);
  });

  it('Electron semantic non-text inputs never establish usable text ownership', async () => {
    const pageTarget = testPageTarget();
    const { backend, logPath } = makeBackend({
      processKind: 'electron',
      pageTarget,
      semanticPointerResult: {
        supported: true,
        ok: true,
        kind: 'left_click',
        effect: 'checked',
        editable: false,
        tagName: 'input',
        inputType: 'checkbox',
        checked: true,
      },
    });
    const sig = new AbortController().signal;
    await backend.run({ type: 'left_click', coordinate: { x: 600, y: 400 } } as CuAction, sig);
    const typed = await backend.run({ type: 'type', text: 'on' } as CuAction, sig);

    assert.equal(typed.outcome.ok, false);
    if (!typed.outcome.ok) assert.equal(typed.outcome.error, 'unsupported_action');
    const records = await readRecords(logPath);
    assert.equal(toolCalls(records, 'insert_text').length, 0);
  });

  it('semantic pointer unsupported falls back to pixel; semantic failure does not double-dispatch', async () => {
    const pageTarget = testPageTarget();
    const unsupported = makeBackend({
      processKind: 'electron',
      pageTarget,
      semanticPointerResult: {
        supported: false,
        ok: false,
        reason: 'unsupported_action',
      },
    });
    const fallback = await unsupported.backend.run(
      { type: 'left_click', coordinate: { x: 600, y: 400 } } as CuAction,
      new AbortController().signal,
    );
    assert.equal(fallback.outcome.ok, true);
    const fallbackRecords = await readRecords(unsupported.logPath);
    assert.equal(businessPageCalls(fallbackRecords).length, 1);
    assert.equal(toolCalls(fallbackRecords, 'click').length, 1);

    const failed = makeBackend({
      processKind: 'electron',
      pageTarget,
      semanticPointerResult: {
        supported: true,
        ok: false,
        kind: 'left_click',
        clickEvents: 0,
      },
    });
    const failure = await failed.backend.run(
      { type: 'left_click', coordinate: { x: 600, y: 400 } } as CuAction,
      new AbortController().signal,
    );
    assert.equal(failure.outcome.ok, false);
    const failedRecords = await readRecords(failed.logPath);
    assert.equal(businessPageCalls(failedRecords).length, 1);
    assert.equal(toolCalls(failedRecords, 'click').length, 0);
  });

  it('Electron page text refuses non-empty fields and mismatched readback', async () => {
    const nonEmptyTarget = testPageTarget();
    const nonEmpty = makeBackend({
      processKind: 'electron',
      pageTarget: nonEmptyTarget,
      pageFieldValue: 'user text',
      emptyAx: true,
      semanticPointerResult: {
        supported: true,
        ok: true,
        kind: 'left_click',
        editable: true,
        tagName: 'textarea',
        clickEvents: 1,
      },
    });
    const sig = new AbortController().signal;
    await nonEmpty.backend.run(
      { type: 'left_click', coordinate: { x: 600, y: 400 } } as CuAction,
      sig,
    );
    const refused = await nonEmpty.backend.run(
      { type: 'type', text: 'overwrite' } as CuAction,
      sig,
    );
    assert.equal(refused.outcome.ok, false);
    const nonEmptyPageCalls = businessPageCalls(await readRecords(nonEmpty.logPath));
    assert.deepEqual(
      nonEmptyPageCalls.map((call) => call.action),
      ['execute_javascript', 'execute_javascript'],
    );

    const mismatchTarget = testPageTarget();
    const mismatch = makeBackend({
      processKind: 'electron',
      pageTarget: mismatchTarget,
      pageReadbackValue: 'wrong',
      emptyAx: true,
      semanticPointerResult: {
        supported: true,
        ok: true,
        kind: 'left_click',
        editable: true,
        tagName: 'textarea',
        clickEvents: 1,
      },
    });
    await mismatch.backend.run(
      { type: 'left_click', coordinate: { x: 600, y: 400 } } as CuAction,
      sig,
    );
    const failed = await mismatch.backend.run({ type: 'type', text: 'missing' } as CuAction, sig);
    assert.equal(failed.outcome.ok, false);
    if (!failed.outcome.ok) {
      assert.equal(failed.outcome.error, 'outcome_unknown');
      assert.equal(failed.outcome.evidence?.path, 'cdp');
    }
    const mismatchPageCalls = businessPageCalls(await readRecords(mismatch.logPath));
    assert.deepEqual(
      mismatchPageCalls.map((call) => call.action),
      ['execute_javascript', 'execute_javascript', 'insert_text', 'execute_javascript'],
    );
  });

  it('native AX text readback mismatch preserves outcome_unknown', async () => {
    const { backend, logPath } = makeBackend({
      nativeReadbackValue: 'wrong',
    });
    const signal = new AbortController().signal;
    const click = await backend.run(
      { type: 'left_click', coordinate: { x: 600, y: 400 } } as CuAction,
      signal,
    );
    assert.equal(click.outcome.ok, true);

    const result = await backend.run({ type: 'type', text: 'expected' } as CuAction, signal);

    assert.equal(result.outcome.ok, false);
    if (!result.outcome.ok) {
      assert.equal(result.outcome.error, 'outcome_unknown');
      assert.equal(result.outcome.evidence?.path, 'ax');
    }
    assert.equal(toolCalls(await readRecords(logPath), 'set_value').length, 1);
  });

  it('native AX text readback request failure preserves outcome_unknown', async () => {
    const { backend, logPath } = makeBackend({
      rpcErrAfterTool: 'get_window_state',
      rpcErrAfterCount: 3,
    });
    const signal = new AbortController().signal;
    const click = await backend.run(
      { type: 'left_click', coordinate: { x: 600, y: 400 } } as CuAction,
      signal,
    );
    assert.equal(click.outcome.ok, true);

    const result = await backend.run({ type: 'type', text: 'expected' } as CuAction, signal);

    assert.equal(result.outcome.ok, false);
    if (!result.outcome.ok) {
      assert.equal(result.outcome.error, 'outcome_unknown');
      assert.equal(result.outcome.evidence?.path, 'ax');
    }
    assert.equal(toolCalls(await readRecords(logPath), 'set_value').length, 1);
  });

  it('malformed native AX readback preserves outcome_unknown after delivery', async () => {
    const { backend, logPath } = makeBackend({
      malformedAxAfter: 3,
    });
    const signal = new AbortController().signal;
    const click = await backend.run(
      { type: 'left_click', coordinate: { x: 600, y: 400 } } as CuAction,
      signal,
    );
    assert.equal(click.outcome.ok, true);

    const result = await backend.run({ type: 'type', text: 'expected' } as CuAction, signal);

    assert.equal(result.outcome.ok, false);
    if (!result.outcome.ok) {
      assert.equal(result.outcome.error, 'outcome_unknown');
      assert.equal(result.outcome.evidence?.path, 'ax');
    }
    assert.equal(toolCalls(await readRecords(logPath), 'set_value').length, 1);
  });

  it('CDP text inspection request failure preserves outcome_unknown', async () => {
    const { backend, logPath } = makeBackend({
      processKind: 'electron',
      pageTarget: testPageTarget(),
      emptyAx: true,
      semanticPointerResult: {
        supported: true,
        ok: true,
        kind: 'left_click',
        editable: true,
        tagName: 'textarea',
        clickEvents: 1,
      },
      rpcErrAfterTool: 'page',
      rpcErrAfterCount: 5,
    });
    const signal = new AbortController().signal;
    const click = await backend.run(
      { type: 'left_click', coordinate: { x: 600, y: 400 } } as CuAction,
      signal,
    );
    assert.equal(click.outcome.ok, true);

    const result = await backend.run({ type: 'type', text: 'expected' } as CuAction, signal);

    assert.equal(result.outcome.ok, false);
    if (!result.outcome.ok) {
      assert.equal(result.outcome.error, 'outcome_unknown');
      assert.equal(result.outcome.evidence?.path, 'cdp');
    }
    assert.equal(
      businessPageCalls(await readRecords(logPath)).filter((call) => call.action === 'insert_text')
        .length,
      1,
    );
  });

  it('semantic dispatch followed by oversized fresh capture returns outcome_unknown', async () => {
    let compressions = 0;
    const { backend, logPath } = makeBackend({
      axRole: 'AXButton',
      bigImage: true,
      compressFrame: (base64, mimeType) => {
        compressions += 1;
        return compressions === 1
          ? { base64: 'anVzdGpwZWc=', mimeType: 'image/jpeg' }
          : {
              base64: 'A'.repeat(12_000_000),
              mimeType: mimeType as 'image/png' | 'image/jpeg',
            };
      },
    });
    const signal = new AbortController().signal;
    const context = {
      sessionId: 'capture-after-dispatch',
      turnId: 'turn-1',
      toolCallId: 'observe',
    };
    const observed = await backend.observeApp!(
      {
        app: 'Fixture Window',
        includeScreenshot: true,
      },
      signal,
      context,
    );

    const result = await backend.runSemantic!(
      {
        type: 'click_element',
        observationId: observed.observationId,
        elementId: '7',
        elementIdentity: observed.elements[0]!.identity,
      },
      signal,
      {
        ...context,
        toolCallId: 'click',
        boundAction: boundElementAction(observed, '7'),
      },
    );

    assert.equal(result.outcome.ok, false);
    if (!result.outcome.ok) {
      assert.equal(result.outcome.error, 'outcome_unknown');
      assert.match(result.outcome.message, /delivered/);
    }
    assert.equal(toolCalls(await readRecords(logPath), 'click').length, 1);
  });

  it('semantic dispatch followed by fresh observation request failure returns outcome_unknown', async () => {
    const { backend, logPath } = makeBackend({
      axRole: 'AXButton',
      rpcErrAfterTool: 'get_window_state',
      rpcErrAfterCount: 3,
    });
    const signal = new AbortController().signal;
    const context = {
      sessionId: 'verification-request-failure',
      turnId: 'turn-1',
      toolCallId: 'observe',
    };
    const observed = await backend.observeApp!(
      {
        app: 'Fixture Window',
        includeScreenshot: true,
      },
      signal,
      context,
    );

    const result = await backend.runSemantic!(
      {
        type: 'click_element',
        observationId: observed.observationId,
        elementId: '7',
        elementIdentity: observed.elements[0]!.identity,
      },
      signal,
      {
        ...context,
        toolCallId: 'click',
        boundAction: boundElementAction(observed, '7'),
      },
    );

    assert.equal(result.outcome.ok, false);
    if (!result.outcome.ok) {
      assert.equal(result.outcome.error, 'outcome_unknown');
      assert.equal(result.outcome.evidence?.path, 'ax');
    }
    assert.equal(toolCalls(await readRecords(logPath), 'click').length, 1);
  });

  it('failed screenshot normalization does not evict a usable observation', async () => {
    let compressions = 0;
    const { backend } = makeBackend({
      axRole: 'AXButton',
      bigImage: true,
      compressFrame: (base64, mimeType) => {
        compressions += 1;
        return compressions <= 16
          ? { base64: 'anVzdGpwZWc=', mimeType: 'image/jpeg' }
          : {
              base64: 'A'.repeat(12_000_000),
              mimeType: mimeType as 'image/png' | 'image/jpeg',
            };
      },
    });
    const signal = new AbortController().signal;
    const context = {
      sessionId: 'observation-cap',
      turnId: 'turn-1',
      toolCallId: 'observe',
    };
    const observations = [];
    for (let index = 0; index < 16; index += 1) {
      observations.push(
        await backend.observeApp!(
          {
            app: 'Fixture Window',
            includeScreenshot: true,
          },
          signal,
          { ...context, toolCallId: `observe-${index}` },
        ),
      );
    }
    await assert.rejects(
      backend.observeApp!(
        {
          app: 'Fixture Window',
          includeScreenshot: true,
        },
        signal,
        { ...context, toolCallId: 'failed-observe' },
      ),
    );

    const first = observations[0]!;
    const result = await backend.runSemantic!(
      {
        type: 'click_element',
        observationId: first.observationId,
        elementId: '7',
        elementIdentity: first.elements[0]!.identity,
      },
      signal,
      {
        ...context,
        toolCallId: 'oldest-click',
        boundAction: boundElementAction(first, '7'),
      },
    );
    assert.notEqual(result.outcome.ok ? undefined : result.outcome.error, 'stale_frame');
  });

  it('abort after delivery returns outcome_unknown and the next call uses a fresh child', async () => {
    const { backend, logPath } = makeBackend({ hangOnceTool: 'get_desktop_state' });
    const controller = new AbortController();
    const p = backend.run({ type: 'screenshot' } as CuAction, controller.signal);
    await waitForRecord(
      logPath,
      (record) => record.kind === 'blocked' && record.tool === 'get_desktop_state',
    );

    controller.abort();
    const aborted = await p;
    assert.equal(aborted.outcome.ok, false);
    if (!aborted.outcome.ok) {
      assert.equal(aborted.outcome.error, 'outcome_unknown');
      assert.match(aborted.outcome.message, /outcome_unknown/);
    }

    const retry = await backend.run(
      { type: 'screenshot' } as CuAction,
      new AbortController().signal,
    );
    assert.equal(retry.outcome.ok, true);
    const starts = (await readRecords(logPath)).filter((record) => record.kind === 'start');
    assert.equal(starts.length, 2);
    assert.notEqual(starts[0]!.pid, starts[1]!.pid);
    assert.equal(toolCalls(await readRecords(logPath), 'get_desktop_state').length, 2);
  });

  it('service release emits a privacy-safe session invalidation producer', async () => {
    const invalidations: Array<{
      sessionId: string;
      reason: string;
      outcomeUnknown: boolean;
    }> = [];
    const { backend, logPath } = makeBackend({
      hangOnceTool: 'get_desktop_state',
      onSessionInvalidated: (event) => invalidations.push(event),
    });
    const controller = new AbortController();
    const pending = backend.run({ type: 'screenshot' }, controller.signal, {
      sessionId: 'release-session',
      turnId: 'turn-1',
      toolCallId: 'capture',
    });
    await waitForRecord(
      logPath,
      (record) => record.kind === 'blocked' && record.tool === 'get_desktop_state',
    );
    controller.abort();
    await pending;
    assert.deepEqual(invalidations, [
      {
        sessionId: 'release-session',
        reason: 'request_aborted',
        outcomeUnknown: true,
      },
    ]);
  });

  it('clearSession generation loss invalidates every session with retained ownership', async () => {
    const invalidated: string[] = [];
    const { backend, logPath } = makeBackend({
      hangOnceTool: 'click',
      onSessionInvalidated: (event) => invalidated.push(event.sessionId),
    });
    const signal = new AbortController().signal;
    const sessionB = {
      sessionId: 'session-b',
      turnId: 'turn-1',
      toolCallId: 'observe-b',
    };
    const observedB = await backend.observeApp?.(
      {
        app: 'Fixture',
        windowId: 77,
        includeScreenshot: true,
      },
      signal,
      sessionB,
    );
    assert.ok(observedB);

    const controller = new AbortController();
    const pendingA = backend.run(
      { type: 'left_click', coordinate: { x: 600, y: 400 } },
      controller.signal,
      {
        sessionId: 'session-a',
        turnId: 'turn-1',
        toolCallId: 'click-a',
      },
    );
    await waitForRecord(logPath, (record) => record.kind === 'blocked' && record.tool === 'click');
    backend.clearSession('session-a');
    await pendingA;

    assert.deepEqual(invalidated.sort(), ['session-a', 'session-b']);
    const staleB = await backend.runSemantic?.(
      {
        type: 'click_element',
        observationId: observedB.observationId,
        elementId: '7',
      },
      signal,
      {
        ...sessionB,
        toolCallId: 'late-b',
      },
    );
    assert.equal(staleB?.outcome.ok, false);
  });

  it('clearSession without generation loss preserves another session observation and keyboard target', async () => {
    const invalidated: string[] = [];
    const { backend, logPath } = makeBackend({
      onSessionInvalidated: (event) => invalidated.push(event.sessionId),
    });
    const signal = new AbortController().signal;
    const sessionB = {
      sessionId: 'session-b',
      turnId: 'turn-1',
      toolCallId: 'observe-b',
    };
    const clickedB = await backend.run(
      { type: 'left_click', coordinate: { x: 600, y: 400 } },
      signal,
      { ...sessionB, toolCallId: 'click-b' },
    );
    assert.equal(clickedB.outcome.ok, true);
    const observedB = await backend.observeApp?.(
      {
        app: 'Fixture',
        windowId: 77,
        includeScreenshot: true,
      },
      signal,
      sessionB,
    );
    assert.ok(observedB);

    backend.clearSession('session-a');

    assert.deepEqual(invalidated, ['session-a']);
    assert.ok(!invalidated.includes('session-b'));
    const reusedObservationB = await backend.runSemantic?.(
      {
        type: 'click_element',
        observationId: observedB.observationId,
        elementId: '7',
        elementIdentity: observedB.elements[0]!.identity,
      },
      signal,
      {
        ...sessionB,
        toolCallId: 'reuse-observation-b',
        boundAction: boundElementAction(observedB, '7'),
      },
    );
    assert.equal(reusedObservationB?.outcome.ok, true);
    const typedB = await backend.run({ type: 'type', text: 'still-owned' }, signal, {
      ...sessionB,
      toolCallId: 'type-b',
    });
    assert.equal(typedB.outcome.ok, true);
    assert.equal(toolCalls(await readRecords(logPath), 'set_value').length, 1);
  });

  it('clearSession without generation loss does not invalidate another session mutation in flight', async () => {
    const invalidated: string[] = [];
    const { backend, logPath } = makeBackend({
      delayTool: 'click',
      delayMs: 100,
      onSessionInvalidated: (event) => invalidated.push(event.sessionId),
    });
    const signal = new AbortController().signal;
    const sessionB = {
      sessionId: 'session-b',
      turnId: 'turn-1',
      toolCallId: 'observe-b',
    };
    const observedB = await backend.observeApp?.(
      {
        app: 'Fixture',
        windowId: 77,
        includeScreenshot: true,
      },
      signal,
      sessionB,
    );
    assert.ok(observedB);
    const pendingB = backend.runSemantic!(
      {
        type: 'click_element',
        observationId: observedB.observationId,
        elementId: '7',
        elementIdentity: observedB.elements[0]!.identity,
      },
      signal,
      {
        ...sessionB,
        toolCallId: 'click-b',
        boundAction: boundElementAction(observedB, '7'),
      },
    );
    await waitForRecord(
      logPath,
      (record) =>
        record.kind === 'recv' && record.method === 'tools/call' && record.params?.name === 'click',
    );
    const generationsBeforeClear = backend.serviceState();

    backend.clearSession('session-a');

    const resultB = await pendingB;
    assert.equal(resultB.outcome.ok, true);
    assert.ok(!invalidated.includes('session-b'));
    assert.deepEqual(backend.serviceState(), generationsBeforeClear);
  });

  it('aborting a delivered action reports outcome_unknown without rejecting the queued session', async () => {
    const { backend, logPath } = makeBackend({ hangOnceTool: 'click' });
    const firstController = new AbortController();
    const first = backend.run(
      { type: 'left_click', coordinate: { x: 600, y: 400 } } as CuAction,
      firstController.signal,
      {
        sessionId: 'session-a',
        turnId: 'turn-1',
        toolCallId: 'first',
        boundAction: boundCoordinateAction(),
      },
    );
    await waitForRecord(logPath, (record) => record.kind === 'blocked' && record.tool === 'click');

    const second = backend.run(
      { type: 'left_click', coordinate: { x: 2000, y: 400 } } as CuAction,
      new AbortController().signal,
      {
        sessionId: 'session-b',
        turnId: 'turn-1',
        toolCallId: 'second',
        boundAction: boundCoordinateAction({
          pid: 5002,
          windowId: 92,
          bounds: { x: 950, y: 150, width: 300, height: 200 },
          sourceBoundsPx: { x: 0, y: 0, width: 1200, height: 800 },
          coordinate: { x: 200, y: 200 },
          zIndex: 9,
        }),
      },
    );
    firstController.abort();
    const firstResult = await first;
    assert.equal(firstResult.outcome.ok, false);
    if (!firstResult.outcome.ok) {
      assert.equal(firstResult.outcome.error, 'outcome_unknown');
      assert.match(firstResult.outcome.message, /outcome_unknown/);
    }
    const secondResult = await second;
    assert.equal(secondResult.outcome.ok, true);

    const records = await readRecords(logPath);
    assert.equal(
      records.filter((record) => record.kind === 'start').length,
      2,
      'the queued second session starts on a fresh child after the shared request aborts',
    );
    const clicks = toolCalls(records, 'click');
    assert.equal(clicks.length, 2);
    assert.equal(clicks.at(-1)?.pid, 5002);
    assert.equal(clicks.at(-1)?.window_id, 92);
  });

  it('dispose during lazy startup prevents a late child spawn and all future calls', async () => {
    const { backend, logPath } = makeBackend();
    const pending = backend.preflight(new AbortController().signal);
    await Promise.resolve();
    await Promise.resolve();
    backend.dispose();
    await assert.rejects(pending, /disposed/i);
    await assert.rejects(backend.preflight(new AbortController().signal), /disposed/i);
    await delay(50);
    assert.equal(
      (await readRecords(logPath)).filter((record) => record.kind === 'start').length,
      0,
    );
  });

  it('a hung handshake times out, kills the child, and fails closed (no deadlock)', async () => {
    // set_config never answers → the bounded handshake must time out instead of
    // wedging every future action forever (the deadlock the review confirmed).
    const { backend, logPath } = makeBackend({ hangTool: 'set_config', handshakeTimeoutMs: 250 });
    await assert.rejects(backend.preflight(new AbortController().signal), /timeout/i);

    const records = await readRecords(logPath);
    const start = records.find((r) => r.kind === 'start');
    assert.ok(start, 'mock started');
    const pid: number = start!.pid;
    let dead = false;
    for (let i = 0; i < 100 && !dead; i++) {
      try {
        process.kill(pid, 0);
        await delay(20);
      } catch {
        dead = true;
      }
    }
    assert.ok(dead, 'child killed after handshake timeout');
  });

  it('a set_config RPC error rejects startup (fail closed — no warn-and-continue)', async () => {
    // The old code swallowed this with console.warn and reported startup ok,
    // letting later scope:desktop actions run against an unconfigured scope.
    const { backend } = makeBackend({ rpcErrTool: 'set_config' });
    await assert.rejects(backend.preflight(new AbortController().signal), /set_config/i);
  });
});
