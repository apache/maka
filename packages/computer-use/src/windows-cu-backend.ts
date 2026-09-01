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

/* Windows Computer Use adapter for maka.cu.windows/0. */
import type { CuAction, ComputerUseErrorCode } from '@maka/core/computer-use';
import type {
  CuAppSummary,
  CuDispatchBackend,
  CuObservation,
  CuObservedElement,
  CuRunContext,
  CuRunResult,
  CuSemanticAction,
} from '@maka/runtime/computer-use-types';
import {
  WindowsCuLifecycleError,
  WindowsCuService,
  type WindowsCuReleaseEvent,
  type WindowsCuServiceOptions,
} from './windows-cu-service.js';

type NativeWindow = {
  hwnd: number;
  pid: number;
  title?: string;
  className?: string;
  isOffscreen?: boolean;
};
type Target = {
  hwnd: number;
  pid: number;
  title?: string;
  processStartTimeUtc: string | number;
  windowGeneration: string;
};
type SnapshotRef = { snapshotId: string; target: Target; byElement: Map<string, string> };

export interface WindowsCuBackendOptions extends WindowsCuServiceOptions {
  service?: WindowsCuService;
  onSessionInvalidated?: (input: {
    sessionId: string;
    reason: WindowsCuReleaseEvent['reason'];
    outcomeUnknown: boolean;
  }) => void;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}
