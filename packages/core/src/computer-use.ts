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
  // The action is bound to an observation and the model also named an app or a
  // window, and the two disagree. Its own word because the recovery is its own:
  // not "look again" but "look at the thing you meant". It was being written
  // into refusal text without being in this list, so the model read a
  // twenty-ninth error word that appeared in no table, and the result carried no
  // `error` at all — a refusal recorded as a successful invocation.
  'target_mismatch',
  // An argument arrived holding one of the placeholders this host writes into
  // the model's own call record in place of a withheld value — `<text:18>`,
  // `<point>`. Nothing was dispatched: the model is replaying the shape of its
  // history rather than the text it means, and typing those characters into the
  // user's field is the one outcome worse than refusing.
  'withheld_value_replayed',
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
  /**
   * Where on screen this action is aimed, for presentation only.
   *
   * A coordinate action carries its target as `sourceCoordinate`, in the
   * observation screenshot's own pixels, and the point on screen is recovered
   * from it. A semantic action has no such coordinate — it names an element —
   * so nothing recovered one, and the presentation layer had nowhere to send
   * the cursor: it stayed where it was and the action was then wiped from the
   * overlay, which is an arrow that never touches what it clicked.
   *
   * This is the observed element's own centre, in the same screen coordinates
   * as `target.bounds`, set only when that centre lies inside the target
   * window — the same condition the executor validates before dispatching. It
   * is never used to dispatch anything: `boundWindowPoint` refuses any binding
   * without `coordinateSpace`, and a semantic binding does not set one.
   */
  presentationScreenPoint?: CuPoint;
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
  'scroll_element',
  'window_action',
  // Dispatched step by step through `runSemantic` like the rest, so it belongs
  // on this side of the partition even though one call carries several steps.
  'element_sequence',
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
 * It is no longer hand-written: the three openers are named here and the rest
 * is spliced from `CU_SEMANTIC_ACTION_TYPES`, so there is one place to add a
 * semantic action rather than two that must agree. `launch_app` is an opener
 * rather than a semantic action because it names an application, not an
 * element: there is no observation for it to be bound to.
 */
export const COMPUTER_USE_SEMANTIC_ACTIONS = [
  'list_apps',
  'launch_app',
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
      /**
       * The message may be shown to the model.
       *
       * Set only by a backend that guarantees its diagnostics carry no text
       * belonging to the observed application. `maka.cu/2` §1.2 makes that a
       * protocol rule: `error.message` is a fixed sentence chosen by
       * `error.code`, and application text is confined to the declared
       * observation fields. cua-driver made no such promise, which is why the
       * message was withheld from every backend alike.
       *
       * Withholding it costs more than it protects. The executor writes "say
       * Backspace or ForwardDelete rather than delete"; the model was handed
       * `unsupported_action` alone, and the tool description tells it that code
       * means keyboard input is off in this build. One mistyped key name taught
       * it that the keyboard does not work.
       *
       * Absent means withheld, so a backend that forgets this flag is quiet
       * rather than leaky.
       */
      messageIsAppTextFree?: boolean;
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
/**
 * One step of an `element_sequence`, as the model reads it back.
 *
 * Projected member by member rather than as one shape, because `steps` is an
 * array in both schemas and `"<2 items>"` is a string: a model replaying its own
 * sequence sent `steps: "<2 items>"`, the `.strict()` wire schema rejected the
 * call before `impl`, and the rejection never reached the debug journal. A step
 * that keeps its own shape stays an array, so the call is refused by name
 * instead of disappearing.
 */
export interface ComputerUseModelCallStep {
  label: string;
  role?: string;
  do?: string;
  value?: string;
}

export interface ComputerUseModelCallArgs {
  action: string;
  app?: string;
  window_id?: number;
  observation_id?: string;
  element_id?: string;
  /** Every other argument the call carried, values reduced to their shape. */
  [key: string]:
    | string
    | number
    | boolean
    | readonly number[]
    | readonly ComputerUseModelCallStep[]
    | undefined;
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
const HOST_ONLY_ARGS = new Set([
  'approvalClass',
  'rememberForTurnAllowed',
  'element_identity',
  'elementIdentity',
]);

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
 *
 * The rule this map has to satisfy, and did not: an argument whose value is a
 * choice from a set the tool publishes must come back as that choice, because
 * the set is what the schema validates against. `window_action` came back as
 * `"<text:4>"`, `scroll_element`'s direction as `"<text:4>"`, and both are
 * `z.enum`s — so a model replaying its own call was rejected by the SDK before
 * `impl` ran and the rejection never reached the debug journal. `observe`'s
 * `query` and `menu` and `wait`'s `wait_for_text` are worse: they are plain
 * strings, so the replay is accepted, and a model that filtered a 1,200-element
 * window with `query:"下载"` and asked for that view again matched nothing and
 * read `showing 0 of 1200` as proof the control does not exist.
 *
 * `query`, `menu` and `wait_for_text` are the model's own words in the sense
 * that matters here: they are predicates it composed and sent, not a verbatim
 * copy of a field's contents the way `select_text`'s substring is, and not a
 * value a person asked to have typed the way `type` and `set_value` are. They
 * go through `redactSecrets` and a length bound like every other plain value.
 */
const MODEL_CALL_PLAIN_VALUES: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  // `query` and `menu` name what to look at, not what was found there.
  ['observe', new Set(['include_screenshot', 'query', 'menu'])],
  ['screenshot', new Set(['include_screenshot'])],
  ['scroll', new Set(['scroll_direction', 'scroll_amount'])],
  // The semantic twin of `scroll`, added after this map was written.
  ['scroll_element', new Set(['scroll_direction', 'scroll_amount'])],
  // The verb, from the enum the schema publishes. `position` and `size` are
  // geometry and are handled by MODEL_CALL_GEOMETRY_ARGS below.
  ['window_action', new Set(['window_action'])],
  // The text a wait is waiting for is a prediction about the screen, written
  // before the screen shows it.
  ['wait', new Set(['duration', 'wait_for_text', 'wait_for_text_gone'])],
  // The key name, from the set of key names the executor accepts.
  ['press_key', new Set(['text'])],
  ['key', new Set(['text'])],
  ['hold_key', new Set(['text', 'duration'])],
  // The element action name, from the closed set the observation lists.
  ['secondary_action', new Set(['text'])],
]);

