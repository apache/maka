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

/**
 * The semantic actions, which name an element rather than a pixel. They are not
 * in `CU_ACTION_TYPES` because they are not `CuAction`s — they are dispatched
 * through `runSemantic` — but they are on the same wire enum, so anything
 * reasoning about "what the model may ask for" has to see both halves.
 */
export const CU_SEMANTIC_ACTION_TYPES = [
  'click_element',
  'set_value',
  'select_text',
  'secondary_action',
  'press_key',
] as const;
export type CuSemanticActionType = (typeof CU_SEMANTIC_ACTION_TYPES)[number];

/**
 * Every action name the tool schema spells out itself, as it spells them —
 * that is, every name that is not one of the `CU_ACTION_TYPES` coordinate
 * actions folded into `CU_TOOL_ACTION_TYPES` below.
 *
 * This list used to be hand-written beside a schema that already listed the
 * same names, and it drifted: `window_action` was added to the strict union and
 * not here, so had it also reached the wire, every window move, resize and
 * minimise would have been summarised as `unknown` — in the approval a person
 * reads before allowing it, and in the record the model reads back of its own
 * call.
 *
 * Drift in the other direction costs just as much and is quieter. A name listed
 * here that the schema does not accept makes `computerUseApprovalSummary`
 * report an action the tool will reject as though it were one that had been
 * taken, and makes `rememberForTurnAllowed` true for it. So the guard in
 * `computer-use-schema-parity.test.ts` (@maka/runtime, which can import the
 * schema; this package cannot) compares the two lists in both directions.
 *
 * It is no longer hand-written: the two openers are named here and the rest is
 * spliced from `CU_SEMANTIC_ACTION_TYPES`, so there is one place to add a
 * semantic action rather than two that must agree.
 */
export const COMPUTER_USE_SEMANTIC_ACTIONS = [
  'list_apps',
  'observe',
  ...CU_SEMANTIC_ACTION_TYPES,
] as const;

/**
 * Every action name the `maka_computer` tool accepts, in wire order.
 *
 * One list, so that adding an action cannot leave a consumer silently matching
 * nothing. This has already cost us once: an offline analyser restated the
 * vocabulary as two regexes, neither of which matched a single coordinate
 * action after the surface moved, and it reported clean runs for trajectories
 * made entirely of blind clicks.
 */
export const CU_TOOL_ACTION_TYPES = [...COMPUTER_USE_SEMANTIC_ACTIONS, ...CU_ACTION_TYPES] as const;
export type CuToolActionType = (typeof CU_TOOL_ACTION_TYPES)[number];

/**
 * The actions that read without changing anything, and so take an observation
 * lease rather than an action lease. Everything else on the wire is treated as
 * mutating — including any action added later, which fails loud in an analyser
 * rather than silently dropping out of the counts.
 */
export const CU_OBSERVING_ACTION_TYPES = [
  'list_apps',
  'observe',
  'screenshot',
  'cursor_position',
  'wait',
] as const;
export type CuObservingActionType = (typeof CU_OBSERVING_ACTION_TYPES)[number];

const OBSERVING_ACTION_SET: ReadonlySet<string> = new Set(CU_OBSERVING_ACTION_TYPES);
const TOOL_ACTION_SET: ReadonlySet<string> = new Set(CU_TOOL_ACTION_TYPES);

export const CU_MUTATING_ACTION_TYPES: readonly CuToolActionType[] = CU_TOOL_ACTION_TYPES.filter(
  (action) => !OBSERVING_ACTION_SET.has(action),
);

export function isCuToolAction(action: string): action is CuToolActionType {
  return TOOL_ACTION_SET.has(action);
}

export function isCuObservingAction(action: string): action is CuObservingActionType {
  return OBSERVING_ACTION_SET.has(action);
}

export function isCuMutatingAction(action: string): action is CuToolActionType {
  return TOOL_ACTION_SET.has(action) && !OBSERVING_ACTION_SET.has(action);
}

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

