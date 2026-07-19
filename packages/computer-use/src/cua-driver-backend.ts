// PR-RUNTIME-CU — the cua-driver CuDispatchBackend (Tier-2 alternative to the
// public-API Swift helper). Spawns trycua/cua-driver (MIT, v0.7.1) in EMBEDDED
// mode and speaks its line-delimited JSON-RPC 2.0 over stdio.
//
// Why embedded + direct spawn: cua-driver's embedded mode inherits the host
// app's TCC grants via the macOS responsibility chain (no second Accessibility/
// Screen-Recording prompt) — but ONLY if we spawn it as a DIRECT child of the
// process that holds the grants (never via `open`/LaunchServices).
//
// Path 18 note: this module only marshals CuAction ↔ cua-driver JSON-RPC and
// neutralizes cua-driver's baggage (telemetry/updater/autostart/overlay off).
// The OS-independent Path 18 duties (per-action TCC re-check, typed errors,
// abort) stay in the @maka/runtime `computer` tool. cua-driver does NOT redact
// secrets — the runtime redacts every backend-supplied message upstream.
//
// KEYBOARD IS TARGET-BOUND, VERIFIED, AND NEVER FRONTMOST. A successful left
// click establishes ownership only for the same Maka session + turn. `type` is
// allowed for a native AX-addressable empty field, or for a uniquely targeted
// Electron page field through CDP Input.insertText. Both paths require fresh
// readback; unknown processes, non-empty fields, and every `key` action fail
// before key delivery. Scroll, drag, failed clicks, another session, and
// another turn never establish ownership.
import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import {
  type CuAction,
  type ComputerUseDisplayIdentity,
  type ComputerUseEffect,
  type ComputerUseErrorCode,
  type ComputerUsePageIdentity,
} from '@maka/core';
import type {
  CuAppSummary,
  CuDispatchBackend,
  CuObservation,
  CuObservedElement,
  CuRunContext,
  CuRunResult,
  CuScreenshot,
  CuSemanticAction,
  CuaBoundAction,
} from '@maka/runtime';
import { normalizeCuaDriverOutcome } from './cua-driver-result.js';
import {
  CuaDriverLifecycleError,
  cuaDriverLifecycleMessage,
  isCuaDriverLifecycleError,
  type CuaDriverReleaseEvent,
  type CuaDriverRoleSnapshot,
} from './cua-driver-release.js';
import { CuaDriverService, type CuaDriverJsonRpcResponse } from './cua-driver-service.js';
import {
  CUA_INSPECT_PREPARED_ELEMENT_SCRIPT,
  buildCuaPrepareElementAtScreenPointScript,
  buildCuaSemanticPointerActionScript,
  parseCuaFocusedPageElement,
  parseCuaSemanticPointerResult,
  resolveCuaPageTextTarget,
  type CuaSemanticPointerAction,
  type CuaSemanticPointerResult,
  type CuaResolvedPageTextTarget,
} from './cua-driver-page-target.js';
import {
  editableElementAtScreenPoint,
  elementAtScreenPoint,
  normalizeCuaSnapshotElement,
  resolveWindowAtDeclaredPoint,
  windowPointFromSnapshot,
  type CuaResolvedWindow,
  type CuaSnapshotElement,
  type CuaWindowRecord,
} from './cua-driver-snapshot.js';

// Frames larger than this get compressed (to JPEG) before the cap check. Small
// crisp PNGs (simple screens) pass through untouched.
const COMPRESS_FRAME_THRESHOLD = 1.5 * 1024 * 1024;
const CUA_DRIVER_FRAME_MAX_BYTES = 8 * 1024 * 1024;
const MAX_OBSERVATIONS_PER_SESSION = 16;

function exceedsCuaDriverFrameCap(byteLength: number): boolean {
  return byteLength > CUA_DRIVER_FRAME_MAX_BYTES;
}

type CuaDriverCaptureFailure = CuRunResult & {
  outcome: Extract<CuRunResult['outcome'], { ok: false }>;
};

class CuaDriverCaptureError extends Error {
  constructor(readonly result: CuaDriverCaptureFailure) {
    super(result.outcome.message);
  }
}

export interface CuaDriverBackendOptions {
  /** Absolute path to the bundled `cua-driver` binary. */
  binaryPath: string;
  /** The host app's bundle id, for TCC responsibility-chain inheritance. */
  hostBundleId: string;
  timeoutMs?: number;
  /** Per-request bound on the startup handshake (defaults to HANDSHAKE_TIMEOUT_MS). */
  handshakeTimeoutMs?: number;
  /** Consecutive lazy-start attempts before a child role becomes unavailable. */
  maxRestartAttempts?: number;
  /** Initial exponential backoff between lazy-start attempts. */
  restartBackoffMs?: number;
  /** Optional pinned executable hash; verified before every spawn. */
  expectedBinarySha256?: string;
  expectedServerName?: string;
  expectedServerVersion?: string;
  expectedProtocolVersion?: string;
  /**
   * Optional frame compressor: given a captured frame (base64 + mimeType) returns
   * a smaller encoding at the SAME (native) resolution — so coordinates are
   * unchanged. Applied only to large frames. Runs in Electron main (nativeImage);
   * omitted under node --test, where frames pass through untouched.
   */
  compressFrame?: (
    base64: string,
    mimeType: string,
  ) => { base64: string; mimeType: 'image/png' | 'image/jpeg' };
  /** Test seam; production classifies the target executable before any keyboard action. */
  classifyProcess?: (pid: number) => Promise<'electron' | 'native' | 'unknown'>;
  /** Test seam; production resolves only already-listening, uniquely identified CDP pages. */
  resolvePageTextTarget?: (input: {
    pid: number;
    windowTitle?: string;
    signal: AbortSignal;
  }) => Promise<CuaResolvedPageTextTarget | undefined>;
  resolvePageDocumentFingerprint?: (input: {
    pid: number;
    windowId: number;
    target: CuaResolvedPageTextTarget;
    signal: AbortSignal;
  }) => Promise<string | undefined>;
  resolveContentFingerprint?: (
    elements: readonly NonNullable<ReturnType<typeof normalizeCuaSnapshotElement>>[],
  ) => string;
  resolveDisplays?: (input: {
    screenshotWidthPx: number;
    screenshotHeightPx: number;
    logicalWidth: number;
    logicalHeight: number;
    signal: AbortSignal;
  }) => Promise<ComputerUseDisplayIdentity[]>;
  /**
   * Host-owned physical-input guard. Returning true fences the pending input
   * before cua-driver receives any mouse or keyboard dispatch.
   */
  physicalInputRecentlyActive?: () => boolean | Promise<boolean>;
  /**
   * Coordinate mouse/scroll/drag dispatch uses the compatibility CGEvent
   * backend, which can interfere with physical mouse button state. Keep it
   * disabled unless a future native executor proves event isolation.
   */
  allowCompatibilityInputDispatch?: boolean;
  /** Privacy-safe diagnostic stream: geometry, roles, dispatch path, and outcome only. */
  onTrace?: (event: CuaDriverTraceEvent) => void;
  /** Host lifecycle producer. Payloads contain no screen or application content. */
  onSessionInvalidated?: (input: {
    sessionId: string;
    reason: CuaDriverReleaseEvent['reason'];
    outcomeUnknown: boolean;
  }) => void;
}

export type CuaDriverTraceEvent =
  | {
      type: 'target';
      toolCallId?: string;
      actionType: CuAction['type'];
      pid: number;
      windowId: number;
      screenPoint: { x: number; y: number };
    }
  | {
      type: 'snapshot';
      toolCallId?: string;
      actionType: CuAction['type'];
      pid: number;
      windowId: number;
      windowPoint: { x: number; y: number };
      containingElements: Array<{
        elementIndex: number;
        role: string;
        depth: number;
        frame: { x: number; y: number; w: number; h: number };
      }>;
      editableElementIndex?: number;
      clickableElementIndex?: number;
    }
  | {
      type: 'dispatch';
      toolCallId?: string;
      actionType: CuAction['type'] | CuSemanticAction['type'];
      tool: string;
      pid?: number;
      windowId?: number;
      address: 'ax' | 'px' | 'semantic' | 'none';
    }
  | {
      type: 'outcome';
      toolCallId?: string;
      actionType: CuAction['type'];
      tool: string;
      outcome: CuaDriverTraceOutcome;
    }
  | {
      type: 'semantic_result';
      toolCallId?: string;
      actionType: CuAction['type'];
      pid: number;
      windowId: number;
      port: number;
      supported: boolean;
      ok: boolean;
      reason?: string;
      effect?: string;
      tagName?: string;
      inputType?: string;
    }
  | {
      type: 'fallback';
      toolCallId?: string;
      actionType: CuAction['type'];
      from: 'semantic';
      to: 'pixel';
      reason: string;
    }
  | {
      type: 'occlusion';
      expectedPid: number;
      expectedWindowId: number;
      winnerPid?: number;
      winnerWindowId?: number;
      winnerZIndex?: number;
    };

export type CuaDriverTraceOutcome =
  | {
      ok: true;
      tier: 'ax' | 'semantic-background' | 'coordinate-background';
      verified?: boolean;
      effect?: ComputerUseEffect;
      completedSubSteps?: number;
    }
  | {
      ok: false;
      error: ComputerUseErrorCode;
      effect?: ComputerUseEffect;
      completedSubSteps?: number;
    };

export type JsonRpcResponse = CuaDriverJsonRpcResponse;

async function classifyMacProcess(pid: number): Promise<'electron' | 'native' | 'unknown'> {
  const executable = await new Promise<string>((resolve, reject) => {
    execFile(
      '/bin/ps',
      ['-p', String(pid), '-o', 'comm='],
      { encoding: 'utf8' },
      (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout.trim());
      },
    );
  }).catch(() => '');
  if (!executable.startsWith('/')) return 'unknown';
  const contentsDir = dirname(dirname(executable));
  const electronFramework = join(contentsDir, 'Frameworks', 'Electron Framework.framework');
  try {
    await access(electronFramework);
    return 'electron';
  } catch {
    return 'native';
  }
}