function number(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
function obj(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
function failure(
  error: ComputerUseErrorCode,
  message: string,
  path = 'windows.native',
): CuRunResult {
  return { outcome: { ok: false, error, message, messageIsAppTextFree: true, evidence: { path } } };
}
function unsupported(action: string): CuRunResult {
  return failure(
    'unsupported_action',
    `Windows native Computer Use does not support '${action}'. No input was dispatched.`,
    'windows.native.unsupported',
  );
}

function windowsFrom(value: unknown): NativeWindow[] {
  const root = obj(value);
  const entries = root?.windows;
  if (!Array.isArray(entries)) return [];
  return entries.flatMap((entry) => {
    const e = obj(entry);
    const hwnd = number(e?.hwnd);
    const pid = number(e?.pid);
    if (hwnd === undefined || pid === undefined || hwnd <= 0 || pid <= 0) return [];
    return [
      {
        hwnd,
        pid,
        ...(text(e?.title) ? { title: e!.title as string } : {}),
        ...(text(e?.className) ? { className: e!.className as string } : {}),
        ...(typeof e?.isOffscreen === 'boolean' ? { isOffscreen: e.isOffscreen } : {}),
      },
    ];
  });
}

export function createWindowsCuBackend(options: WindowsCuBackendOptions): CuDispatchBackend & {
  executorState: () => ReturnType<WindowsCuService['snapshot']>;
  dispose: () => void;
  clearSession: (sessionId: string) => void;
} {
  let observationCounter = 0;
  const observations = new Map<string, Map<string, SnapshotRef>>();

  const sessionObservations = (sessionId: string) => {
    let map = observations.get(sessionId);
    if (!map) {
      map = new Map();
      observations.set(sessionId, map);
    }
    return map;
  };
  const invalidate = (event: WindowsCuReleaseEvent) => {
    const unknownSessions = new Set(event.sessionIds);
    const sessions = new Set([...observations.keys(), ...event.sessionIds]);
    for (const sessionId of sessions) {
      observations.delete(sessionId);
      options.onSessionInvalidated?.({
        sessionId,
        reason: event.reason,
        outcomeUnknown: event.outcomeUnknown && unknownSessions.has(sessionId),
      });
    }
  };
  // The service callback is composed here so restart/session invalidation is
  // visible to Runtime while preserving any host callback used by callers.
  const ownedService =
    options.service ??
    new WindowsCuService({
      ...options,
      onRelease: (event) => {
        invalidate(event);
        options.onRelease?.(event);
      },
    });
  if (options.service) {
    ownedService.subscribeRelease(invalidate);
    ownedService.subscribeRelease((event) => options.onRelease?.(event));
  }

  async function listWindows(signal: AbortSignal, sessionId?: string): Promise<NativeWindow[]> {
    return windowsFrom(await ownedService.call('list_windows', {}, signal, sessionId));
  }
  async function resolveWindow(
    input: { app?: string; windowId?: number },
    signal: AbortSignal,
    sessionId?: string,
  ): Promise<NativeWindow | CuRunResult> {
    const windows = await listWindows(signal, sessionId);
    let matches = windows;
    if (input.windowId !== undefined)
      matches = matches.filter((window) => window.hwnd === input.windowId);
    if (input.app) {
      const app = input.app.trim().toLowerCase();
      matches = matches.filter(
        (window) =>
          `pid:${window.pid}`.toLowerCase() === app ||
          String(window.hwnd) === input.app ||
          window.title?.toLowerCase().includes(app) === true,
      );
    }
    if (matches.length === 0)
      return failure(
        'target_missing',
        'The requested Windows window is no longer running.',
        'windows.native.target',
      );
    if (matches.length !== 1)
      return failure(
        'ambiguous_target',
        'More than one running Windows window matched; specify window_id.',
        'windows.native.target',
      );
    return matches[0]!;
  }
  function parseTarget(value: unknown): Target | undefined {
    const t = obj(value);
    const hwnd = number(t?.hwnd);
    const pid = number(t?.pid);
    const start =
      typeof t?.processStartTimeUtc === 'string' || typeof t?.processStartTimeUtc === 'number'
        ? t.processStartTimeUtc
        : undefined;
    const generation = text(t?.windowGeneration);
    if (hwnd === undefined || pid === undefined || start === undefined || generation === undefined)
      return undefined;
    return {
      hwnd,
      pid,
      processStartTimeUtc: start,
      windowGeneration: generation,
      ...(text(t?.title) ? { title: t!.title as string } : {}),
    };
  }
  function parseBounds(value: unknown): CuObservedElement['frame'] | undefined {
    if (!Array.isArray(value) || value.length < 4) return undefined;
    const [x, y, width, height] = value.map(number);
    return [x, y, width, height].every((v) => v !== undefined)
      ? { x: x!, y: y!, width: width!, height: height! }
      : undefined;
  }
  function parseObservation(
    raw: Record<string, unknown>,
    window: NativeWindow,
    includeScreenshot: boolean,
    sessionId: string,
  ): CuObservation | undefined {
    const snapshotId = text(raw.snapshotId);
    const target = parseTarget(raw.target);
    const tree = obj(raw.tree);
    const nodes = Array.isArray(tree?.nodes) ? tree.nodes : [];
    if (!snapshotId || !target) return undefined;
    const observationId = `windows-${++observationCounter}`;
    const byElement = new Map<string, string>();
    const elements: CuObservedElement[] = nodes.flatMap((item, index) => {
      const node = obj(item);
      const token = text(node?.token);
      if (!node || !token) return [];
      const elementId = `element-${observationCounter}-${index + 1}`;
      byElement.set(elementId, token);
      const controlType = text(node.controlType) ?? 'unknown';
      const role = controlType.replace(/^ControlType\./, '').toLowerCase();
      const element: CuObservedElement = {
        elementId,
        role,
        ...(text(node.name) ? { label: node.name as string } : {}),
        ...(stringValue(node.value) !== undefined ? { value: node.value as string } : {}),
        ...(typeof node.isEnabled === 'boolean' ? { enabled: node.isEnabled } : {}),
        ...(parseBounds(node.bounds) ? { frame: parseBounds(node.bounds) } : {}),
        identity: {
          token,
          role,
          ...(text(node.name) ? { label: node.name as string } : {}),
          ...(stringValue(node.value) !== undefined ? { value: node.value as string } : {}),
        },
      };
      return [element];
    });
    const observation: CuObservation = {
      observationId,
      appId: `pid:${target.pid}`,
      pid: target.pid,
      windowId: target.hwnd,
      ...(target.title
        ? { windowTitle: target.title }
        : window.title
          ? { windowTitle: window.title }
          : {}),
      capturedAt: Date.now(),
      truncated: tree?.truncated === true,
      elements,
    };
    sessionObservations(sessionId).set(observationId, { snapshotId, target, byElement });
    return observation;
  }
  async function capture(target: Target, signal: AbortSignal, sessionId: string) {
    const raw = await ownedService.call('capture', target, signal, sessionId);
    const root = obj(raw);
    const frame = obj(root?.frame) ?? root;
    const base64 = text(frame?.base64);
    const widthPx = number(frame?.width);
    const heightPx = number(frame?.height);
    if (!base64 || widthPx === undefined || heightPx === undefined) return undefined;
    return { base64, mimeType: 'image/png' as const, widthPx, heightPx };
  }

  const backend: CuDispatchBackend & {
    executorState: () => ReturnType<WindowsCuService['snapshot']>;
    dispose: () => void;
    clearSession: (sessionId: string) => void;
  } = {
    async preflight(signal) {
      const handshake = await ownedService.ensureStarted(signal);
      const capabilities = obj(handshake.capabilities);
      const observation = obj(capabilities?.observation);
      const captureCapability = obj(capabilities?.capture);
      return {
        accessibility: observation?.uia === true,
        screenRecording: captureCapability?.targetWindowWgc === true,
      };
    },
    async listApps(signal): Promise<CuAppSummary[]> {
      const windows = await listWindows(signal);
      const grouped = new Map<number, NativeWindow[]>();
      for (const window of windows)
        grouped.set(window.pid, [...(grouped.get(window.pid) ?? []), window]);
      return [...grouped].map(([pid, groupedWindows]) => ({
        appId: `pid:${pid}`,
        pid,
        ...(groupedWindows[0]?.title ? { name: groupedWindows[0].title } : {}),
        windowCount: groupedWindows.length,
        windows: groupedWindows.map((window) => ({
          windowId: window.hwnd,
          ...(window.title ? { title: window.title } : {}),
        })),
      }));
    },
    async observeApp(input, signal, context) {
      const selected = await resolveWindow(input, signal, context.sessionId);
      if (!('hwnd' in selected))
        throw new Error(
          `${selected.outcome.ok ? 'target_missing' : selected.outcome.error}: ${selected.outcome.ok ? 'No Windows target was selected.' : selected.outcome.message}`,
        );
      const raw = await ownedService.call(
        'observe',
        { hwnd: selected.hwnd },
        signal,
        context.sessionId,
      );
      const observation = parseObservation(
        raw,
        selected,
        input.includeScreenshot,
        context.sessionId,
      );
      if (!observation)
        throw new Error('service_unavailable: Windows helper returned an invalid observation');
      if (input.includeScreenshot) {
        const ref = sessionObservations(context.sessionId).get(observation.observationId);
        const screenshot = ref ? await capture(ref.target, signal, context.sessionId) : undefined;
        if (!screenshot)
          throw new Error('capture_failed: Windows Graphics Capture returned no frame');
        observation.screenshot = screenshot;
      }
      return observation;
    },
    async captureObservation(input, signal, context) {
      const selected = await resolveWindow(input, signal, context.sessionId);
      if (!('hwnd' in selected))
        throw new Error(
          `${selected.outcome.ok ? 'target_missing' : selected.outcome.error}: ${selected.outcome.ok ? 'No Windows target was selected.' : selected.outcome.message}`,
        );
      const raw = await ownedService.call(
        'observe',
        { hwnd: selected.hwnd },
        signal,
        context.sessionId,
      );
      const observation = parseObservation(
        raw,
        selected,
        input.includeScreenshot,
        context.sessionId,
      );
      if (!observation)
        throw new Error('service_unavailable: Windows helper returned an invalid observation');
      const ref = sessionObservations(context.sessionId).get(observation.observationId);
      if (input.includeScreenshot && ref) {
        const screenshot = await capture(ref.target, signal, context.sessionId);
        if (!screenshot)
          throw new Error('capture_failed: Windows Graphics Capture returned no frame');
        observation.screenshot = screenshot;
      }
      return observation;
    },
    async runSemantic(action: CuSemanticAction, signal, context): Promise<CuRunResult> {
      if (action.type !== 'click_element' && action.type !== 'set_value')
        return unsupported(action.type);
      const session = observations.get(context.sessionId);
      const ref = session?.get(action.observationId);
      if (!ref)
        return failure(
          'stale_frame',
          'The observation is no longer valid; observe the window again.',
          'windows.native.snapshot',
        );
      const token = ref.byElement.get(action.elementId);
      if (!token)
        return failure(
          'stale_frame',
          'The element id is not present in that observation; observe the window again.',
          'windows.native.snapshot',
        );
      // Native snapshots are single use. Spend the local lease first so a
      // retry cannot dispatch a second mutation.
      observations.get(context.sessionId)?.delete(action.observationId);
      try {
        const raw = await ownedService.call(
          'act',
          {
            snapshotId: ref.snapshotId,
            elementToken: token,
            op: action.type,
            ...(action.type === 'set_value' ? { value: action.value } : {}),
          },
          signal,
          context.sessionId,
        );
        const outcome = obj(raw?.outcome);
        const status = text(outcome?.status);
        if (status === 'verified')
          return {
            outcome: {
              ok: true,
              tier: 'ax',
              verified: true,
              evidence: {
                path: `windows.native.${text(outcome?.path) ?? action.type}`,
                effect: 'confirmed',
              },
            },
          };
        if (status === 'unknown')
          return failure(
            'outcome_unknown',
            'Windows helper could not verify whether the action completed.',
            'windows.native.outcome',
          );
        const reason = text(outcome?.reason) ?? 'The Windows control refused the requested action.';
        return failure(
          reason.includes('unsupported') ? 'unsupported_action' : 'dispatch_refused',
          reason,
          'windows.native.outcome',
        );
      } catch (error) {
        if (error instanceof WindowsCuLifecycleError && error.code === 'outcome_unknown') {
          return failure(
            'outcome_unknown',
            'The Windows helper exited after the action was delivered; the result is unknown. Observe the window before retrying.',
            'windows.native.outcome_unknown',
          );
        }
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes('stale') || message.includes('snapshot'))
          return failure(
            'stale_frame',
            'The observation has expired; observe the window again.',
            'windows.native.snapshot',
          );
        return failure(
          'service_unavailable',
          'The Windows helper did not return a result.',
          'windows.native.service',
        );
      }
    },
    async run(action: CuAction, signal, context) {
      if (action.type === 'wait') {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, Math.min(action.durationMs, 10_000));
          signal.addEventListener(
            'abort',
            () => {
              clearTimeout(timer);
              reject(new Error('aborted'));
            },
            { once: true },
          );
        });
        return { outcome: { ok: true, tier: 'semantic-background' } };
      }
      if (action.type === 'screenshot') {
        try {
          const observation = await backend.captureObservation!(
            {
              includeScreenshot: true,
              ...(context.boundAction?.target.windowId
                ? { windowId: context.boundAction.target.windowId }
                : {}),
            },
            signal,
            context,
          );
          return {
            outcome: { ok: true, tier: 'ax' as const },
            observation,
            screenshot: observation.screenshot,
          };
        } catch {
          return failure(
            'capture_failed',
            'Windows Graphics Capture did not produce a frame.',
            'windows.native.capture',
          );
        }
      }
      return unsupported(action.type);
    },
    clearSession(sessionId) {
      observations.delete(sessionId);
      ownedService.clearSession(sessionId);
    },
    executorState: () => ownedService.snapshot(),
    dispose: () => ownedService.dispose(),
  };
  return backend;
}