/**
 * Members of an `element_sequence` step that are the model's own choice.
 *
 * `do` is a two-value enum and `role` is an accessibility role name from a
 * fixed vocabulary; both are rejected by the schema when they come back as a
 * shape. `label` and `value` are not here: a label is the text a control shows,
 * and a value is what a person asked to have written.
 */
const MODEL_CALL_PLAIN_STEP_MEMBERS = new Set(['do', 'role']);

/**
 * Geometry the model itself chose, projected verbatim.
 *
 * Independent of action, because these names mean the same thing wherever they
 * appear and none of them ever holds screen content: a coordinate, the drag
 * origin, the zoom rectangle, and the place and size a window was asked to take
 * are numbers the model wrote into the call. A model that clicked a point and
 * missed has to be able to see which point, or its next call is the same call.
 *
 * `position` and `size` joined late, with `window_action`. Reduced to
 * `"<point>"` they were a string where the schema wants a tuple, so a replayed
 * window move was rejected off the wire.
 */
const MODEL_CALL_GEOMETRY_ARGS = new Set([
  'coordinate',
  'start_coordinate',
  'region',
  'position',
  'size',
]);

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
 *
 * A string carries its length. `<text>` on its own was a placeholder in the
 * shape of a fill-in-the-blank, and `value`/`text` are `z.string().max(8000)`
 * with no lower bound or pattern — so `"<text>"` was a legal call at the wire
 * schema and at the strict union both, and a model replaying its own
 * `set_value` typed those six characters into the user's field. A length is a
 * description of the value rather than a substitute for it, and
 * `COMPUTER_USE_WITHHELD_VALUE` below is what the tool refuses on so the
 * mistake is named instead of typed.
 */
function shapeOf(value: unknown): string {
  if (Array.isArray(value)) {
    return value.length === 2 && value.every((v) => typeof v === 'number')
      ? '<point>'
      : `<${value.length} ${value.length === 1 ? 'item' : 'items'}>`;
  }
  if (typeof value === 'string') return `<text:${value.length}>`;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '<value>';
}

/**
 * The steps of an `element_sequence`, each member projected on its own terms.
 *
 * Returns `undefined` for anything that is not a list of step-shaped objects,
 * so a malformed `steps` still degrades to a shape rather than being echoed.
 */