/**
 * The call as the model should read it back: its own arguments, in the names
 * the tool accepts.
 *
 * The approval summary above is the host's projection for deciding and
 * displaying a permission. It was also being written into the model-facing
 * record of the call, and that had a cost nobody was watching for: the model's
 * transcript said it had called `maka_computer` with `approvalClass`,
 * `rememberForTurnAllowed` and `windowId` — two host-only fields and a key in a
 * dialect the tool rejects — so it went on calling it that way. A real desktop
 * run failed six of eleven calls on shapes copied from its own history, and the
 * telemetry file on this machine holds 29 such rejections.
 *
 * Same privacy boundary as the summary: typed text and written values are what
 * a person asked for or what a window held, and they stay out. Element ids do
 * not — an element id is an index into one observation, and withholding it is
 * what left the model unable to see which control it had just acted on.
 *
 * Nor do coordinates. A coordinate is not read off the screen: it is the
 * model's own output, four digits it chose and sent. Reduced to `<point>` it
 * left a model that clicked [412, 88] and missed unable to tell whether it had
 * already tried that point — the repeated-and-thrash shape this projection
 * exists to make visible, reintroduced by the projection itself.
 *
 * Accepts either dialect on input, so it can project raw arguments or an
 * approval summary recovered from storage.
 */
export interface ComputerUseModelCallArgs {
  action: string;
  app?: string;
  window_id?: number;
  observation_id?: string;
  element_id?: string;
  /** Every other argument the call carried, values reduced to their shape. */
  [key: string]: string | number | boolean | readonly number[] | undefined;
}

/**
 * Fields the host adds, which the model never sent and must never be shown as
 * though it had.
 *
 * `approvalClass` and `rememberForTurnAllowed` come from the approval summary.
 * `element_identity` is added by the Computer Use tool's own `permissionArgs`,
 * which resolves the model's `element_id` against the live observation — and
 * `permissionArgs` is what this projection is applied to on the ToolRuntime
 * path, so without this the model would read back a call carrying a key it has
 * no way to send and whose value came off the accessibility tree.
 */
const HOST_ONLY_ARGS = new Set(['approvalClass', 'rememberForTurnAllowed', 'element_identity']);

/** The keys projected by name above, so the sweep below does not repeat them. */
const MODEL_CALL_NAMED_ARGS = new Set([
  'action',
  'app',
  'window_id',
  'windowId',
  'observation_id',
  'observationId',
  'element_id',
  'elementId',
]);

/**
 * Arguments whose value is the model's own choice from a fixed set, a number,
 * or a word it wrote itself — nothing here comes off the screen.
 *
 * Keyed by action, not by argument name, because `text` is six arguments
 * wearing one name. It carries the key for `press_key`, `key` and `hold_key`,
 * the element action name for `secondary_action`, the substring to select for
 * `select_text`, and whatever a person asked to be typed for `type`. Two of
 * those come off the screen or out of a person's head; four are a name the
 * model picked from a set the executor publishes.
 *
 * Keying on the name meant excluding all six, which is right for `type` and
 * wrong for the rest — and the wrong half is the one that motivated this
 * projection: the model read back `press_key ... text: <text>` and could not
 * see which key it had pressed.
 */
const MODEL_CALL_PLAIN_VALUES: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['observe', new Set(['include_screenshot'])],
  ['screenshot', new Set(['include_screenshot'])],
  ['scroll', new Set(['scroll_direction', 'scroll_amount'])],
  ['wait', new Set(['duration'])],
  // The key name, from the set of key names the executor accepts.
  ['press_key', new Set(['text'])],
  ['key', new Set(['text'])],
  ['hold_key', new Set(['text', 'duration'])],
  // The element action name, from the closed set the observation lists.
  ['secondary_action', new Set(['text'])],
]);

/**
 * Geometry the model itself chose, projected verbatim.
 *
 * Independent of action, because these three names mean the same thing
 * wherever they appear and none of them ever holds screen content: a
 * coordinate, the drag origin, and the zoom rectangle are numbers the model
 * wrote into the call. A model that clicked a point and missed has to be able
 * to see which point, or its next call is the same call.
 */
