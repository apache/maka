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

import { randomUUID } from 'node:crypto';
import type { ComputerUseErrorCode } from '@maka/core/computer-use';
import type {
  CuAppSummary,
  CuDispatchBackend,
  CuObservation,
  CuRunContext,
  CuRunResult,
  CuScreenshot,
  CuSemanticAction,
} from '@maka/runtime/computer-use-types';
import { CuaDriverService, type CuaDriverResult } from './cua-driver-service.js';
import { abortableDelay } from './abortable-delay.js';
import { exceedsFrameCap, FRAME_COMPRESS_THRESHOLD_BYTES } from './frame-budget.js';

type RecordValue = Record<string, unknown>;

interface Snapshot {
  observationId: string;
  sessionId: string;
  turnId: string;
  generation: number;
  pid: number;
  windowId: number;
  bounds?: { x: number; y: number; width: number; height: number };
  elements: Map<string, string>;
}

export interface CuaDriverBackendOptions {
  binaryPath: string;
  expectedBinarySha256: string;
  compressFrame?: (
    base64: string,
    mimeType: string,
  ) => { base64: string; mimeType: 'image/png' | 'image/jpeg' };
  physicalInputRecentlyActive?: () => boolean | Promise<boolean>;
  onSessionInvalidated?: (input: { sessionId: string }) => void;
  requestAccessibilityPermission?: () => void;
  createService?: (
    binaryPath: string,
    expectedBinarySha256: string,
    onUnexpectedClose: () => void,
  ) => CuaDriverService;
}

const ERROR_SENTENCES: Record<ComputerUseErrorCode, string> = {
  permission_missing: 'Grant Maka Accessibility and Screen Recording access, then try again.',
  permission_pending: 'The macOS permission request is still pending.',
  policy_denied: 'The action is outside the authorized Computer Use scope.',
  policy_forbidden: 'The action is forbidden by Computer Use policy.',
  invalid_coordinate: 'The action has an invalid coordinate.',
  capture_failed: 'The window could not be observed. Observe it again.',
  sensitivity_blocked: 'The target is sensitive and cannot be operated.',
  unsupported_action: 'This action is not supported by the bundled executor.',
  aborted: 'The action was cancelled.',
  timeout: 'The executor timed out. Observe the window before another action.',
  no_active_frame: 'Observe the target window before acting.',
  no_active_session: 'The Computer Use session is no longer active.',
  stale_frame: 'The observation is stale. Observe the window again.',
  stale_epoch: 'The observation belongs to an earlier executor generation.',
  target_missing: 'The target no longer exists. Observe the window again.',
  ambiguous_target: 'More than one target matches. Select a specific window.',
  target_changed: 'The target window changed. Observe it again.',
  target_mismatch: 'The requested target differs from the observed window.',
  withheld_value_replayed: 'The action used a redacted value from an earlier result.',
  target_occluded: 'The target is occluded. Observe it again.',
  page_target_changed: 'The page target changed. Observe it again.',
  duplicate_action: 'This action has already been dispatched.',
  user_intervened: 'The user is controlling the computer. Observe again later.',
  reobserve_required: 'Observe the window again before acting.',
  screen_locked: 'Unlock the screen before using Computer Use.',
  blocked_url: 'The page is blocked by Computer Use policy.',
  user_stopped: 'The user stopped Computer Use.',
  service_unavailable: 'The bundled Computer Use executor is unavailable.',
  service_mismatch: 'The bundled Computer Use executor did not match its pin.',
  outcome_unknown: 'The executor connection was lost. Observe before another action.',
  dispatch_refused: 'The target refused this action. Observe before trying another route.',
  foreground_required:
    'The background action could not reach this window. Explain which application and action need brief foreground access, ask the user in conversation, and wait for an explicit reply before retrying with foreground delivery.',
};

const BEFORE_DISPATCH = new Set<ComputerUseErrorCode>([
  'foreground_required',
  'stale_frame',
  'target_missing',
  'target_mismatch',
  'policy_denied',
  'permission_missing',
  'unsupported_action',
  'user_intervened',
]);

const SECONDARY_ACTIONS: Record<string, string> = {
  AXPress: 'press',
  AXShowMenu: 'show_menu',
  AXPick: 'pick',
  AXConfirm: 'confirm',
  AXCancel: 'cancel',
  AXOpen: 'open',
};

