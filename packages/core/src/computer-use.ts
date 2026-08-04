/**
 * Provider-neutral Computer Use contract.
 *
 * This module contains shared vocabulary only. It does not select a provider,
 * capture a screen, or dispatch input. Runtime and host implementations must
 * preserve these identities and fail-closed semantics end to end.
 */

import { redactSecrets } from './redaction.js';

export const COMPUTER_USE_ERROR_CODES = [
  'permission_missing',
  'permission_pending',
  'policy_denied',
  'policy_forbidden',
  'invalid_coordinate',
  'capture_failed',
  'sensitivity_blocked',
  'unsupported_action',
  'aborted',
  'timeout',
  'no_active_frame',
  'no_active_session',
  'stale_frame',
  'stale_epoch',
  'target_missing',
  'ambiguous_target',
  'target_changed',
  'target_occluded',
  'page_target_changed',
  'duplicate_action',
  'user_intervened',
  'reobserve_required',
  'screen_locked',
  'blocked_url',
  'user_stopped',
  'service_unavailable',
  'service_mismatch',
  'outcome_unknown',
  /**
   * The action reached the target and the target declined to perform it.
   *
   * Its own member, because `capture_failed` names the wrong subsystem and
   * `unsupported_action` is where "the element does not offer this" already
   * lands. The difference between "it does not offer this" and "it offered it,
   * we tried, the OS said no" is the difference between try something else and
   * try again, so a model that reads one code for both loses its next move.
   */
  'dispatch_refused',
] as const;

export type ComputerUseErrorCode = (typeof COMPUTER_USE_ERROR_CODES)[number];

export function isComputerUseErrorCode(value: unknown): value is ComputerUseErrorCode {
  return (
    typeof value === 'string' && (COMPUTER_USE_ERROR_CODES as readonly string[]).includes(value)
  );
}

export interface CuPoint {
  x: number;
  y: number;
}