export function createCuaDriverBackend(opts: CuaDriverBackendOptions): CuDispatchBackend & {
  inspectWindowAt: (
    point: { x: number; y: number },
    signal: AbortSignal,
  ) => Promise<CuaResolvedWindow | undefined>;
  serviceState: () => {
    action: CuaDriverRoleSnapshot;
    capture: CuaDriverRoleSnapshot;
  };
  clearSession: (sessionId: string) => void;
  dispose: () => void;
} {
  const clientHome = (role: 'action' | 'capture') =>
    join(tmpdir(), `maka-cua-${role}-${process.pid}-${randomUUID()}`);
  // Cached backing scale (device px per logical point). The model's click
  // coordinate is in get_desktop_state DEVICE pixels; window bounds from
  // list_windows are in logical SCREEN POINTS, so we convert with this.
  let lastFrameWidthPx: number | undefined; // device width of the last capture

  // Keyboard ownership is session + turn scoped. Only a successful click may
  // establish it; pointer-only scroll/drag actions do not imply text focus.
  interface KeyboardTarget {
    window: CuaResolvedWindow;
    editable: boolean;
    pageTarget?: CuaResolvedPageTextTarget;
  }
  const targetsBySession = new Map<string, { turnId: string; target: KeyboardTarget }>();
  const sessionGenerations = new Map<string, number>();
  interface StoredObservation {
    context: Pick<CuRunContext, 'sessionId' | 'turnId'>;
    appId: string;
    window: CuaResolvedWindow;
    elements: Map<string, NonNullable<ReturnType<typeof normalizeCuaSnapshotElement>>>;
    contentFingerprint: string;
    page?: ComputerUsePageIdentity;
    screenshotWidthPx?: number;
    screenshotHeightPx?: number;
    displays?: ComputerUseDisplayIdentity[];
  }
  const observations = new Map<string, StoredObservation>();
  const observationIdsBySession = new Map<string, string[]>();
  const operationQueues = new Map<string, Promise<void>>();
  let sessionClearReleaseEvents: CuaDriverReleaseEvent[] | undefined;
  let disposed = false;

  async function physicalInputFailure(): Promise<CuRunResult | undefined> {
    if (!opts.physicalInputRecentlyActive) return undefined;
    try {
      if (!(await opts.physicalInputRecentlyActive())) return undefined;
    } catch {
      // The guard is a safety boundary. If the host cannot establish an idle
      // window, refuse the dispatch and require a fresh observation.
    }
    return {
      outcome: {
        ok: false,
        error: 'user_intervened',
        message: 'physical user input is active; wait for input to settle and observe again',
      },
    };
  }

  function compatibilityInputBlocked(actionType: string): CuRunResult {
    return {
      outcome: {
        ok: false,
        error: 'unsupported_action',
        message:
          `background '${actionType}' is disabled because the compatibility ` +
          'event backend can interfere with physical user input',
      },
    };
  }

  function contentFingerprint(
    elements: Iterable<NonNullable<ReturnType<typeof normalizeCuaSnapshotElement>>>,
  ): string {
    const structural = [
      ...new Set(
        [...elements].map((element) =>
          JSON.stringify({
            role: element.role,
            label: element.label,
            value: element.value,
            frame: element.frame,
            depth: element.depth,
          }),
        ),
      ),
    ].sort();
    return createHash('sha256').update(JSON.stringify(structural)).digest('hex');
  }

  function storeObservation(observationId: string, observation: StoredObservation): void {
    const sessionId = observation.context.sessionId;
    const ids = observationIdsBySession.get(sessionId) ?? [];
    while (ids.length >= MAX_OBSERVATIONS_PER_SESSION) {
      observations.delete(ids.shift()!);
    }
    ids.push(observationId);
    observationIdsBySession.set(sessionId, ids);
    observations.set(observationId, observation);
  }

  function deleteObservation(observationId: string): void {
    const observation = observations.get(observationId);
    if (!observation) return;
    observations.delete(observationId);
    const sessionId = observation.context.sessionId;
    const ids = observationIdsBySession.get(sessionId);
    if (!ids) return;
    const index = ids.indexOf(observationId);
    if (index >= 0) ids.splice(index, 1);
    if (ids.length === 0) observationIdsBySession.delete(sessionId);
  }

  function normalizeScreenshot(
    image: { data?: string; mimeType?: string } | undefined,
    widthPx: number,
    heightPx: number,
    label: string,
  ): CuScreenshot | CuaDriverCaptureFailure {
    if (!image?.data) {
      return {
        outcome: {
          ok: false,
          error: 'capture_failed',
          message: `${label} returned no image`,
        },
      };
    }
    let base64 = image.data;
    let mimeType: 'image/png' | 'image/jpeg' =
      image.mimeType === 'image/jpeg' ? 'image/jpeg' : 'image/png';
    let byteLength = Buffer.from(base64, 'base64').byteLength;
    if (opts.compressFrame && byteLength > COMPRESS_FRAME_THRESHOLD) {
      const compressed = opts.compressFrame(base64, mimeType);
      base64 = compressed.base64;
      mimeType = compressed.mimeType;
      byteLength = Buffer.from(base64, 'base64').byteLength;
    }
    if (exceedsCuaDriverFrameCap(byteLength)) {
      return {
        outcome: {
          ok: false,
          error: 'sensitivity_blocked',
          message: `${label} ${byteLength}B exceeds cap`,
        },
      };
    }
    return { base64, mimeType, widthPx, heightPx };
  }

  function deliveredVerificationFailure(actionType: string, path: 'ax' | 'cdp'): CuRunResult {
    return {
      outcome: {
        ok: false,
        error: 'outcome_unknown',
        message: `${actionType} was delivered but post-dispatch verification failed`,
        evidence: { path, effect: 'unverifiable' },
      },
    };
  }

  function clearLocalSession(sessionId: string): void {
    targetsBySession.delete(sessionId);
    for (const id of observationIdsBySession.get(sessionId) ?? []) {
      observations.delete(id);
    }
    observationIdsBySession.delete(sessionId);
    sessionGenerations.set(sessionId, (sessionGenerations.get(sessionId) ?? 0) + 1);
  }

  function applyServiceRelease(events: readonly CuaDriverReleaseEvent[]): void {
    const generationReleased = events.some((event) => event.generationReleased);
    const sessions = [
      ...new Set([
        ...events.flatMap((event) => event.sessionIds),
        ...(generationReleased ? targetsBySession.keys() : []),
        ...(generationReleased
          ? [...observations.values()].map((observation) => observation.context.sessionId)
          : []),
      ]),
    ];
    for (const sessionId of sessions) {
      clearLocalSession(sessionId);
      try {
        opts.onSessionInvalidated?.({
          sessionId,
          reason: events[0]!.reason,
          outcomeUnknown: events.some((event) => event.outcomeUnknown),
        });
      } catch {
        // Host lifecycle observers cannot change service recovery.
      }
    }
  }

  function onServiceRelease(event: CuaDriverReleaseEvent): void {
    if (event.reason === 'disposed') return;
    if (event.reason === 'session_cleared' && sessionClearReleaseEvents) {
      sessionClearReleaseEvents.push(event);
      return;
    }
    applyServiceRelease([event]);
  }

  const actionClient = new CuaDriverService({
    role: 'action',
    binaryPath: opts.binaryPath,
    hostBundleId: opts.hostBundleId,
    captureScope: 'window',
    homeDir: clientHome('action'),
    ...(opts.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs }),
    ...(opts.handshakeTimeoutMs === undefined
      ? {}
      : { handshakeTimeoutMs: opts.handshakeTimeoutMs }),
    ...(opts.maxRestartAttempts === undefined
      ? {}
      : { maxRestartAttempts: opts.maxRestartAttempts }),
    ...(opts.restartBackoffMs === undefined ? {} : { restartBackoffMs: opts.restartBackoffMs }),
    ...(opts.expectedBinarySha256 === undefined
      ? {}
      : { expectedBinarySha256: opts.expectedBinarySha256 }),
    ...(opts.expectedServerName === undefined
      ? {}
      : { expectedServerName: opts.expectedServerName }),
    ...(opts.expectedServerVersion === undefined
      ? {}
      : { expectedServerVersion: opts.expectedServerVersion }),
    ...(opts.expectedProtocolVersion === undefined
      ? {}
      : { expectedProtocolVersion: opts.expectedProtocolVersion }),
    onRelease: onServiceRelease,
  });
  const captureClient = new CuaDriverService({
    role: 'capture',
    binaryPath: opts.binaryPath,
    hostBundleId: opts.hostBundleId,
    captureScope: 'desktop',
    homeDir: clientHome('capture'),
    ...(opts.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs }),
    ...(opts.handshakeTimeoutMs === undefined
      ? {}
      : { handshakeTimeoutMs: opts.handshakeTimeoutMs }),
    ...(opts.maxRestartAttempts === undefined
      ? {}
      : { maxRestartAttempts: opts.maxRestartAttempts }),
    ...(opts.restartBackoffMs === undefined ? {} : { restartBackoffMs: opts.restartBackoffMs }),
    ...(opts.expectedBinarySha256 === undefined
      ? {}
      : { expectedBinarySha256: opts.expectedBinarySha256 }),
    ...(opts.expectedServerName === undefined
      ? {}
      : { expectedServerName: opts.expectedServerName }),
    ...(opts.expectedServerVersion === undefined
      ? {}
      : { expectedServerVersion: opts.expectedServerVersion }),
    ...(opts.expectedProtocolVersion === undefined
      ? {}
      : { expectedProtocolVersion: opts.expectedProtocolVersion }),
    onRelease: onServiceRelease,
  });

  function trace(event: CuaDriverTraceEvent): void {
    try {
      opts.onTrace?.(event);
    } catch {
      // Diagnostics must never change dispatch.
    }
  }

  function traceOutcome(outcome: CuRunResult['outcome']): CuaDriverTraceOutcome {
    return outcome.ok
      ? {
          ok: true,
          tier: outcome.tier,
          ...(outcome.verified === undefined ? {} : { verified: outcome.verified }),
          ...(outcome.evidence?.effect ? { effect: outcome.evidence.effect } : {}),
          ...(outcome.completedSubSteps === undefined
            ? {}
            : { completedSubSteps: outcome.completedSubSteps }),
        }
      : {
          ok: false,
          error: outcome.error,
          ...(outcome.evidence?.effect ? { effect: outcome.evidence.effect } : {}),
          ...(outcome.completedSubSteps === undefined
            ? {}
            : { completedSubSteps: outcome.completedSubSteps }),
        };
  }

  async function displayMetrics(signal: AbortSignal): Promise<{
    desktopFrameWidthPx: number;
    logicalDisplayWidth: number;
  }> {
    const r = await actionClient.callTool('get_screen_size', {}, signal);
    const sc = r?.structuredContent ?? {};
    const logicalW = typeof sc.width === 'number' && sc.width > 0 ? sc.width : 0;
    const fallbackScale =
      typeof sc.scale_factor === 'number' && sc.scale_factor > 0 ? sc.scale_factor : 1;
    return {
      desktopFrameWidthPx: lastFrameWidthPx ?? logicalW * fallbackScale,
      logicalDisplayWidth: logicalW,
    };
  }

  async function withOperationQueue<T>(
    signal: AbortSignal,
    operation: () => Promise<T>,
    sessionId?: string,
  ): Promise<T> {
    if (disposed) throw new Error('cua-driver backend disposed');
    const queueKey = '__shared_child__';
    const sessionGeneration =
      sessionId === undefined ? undefined : (sessionGenerations.get(sessionId) ?? 0);
    const previous = operationQueues.get(queueKey) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const current = previous.then(() => gate);
    operationQueues.set(queueKey, current);
    await previous;
    try {
      if (disposed) throw new Error('cua-driver backend disposed');
      if (signal.aborted) throw new Error('aborted');
      if (
        sessionId !== undefined &&
        (sessionGenerations.get(sessionId) ?? 0) !== sessionGeneration
      ) {
        throw new CuaDriverLifecycleError(
          'aborted',
          'session was cleared before request delivery',
          'action',
          actionClient.snapshot().generation,
          'queued',
        );
      }
      if (!sessionId) return await operation();
      return await actionClient.withSession(sessionId, () =>
        captureClient.withSession(sessionId, operation),
      );
    } finally {
      release();
      if (operationQueues.get(queueKey) === current) {
        operationQueues.delete(queueKey);
      }
    }
  }

  function lifecycleFailure(error: unknown): CuRunResult | undefined {
    if (!isCuaDriverLifecycleError(error)) return undefined;
    const code: ComputerUseErrorCode = error.code === 'aborted' ? 'aborted' : error.code;
    return {
      outcome: {
        ok: false,
        error: code,
        message: cuaDriverLifecycleMessage(error),
      },
    };
  }

  /**
   * Resolve the frontmost on-screen app window under a DEVICE-pixel click point,
   * mirroring cua-driver's screen-point resolution (without using its forbidden
   * pid-less input path),
   * layer-0, highest z_index wins). Returns the target pid + window_id + the
   * window-local DEVICE coordinate. Null when NO app window owns the pixel (empty
   * desktop) — where cua-driver would warp the real cursor, so we must refuse.
   * Excludes non-layer-0 windows, which also excludes Maka's always-on-top overlay.
   */
  async function resolveWindowAt(
    deviceX: number,
    deviceY: number,
    signal: AbortSignal,
  ): Promise<CuaResolvedWindow | undefined> {
    const metrics = await displayMetrics(signal);
    const r = await actionClient.callTool('list_windows', {}, signal);
    return resolveWindowAtDeclaredPoint({
      declaredPoint: { x: deviceX, y: deviceY },
      desktopFrameWidthPx: metrics.desktopFrameWidthPx,
      logicalDisplayWidth: metrics.logicalDisplayWidth,
      windows: (r?.structuredContent?.windows ?? []) as Array<Record<string, unknown>>,
    });
  }

  interface TargetSnapshot {
    elements: CuaSnapshotElement[];
    screenshotWidthPx: number;
    screenshotHeightPx: number;
    windowPoint: { x: number; y: number };
  }

  async function snapshotTarget(
    target: CuaResolvedWindow,
    signal: AbortSignal,
  ): Promise<TargetSnapshot> {
    const state = await actionClient.callTool(
      'get_window_state',
      {
        pid: target.pid,
        window_id: target.windowId,
        include_screenshot: true,
        max_elements: 500,
        max_depth: 25,
      },
      signal,
    );
    const outcome = normalizeCuaDriverOutcome(state);
    if (!outcome.ok) {
      throw new Error(outcome.message);
    }
    const structured = state?.structuredContent ?? {};
    const windowPoint = windowPointFromSnapshot({
      screenPoint: target.screenPoint,
      windowBounds: target.bounds,
      screenshotWidthPx: Number(structured.screenshot_width),
      screenshotHeightPx: Number(structured.screenshot_height),
    });
    if (!windowPoint) {
      throw new Error('cua-driver returned invalid window screenshot dimensions');
    }
    if (!Array.isArray(structured.elements)) {
      throw new Error('cua-driver returned invalid AX elements');
    }
    return {
      elements: structured.elements as CuaSnapshotElement[],
      screenshotWidthPx: Number(structured.screenshot_width),
      screenshotHeightPx: Number(structured.screenshot_height),
      windowPoint,
    };
  }

  async function listWindowRecords(signal: AbortSignal): Promise<CuaWindowRecord[]> {
    const result = await actionClient.callTool('list_windows', {}, signal);
    return (result?.structuredContent?.windows ?? []) as CuaWindowRecord[];
  }

  function sameBounds(
    left: CuaResolvedWindow['bounds'] | undefined,
    right: CuaResolvedWindow['bounds'] | undefined,
  ): boolean {
    return (
      !!left &&
      !!right &&
      left.x === right.x &&
      left.y === right.y &&
      left.width === right.width &&
      left.height === right.height
    );
  }

  function sameDisplay(
    left: ComputerUseDisplayIdentity,
    right: ComputerUseDisplayIdentity,
  ): boolean {
    return (
      left.displayId === right.displayId &&
      left.scaleFactor === right.scaleFactor &&
      sameBounds(left.logicalBounds, right.logicalBounds) &&
      sameBounds(left.sourceBoundsPx, right.sourceBoundsPx)
    );
  }

  async function pageIdentity(
    window: CuaResolvedWindow,
    target: CuaResolvedPageTextTarget,
    signal: AbortSignal,
  ): Promise<ComputerUsePageIdentity | undefined> {
    const documentFingerprint = await (opts.resolvePageDocumentFingerprint
      ? opts.resolvePageDocumentFingerprint({
          pid: window.pid,
          windowId: window.windowId,
          target,
          signal,
        })
      : resolvePageDocumentFingerprint(window, target, signal));
    if (!documentFingerprint) return undefined;
    return {
      cdpPort: target.port,
      pageTargetId: target.pageTargetId,
      pageUrl: target.pageUrl,
      targetUrlContains: target.targetUrlContains,
      documentFingerprint,
    };
  }

  function samePage(
    left: ComputerUsePageIdentity | undefined,
    right: ComputerUsePageIdentity | undefined,
  ): boolean {
    return !left
      ? right === undefined
      : !!right &&
          left.cdpPort === right.cdpPort &&
          left.pageTargetId === right.pageTargetId &&
          left.pageUrl === right.pageUrl &&
          left.documentFingerprint === right.documentFingerprint;
  }

  async function resolvePageDocumentFingerprint(
    window: CuaResolvedWindow,
    target: CuaResolvedPageTextTarget,
    signal: AbortSignal,
  ): Promise<string | undefined> {
    const response = await actionClient.callTool(
      'page',
      {
        pid: window.pid,
        window_id: window.windowId,
        action: 'execute_javascript',
        javascript:
          'JSON.stringify({href:String(location.href),timeOrigin:Number(performance.timeOrigin),readyState:String(document.readyState)})',
        cdp_port: target.port,
        target_url_contains: target.targetUrlContains,
      },
      signal,
    );
    if (response?.isError) return undefined;
    const text = response?.content?.find(
      (content) => content.type === 'text' && typeof content.text === 'string',
    )?.text;
    return text ? createHash('sha256').update(text).digest('hex') : undefined;
  }

  async function resolveWindowDisplays(
    screenshotWidthPx: number,
    screenshotHeightPx: number,
    window: CuaResolvedWindow,
  ): Promise<ComputerUseDisplayIdentity[]> {
    return [
      {
        displayId: `window:${window.pid}:${window.windowId}`,
        logicalBounds: { x: 0, y: 0, width: screenshotWidthPx, height: screenshotHeightPx },
        sourceBoundsPx: { x: 0, y: 0, width: screenshotWidthPx, height: screenshotHeightPx },
        scaleFactor: 1,
      },
    ];
  }

  async function resolveObservedPage(
    window: CuaResolvedWindow,
    signal: AbortSignal,
  ): Promise<ComputerUsePageIdentity | undefined> {
    const processKind = await (opts.classifyProcess ?? classifyMacProcess)(window.pid);
    if (processKind !== 'electron') return undefined;
    const target = await (
      opts.resolvePageTextTarget ?? ((input) => resolveCuaPageTextTarget(input))
    )({
      pid: window.pid,
      ...(window.title ? { windowTitle: window.title } : {}),
      signal,
    });
    return target ? pageIdentity(window, target, signal) : undefined;
  }

  function appIdForWindow(window: CuaWindowRecord): string | undefined {
    return typeof window.app_name === 'string' && window.app_name.trim()
      ? window.app_name.trim()
      : typeof window.pid === 'number'
        ? `pid:${window.pid}`
        : undefined;
  }

  function resolveObservedWindow(
    windows: readonly CuaWindowRecord[],
    app: string | undefined,
    windowId?: number,
  ): CuaResolvedWindow {
    const eligible = windows
      .flatMap((window) => {
        if (
          window.layer !== 0 ||
          window.is_on_screen === false ||
          typeof window.pid !== 'number' ||
          typeof window.window_id !== 'number' ||
          !window.bounds ||
          typeof window.bounds !== 'object'
        )
          return [];
        const bounds = window.bounds as Record<string, unknown>;
        if (
          typeof bounds.x !== 'number' ||
          typeof bounds.y !== 'number' ||
          typeof bounds.width !== 'number' ||
          typeof bounds.height !== 'number' ||
          bounds.width <= 0 ||
          bounds.height <= 0
        )
          return [];
        const appId = appIdForWindow(window);
        const title = typeof window.title === 'string' ? window.title : undefined;
        if (windowId !== undefined && window.window_id !== windowId) return [];
        if (app && app !== appId && app !== `pid:${window.pid}` && app !== title) return [];
        return [
          {
            pid: window.pid,
            windowId: window.window_id,
            ...(appId ? { appName: appId } : {}),
            ...(title ? { title } : {}),
            bounds: {
              x: bounds.x,
              y: bounds.y,
              width: bounds.width,
              height: bounds.height,
            },
            screenPoint: {
              x: bounds.x + bounds.width / 2,
              y: bounds.y + bounds.height / 2,
            },
            zIndex: Number(window.z_index) || 0,
          },
        ];
      })
      .sort((a, b) => b.zIndex - a.zIndex);
    if (eligible.length === 0)
      throw new Error(
        `invalidApp: no visible window matched ${app ?? windowId ?? 'the current desktop'}`,
      );
    if (windowId === undefined && app && eligible.length > 1) {
      throw new Error(`ambiguousApp: ${app} matched ${eligible.length} visible windows`);
    }
    const winner = eligible[0]!;
    return {
      pid: winner.pid,
      windowId: winner.windowId,
      ...(winner.appName ? { appName: winner.appName } : {}),
      ...(winner.title ? { title: winner.title } : {}),
      bounds: winner.bounds,
      screenPoint: winner.screenPoint,
      zIndex: winner.zIndex,
    };
  }

  async function observeWindow(
    input: { app?: string; windowId?: number; includeScreenshot: boolean },
    signal: AbortSignal,
    context: CuRunContext,
  ): Promise<CuObservation> {
    const window = resolveObservedWindow(
      await listWindowRecords(signal),
      input.app,
      input.windowId,
    );
    return observeResolvedWindow(window, input.includeScreenshot, signal, context);
  }

  async function observeResolvedWindow(
    window: CuaResolvedWindow,
    includeScreenshot: boolean,
    signal: AbortSignal,
    context: CuRunContext,
  ): Promise<CuObservation> {
    const state = await actionClient.callTool(
      'get_window_state',
      {
        pid: window.pid,
        window_id: window.windowId,
        include_screenshot: includeScreenshot,
        max_elements: 500,
        max_depth: 25,
      },
      signal,
    );
    const outcome = normalizeCuaDriverOutcome(state);
    if (!outcome.ok) throw new Error(outcome.message);
    const structured = state?.structuredContent ?? {};
    const elements = new Map<string, NonNullable<ReturnType<typeof normalizeCuaSnapshotElement>>>();
    for (const candidate of (structured.elements ?? []) as CuaSnapshotElement[]) {
      const element = normalizeCuaSnapshotElement(candidate);
      if (!element) continue;
      const elementId = String(element.element_index);
      elements.set(elementId, element);
    }
    const observationId = randomUUID();
    const appId = window.appName ?? `pid:${window.pid}`;
    const screenshotWidthPx = Number(structured.screenshot_width) || undefined;
    const screenshotHeightPx = Number(structured.screenshot_height) || undefined;
    const displays =
      screenshotWidthPx && screenshotHeightPx
        ? await resolveWindowDisplays(screenshotWidthPx, screenshotHeightPx, window)
        : undefined;
    const page = await resolveObservedPage(window, signal);
    const axContentFingerprint = opts.resolveContentFingerprint
      ? opts.resolveContentFingerprint([...elements.values()])
      : contentFingerprint(elements.values());
    const image = includeScreenshot
      ? state?.content?.find(
          (content) => content.type === 'image' && typeof content.data === 'string',
        )
      : undefined;
    const normalizedScreenshot = includeScreenshot
      ? normalizeScreenshot(
          image,
          Number(structured.screenshot_width) || 0,
          Number(structured.screenshot_height) || 0,
          'window frame',
        )
      : undefined;
    if (normalizedScreenshot && 'outcome' in normalizedScreenshot) {
      throw new CuaDriverCaptureError(normalizedScreenshot);
    }
    const screenshot = normalizedScreenshot;
    storeObservation(observationId, {
      context: { sessionId: context.sessionId, turnId: context.turnId },
      appId,
      window,
      elements,
      contentFingerprint: axContentFingerprint,
      ...(page ? { page } : {}),
      ...(screenshotWidthPx ? { screenshotWidthPx } : {}),
      ...(screenshotHeightPx ? { screenshotHeightPx } : {}),
      ...(displays ? { displays } : {}),
    });
    return {
      observationId,
      appId,
      pid: window.pid,
      windowId: window.windowId,
      ...(window.title ? { windowTitle: window.title } : {}),
      capturedAt: Date.now(),
      windowBounds: window.bounds,
      sourceBoundsPx:
        screenshotWidthPx && screenshotHeightPx
          ? { x: 0, y: 0, width: screenshotWidthPx, height: screenshotHeightPx }
          : undefined,
      zIndex: window.zIndex,
      contentFingerprint: axContentFingerprint,
      ...(page ? { page } : {}),
      ...(displays ? { displays } : {}),
      elements: [...elements].map(([elementId, element]) => ({
        elementId,
        role: element.role,
        ...(element.label ? { label: element.label } : {}),
        ...(element.value !== undefined ? { value: element.value } : {}),
        frame: {
          x: element.frame.x,
          y: element.frame.y,
          width: element.frame.w,
          height: element.frame.h,
        },
        identity: {
          ...(element.element_token ? { token: element.element_token } : {}),
          role: element.role,
          ...(element.label ? { label: element.label } : {}),
          ...(element.value !== undefined ? { value: element.value } : {}),
        },
      })),
      ...(screenshot ? { screenshot } : {}),
    };
  }

  function elementMatchesIdentity(
    element: NonNullable<ReturnType<typeof normalizeCuaSnapshotElement>>,
    identity: CuObservedElement['identity'] | undefined,
    original?: NonNullable<ReturnType<typeof normalizeCuaSnapshotElement>>,
  ): boolean {
    if (!identity) return false;
    if (element.role !== identity.role) return false;
    const label = identity.label?.trim();
    return (
      (!label || element.label === identity.label) &&
      !!original &&
      element.depth === original.depth &&
      element.frame.x === original.frame.x &&
      element.frame.y === original.frame.y &&
      element.frame.w === original.frame.w &&
      element.frame.h === original.frame.h &&
      element.value === original.value
    );
  }

  function dedupeSemanticElements(
    elements: NonNullable<ReturnType<typeof normalizeCuaSnapshotElement>>[],
  ): NonNullable<ReturnType<typeof normalizeCuaSnapshotElement>>[] {
    const seen = new Set<string>();
    return elements.filter((element) => {
      const key = JSON.stringify({
        role: element.role,
        label: element.label,
        value: element.value,
        frame: element.frame,
        depth: element.depth,
      });
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  async function validateStoredWindow(
    observation: StoredObservation,
    bound: CuaBoundAction | undefined,
    signal: AbortSignal,
    mode: 'coordinate' | 'semantic',
  ): Promise<CuaResolvedWindow | CuRunResult> {
    if (
      bound?.target &&
      (bound.target.pid !== observation.window.pid ||
        bound.target.windowId !== observation.window.windowId)
    ) {
      return {
        outcome: {
          ok: false,
          error: 'target_changed',
          message: 'bound target does not match the stored observation',
        },
      };
    }
    const windows = await listWindowRecords(signal);
    const current = windows.find(
      (window) =>
        window.pid === observation.window.pid && window.window_id === observation.window.windowId,
    );
    if (!current) {
      return {
        outcome: {
          ok: false,
          error: 'target_missing',
          message: 'observed target window no longer exists',
        },
      };
    }
    const resolved = resolveObservedWindow(
      windows,
      `pid:${observation.window.pid}`,
      observation.window.windowId,
    );
    if (
      !sameBounds(resolved.bounds, observation.window.bounds) ||
      resolved.appName !== observation.window.appName ||
      resolved.title !== observation.window.title
    ) {
      return {
        outcome: {
          ok: false,
          error: 'target_changed',
          message: 'observed target identity or geometry changed',
        },
      };
    }
    if (observation.page) {
      const page = await resolveObservedPage(resolved, signal);
      if (!samePage(observation.page, page)) {
        return {
          outcome: {
            ok: false,
            error: 'page_target_changed',
            message: 'observed Electron page identity changed',
          },
        };
      }
    }
    if (mode === 'coordinate') {
      const currentState = await actionClient.callTool(
        'get_window_state',
        {
          pid: resolved.pid,
          window_id: resolved.windowId,
          include_screenshot: false,
          max_elements: 500,
          max_depth: 25,
        },
        signal,
      );
      const currentOutcome = normalizeCuaDriverOutcome(currentState);
      if (!currentOutcome.ok) return { outcome: currentOutcome };
      const currentElements = (
        (currentState?.structuredContent?.elements ?? []) as CuaSnapshotElement[]
      ).flatMap((candidate) => {
        const element = normalizeCuaSnapshotElement(candidate);
        return element ? [element] : [];
      });
      const currentFingerprint = opts.resolveContentFingerprint
        ? opts.resolveContentFingerprint(currentElements)
        : contentFingerprint(currentElements);
      if (currentFingerprint !== observation.contentFingerprint) {
        return {
          outcome: {
            ok: false,
            error: 'target_changed',
            message: 'observed native element structure changed',
          },
        };
      }
    }
    if (bound?.display && observation.displays) {
      const display = observation.displays.find(
        (candidate) => candidate.displayId === bound.display?.displayId,
      );
      if (!display || !sameDisplay(display, bound.display)) {
        return {
          outcome: {
            ok: false,
            error: 'target_changed',
            message: 'observed coordinate transform changed',
          },
        };
      }
    }
    return resolved;
  }

  function boundWindowPoint(
    bound: CuaBoundAction,
    target: CuaResolvedWindow,
    start = false,
  ): { windowPoint: { x: number; y: number }; screenPoint: { x: number; y: number } } | undefined {
    if (bound.coordinateSpace !== 'window-screenshot-local') return undefined;
    const source = start ? bound.sourceStartCoordinate : bound.sourceCoordinate;
    const windowPoint = start ? bound.windowStartCoordinate : bound.windowCoordinate;
    const sourceBounds = bound.target?.sourceBoundsPx;
    if (!source || !windowPoint || !sourceBounds) return undefined;
    if (
      source.x < 0 ||
      source.y < 0 ||
      source.x >= sourceBounds.width ||
      source.y >= sourceBounds.height
    )
      return undefined;
    return {
      windowPoint,
      screenPoint: {
        x: target.bounds.x + (source.x / sourceBounds.width) * target.bounds.width,
        y: target.bounds.y + (source.y / sourceBounds.height) * target.bounds.height,
      },
    };
  }

  async function validateBoundCoordinate(
    bound: CuaBoundAction | undefined,
    signal: AbortSignal,
    start = false,
    requireVisible = true,
  ): Promise<CuaResolvedWindow | CuRunResult | undefined> {
    if (!bound?.target) return undefined;
    if (!bound.target.contentFingerprint) {
      return {
        outcome: {
          ok: false,
          error: 'target_changed',
          message: 'bound target is missing native content identity',
        },
      };
    }
    const stored: StoredObservation = {
      context: { sessionId: '', turnId: '' },
      appId: bound.target.appName ?? `pid:${bound.target.pid}`,
      window: {
        pid: bound.target.pid,
        windowId: bound.target.windowId,
        ...(bound.target.appName ? { appName: bound.target.appName } : {}),
        ...(bound.target.title ? { title: bound.target.title } : {}),
        bounds: bound.target.bounds ?? { x: 0, y: 0, width: 0, height: 0 },
        screenPoint: { x: 0, y: 0 },
        zIndex: bound.target.zIndex ?? 0,
      },
      elements: new Map(),
      contentFingerprint: bound.target.contentFingerprint,
      ...(bound.target.page ? { page: bound.target.page } : {}),
      ...(bound.display ? { displays: [bound.display] } : {}),
    };
    const validated = await validateStoredWindow(stored, bound, signal, 'coordinate');
    if ('outcome' in validated) return validated;
    const currentState = await actionClient.callTool(
      'get_window_state',
      {
        pid: validated.pid,
        window_id: validated.windowId,
        include_screenshot: false,
        max_elements: 0,
        max_depth: 0,
      },
      signal,
    );
    const currentOutcome = normalizeCuaDriverOutcome(currentState);
    if (!currentOutcome.ok) return { outcome: currentOutcome };
    const currentStructured = currentState?.structuredContent ?? {};
    const currentWidth = Number(currentStructured.screenshot_width);
    const currentHeight = Number(currentStructured.screenshot_height);
    if (
      !bound.target.sourceBoundsPx ||
      (currentWidth > 0 &&
        currentHeight > 0 &&
        (currentWidth !== bound.target.sourceBoundsPx.width ||
          currentHeight !== bound.target.sourceBoundsPx.height))
    ) {
      return {
        outcome: {
          ok: false,
          error: 'target_changed',
          message: 'window screenshot scale or layout changed after observation',
        },
      };
    }
    const point = boundWindowPoint(bound, validated, start);
    if (!point) {
      return {
        outcome: {
          ok: false,
          error: 'invalid_coordinate',
          message: 'bound coordinate is outside its window screenshot space',
        },
      };
    }
    if (!requireVisible) {
      return {
        ...validated,
        screenPoint: point.screenPoint,
      };
    }
    const windows = await listWindowRecords(signal);
    const winner = windows
      .flatMap((window) => {
        if (
          window.layer !== 0 ||
          window.is_on_screen === false ||
          typeof window.pid !== 'number' ||
          typeof window.window_id !== 'number' ||
          !window.bounds ||
          typeof window.bounds !== 'object'
        )
          return [];
        const bounds = window.bounds as Record<string, unknown>;
        if (
          typeof bounds.x !== 'number' ||
          typeof bounds.y !== 'number' ||
          typeof bounds.width !== 'number' ||
          typeof bounds.height !== 'number'
        )
          return [];
        const inside =
          point.screenPoint.x >= bounds.x &&
          point.screenPoint.x < bounds.x + bounds.width &&
          point.screenPoint.y >= bounds.y &&
          point.screenPoint.y < bounds.y + bounds.height;
        return inside
          ? [
              {
                pid: window.pid,
                windowId: window.window_id,
                zIndex: Number(window.z_index) || 0,
              },
            ]
          : [];
      })
      .sort((left, right) => right.zIndex - left.zIndex)[0];
    if (!winner || winner.pid !== validated.pid || winner.windowId !== validated.windowId) {
      trace({
        type: 'occlusion',
        expectedPid: validated.pid,
        expectedWindowId: validated.windowId,
        ...(winner
          ? {
              winnerPid: winner.pid,
              winnerWindowId: winner.windowId,
              winnerZIndex: winner.zIndex,
            }
          : {}),
      });
      return {
        outcome: {
          ok: false,
          error: 'target_occluded',
          message: 'another window now owns the bound coordinate',
        },
      };
    }
    return {
      ...validated,
      screenPoint: point.screenPoint,
    };
  }

  async function coordinateTarget(
    bound: CuaBoundAction | undefined,
    fallback: { x: number; y: number },
    signal: AbortSignal,
    start = false,
    requireVisible = true,
  ): Promise<CuaResolvedWindow | CuRunResult | undefined> {
    if (bound) return validateBoundCoordinate(bound, signal, start, requireVisible);
    return resolveWindowAt(fallback.x, fallback.y, signal);
  }

  async function refetchSemanticElement(
    observation: StoredObservation,
    action: CuSemanticAction,
    signal: AbortSignal,
  ): Promise<NonNullable<ReturnType<typeof normalizeCuaSnapshotElement>> | CuRunResult> {
    const state = await actionClient.callTool(
      'get_window_state',
      {
        pid: observation.window.pid,
        window_id: observation.window.windowId,
        include_screenshot: false,
        max_elements: 500,
        max_depth: 25,
      },
      signal,
    );
    const outcome = normalizeCuaDriverOutcome(state);
    if (!outcome.ok) return { outcome };
    const fresh = dedupeSemanticElements(
      ((state?.structuredContent?.elements ?? []) as CuaSnapshotElement[]).flatMap((candidate) => {
        const element = normalizeCuaSnapshotElement(candidate);
        return element ? [element] : [];
      }),
    );
    const original = observation.elements.get(action.elementId);
    const identity =
      action.elementIdentity ??
      (original
        ? {
            ...(original.element_token ? { token: original.element_token } : {}),
            role: original.role,
            ...(original.label ? { label: original.label } : {}),
            ...(original.value !== undefined ? { value: original.value } : {}),
          }
        : undefined);
    if (!identity) {
      return {
        outcome: {
          ok: false,
          error: 'stale_frame',
          message: 'semantic element identity is unavailable',
        },
      };
    }
    const identityMatches = fresh.filter(
      (candidate) =>
        candidate.role === identity.role &&
        (!identity.label?.trim() || candidate.label === identity.label) &&
        (identity.value === undefined || candidate.value === identity.value),
    );
    if (identityMatches.length > 1) {
      return {
        outcome: {
          ok: false,
          error: 'stale_frame',
          message: 'semantic element identity is ambiguous in the fresh observation',
        },
      };
    }
    const matches = identityMatches.filter((candidate) =>
      elementMatchesIdentity(candidate, identity, original),
    );
    if (matches.length === 1) return matches[0]!;
    return {
      outcome: {
        ok: false,
        error: 'stale_frame',
        message: 'semantic element is missing from the fresh observation',
      },
    };
  }

  function targetForContext(context: CuRunContext): KeyboardTarget | undefined {
    const state = targetsBySession.get(context.sessionId);
    if (!state) return undefined;
    const boundTarget = context.boundAction?.target;
    if (
      state.turnId !== context.turnId ||
      (boundTarget &&
        (boundTarget.pid !== state.target.window.pid ||
          boundTarget.windowId !== state.target.window.windowId))
    ) {
      targetsBySession.delete(context.sessionId);
      return undefined;
    }
    return state.target;
  }

  async function fillEditableTarget(
    target: KeyboardTarget,
    text: string,
    signal: AbortSignal,
  ): Promise<CuRunResult['outcome']> {
    const processKind = await (opts.classifyProcess ?? classifyMacProcess)(target.window.pid);
    if (processKind === 'electron') {
      return fillElectronPageTarget(target, text, signal);
    }
    if (processKind !== 'native') {
      return {
        ok: false,
        error: 'unsupported_action',
        message: 'target process type could not be verified; background key events are refused',
      };
    }
    if (!target.editable) {
      return {
        ok: false,
        error: 'unsupported_action',
        message: 'background text input requires an AX-addressable editable field',
      };
    }
    const snapshot = await snapshotTarget(target.window, signal);
    const element = editableElementAtScreenPoint(snapshot.elements, target.window.screenPoint);
    if (!element) {
      return {
        ok: false,
        error: 'unsupported_action',
        message: 'editable field was not present in the fresh AX snapshot',
      };
    }
    if (element.value && element.value !== text) {
      return {
        ok: false,
        error: 'unsupported_action',
        message: 'background AX fill refuses to overwrite a non-empty field',
      };
    }
    if (element.value === text) {
      return {
        ok: true,
        tier: 'ax',
        verified: true,
        evidence: { path: 'ax', effect: 'confirmed' },
      };
    }
    const setResult = await actionClient.callTool(
      'set_value',
      {
        pid: target.window.pid,
        window_id: target.window.windowId,
        element_index: element.element_index,
        ...(element.element_token ? { element_token: element.element_token } : {}),
        value: text,
      },
      signal,
    );
    if (setResult?.isError) return normalizeCuaDriverOutcome(setResult);
    let after: TargetSnapshot;
    try {
      after = await snapshotTarget(target.window, signal);
    } catch {
      return deliveredVerificationFailure('AXValue write', 'ax').outcome;
    }
    const verified =
      editableElementAtScreenPoint(after.elements, target.window.screenPoint)?.value === text;
    return verified
      ? {
          ok: true,
          tier: 'ax',
          verified: true,
          evidence: { path: 'ax', effect: 'confirmed' },
        }
      : {
          ok: false,
          error: 'outcome_unknown',
          message: 'AXValue write could not be confirmed by a fresh snapshot',
          evidence: { path: 'ax', effect: 'unverifiable' },
        };
  }

  async function fillElectronPageTarget(
    target: KeyboardTarget,
    text: string,
    signal: AbortSignal,
  ): Promise<CuRunResult['outcome']> {
    if (!target.editable) {
      return {
        ok: false,
        error: 'unsupported_action',
        message: 'background Electron text requires a verified text-editable click target',
      };
    }
    const pageTarget =
      target.pageTarget ??
      (await (opts.resolvePageTextTarget ?? ((input) => resolveCuaPageTextTarget(input)))({
        pid: target.window.pid,
        ...(target.window.title ? { windowTitle: target.window.title } : {}),
        signal,
      }));
    if (!pageTarget) {
      return {
        ok: false,
        error: 'unsupported_action',
        message: 'Electron background text requires a unique, already-listening CDP page target',
      };
    }
    const executePageScript = async (javascript: string) => {
      const response = await actionClient.callTool(
        'page',
        {
          pid: target.window.pid,
          window_id: target.window.windowId,
          action: 'execute_javascript',
          javascript,
          cdp_port: pageTarget.port,
          target_url_contains: pageTarget.targetUrlContains,
        },
        signal,
      );
      if (response?.isError) return { response };
      const text = response?.content?.find(
        (content) => content.type === 'text' && typeof content.text === 'string',
      )?.text;
      return { response, element: parseCuaFocusedPageElement(text) };
    };
    const prepared = await executePageScript(
      buildCuaPrepareElementAtScreenPointScript(target.window.screenPoint),
    );
    if (prepared.response?.isError) return normalizeCuaDriverOutcome(prepared.response);
    const before = prepared.element;
    if (!before?.editable) {
      return {
        ok: false,
        error: 'unsupported_action',
        message: 'the uniquely identified Electron page has no focused editable DOM element',
      };
    }
    if (before.value && before.value !== text) {
      return {
        ok: false,
        error: 'unsupported_action',
        message: 'background Electron fill refuses to overwrite a non-empty DOM field',
      };
    }
    if (before.value === text) {
      return {
        ok: true,
        tier: 'semantic-background',
        verified: true,
        evidence: { path: 'cdp', effect: 'confirmed' },
      };
    }
    const result = await actionClient.callTool(
      'page',
      {
        pid: target.window.pid,
        window_id: target.window.windowId,
        action: 'insert_text',
        text,
        cdp_port: pageTarget.port,
        target_url_contains: pageTarget.targetUrlContains,
      },
      signal,
    );
    if (result?.isError) return normalizeCuaDriverOutcome(result);
    let inspected: Awaited<ReturnType<typeof executePageScript>>;
    try {
      inspected = await executePageScript(CUA_INSPECT_PREPARED_ELEMENT_SCRIPT);
    } catch {
      return deliveredVerificationFailure('CDP Input.insertText', 'cdp').outcome;
    }
    if (inspected.response?.isError) {
      return deliveredVerificationFailure('CDP Input.insertText', 'cdp').outcome;
    }
    const after = inspected.element;
    return after?.editable === true && after.value === text
      ? {
          ok: true,
          tier: 'semantic-background',
          verified: true,
          evidence: { path: 'cdp', effect: 'confirmed' },
        }
      : {
          ok: false,
          error: 'outcome_unknown',
          message: 'CDP Input.insertText could not be confirmed by DOM readback',
          evidence: { path: 'cdp', effect: 'unverifiable' },
        };
  }

  async function runElectronSemanticPointer(
    action: CuaSemanticPointerAction,
    window: CuaResolvedWindow,
    signal: AbortSignal,
    toolCallId: string,
    boundPage?: ComputerUsePageIdentity,
  ): Promise<{
    handled: boolean;
    outcome?: CuRunResult['outcome'];
    result?: CuaSemanticPointerResult;
    pageTarget?: CuaResolvedPageTextTarget;
  }> {
    const processKind = await (opts.classifyProcess ?? classifyMacProcess)(window.pid);
    if (processKind !== 'electron') return { handled: false };
    const resolvePageTextTarget =
      opts.resolvePageTextTarget ?? ((input) => resolveCuaPageTextTarget(input));
    const pageTarget = await resolvePageTextTarget({
      pid: window.pid,
      ...(window.title ? { windowTitle: window.title } : {}),
      signal,
    });
    if (!pageTarget) {
      if (boundPage) {
        return {
          handled: true,
          outcome: {
            ok: false,
            error: 'page_target_changed',
            message: 'bound Electron page target is no longer uniquely available',
          },
        };
      }
      trace({
        type: 'fallback',
        toolCallId,
        actionType: action.type,
        from: 'semantic',
        to: 'pixel',
        reason: 'page_target_unavailable',
      });
      return {
        handled: true,
        outcome: compatibilityInputBlocked(action.type).outcome,
      };
    }
    const currentPage = await pageIdentity(window, pageTarget, signal);
    if (boundPage && !samePage(boundPage, currentPage)) {
      return {
        handled: true,
        outcome: {
          ok: false,
          error: 'page_target_changed',
          message: 'bound Electron page identity changed before dispatch',
        },
      };
    }

    trace({
      type: 'dispatch',
      toolCallId,
      actionType: action.type,
      tool: 'page',
      pid: window.pid,
      windowId: window.windowId,
      address: 'semantic',
    });
    const response = await actionClient.callTool(
      'page',
      {
        pid: window.pid,
        window_id: window.windowId,
        action: 'execute_javascript',
        javascript: buildCuaSemanticPointerActionScript(action),
        cdp_port: pageTarget.port,
        target_url_contains: pageTarget.targetUrlContains,
      },
      signal,
    );
    if (response?.isError) {
      const outcome = normalizeCuaDriverOutcome(response);
      trace({
        type: 'outcome',
        toolCallId,
        actionType: action.type,
        tool: 'page',
        outcome: traceOutcome(outcome),
      });
      return { handled: true, outcome };
    }
    const text = response?.content?.find(
      (content) => content.type === 'text' && typeof content.text === 'string',
    )?.text;
    const result = parseCuaSemanticPointerResult(text);
    if (!result) {
      const outcome: CuRunResult['outcome'] = {
        ok: false,
        error: 'capture_failed',
        message: 'cua-driver page action returned an invalid semantic result',
        evidence: { path: 'cdp', effect: 'unverifiable' },
      };
      trace({
        type: 'outcome',
        toolCallId,
        actionType: action.type,
        tool: 'page',
        outcome: traceOutcome(outcome),
      });
      return { handled: true, outcome };
    }
    trace({
      type: 'semantic_result',
      toolCallId,
      actionType: action.type,
      pid: window.pid,
      windowId: window.windowId,
      port: pageTarget.port,
      supported: result.supported,
      ok: result.ok,
      ...(result.reason ? { reason: result.reason } : {}),
      ...(result.effect ? { effect: result.effect } : {}),
      ...(result.tagName ? { tagName: result.tagName } : {}),
      ...(result.inputType ? { inputType: result.inputType } : {}),
    });
    if (!result.supported) {
      trace({
        type: 'fallback',
        toolCallId,
        actionType: action.type,
        from: 'semantic',
        to: 'pixel',
        reason: result.reason ?? 'unsupported_action',
      });
      return { handled: false, result };
    }
    const outcome: CuRunResult['outcome'] = result.ok
      ? {
          ok: true,
          tier: 'semantic-background',
          verified: true,
          evidence: { path: 'cdp', effect: 'confirmed' },
        }
      : {
          ok: false,
          error: 'outcome_unknown',
          message: `semantic pointer action did not verify (${result.reason ?? result.kind ?? action.type})`,
          evidence: { path: 'cdp', effect: 'unverifiable' },
        };
    trace({
      type: 'outcome',
      toolCallId,
      actionType: action.type,
      tool: 'page',
      outcome: traceOutcome(outcome),
    });
    return { handled: true, outcome, result, pageTarget };
  }

  return {
    async listApps(signal) {
      return withOperationQueue(signal, async (): Promise<CuAppSummary[]> => {
        const windows = await listWindowRecords(signal);
        const apps = new Map<string, CuAppSummary>();
        for (const window of windows) {
          if (
            window.layer !== 0 ||
            window.is_on_screen === false ||
            typeof window.pid !== 'number' ||
            typeof window.window_id !== 'number'
          )
            continue;
          const appId = appIdForWindow(window) ?? `pid:${window.pid}`;
          const current = apps.get(appId);
          if (current) {
            current.windowCount += 1;
            current.windows?.push({
              windowId: window.window_id,
              ...(typeof window.title === 'string' ? { title: window.title } : {}),
            });
          } else
            apps.set(appId, {
              appId,
              pid: window.pid,
              ...(typeof window.app_name === 'string' ? { name: window.app_name } : {}),
              windowCount: 1,
              windows: [
                {
                  windowId: window.window_id,
                  ...(typeof window.title === 'string' ? { title: window.title } : {}),
                },
              ],
            });
        }
        return [...apps.values()];
      });
    },

    async observeApp(input, signal, context) {
      return withOperationQueue(
        signal,
        () => observeWindow(input, signal, context),
        context.sessionId,
      );
    },

    async captureObservation(input, signal, context) {
      return withOperationQueue(
        signal,
        () => observeWindow(input, signal, context),
        context.sessionId,
      );
    },

    async runSemantic(action: CuSemanticAction, signal, context) {
      try {
        return await withOperationQueue(
          signal,
          async () => {
            const observation = observations.get(action.observationId);
            deleteObservation(action.observationId);
            if (!observation) {
              return {
                outcome: {
                  ok: false,
                  error: 'stale_frame',
                  message: 'observation is missing or already consumed',
                },
              };
            }
            if (
              observation.context.sessionId !== context.sessionId ||
              observation.context.turnId !== context.turnId
            ) {
              return {
                outcome: {
                  ok: false,
                  error: 'stale_frame',
                  message: 'observation belongs to another session or turn',
                },
              };
            }
            const validated = await validateStoredWindow(
              observation,
              context.boundAction,
              signal,
              'semantic',
            );
            if ('outcome' in validated) return validated;
            if (action.type === 'press_key') {
              const refetched = await refetchSemanticElement(observation, action, signal);
              if ('outcome' in refetched) return refetched;
              const resolvedScreenPoint = {
                x: refetched.frame.x + refetched.frame.w / 2,
                y: refetched.frame.y + refetched.frame.h / 2,
              };
              trace({
                type: 'dispatch',
                toolCallId: context.toolCallId,
                actionType: action.type,
                tool: 'press_key',
                pid: validated.pid,
                windowId: validated.windowId,
                address: 'ax',
              });
              const result = await actionClient.callTool(
                'press_key',
                {
                  pid: validated.pid,
                  window_id: validated.windowId,
                  element_index: refetched.element_index,
                  ...(refetched.element_token
                    ? { element_token: refetched.element_token }
                    : {}),
                  key: action.key,
                },
                signal,
              );
              const outcome = normalizeCuaDriverOutcome(result);
              if (!outcome.ok) return { outcome };
              let fresh: CuObservation;
              try {
                fresh = await observeResolvedWindow(validated, true, signal, context);
              } catch {
                return deliveredVerificationFailure('press_key', 'ax');
              }
              return {
                outcome,
                observation: fresh,
                resolvedScreenPoint,
                ...(fresh.screenshot ? { screenshot: fresh.screenshot } : {}),
              };
            }
            if (action.type === 'select_text' || action.type === 'secondary_action') {
              return {
                outcome: {
                  ok: false,
                  error: 'unsupported_action',
                  message: `semantic action '${action.type}' is not exposed by the pinned cua-driver registry`,
                },
              };
            }
            const refetched = await refetchSemanticElement(observation, action, signal);
            if ('outcome' in refetched) return refetched;
            const resolvedScreenPoint = {
              x: refetched.frame.x + refetched.frame.w / 2,
              y: refetched.frame.y + refetched.frame.h / 2,
            };
            // AX element actions address a freshly refetched element inside an
            // already-validated app/window. They do not hit-test screen pixels,
            // so another foreground window must not block background AXPress or
            // AXValue dispatch. Coordinate actions retain the z-order check in
            // validateBoundCoordinate.
            const args = {
              pid: validated.pid,
              window_id: validated.windowId,
              element_index: refetched.element_index,
              ...(refetched.element_token ? { element_token: refetched.element_token } : {}),
            };
            trace({
              type: 'dispatch',
              toolCallId: context.toolCallId,
              actionType: action.type,
              tool: action.type === 'click_element' ? 'click' : 'set_value',
              pid: validated.pid,
              windowId: validated.windowId,
              address: 'ax',
            });
            const result =
              action.type === 'click_element'
                ? await actionClient.callTool('click', args, signal)
                : action.type === 'set_value'
                  ? await actionClient.callTool(
                      'set_value',
                      { ...args, value: action.value },
                      signal,
                    )
                  : undefined;
            if (!result) {
              return {
                outcome: {
                  ok: false,
                  error: 'unsupported_action',
                  message: `semantic action '${action.type}' is not supported by cua-driver`,
                },
              };
            }
            const outcome = normalizeCuaDriverOutcome(result);
            if (!outcome.ok) return { outcome };
            let fresh: CuObservation;
            try {
              fresh = await observeResolvedWindow(validated, true, signal, context);
            } catch {
              return deliveredVerificationFailure(action.type, 'ax');
            }
            if (action.type === 'set_value') {
              const exactIndexElement = fresh.elements.find(
                (candidate) => candidate.elementId === String(refetched.element_index),
              );
              const matchingElements = fresh.elements.filter(
                (candidate) =>
                  candidate.role === refetched.role &&
                  candidate.label === refetched.label &&
                  candidate.frame !== undefined &&
                  candidate.frame.x === refetched.frame.x &&
                  candidate.frame.y === refetched.frame.y &&
                  candidate.frame.width === refetched.frame.w &&
                  candidate.frame.height === refetched.frame.h,
              );
              const readbackElement =
                exactIndexElement &&
                exactIndexElement.role === refetched.role &&
                exactIndexElement.label === refetched.label
                  ? exactIndexElement
                  : matchingElements.length === 1
                    ? matchingElements[0]
                    : undefined;
              if (
                !readbackElement ||
                readbackElement.value !== action.value
              ) {
                return {
                  ...deliveredVerificationFailure('set_value', 'ax'),
                  observation: fresh,
                  resolvedScreenPoint,
                  ...(fresh.screenshot ? { screenshot: fresh.screenshot } : {}),
                };
              }
              return {
                outcome: {
                  ok: true,
                  tier: 'ax',
                  verified: true,
                  evidence: { path: 'ax', effect: 'confirmed' },
                },
                observation: fresh,
                resolvedScreenPoint,
                ...(fresh.screenshot ? { screenshot: fresh.screenshot } : {}),
              };
            }
            return {
              outcome,
              observation: fresh,
              resolvedScreenPoint,
              ...(fresh.screenshot ? { screenshot: fresh.screenshot } : {}),
            };
          },
          context.sessionId,
        );
      } catch (error) {
        if (error instanceof CuaDriverCaptureError) return error.result;
        const failure = lifecycleFailure(error);
        if (failure) return failure;
        throw error;
      }
    },

    async inspectWindowAt(point, signal) {
      return withOperationQueue(signal, () => resolveWindowAt(point.x, point.y, signal));
    },

    async preflight(signal) {
      return withOperationQueue(signal, async () => {
        const r = await actionClient.callTool('check_permissions', { prompt: false }, signal);
        const sc = r?.structuredContent ?? {};
        return {
          accessibility: sc.accessibility === true,
          // Prefer the live ScreenCaptureKit probe over the cached boolean.
          screenRecording: sc.screen_recording_capturable === true || sc.screen_recording === true,
        };
      });
    },

    async run(action, signal, context: CuRunContext): Promise<CuRunResult> {
      const sessionGeneration = sessionGenerations.get(context.sessionId) ?? 0;
      try {
        return await withOperationQueue(
          signal,
          async () => {
            // A new turn invalidates any prior keyboard ownership before this action.
            targetForContext(context);
            // A left-click attempt transfers ownership. Clear the old target before
            // resolution/snapshot/dispatch so any failure leaves keyboard input
            // unowned instead of silently routing it to the previous window.
            if (action.type === 'left_click') targetsBySession.delete(context.sessionId);
            switch (action.type) {
              case 'screenshot': {
                const r = await captureClient.callTool('get_desktop_state', {}, signal);
                const img = r?.content?.find((c) => c.type === 'image');
                const sc = r?.structuredContent ?? {};
                // Remember the device frame width so getScale() can derive the true
                // device/logical ratio (see getScale — scale_factor is unreliable).
                if (typeof sc.screenshot_width === 'number' && sc.screenshot_width > 0) {
                  lastFrameWidthPx = sc.screenshot_width;
                }
                const screenshot = normalizeScreenshot(
                  img,
                  typeof sc.screenshot_width === 'number' ? sc.screenshot_width : 0,
                  typeof sc.screenshot_height === 'number' ? sc.screenshot_height : 0,
                  'frame',
                );
                if ('outcome' in screenshot) return screenshot;
                return { outcome: { ok: true, tier: 'coordinate-background' }, screenshot };
              }
              case 'left_click':
              case 'right_click':
              case 'middle_click':
              case 'double_click':
              case 'triple_click': {
                // Resolve the window under the point and click via pid+window_id, which
                // forces cua-driver's click_at_xy_with_window_local → CGEventPostToPid /
                // SLEventPostToPid — NO cursor warp (the forbidden pid-less path would
                // move the REAL cursor). Fail closed when no
                // app window owns the pixel (empty desktop), where the only path warps.
                const win = await coordinateTarget(context.boundAction, action.coordinate, signal);
                if (win && 'outcome' in win) return win;
                if (!win) {
                  return {
                    outcome: {
                      ok: false,
                      error: 'unsupported_action',
                      message:
                        `no app window under the click point (empty desktop / wallpaper) — refusing '${action.type}': ` +
                        "the only backend path there warps the user's real cursor. Click on an app window instead.",
                    },
                  };
                }
                trace({
                  type: 'target',
                  toolCallId: context.toolCallId,
                  actionType: action.type,
                  pid: win.pid,
                  windowId: win.windowId,
                  screenPoint: win.screenPoint,
                });
                if (
                  action.type === 'left_click' ||
                  action.type === 'right_click' ||
                  action.type === 'double_click'
                ) {
                  const semantic = await runElectronSemanticPointer(
                    { type: action.type, screenPoint: win.screenPoint },
                    win,
                    signal,
                    context.toolCallId,
                    context.boundAction?.target?.page,
                  );
                  if (semantic.handled && semantic.outcome) {
                    if (
                      semantic.outcome.ok &&
                      action.type === 'left_click' &&
                      (sessionGenerations.get(context.sessionId) ?? 0) === sessionGeneration
                    ) {
                      targetsBySession.set(context.sessionId, {
                        turnId: context.turnId,
                        target: {
                          window: win,
                          editable: semantic.result?.editable === true,
                          ...(semantic.pageTarget ? { pageTarget: semantic.pageTarget } : {}),
                        },
                      });
                    }
                    return { outcome: semantic.outcome, resolvedScreenPoint: win.screenPoint };
                  }
                }
                if (opts.allowCompatibilityInputDispatch !== true) {
                  return compatibilityInputBlocked(action.type);
                }
                {
                  let snapshot: TargetSnapshot;
                  try {
                    snapshot = await snapshotTarget(win, signal);
                  } catch (error) {
                    return {
                      outcome: {
                        ok: false as const,
                        error: 'capture_failed' as const,
                        message: (error as Error).message,
                      },
                    };
                  }
                  const editableElement = editableElementAtScreenPoint(
                    snapshot.elements,
                    win.screenPoint,
                  );
                  const element =
                    action.type === 'middle_click' ||
                    action.type === 'double_click' ||
                    action.type === 'triple_click' ||
                    editableElement !== undefined
                      ? undefined
                      : elementAtScreenPoint(snapshot.elements, win.screenPoint);
                  trace({
                    type: 'snapshot',
                    toolCallId: context.toolCallId,
                    actionType: action.type,
                    pid: win.pid,
                    windowId: win.windowId,
                    windowPoint: snapshot.windowPoint,
                    containingElements: snapshot.elements.flatMap((candidate) => {
                      if (
                        typeof candidate.element_index !== 'number' ||
                        typeof candidate.role !== 'string' ||
                        typeof candidate.depth !== 'number' ||
                        !candidate.frame ||
                        typeof candidate.frame !== 'object'
                      )
                        return [];
                      const frame = candidate.frame as Record<string, unknown>;
                      if (
                        typeof frame.x !== 'number' ||
                        typeof frame.y !== 'number' ||
                        typeof frame.w !== 'number' ||
                        typeof frame.h !== 'number'
                      )
                        return [];
                      const inside =
                        win.screenPoint.x >= frame.x &&
                        win.screenPoint.x < frame.x + frame.w &&
                        win.screenPoint.y >= frame.y &&
                        win.screenPoint.y < frame.y + frame.h;
                      return inside
                        ? [
                            {
                              elementIndex: candidate.element_index,
                              role: candidate.role,
                              depth: candidate.depth,
                              frame: {
                                x: frame.x,
                                y: frame.y,
                                w: frame.w,
                                h: frame.h,
                              },
                            },
                          ]
                        : [];
                    }),
                    ...(editableElement
                      ? { editableElementIndex: editableElement.element_index }
                      : {}),
                    ...(element ? { clickableElementIndex: element.element_index } : {}),
                  });
                  const args: Record<string, unknown> = {
                    pid: win.pid,
                    window_id: win.windowId,
                    x: snapshot.windowPoint.x,
                    y: snapshot.windowPoint.y,
                  };
                  if (action.type === 'right_click') args.button = 'right';
                  if (action.type === 'middle_click') args.button = 'middle';
                  if (action.type === 'triple_click') args.count = 3;
                  const toolName = action.type === 'double_click' ? 'double_click' : 'click';
                  const intervention = await physicalInputFailure();
                  if (intervention) return intervention;
                  trace({
                    type: 'dispatch',
                    toolCallId: context.toolCallId,
                    actionType: action.type,
                    tool: toolName,
                    pid: win.pid,
                    windowId: win.windowId,
                    address: 'px',
                  });
                  const r = await actionClient.callTool(toolName, args, signal);
                  const outcome = normalizeCuaDriverOutcome(r);
                  trace({
                    type: 'outcome',
                    toolCallId: context.toolCallId,
                    actionType: action.type,
                    tool: toolName,
                    outcome: traceOutcome(outcome),
                  });
                  if (
                    outcome.ok &&
                    action.type === 'left_click' &&
                    (sessionGenerations.get(context.sessionId) ?? 0) === sessionGeneration
                  ) {
                    targetsBySession.set(context.sessionId, {
                      turnId: context.turnId,
                      target: {
                        window: win,
                        editable: editableElement !== undefined,
                      },
                    });
                  }
                  return { outcome, resolvedScreenPoint: win.screenPoint };
                }
              }
              case 'scroll': {
                if (opts.allowCompatibilityInputDispatch !== true) {
                  return compatibilityInputBlocked(action.type);
                }
                // Scroll REQUIRES a pid and posts via scroll_wheel_at_xy → post_to_pid
                // (no cursor warp — the warp only exists in the empty-desktop click path).
                // Resolve the window under the point and scroll it window-locally; fail
                // closed on empty desktop (nothing scrollable there anyway).
                const win = await coordinateTarget(context.boundAction, action.coordinate, signal);
                if (win && 'outcome' in win) return win;
                if (!win) {
                  return {
                    outcome: {
                      ok: false,
                      error: 'unsupported_action',
                      message:
                        "no app window under the scroll point (empty desktop) — refusing 'scroll'. Scroll over an app window instead.",
                    },
                  };
                }
                {
                  let snapshot: TargetSnapshot;
                  try {
                    snapshot = await snapshotTarget(win, signal);
                  } catch (error) {
                    return {
                      outcome: {
                        ok: false as const,
                        error: 'capture_failed' as const,
                        message: (error as Error).message,
                      },
                    };
                  }
                  const intervention = await physicalInputFailure();
                  if (intervention) return intervention;
                  const r = await actionClient.callTool(
                    'scroll',
                    {
                      pid: win.pid,
                      window_id: win.windowId,
                      x: snapshot.windowPoint.x,
                      y: snapshot.windowPoint.y,
                      direction: action.scrollDirection,
                      amount: action.scrollAmount,
                    },
                    signal,
                  );
                  return {
                    outcome: normalizeCuaDriverOutcome(r),
                    resolvedScreenPoint: win.screenPoint,
                  };
                }
              }
              case 'left_click_drag': {
                if (opts.allowCompatibilityInputDispatch !== true) {
                  return compatibilityInputBlocked(action.type);
                }
                // Press-drag-release WITHIN a single window. cua-driver's `drag` sends the
                // whole down→(interpolated moves)→up sequence through the SAME window-local
                // post_mouse_event → SLEventPostToPid/CGEventPostToPid path as click
                // (source-verified against cua-driver-rs v0.7.1: no cursor warp exists
                // on the PID-bound drag path; drag requires a PID)
                // is required). So a pid+window_id drag never moves the user's REAL cursor.
                // We resolve BOTH endpoints and require the SAME window: a window-local drag
                // cannot cross windows, and cross-app drag-and-drop needs a real
                // NSDraggingSession this synthetic post_to_pid path cannot establish
                // (cua-driver itself marks the result unverifiable). Fail closed on empty
                // desktop (no target window ⇒ no required pid to post to) or cross-window.
                // delivery_mode is left DEFAULT (Background) — never 'foreground', which
                // would briefly reorder window z-order/frontmost (a focus disturbance).
                const from = await coordinateTarget(
                  context.boundAction,
                  action.startCoordinate,
                  signal,
                  true,
                );
                if (from && 'outcome' in from) return from;
                const to = await coordinateTarget(context.boundAction, action.coordinate, signal);
                if (to && 'outcome' in to) return to;
                if (!from || !to) {
                  return {
                    outcome: {
                      ok: false,
                      error: 'unsupported_action',
                      message:
                        'drag endpoint is not over an app window (empty desktop) — refusing: the drag needs a target window/pid. ' +
                        'Drag within a single app window instead.',
                    },
                  };
                }
                if (from.pid !== to.pid || from.windowId !== to.windowId) {
                  return {
                    outcome: {
                      ok: false,
                      error: 'unsupported_action',
                      message:
                        'drag endpoints span different windows — refusing: a background window-local drag cannot cross windows, ' +
                        'and cross-app drag-and-drop needs a real drag session. Keep both endpoints inside one window.',
                    },
                  };
                }
                const semantic = await runElectronSemanticPointer(
                  {
                    type: 'left_click_drag',
                    startScreenPoint: from.screenPoint,
                    endScreenPoint: to.screenPoint,
                  },
                  from,
                  signal,
                  context.toolCallId,
                  context.boundAction?.target?.page,
                );
                if (semantic.handled && semantic.outcome) {
                  return { outcome: semantic.outcome, resolvedScreenPoint: to.screenPoint };
                }
                {
                  let snapshot: TargetSnapshot;
                  try {
                    snapshot = await snapshotTarget(from, signal);
                  } catch (error) {
                    return {
                      outcome: {
                        ok: false as const,
                        error: 'capture_failed' as const,
                        message: (error as Error).message,
                      },
                    };
                  }
                  const toPoint = windowPointFromSnapshot({
                    screenPoint: to.screenPoint,
                    windowBounds: from.bounds,
                    screenshotWidthPx: snapshot.screenshotWidthPx,
                    screenshotHeightPx: snapshot.screenshotHeightPx,
                  });
                  if (!toPoint) {
                    return {
                      outcome: {
                        ok: false as const,
                        error: 'invalid_coordinate' as const,
                        message: 'drag endpoint does not map into the target window snapshot',
                      },
                    };
                  }
                  const intervention = await physicalInputFailure();
                  if (intervention) return intervention;
                  const r = await actionClient.callTool(
                    'drag',
                    {
                      pid: from.pid,
                      window_id: from.windowId,
                      from_x: snapshot.windowPoint.x,
                      from_y: snapshot.windowPoint.y,
                      to_x: toPoint.x,
                      to_y: toPoint.y,
                    },
                    signal,
                  );
                  return {
                    outcome: normalizeCuaDriverOutcome(r),
                    resolvedScreenPoint: to.screenPoint,
                  };
                }
              }
              case 'zoom': {
                // cua-driver zoom is window-scoped. Resolve both region corners in
                // the declared desktop pixel space and require one owning window,
                // then convert the crop to that window's screenshot-pixel space.
                const x1 = Math.min(action.region.x1, action.region.x2);
                const y1 = Math.min(action.region.y1, action.region.y2);
                const x2 = Math.max(action.region.x1, action.region.x2);
                const y2 = Math.max(action.region.y1, action.region.y2);
                const topLeft = await coordinateTarget(
                  context.boundAction,
                  { x: x1, y: y1 },
                  signal,
                  true,
                  false,
                );
                if (topLeft && 'outcome' in topLeft) return topLeft;
                const bottomRight = await coordinateTarget(
                  context.boundAction,
                  { x: x2, y: y2 },
                  signal,
                  false,
                  false,
                );
                if (bottomRight && 'outcome' in bottomRight) return bottomRight;
                if (!topLeft || !bottomRight) {
                  return {
                    outcome: {
                      ok: false,
                      error: 'unsupported_action',
                      message: 'zoom region is not fully contained in an app window.',
                    },
                  };
                }
                if (topLeft.pid !== bottomRight.pid || topLeft.windowId !== bottomRight.windowId) {
                  return {
                    outcome: {
                      ok: false,
                      error: 'unsupported_action',
                      message:
                        'zoom region spans different windows; keep the region inside one app window.',
                    },
                  };
                }
                {
                  let snapshot: TargetSnapshot;
                  try {
                    snapshot = await snapshotTarget(topLeft, signal);
                  } catch (error) {
                    return {
                      outcome: {
                        ok: false as const,
                        error: 'capture_failed' as const,
                        message: (error as Error).message,
                      },
                    };
                  }
                  const bottomRightPoint = windowPointFromSnapshot({
                    screenPoint: bottomRight.screenPoint,
                    windowBounds: topLeft.bounds,
                    screenshotWidthPx: snapshot.screenshotWidthPx,
                    screenshotHeightPx: snapshot.screenshotHeightPx,
                  });
                  if (!bottomRightPoint) {
                    return {
                      outcome: {
                        ok: false as const,
                        error: 'invalid_coordinate' as const,
                        message: 'zoom region does not map into the target window snapshot',
                      },
                    };
                  }
                  const r = await actionClient.callTool(
                    'zoom',
                    {
                      pid: topLeft.pid,
                      window_id: topLeft.windowId,
                      x1: snapshot.windowPoint.x,
                      y1: snapshot.windowPoint.y,
                      x2: bottomRightPoint.x,
                      y2: bottomRightPoint.y,
                    },
                    signal,
                  );
                  if (r?.isError) return { outcome: normalizeCuaDriverOutcome(r) };
                  const image = r?.content?.find((content) => content.type === 'image');
                  if (!image?.data) {
                    return {
                      outcome: {
                        ok: false as const,
                        error: 'capture_failed' as const,
                        message: 'zoom returned no image',
                      },
                    };
                  }
                  const byteLength = Buffer.from(image.data, 'base64').byteLength;
                  if (exceedsCuaDriverFrameCap(byteLength)) {
                    return {
                      outcome: {
                        ok: false as const,
                        error: 'sensitivity_blocked' as const,
                        message: `zoom frame ${byteLength}B exceeds cap`,
                      },
                    };
                  }
                  const fresh = await observeResolvedWindow(topLeft, true, signal, context);
                  return {
                    outcome: {
                      ok: true as const,
                      tier: 'coordinate-background' as const,
                      verified: false,
                      evidence: { path: 'screenshot-detail', effect: 'unverifiable' },
                    },
                    observation: fresh,
                    ...(fresh.screenshot ? { screenshot: fresh.screenshot } : {}),
                  };
                }
              }
              case 'type':
              case 'key': {
                // Target-bound keyboard: `type` may fill a native empty AX field only
                // after fresh read-back. `key` is refused because cua-driver reports
                // key events as unverifiable and user clicks can redirect renderer focus.
                const target = targetForContext(context);
                if (!target) {
                  return {
                    outcome: {
                      ok: false,
                      error: 'unsupported_action',
                      message:
                        `keyboard action '${action.type}' has no target window yet — refusing: ` +
                        'click an editable native field before a verified text fill.',
                    },
                  };
                }
                if (action.type === 'type') {
                  try {
                    return { outcome: await fillEditableTarget(target, action.text, signal) };
                  } catch (error) {
                    const failure = lifecycleFailure(error);
                    if (failure) return failure;
                    return {
                      outcome: {
                        ok: false,
                        error: 'capture_failed',
                        message: (error as Error).message,
                      },
                    };
                  }
                }
                return {
                  outcome: {
                    ok: false,
                    error: 'unsupported_action',
                    message: 'background key chords cannot be verified without risking focus races',
                  },
                };
              }
              case 'wait':
                await new Promise((res) => setTimeout(res, Math.min(action.durationMs, 10_000)));
                return { outcome: { ok: true, tier: 'coordinate-background' } };
              case 'cursor_position': {
                const result = await actionClient.callTool('get_cursor_position', {}, signal);
                const structured = result?.structuredContent ?? {};
                if (
                  result?.isError ||
                  typeof structured.x !== 'number' ||
                  !Number.isFinite(structured.x) ||
                  typeof structured.y !== 'number' ||
                  !Number.isFinite(structured.y)
                ) {
                  return {
                    outcome: {
                      ok: false,
                      error: 'capture_failed',
                      message: 'cua-driver returned an invalid cursor position',
                    },
                  };
                }
                return {
                  outcome: { ok: true, tier: 'coordinate-background' },
                  resolvedScreenPoint: { x: structured.x, y: structured.y },
                };
              }
              case 'mouse_move': {
                const win = await coordinateTarget(context.boundAction, action.coordinate, signal);
                if (win && 'outcome' in win) return win;
                if (!win) {
                  return {
                    outcome: {
                      ok: false,
                      error: 'target_missing',
                      message: 'no bound app window at the requested cursor point',
                    },
                  };
                }
                return {
                  outcome: { ok: true, tier: 'coordinate-background' },
                  resolvedScreenPoint: win.screenPoint,
                };
              }
              default:
                return {
                  outcome: {
                    ok: false,
                    error: 'unsupported_action',
                    message: `action '${action.type}' not mapped to cua-driver`,
                  },
                };
            }
          },
          context.sessionId,
        );
      } catch (error) {
        const failure = lifecycleFailure(error);
        if (failure) return failure;
        throw error;
      }
    },

    serviceState() {
      return {
        action: actionClient.snapshot(),
        capture: captureClient.snapshot(),
      };
    },

    clearSession(sessionId) {
      const releases: CuaDriverReleaseEvent[] = [];
      sessionClearReleaseEvents = releases;
      try {
        actionClient.clearSession(sessionId);
        captureClient.clearSession(sessionId);
      } finally {
        sessionClearReleaseEvents = undefined;
      }
      if (releases.length > 0) {
        applyServiceRelease(releases);
      } else {
        clearLocalSession(sessionId);
      }
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      targetsBySession.clear();
      observations.clear();
      observationIdsBySession.clear();
      sessionGenerations.clear();
      const errors: unknown[] = [];
      for (const client of [actionClient, captureClient]) {
        try {
          client.dispose();
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length > 0) {
        throw new AggregateError(errors, 'failed to dispose cua-driver services');
      }
    },
  };
}