function keyCall(chord: string): { name: 'press_key' | 'hotkey'; args: RecordValue } | undefined {
  const parts = chord.split('+').map((part) => part.trim().toLowerCase());
  if (parts.length === 1) return { name: 'press_key', args: { key: chord } };
  const aliases: Record<string, string> = {
    command: 'cmd',
    meta: 'cmd',
    control: 'ctrl',
    alt: 'option',
  };
  const modifiers = parts.slice(0, -1).map((part) => aliases[part] ?? part);
  const key = parts.at(-1);
  if (!key || modifiers.some((part) => !['cmd', 'ctrl', 'option', 'shift', 'fn'].includes(part))) {
    return undefined;
  }
  return { name: 'hotkey', args: { keys: [...modifiers, key] } };
}

function failure(error: ComputerUseErrorCode): CuRunResult {
  return {
    outcome: {
      ok: false,
      error,
      message: ERROR_SENTENCES[error],
      messageIsAppTextFree: true,
      ...(BEFORE_DISPATCH.has(error) ? { evidence: { path: 'none' } } : {}),
    },
  };
}

function object(value: unknown): RecordValue | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as RecordValue)
    : undefined;
}

function string(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function number(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined;
}

function bounds(value: unknown): Snapshot['bounds'] {
  const input = object(value);
  if (!input) return undefined;
  const x = number(input.x);
  const y = number(input.y);
  const width = number(input.width);
  const height = number(input.height);
  return x === undefined || y === undefined || width === undefined || height === undefined
    ? undefined
    : { x, y, width, height };
}

function screenshot(result: CuaDriverResult, structured: RecordValue): CuScreenshot | undefined {
  const image = result.content.find(
    (block) => block.type === 'image' && typeof block.data === 'string',
  );
  const widthPx = number(structured.screenshot_width);
  const heightPx = number(structured.screenshot_height);
  if (!image?.data || !widthPx || !heightPx) return undefined;
  return {
    base64: image.data,
    mimeType: image.mimeType === 'image/jpeg' ? 'image/jpeg' : 'image/png',
    widthPx,
    heightPx,
  };
}

function refusalCode(result: CuaDriverResult): ComputerUseErrorCode | undefined {
  const payload = result.structuredContent;
  const code = string(object(payload?.refusal)?.code) ?? string(payload?.code);
  switch (code) {
    case 'stale_element_token':
    case 'stale_snapshot':
      return 'stale_frame';
    case 'window_target_not_found':
    case 'element_not_found':
      return 'target_missing';
    case 'background_occluded':
      return 'target_occluded';
    case 'permission_missing':
      return 'permission_missing';
    case 'authorization_required':
    case 'policy_denied':
      return 'policy_denied';
    case 'background_unavailable':
      return 'foreground_required';
    default:
      return result.isError ? 'dispatch_refused' : undefined;
  }
}

export function createCuaDriverBackend(options: CuaDriverBackendOptions): CuDispatchBackend & {
  executorState(): ReturnType<CuaDriverService['snapshot']>;
  dispose(): void;
} {
  const snapshots = new Map<string, Snapshot>();
  const onUnexpectedClose = () => {
    for (const sessionId of snapshots.keys()) options.onSessionInvalidated?.({ sessionId });
    snapshots.clear();
  };
  const service =
    options.createService?.(options.binaryPath, options.expectedBinarySha256, onUnexpectedClose) ??
    new CuaDriverService(options.binaryPath, options.expectedBinarySha256, onUnexpectedClose);

  async function call(
    name: string,
    args: RecordValue,
    signal: AbortSignal,
  ): Promise<CuaDriverResult> {
    return service.call(name, args, signal);
  }

  function current(observationId: string, context: CuRunContext): Snapshot | undefined {
    const snapshot = snapshots.get(context.sessionId);
    return snapshot?.observationId === observationId &&
      snapshot.turnId === context.turnId &&
      snapshot.generation === service.snapshot().generation
      ? snapshot
      : undefined;
  }

  async function observe(
    input: {
      app?: string;
      windowId?: number;
      includeScreenshot: boolean;
      menu?: string;
      query?: string;
    },
    signal: AbortSignal,
    context: CuRunContext,
  ): Promise<CuObservation> {
    const windows = await call('list_windows', {}, signal);
    if (windows.isError) throw new Error('list_windows failed');
    const candidates = Array.isArray(windows.structuredContent?.windows)
      ? windows.structuredContent.windows.map(object).filter((item): item is RecordValue => !!item)
      : [];
    const apps = input.app ? await call('list_apps', {}, signal) : undefined;
    if (apps?.isError) throw new Error('list_apps failed');
    const appRows = Array.isArray(apps?.structuredContent?.apps)
      ? apps.structuredContent.apps.map(object).filter((app): app is RecordValue => !!app)
      : [];
    const requestedPids = input.app
      ? new Set(
          appRows
            .filter((app) =>
              [app.bundle_id, app.name].some(
                (candidate) =>
                  typeof candidate === 'string' &&
                  candidate.toLowerCase() === input.app!.toLowerCase(),
              ),
            )
            .map((app) => number(app.pid)),
        )
      : undefined;
    const matched = candidates.filter((window) => {
      const id = number(window.window_id);
      if (input.windowId !== undefined && id !== input.windowId) return false;
      if (input.windowId === undefined && window.is_on_screen === false && !string(window.title))
        return false;
      if (!input.app) return input.windowId !== undefined;
      return (
        requestedPids?.has(number(window.pid)) ||
        string(window.app_name)?.toLowerCase() === input.app.toLowerCase()
      );
    });
    if (matched.length === 0) throw new Error('target_missing');
    matched.sort(
      (a, b) =>
        Number(b.is_on_screen === true) - Number(a.is_on_screen === true) ||
        (number(b.z_index) ?? -1) - (number(a.z_index) ?? -1),
    );
    const window = matched[0]!;
    const pid = number(window.pid);
    const windowId = number(window.window_id);
    if (!pid || !windowId) throw new Error('target_missing');
    const result = await call(
      'get_window_state',
      {
        pid,
        window_id: windowId,
        session: context.sessionId,
        include_accessibility_tree: true,
        include_screenshot: input.includeScreenshot,
        ...(input.query ? { query: input.query } : {}),
      },
      signal,
    );
    if (result.isError) throw new Error('capture_failed');
    const structured = result.structuredContent ?? {};
    const nativeSnapshotId = string(structured.snapshot_id);
    if (!nativeSnapshotId) throw new Error('capture_failed');
    const observationId = randomUUID();
    const tokens = new Map<string, string>();
    const elements = (Array.isArray(structured.elements) ? structured.elements : [])
      .map(object)
      .filter((element): element is RecordValue => !!element)
      .map((element) => {
        const index = number(element.element_index);
        const token = string(element.element_token);
        if (index === undefined || !token) return undefined;
        const elementId = String(index);
        tokens.set(elementId, token);
        const frame = object(element.frame);
        return {
          elementId,
          role: string(element.role) ?? 'unknown',
          ...(string(element.label) ? { label: string(element.label) } : {}),
          ...(string(element.value) ? { value: string(element.value) } : {}),
          ...(typeof element.enabled === 'boolean' ? { enabled: element.enabled } : {}),
          ...(typeof element.focused === 'boolean' ? { focused: element.focused } : {}),
          ...(typeof element.selected === 'boolean' ? { selected: element.selected } : {}),
          ...(Array.isArray(element.actions)
            ? {
                actions: element.actions
                  .map((value) => SECONDARY_ACTIONS[String(value)])
                  .filter((value): value is string => !!value && value !== 'press'),
              }
            : {}),
          ...(number(element.parent_index) !== undefined
            ? { parentElementId: String(element.parent_index) }
            : {}),
          ...(frame &&
          number(frame.x) !== undefined &&
          number(frame.y) !== undefined &&
          number(frame.w) !== undefined &&
          number(frame.h) !== undefined
            ? {
                frame: {
                  x: number(frame.x)!,
                  y: number(frame.y)!,
                  width: number(frame.w)!,
                  height: number(frame.h)!,
                },
              }
            : {}),
          identity: {
            token,
            role: string(element.role) ?? 'unknown',
            label: string(element.label),
            value: string(element.value),
          },
        };
      })
      .filter((element): element is NonNullable<typeof element> => !!element);
    const appId =
      string(appRows.find((app) => number(app.pid) === pid)?.bundle_id) ??
      string(structured.app_name) ??
      string(window.app_name) ??
      input.app ??
      '';
    const windowBounds = bounds(structured.window_bounds) ?? bounds(window.bounds);
    snapshots.set(context.sessionId, {
      observationId,
      sessionId: context.sessionId,
      turnId: context.turnId,
      generation: service.snapshot().generation,
      pid,
      windowId,
      bounds: windowBounds,
      elements: tokens,
    });
    const captured = screenshot(result, structured);
    const originalBytes = captured ? Buffer.byteLength(captured.base64, 'base64') : 0;
    const compressed =
      captured && originalBytes > FRAME_COMPRESS_THRESHOLD_BYTES
        ? options.compressFrame?.(captured.base64, captured.mimeType)
        : undefined;
    const shot = captured && compressed ? { ...captured, ...compressed } : captured;
    if (shot && exceedsFrameCap(Buffer.byteLength(shot.base64, 'base64')))
      throw new Error('capture_failed');
    return {
      observationId,
      appId,
      pid,
      windowId,
      windowTitle: string(structured.window_title) ?? string(window.title),
      capturedAt: Date.now(),
      ...(windowBounds ? { windowBounds } : {}),
      ...(shot ? { screenshot: shot } : {}),
      ...(input.menu ? { menu: { unavailable: true } } : {}),
      truncated: structured.truncated === true || structured.elements_complete === false,
      elements,
    };
  }

  async function act(
    name: string,
    args: RecordValue,
    snapshot: Snapshot,
    signal: AbortSignal,
    context: CuRunContext,
  ): Promise<CuRunResult> {
    if (await options.physicalInputRecentlyActive?.()) return failure('user_intervened');
    let result: CuaDriverResult;
    try {
      result = await call(
        name,
        { ...args, pid: snapshot.pid, window_id: snapshot.windowId, session: context.sessionId },
        signal,
      );
    } catch {
      snapshots.delete(context.sessionId);
      options.onSessionInvalidated?.({ sessionId: context.sessionId });
      return failure(signal.aborted ? 'aborted' : 'outcome_unknown');
    }
    const refusal = refusalCode(result);
    if (refusal) return failure(refusal);
    const payload = result.structuredContent ?? {};
    const effect = string(payload.effect);
    if (!effect || effect === 'refused') return failure('dispatch_refused');
    return {
      outcome: {
        ok: true,
        tier:
          args.delivery_mode === 'foreground'
            ? 'foreground'
            : string(payload.route) === 'accessibility'
              ? 'ax'
              : 'semantic-background',
        verified: effect === 'confirmed',
        evidence: {
          effect:
            effect === 'confirmed'
              ? 'confirmed'
              : effect === 'suspected_noop'
                ? 'suspected_noop'
                : 'unverifiable',
        },
      },
    };
  }

  return {
    executorState: () => service.snapshot(),
    dispose: () => {
      void service.dispose();
    },
    clearSession: (sessionId) => {
      snapshots.delete(sessionId);
    },
    preflight: async (signal) => {
      const result = await call('check_permissions', {}, signal);
      if (result.isError) throw new Error('check_permissions failed');
      const state = result.structuredContent ?? {};
      return {
        accessibility: state.accessibility === true,
        screenRecording: state.screen_recording === true,
      };
    },
    requestAccessibilityPermission: async () => {
      options.requestAccessibilityPermission?.();
    },
    listApps: async (signal): Promise<CuAppSummary[]> => {
      const [apps, windows] = await Promise.all([
        call('list_apps', {}, signal),
        call('list_windows', {}, signal),
      ]);
      if (apps.isError || windows.isError) throw new Error('list_apps failed');
      const appRows = Array.isArray(apps.structuredContent?.apps)
        ? apps.structuredContent.apps
        : [];
      const windowRows = Array.isArray(windows.structuredContent?.windows)
        ? windows.structuredContent.windows
        : [];
      return appRows
        .map(object)
        .filter((app): app is RecordValue => !!app && app.running === true)
        .map((app) => {
          const pid = number(app.pid) ?? 0;
          const found = windowRows
            .map(object)
            .filter((window): window is RecordValue => !!window && window.pid === pid);
          return {
            appId: string(app.bundle_id) ?? string(app.name) ?? '',
            pid,
            name: string(app.name),
            windowCount: found.length,
            windows: found.map((window) => ({
              windowId: number(window.window_id) ?? 0,
              title: string(window.title),
            })),
          };
        });
    },
    launchApp: async ({ app }, signal) => {
      const result = await call(
        'launch_app',
        app.includes('.') ? { bundle_id: app } : { name: app },
        signal,
      );
      if (result.isError) throw new Error('launch_app failed');
      const data = result.structuredContent ?? {};
      return {
        pid: number(data.pid) ?? 0,
        bundleId: string(data.bundle_id),
        name: string(data.name),
        focusHeld: data.self_activation_suppressed !== false,
        windows: Array.isArray(data.windows)
          ? data.windows
              .map(object)
              .filter((window): window is RecordValue => !!window)
              .map((window) => ({
                windowId: number(window.window_id) ?? 0,
                title: string(window.title),
              }))
          : [],
      };
    },
    observeApp: observe,
    captureObservation: observe,
    runSemantic: async (action: CuSemanticAction, signal, context): Promise<CuRunResult> => {
      const snapshot = current(action.observationId, context);
      if (!snapshot) return failure('stale_frame');
      if (
        context.boundAction?.target.pid !== snapshot.pid ||
        context.boundAction?.target.windowId !== snapshot.windowId
      ) {
        return failure('target_mismatch');
      }
      const token =
        'elementId' in action ? snapshot.elements.get(action.elementId ?? '') : undefined;
      if ('elementId' in action && action.elementId && !token) return failure('target_missing');
      const target = token ? { element_token: token } : {};
      switch (action.type) {
        case 'click_element':
          return act(
            'click',
            { ...target, delivery_mode: action.deliveryMode ?? 'background' },
            snapshot,
            signal,
            context,
          );
        case 'set_value':
          return act('set_value', { ...target, value: action.value }, snapshot, signal, context);
        case 'secondary_action':
          if (!['press', 'show_menu', 'pick', 'confirm', 'cancel', 'open'].includes(action.action))
            return failure('unsupported_action');
          return act(
            'click',
            {
              ...target,
              action: action.action,
              delivery_mode: action.deliveryMode ?? 'background',
            },
            snapshot,
            signal,
            context,
          );
        case 'scroll_element':
          return act(
            'scroll',
            {
              ...target,
              direction: action.direction,
              by: (action.pages ?? 1) < 1 ? 'line' : 'page',
              amount: Math.max(
                1,
                Math.min(
                  50,
                  Math.round(
                    (action.pages ?? 1) < 1 ? (action.pages ?? 1) * 30 : (action.pages ?? 1),
                  ),
                ),
              ),
              delivery_mode: action.deliveryMode ?? 'background',
            },
            snapshot,
            signal,
            context,
          );
        case 'press_key': {
          const key = keyCall(action.key);
          if (!key) return failure('unsupported_action');
          return act(
            key.name,
            { ...target, ...key.args, delivery_mode: action.deliveryMode ?? 'background' },
            snapshot,
            signal,
            context,
          );
        }
        case 'window_action': {
          if (action.action === 'minimize' || !snapshot.bounds)
            return failure('unsupported_action');
          const original = snapshot.bounds;
          const position = action.position ?? original;
          const size = action.size ?? original;
          return act(
            'set_window_frame',
            { x: position.x, y: position.y, width: size.width, height: size.height },
            snapshot,
            signal,
            context,
          );
        }
        case 'select_text':
          return failure('unsupported_action');
      }
    },
    run: async (action, signal, context): Promise<CuRunResult> => {
      if (action.type === 'wait') {
        await abortableDelay(action.durationMs, signal);
        return { outcome: { ok: true, tier: 'ax', verified: true } };
      }
      const bound = context.boundAction?.target;
      const snapshot = [...snapshots.values()].find(
        (item) =>
          item.sessionId === context.sessionId &&
          item.turnId === context.turnId &&
          item.pid === bound?.pid &&
          item.windowId === bound?.windowId,
      );
      if (!snapshot) return failure('stale_frame');
      if (action.type === 'screenshot') {
        try {
          const observation = await observe(
            { windowId: snapshot.windowId, includeScreenshot: true },
            signal,
            context,
          );
          return {
            outcome: { ok: true, tier: 'ax', verified: true },
            observation,
            screenshot: observation.screenshot,
          };
        } catch {
          return failure('capture_failed');
        }
      }
      if (action.type === 'type')
        return act(
          'type_text',
          { text: action.text, delivery_mode: action.deliveryMode ?? 'background' },
          snapshot,
          signal,
          context,
        );
      const key = keyCall(action.text);
      if (!key) return failure('unsupported_action');
      return act(
        key.name,
        { ...key.args, delivery_mode: action.deliveryMode ?? 'background' },
        snapshot,
        signal,
        context,
      );
    },
  };
}