function projectSteps(value: unknown): readonly ComputerUseModelCallStep[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > 32) return undefined;
  const projected: ComputerUseModelCallStep[] = [];
  for (const entry of value) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return undefined;
    const step = asRecord(entry);
    const out: ComputerUseModelCallStep = { label: shapeOf(ownDataProperty(step, 'label')) };
    for (const member of MODEL_CALL_PLAIN_STEP_MEMBERS) {
      const held = ownDataProperty(step, member);
      if (typeof held === 'string' && held.length > 0) {
        out[member as 'do' | 'role'] = boundedDisplay(redactSecrets(held), 64);
      }
    }
    if ('value' in step) out.value = shapeOf(ownDataProperty(step, 'value'));
    projected.push(out);
  }
  return projected;
}

/**
 * The marks a withheld argument leaves in the record the model reads back.
 *
 * Exported so the tool can refuse one instead of acting on it literally: the
 * record is the shape a model imitates, and these are the only strings in it
 * that were never a value.
 *
 * Bare `<text>` is here although nothing writes it any more. It is what the
 * previous release wrote, and a conversation that started under that release
 * carries it in history; a model replaying that call has to be refused too,
 * not have those six characters typed into the user's field.
 */
export const COMPUTER_USE_WITHHELD_VALUE = /^<(?:text(?::\d+)?|point|value|\d+ items?)>$/;

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
  const rest: Record<
    string,
    string | number | boolean | readonly number[] | readonly ComputerUseModelCallStep[]
  > = {};
  const plain = MODEL_CALL_PLAIN_VALUES.get(action);
  for (const [key, value] of Object.entries(record ?? {})) {
    if (MODEL_CALL_NAMED_ARGS.has(key) || HOST_ONLY_ARGS.has(key)) continue;
    if (MODEL_CALL_GEOMETRY_ARGS.has(key)) {
      rest[key] = integerTuple(value) ?? shapeOf(value);
      continue;
    }
    if (key === 'steps') {
      const steps = projectSteps(value);
      rest[key] = steps ?? shapeOf(value);
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
    // Redacted like every field beside it. This one is the model's way back to
    // an observation it already read, so the temptation is to pass it through
    // untouched — but the model is what wrote it, and nothing validates the
    // arguments before this projection runs, so a secret-shaped value under
    // this key reached the transcript verbatim while the same string under
    // `app` or `element_id` was redacted. An id the executor actually minted is
    // a UUID, which `redactSecrets` leaves alone, so the observe-then-act loop
    // is unaffected: what gets rewritten here was never one of ours.
    ...(typeof observationId === 'string' && stableIdentifier(observationId)
      ? { observation_id: boundedDisplay(redactSecrets(stableIdentifier(observationId)!), 256) }
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
const SEMANTIC_ACTIONS = new Set([
  'click_element',
  'set_value',
  'select_text',
  'secondary_action',
  // Scrolling an element moves what is on screen without changing any value.
  // It is still a mutation of the target's state, and it is the semantic twin
  // of the coordinate `scroll` that already sits in POINTER_ACTIONS.
  'scroll_element',
  // A sequence of element actions is still element actions: same class, same
  // approval, one call.
  'element_sequence',
  // Starting an app changes what is on screen. It touches no element, but it
  // is not a read, and letting it fall through to the default would have
  // classified it correctly by accident rather than on purpose.
  'launch_app',
]);

// Exactly the wire vocabulary, derived rather than restated: an action the tool
// accepts is an action a person can be asked to approve.
const APPROVAL_ACTIONS = new Set<string>(CU_TOOL_ACTION_TYPES);

export function computerUseApprovalSummary(args: unknown): ComputerUseApprovalSummary {
  const record = asRecord(args);
  const rawAction = ownDataProperty(record, 'action');
  const knownAction = typeof rawAction === 'string' && APPROVAL_ACTIONS.has(rawAction);
  const action = knownAction ? rawAction : 'unknown';
  // The tool defaults observe to a text-only Accessibility tree. Permission
  // classification must follow the action that will execute, not the old
  // screenshot-by-default contract: an omitted flag is metadata_read, and only
  // an explicit true requires Screen Recording approval.
  const includeScreenshot = ownDataProperty(record, 'include_screenshot') === true;
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