const MODEL_CALL_GEOMETRY_ARGS = new Set(['coordinate', 'start_coordinate', 'region']);

/** Integers only, so a mistyped `coordinate` still degrades to a shape. */
function integerTuple(value: unknown): readonly number[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > 4) return undefined;
  return value.every((entry) => typeof entry === 'number' && Number.isInteger(entry))
    ? [...(value as number[])]
    : undefined;
}

/**
 * A screen-derived or typed argument, kept as a shape.
 *
 * The value is what a person typed or what a window showed, so it stays out.
 * The key does not: without it the model reads its own history as a call it
 * never made.
 */
function shapeOf(value: unknown): string {
  if (Array.isArray(value)) {
    return value.length === 2 && value.every((v) => typeof v === 'number')
      ? '<point>'
      : `<${value.length} ${value.length === 1 ? 'item' : 'items'}>`;
  }
  if (typeof value === 'string') return '<text>';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '<value>';
}

export function computerUseModelCallArgs(args: unknown): ComputerUseModelCallArgs {
  const record = asRecord(args);
  const rawAction = ownDataProperty(record, 'action');
  // The action the model sent, whatever it was. Collapsing an unrecognised name
  // to `unknown` is the approval summary's job — there `knownAction` decides
  // what a person is asked to allow. Here it erases the one thing the record is
  // for: a model whose call was rejected for naming an action the schema does
  // not carry reads its own history as `action: 'unknown'` and cannot connect
  // the rejection to what it sent.
  const action =
    typeof rawAction === 'string' && rawAction.length > 0
      ? boundedDisplay(redactSecrets(rawAction), 64)
      : 'unknown';
  const app = ownDataProperty(record, 'app');
  const windowId = ownDataProperty(record, 'window_id') ?? ownDataProperty(record, 'windowId');
  const observationId =
    ownDataProperty(record, 'observation_id') ?? ownDataProperty(record, 'observationId');
  const elementId = ownDataProperty(record, 'element_id') ?? ownDataProperty(record, 'elementId');
  // Every remaining argument the model sent, as a shape. The approval summary
  // this replaces names five keys and drops the rest, so `press_key` came back
  // to the model as a call with no key, `set_value` as one with no value,
  // `scroll` as one with no direction. The model reads that as the shape that
  // worked and sends it again — and a real session refused eighteen calls for
  // missing exactly the fields the projection had removed. The privacy boundary
  // is about values, and only values are withheld.
  const rest: Record<string, string | number | boolean | readonly number[]> = {};
  const plain = MODEL_CALL_PLAIN_VALUES.get(action);
  for (const [key, value] of Object.entries(record ?? {})) {
    if (MODEL_CALL_NAMED_ARGS.has(key) || HOST_ONLY_ARGS.has(key)) continue;
    if (MODEL_CALL_GEOMETRY_ARGS.has(key)) {
      rest[key] = integerTuple(value) ?? shapeOf(value);
      continue;
    }
    if (plain?.has(key)) {
      rest[key] =
        typeof value === 'string'
          ? boundedDisplay(redactSecrets(value), 256)
          : typeof value === 'number' || typeof value === 'boolean'
            ? value
            : shapeOf(value);
      continue;
    }
    rest[key] = shapeOf(value);
  }
  return {
    action,
    ...(typeof app === 'string' && app.length > 0
      ? { app: boundedDisplay(redactSecrets(app), 256) }
      : {}),
    ...(typeof windowId === 'number' && Number.isInteger(windowId) ? { window_id: windowId } : {}),
    ...(typeof observationId === 'string' && stableIdentifier(observationId)
      ? { observation_id: stableIdentifier(observationId) }
      : {}),
    ...(typeof elementId === 'string' && elementId.length > 0
      ? { element_id: boundedDisplay(redactSecrets(elementId), 256) }
      : {}),
    ...rest,
  };
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

// Exactly the wire vocabulary, derived rather than restated: an action the tool
// accepts is an action a person can be asked to approve.
const APPROVAL_ACTIONS = new Set<string>(CU_TOOL_ACTION_TYPES);

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
