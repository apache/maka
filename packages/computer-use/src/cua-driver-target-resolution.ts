import type { ComputerUseDisplayIdentity, ComputerUsePageIdentity } from '@maka/core';
import type {
  CuaBoundAction,
  CuObservedElement,
  CuRunContext,
  CuRunResult,
  CuSemanticAction,
} from '@maka/runtime';
import { normalizeCuaDriverOutcome } from './cua-driver-result.js';
import type { CuaDriverJsonRpcResponse } from './cua-driver-service.js';
import {
  normalizeCuaSnapshotElement,
  type CuaResolvedWindow,
  type CuaSnapshotElement,
  type CuaWindowRecord,
} from './cua-driver-snapshot.js';

type CuaNormalizedElement = NonNullable<ReturnType<typeof normalizeCuaSnapshotElement>>;

export interface CuaStoredObservation {
  context: Pick<CuRunContext, 'sessionId' | 'turnId'>;
  appId: string;
  window: CuaResolvedWindow;
  elements: Map<string, CuaNormalizedElement>;
  contentFingerprint: string;
  page?: ComputerUsePageIdentity;
  screenshotWidthPx?: number;
  screenshotHeightPx?: number;
  displays?: ComputerUseDisplayIdentity[];
}

interface CuaWindowStateRequest {
  pid: number;
  windowId: number;
  includeScreenshot: boolean;
  maxElements: number;
  maxDepth: number;
}

interface CuaOcclusionTrace {
  expectedPid: number;
  expectedWindowId: number;
  winnerPid?: number;
  winnerWindowId?: number;
  winnerZIndex?: number;
}

interface CuaWindowOwner {
  pid: number;
  windowId: number;
  zIndex: number;
}

export interface CuaTargetResolutionDeps {
  listWindowRecords(signal: AbortSignal): Promise<CuaWindowRecord[]>;
  getWindowState(
    input: CuaWindowStateRequest,
    signal: AbortSignal,
  ): Promise<CuaDriverJsonRpcResponse['result']>;
  resolveWindowAt(
    x: number,
    y: number,
    signal: AbortSignal,
  ): Promise<CuaResolvedWindow | undefined>;
  resolveObservedWindow(
    windows: readonly CuaWindowRecord[],
    app: string | undefined,
    windowId?: number,
  ): CuaResolvedWindow;
  resolveObservedPage(
    window: CuaResolvedWindow,
    signal: AbortSignal,
  ): Promise<ComputerUsePageIdentity | undefined>;
  samePage(
    left: ComputerUsePageIdentity | undefined,
    right: ComputerUsePageIdentity | undefined,
  ): boolean;
  resolveContentFingerprint(elements: readonly CuaNormalizedElement[]): string;
  takeObservation(observationId: string): CuaStoredObservation | undefined;
  traceOcclusion(event: CuaOcclusionTrace): void;
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

function sameDisplay(left: ComputerUseDisplayIdentity, right: ComputerUseDisplayIdentity): boolean {
  return (
    left.displayId === right.displayId &&
    left.scaleFactor === right.scaleFactor &&
    sameBounds(left.logicalBounds, right.logicalBounds) &&
    sameBounds(left.sourceBoundsPx, right.sourceBoundsPx)
  );
}

function topWindowAtPoint(
  windows: readonly CuaWindowRecord[],
  point: { x: number; y: number },
): CuaWindowOwner | undefined {
  return windows
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
        point.x >= bounds.x &&
        point.x < bounds.x + bounds.width &&
        point.y >= bounds.y &&
        point.y < bounds.y + bounds.height;
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
}

function elementMatchesIdentity(
  element: CuaNormalizedElement,
  identity: CuObservedElement['identity'] | undefined,
  original?: CuaNormalizedElement,
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

function dedupeSemanticElements(elements: CuaNormalizedElement[]): CuaNormalizedElement[] {
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

export function consumeSemanticObservation(
  deps: CuaTargetResolutionDeps,
  observationId: string,
  context: Pick<CuRunContext, 'sessionId' | 'turnId'>,
): CuaStoredObservation | CuRunResult {
  const observation = deps.takeObservation(observationId);
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
  return observation;
}

export async function validateSemanticElementVisibility(
  deps: CuaTargetResolutionDeps,
  window: CuaResolvedWindow,
  element: CuaNormalizedElement,
  signal: AbortSignal,
): Promise<CuRunResult | undefined> {
  const point = {
    x: element.frame.x + element.frame.w / 2,
    y: element.frame.y + element.frame.h / 2,
  };
  if (
    point.x < window.bounds.x ||
    point.x >= window.bounds.x + window.bounds.width ||
    point.y < window.bounds.y ||
    point.y >= window.bounds.y + window.bounds.height
  ) {
    return {
      outcome: {
        ok: false,
        error: 'target_changed',
        message: 'semantic element moved outside the observed target window',
      },
    };
  }
  const winner = topWindowAtPoint(await deps.listWindowRecords(signal), point);
  if (!winner || winner.pid !== window.pid || winner.windowId !== window.windowId) {
    deps.traceOcclusion({
      expectedPid: window.pid,
      expectedWindowId: window.windowId,
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
        message: 'another window now owns the semantic element position',
      },
    };
  }
  return undefined;
}

export async function validateStoredWindow(
  deps: CuaTargetResolutionDeps,
  observation: CuaStoredObservation,
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
  const windows = await deps.listWindowRecords(signal);
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
  const resolved = deps.resolveObservedWindow(
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
    const page = await deps.resolveObservedPage(resolved, signal);
    if (!deps.samePage(observation.page, page)) {
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
    const currentState = await deps.getWindowState(
      {
        pid: resolved.pid,
        windowId: resolved.windowId,
        includeScreenshot: false,
        maxElements: 500,
        maxDepth: 25,
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
    const currentFingerprint = deps.resolveContentFingerprint(currentElements);
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

export function boundWindowPoint(
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

export async function validateBoundCoordinate(
  deps: CuaTargetResolutionDeps,
  bound: CuaBoundAction | undefined,
  signal: AbortSignal,
  start = false,
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
  const stored: CuaStoredObservation = {
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
  const validated = await validateStoredWindow(deps, stored, bound, signal, 'coordinate');
  if ('outcome' in validated) return validated;
  const currentState = await deps.getWindowState(
    {
      pid: validated.pid,
      windowId: validated.windowId,
      includeScreenshot: false,
      maxElements: 0,
      maxDepth: 0,
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
  const winner = topWindowAtPoint(await deps.listWindowRecords(signal), point.screenPoint);
  if (!winner || winner.pid !== validated.pid || winner.windowId !== validated.windowId) {
    deps.traceOcclusion({
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

export async function coordinateTarget(
  deps: CuaTargetResolutionDeps,
  bound: CuaBoundAction | undefined,
  fallback: { x: number; y: number },
  signal: AbortSignal,
  start = false,
): Promise<CuaResolvedWindow | CuRunResult | undefined> {
  if (bound) return validateBoundCoordinate(deps, bound, signal, start);
  return deps.resolveWindowAt(fallback.x, fallback.y, signal);
}

export async function refetchSemanticElement(
  deps: CuaTargetResolutionDeps,
  observation: CuaStoredObservation,
  action: Exclude<CuSemanticAction, { type: 'press_key' }>,
  signal: AbortSignal,
): Promise<CuaNormalizedElement | CuRunResult> {
  const state = await deps.getWindowState(
    {
      pid: observation.window.pid,
      windowId: observation.window.windowId,
      includeScreenshot: false,
      maxElements: 500,
      maxDepth: 25,
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