export interface CuRegion {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface ComputerUseRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ComputerUseFrameIdentity {
  frameId: string;
  epoch: number;
}

export interface ComputerUseDisplayIdentity {
  displayId: string;
  logicalBounds: ComputerUseRect;
  sourceBoundsPx: ComputerUseRect;
  scaleFactor: number;
}

export interface ComputerUsePageIdentity {
  cdpPort: number;
  pageTargetId: string;
  pageUrl: string;
  targetUrlContains: string;
  documentFingerprint?: string;
}

export interface ComputerUseWindowIdentity {
  pid: number;
  windowId: number;
  bundleId?: string;
  appName?: string;
  title?: string;
  bounds?: ComputerUseRect;
  sourceBoundsPx?: ComputerUseRect;
  zIndex?: number;
  contentFingerprint?: string;
  page?: ComputerUsePageIdentity;
}

export interface ComputerUseObservationIdentity extends ComputerUseFrameIdentity {
  capturedAt: number;
  screenshotWidthPx?: number;
  screenshotHeightPx?: number;
  displays: ComputerUseDisplayIdentity[];
  target: ComputerUseWindowIdentity;
}

export interface ComputerUseBoundAction extends ComputerUseFrameIdentity {
  actionFingerprint: string;
  target: ComputerUseWindowIdentity;
  display?: ComputerUseDisplayIdentity;
  elementId?: string;
  sourceCoordinate?: CuPoint;
  sourceStartCoordinate?: CuPoint;
  windowCoordinate?: CuPoint;
  windowStartCoordinate?: CuPoint;
  coordinateSpace?: 'window-screenshot-local';
}

export const CU_SCROLL_DIRECTIONS = ['up', 'down', 'left', 'right'] as const;
export type CuScrollDirection = (typeof CU_SCROLL_DIRECTIONS)[number];

export const CU_ACTION_TYPES = [
  'screenshot',
  'cursor_position',
  'mouse_move',
  'left_click',
  'right_click',
  'middle_click',
  'double_click',
  'triple_click',
  'left_mouse_down',
  'left_mouse_up',
  'left_click_drag',
  'type',
  'key',
  'hold_key',
  'scroll',
  'wait',
  'zoom',
] as const;

export const COMPUTER_USE_ACTION_TYPES = CU_ACTION_TYPES;
export type CuActionType = (typeof CU_ACTION_TYPES)[number];

export type CuAction =
  | { type: 'screenshot' }
  | { type: 'cursor_position' }
  | { type: 'mouse_move'; coordinate: CuPoint }
  | { type: 'left_click'; coordinate: CuPoint; text?: string }
  | { type: 'right_click'; coordinate: CuPoint; text?: string }
  | { type: 'middle_click'; coordinate: CuPoint; text?: string }
  | { type: 'double_click'; coordinate: CuPoint; text?: string }
  | { type: 'triple_click'; coordinate: CuPoint; text?: string }
  | { type: 'left_mouse_down'; coordinate: CuPoint }
  | { type: 'left_mouse_up'; coordinate: CuPoint }
  | { type: 'left_click_drag'; startCoordinate: CuPoint; coordinate: CuPoint; text?: string }
  | { type: 'type'; text: string }
  | { type: 'key'; text: string }
  | { type: 'hold_key'; text: string; durationMs: number }
  | {
      type: 'scroll';
      coordinate: CuPoint;
      scrollDirection: CuScrollDirection;
      scrollAmount: number;
      text?: string;
    }
  | { type: 'wait'; durationMs: number }
  | { type: 'zoom'; region: CuRegion };

export const COMPUTER_USE_FRAME_SOURCE_KINDS = ['live-capture'] as const;
export type ComputerUseFrameSourceKind = (typeof COMPUTER_USE_FRAME_SOURCE_KINDS)[number];

export interface ComputerUseScreenFrame {
  actionId: string;
  sourceKind: ComputerUseFrameSourceKind;
  mimeType: 'image/png' | 'image/jpeg';
  widthPx: number;
  heightPx: number;
  capturedAt: number;
}

export const COMPUTER_USE_DISPATCH_TIERS = [
  'ax',
  'semantic-background',
  'coordinate-background',
] as const;

export type ComputerUseDispatchTier = (typeof COMPUTER_USE_DISPATCH_TIERS)[number];

export const COMPUTER_USE_EFFECTS = ['confirmed', 'unverifiable', 'suspected_noop'] as const;

export type ComputerUseEffect = (typeof COMPUTER_USE_EFFECTS)[number];

export interface ComputerUseDispatchEvidence {
  effect?: ComputerUseEffect;
  reason?: string;
}

export type ComputerUseActionOutcome =
  | {
      ok: true;
      mutation: false;
      tier: ComputerUseDispatchTier;
      verified: boolean;
      evidence?: ComputerUseDispatchEvidence;
      frame?: ComputerUseScreenFrame;
      observation?: ComputerUseObservationIdentity;
      completedSubSteps?: number;
    }
  | {
      ok: true;
      mutation: true;
      tier: ComputerUseDispatchTier;
      verified: boolean;
      evidence?: ComputerUseDispatchEvidence;
      frame?: ComputerUseScreenFrame;
      observation: ComputerUseObservationIdentity;
      completedSubSteps?: number;
    }
  | {
      ok: false;
      error: ComputerUseErrorCode;
      message: string;
      evidence?: ComputerUseDispatchEvidence;
      completedSubSteps?: number;
    };

/**
 * Approval is a capability gate, not proof that an action is fresh or valid.
 * Runtime must still establish an active observation and validate the target.
 */
export const COMPUTER_USE_APPROVAL_CLASSES = [
  'metadata_read',
  'screenshot_read',
  'pointer_mutation',
  'keyboard_mutation',
  'semantic_mutation',
] as const;

export type ComputerUseApprovalClass = (typeof COMPUTER_USE_APPROVAL_CLASSES)[number];

export interface ComputerUseApprovalSummary {
  action: string;
  approvalClass: ComputerUseApprovalClass;
  rememberForTurnAllowed: boolean;
  app?: string;
  windowId?: number;
  observationId?: string;
}

const POINTER_ACTIONS = new Set([
  'mouse_move',
  'left_click',
  'right_click',
  'middle_click',
  'double_click',
  'triple_click',
  'left_mouse_down',
  'left_mouse_up',
  'left_click_drag',
  'scroll',
  'zoom',
]);

const KEYBOARD_ACTIONS = new Set(['type', 'key', 'hold_key', 'press_key']);
const SEMANTIC_ACTIONS = new Set(['click_element', 'set_value', 'select_text', 'secondary_action']);

const APPROVAL_ACTIONS = new Set([
  'list_apps',
  'observe',
  'click_element',
  'set_value',
  'select_text',
  'secondary_action',
  'press_key',
  ...CU_ACTION_TYPES,
]);

export function computerUseApprovalSummary(args: unknown): ComputerUseApprovalSummary {
  const record = asRecord(args);
  const rawAction = ownDataProperty(record, 'action');
  const knownAction = typeof rawAction === 'string' && APPROVAL_ACTIONS.has(rawAction);
  const action = knownAction ? rawAction : 'unknown';
  const includeScreenshot = ownDataProperty(record, 'include_screenshot') !== false;
  const approvalClass: ComputerUseApprovalClass =
    action === 'list_apps' || action === 'cursor_position' || action === 'wait'
      ? 'metadata_read'
      : action === 'observe'
        ? includeScreenshot
          ? 'screenshot_read'
          : 'metadata_read'
        : action === 'screenshot'
          ? 'screenshot_read'
          : POINTER_ACTIONS.has(action)
            ? 'pointer_mutation'
            : KEYBOARD_ACTIONS.has(action)
              ? 'keyboard_mutation'
              : SEMANTIC_ACTIONS.has(action)
                ? 'semantic_mutation'
                : 'semantic_mutation';

  const rawApp = ownDataProperty(record, 'app');
  const rawWindowId = ownDataProperty(record, 'window_id');
  const rawObservationId = ownDataProperty(record, 'observation_id');
  const exactApp = typeof rawApp === 'string' && rawApp.length > 0 ? rawApp : undefined;
  const app = exactApp === undefined ? undefined : boundedDisplay(redactSecrets(exactApp), 256);
  const windowId =
    typeof rawWindowId === 'number' && Number.isInteger(rawWindowId) ? rawWindowId : undefined;
  const exactObservationId =
    typeof rawObservationId === 'string' ? stableIdentifier(rawObservationId) : undefined;
  const observationId =
    exactObservationId === undefined
      ? undefined
      : boundedDisplay(redactSecrets(exactObservationId), 256);
  const explicitTarget = exactApp !== undefined || windowId !== undefined;
  const targetBound =
    action === 'list_apps' ||
    ((action === 'observe' || action === 'screenshot') && explicitTarget) ||
    ((POINTER_ACTIONS.has(action) ||
      KEYBOARD_ACTIONS.has(action) ||
      SEMANTIC_ACTIONS.has(action)) &&
      exactObservationId !== undefined &&
      explicitTarget);
  const rememberForTurnAllowed = knownAction && targetBound;

  return {
    action,
    approvalClass,
    rememberForTurnAllowed,
    ...(app === undefined ? {} : { app }),
    ...(windowId === undefined ? {} : { windowId }),
    ...(observationId === undefined ? {} : { observationId }),
  };
}

export function computerUseApprovalScopeKey(args: unknown): string {
  const record = asRecord(args);
  const rawAction = ownDataProperty(record, 'action');
  const exactAction = typeof rawAction === 'string' ? rawAction : null;
  const rawApp = ownDataProperty(record, 'app');
  const exactApp = typeof rawApp === 'string' ? rawApp : null;
  const rawWindowId = ownDataProperty(record, 'window_id');
  const exactWindowId =
    typeof rawWindowId === 'number' && Number.isInteger(rawWindowId) ? rawWindowId : null;
  const rawObservationId = ownDataProperty(record, 'observation_id');
  const exactObservationId = typeof rawObservationId === 'string' ? rawObservationId : null;
  const summary = computerUseApprovalSummary(record);
  return `computer_use:${JSON.stringify([
    summary.approvalClass,
    exactAction,
    exactApp,
    exactWindowId,
    exactObservationId,
  ])}`;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function boundedDisplay(value: string, maxLength: number): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function stableIdentifier(value: string): string | undefined {
  const normalized = value.trim();
  return /^[A-Za-z0-9._:-]{1,256}$/.test(normalized) ? normalized : undefined;
}

function ownDataProperty(record: Record<string, unknown>, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  if (!descriptor) return undefined;
  if (!('value' in descriptor)) {
    throw new Error(`Computer Use approval requires ${key} to be a plain data property`);
  }
  return descriptor.value;
}
