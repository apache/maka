import { z } from 'zod';
import { type CuAction, type CuPoint } from '@maka/core/computer-use';
import type { CuDispatchEvidence, CuRunResult, CuSemanticAction } from './computer-use-types.js';

export const coordinate = z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative()]);
export const text = z.string().max(8000);

/**
 * The sentences the schema's own refinements produce.
 *
 * A `.refine()` failure carries its message and an empty `issue.path`, so the
 * violation describer had no field to name and fell through to the generic
 * "the argument shape does not match this action" — throwing away the one
 * sentence that said what was missing. They are listed here so the describer
 * can pass a message through only when this file wrote it: a message is host
 * prose, and anything that did not come from this table could be carrying
 * whatever the model or the executor put in it.
 */
export const COMPUTER_USE_REFINEMENT_MESSAGES = {
  observeTarget:
    'observe requires app or window_id — name the application in `app`, or pass a `window_id` from an earlier observe',
  screenshotTarget:
    'screenshot requires app or window_id — name the application in `app`, or pass a `window_id` from an earlier observe',
  windowMovePosition: 'window_action move requires position',
  windowResizeSize: 'window_action resize requires size',
  waitOneCondition: 'wait takes one condition, not both — send wait_for_text or wait_for_text_gone',
} as const;

const REFINEMENT_MESSAGE_SET: ReadonlySet<string> = new Set(
  Object.values(COMPUTER_USE_REFINEMENT_MESSAGES),
);

/**
 * The target hints a model may repeat on an action that already names its
 * target through `observation_id`.
 *
 * The tool schema the model is shown is one flat object: `app` and `window_id`
 * are top-level optional parameters described as "exact window_id from
 * list_apps or observe", so a model being careful about which window it is
 * driving supplies them. This union then rejected them as unrecognized keys.
 *
 * On a real desktop run that cost six of eleven calls: the model repeated the
 * same shape three times, was told only "arguments failed validation", guessed
 * a different shape, and abandoned the arithmetic half-finished.
 *
 * They are accepted and then checked against the observation the action is
 * bound to — never trusted as the target. Dispatch still resolves through the
 * frame, and a hint that contradicts the frame is reported rather than ignored.
 */
const redundantTargetHints = {
  app: z.string().min(1).max(512).optional(),
  window_id: z.number().int().positive().optional(),
} as const;
const pointerAction = <
  T extends 'left_click' | 'right_click' | 'middle_click' | 'double_click' | 'triple_click',
>(
  action: T,
) =>
  z
    .object({
      action: z.literal(action),
      observation_id: z.string().min(1).max(256),
      coordinate,
      text: text.optional(),
    })
    .strict();
export const computerParams = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('list_apps'),
      /**
       * Narrow the list to what was asked for.
       *
       * Unfiltered this was 12,933 bytes on a real run — about 3,600 tokens,
       * 85% of a three-call turn — spent confirming an app id the prompt had
       * already named. Every model tried, from the strongest to the weakest,
       * because it is the only bridge from a display name to the app id
       * `observe` requires.
       */
      app: z.string().min(1).max(512).optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal('launch_app'),
      // The model names an app; everything else about how it is launched stays
      // host-controlled. The driver also accepts arbitrary argv and a WebKit
      // inspector port, neither of which the model gets to set.
      app: z.string().min(1).max(512),
    })
    .strict(),
  z
    .object({
      action: z.literal('observe'),
      app: z.string().min(1).max(512).optional(),
      window_id: z.number().int().positive().optional(),
      include_screenshot: z.boolean().optional(),
      // §5.8. Every observation lists the menu titles; this opens one of them.
      // A title rather than a path, because only the top level can be opened —
      // a submenu comes with the menu that contains it.
      menu: z.string().min(1).max(256).optional(),
      // Narrows what is written, never what can be addressed.
      query: z.string().min(1).max(256).optional(),
    })
    .strict()
    .refine((input) => input.app !== undefined || input.window_id !== undefined, {
      // No mention of approval: whether a call is reviewed is a host pipeline
      // the model cannot see, cannot influence, and cannot fix by re-sending.
      // What it can fix is the missing argument.
      message: COMPUTER_USE_REFINEMENT_MESSAGES.observeTarget,
    }),
  z
    .object({
      action: z.literal('click_element'),
      observation_id: z.string().min(1).max(256),
      element_id: z.string().min(1).max(256),
      ...redundantTargetHints,
    })
    .strict(),
  z
    .object({
      action: z.literal('set_value'),
      observation_id: z.string().min(1).max(256),
      element_id: z.string().min(1).max(256),
      value: text,
      ...redundantTargetHints,
    })
    .strict(),
  z
    .object({
      action: z.literal('select_text'),
      observation_id: z.string().min(1).max(256),
      element_id: z.string().min(1).max(256),
      text,
      ...redundantTargetHints,
    })
    .strict(),
  z
    .object({
      action: z.literal('secondary_action'),
      observation_id: z.string().min(1).max(256),
      element_id: z.string().min(1).max(256),
      text,
      ...redundantTargetHints,
    })
    .strict(),
  z
    .object({
      action: z.literal('scroll_element'),
      observation_id: z.string().min(1).max(256),
      element_id: z.string().min(1).max(256),
      scroll_direction: z.enum(['up', 'down', 'left', 'right']),
      scroll_amount: z.number().int().min(0).max(100).optional(),
      ...redundantTargetHints,
    })
    .strict(),
  /**
   * Several element actions described the way a person would describe them,
   * carried out one at a time by the host.
   *
   * `element_id` is an index into one snapshot: it is spent the moment anything
   * happens, so every action costs the model a round trip to look again. On a
   * real seven-application matrix that came to 97 calls for at most five useful
   * actions per scenario, and six of seven ran out of time — with a median tool
   * call of 734ms. The round trips were the whole cost.
   *
   * A label is not an index. "Press 7, then multiply, then 8, then equals" is
   * true of the calculator before and after each press, so the host can take
   * one step, look again with its own eyes, find the next control, and take the
   * next — which is what frame binding wants. It exists to stop the MODEL
   * acting on a view that has moved on; the host acting on a view it captured
   * a moment ago is the case it was built to allow.
   *
   * Stops at the first step it cannot resolve unambiguously or cannot dispatch,
   * and says which one.
   */
  z
    .object({
      action: z.literal('element_sequence'),
      observation_id: z.string().min(1).max(256),
      steps: z
        .array(
          z
            .object({
              label: z.string().min(1).max(256),
              role: z.string().min(1).max(64).optional(),
              do: z.enum(['click', 'set_value']).optional(),
              value: text.optional(),
            })
            .strict(),
        )
        .min(1)
        .max(12),
      ...redundantTargetHints,
    })
    .strict(),
  /**
   * A window's own geometry, which is not a control on the screen.
   *
   * `AXPosition` and `AXSize` are settable on nearly every window and writing
   * them does not bring the application forward, so this costs none of the
   * invariants a drag would. It is separate from the element actions because it
   * addresses the window rather than something inside it.
   */
  z
    .object({
      action: z.literal('window_action'),
      observation_id: z.string().min(1).max(256),
      element_id: z.string().min(1).max(256),
      window_action: z.enum(['move', 'resize', 'minimize']),
      // Not `coordinate`: that one is non-negative because it addresses a pixel
      // inside a window's own screenshot, where there is no such thing as a
      // negative offset. A window's position is a place on the desktop, and a
      // second display is a real place — measured on this machine, display 2
      // sits at (-193, -1080) in the space the observation already reports its
      // window bounds in. Refusing a negative here makes half the desktop
      // unaddressable.
      position: z.tuple([z.number().int(), z.number().int()]).optional(),
      size: z.tuple([z.number().int().positive(), z.number().int().positive()]).optional(),
      ...redundantTargetHints,
    })
    .strict()
    .refine((input) => input.window_action !== 'move' || input.position !== undefined, {
      message: COMPUTER_USE_REFINEMENT_MESSAGES.windowMovePosition,
    })
    .refine((input) => input.window_action !== 'resize' || input.size !== undefined, {
      message: COMPUTER_USE_REFINEMENT_MESSAGES.windowResizeSize,
    }),
  z
    .object({
      action: z.literal('press_key'),
      observation_id: z.string().min(1).max(256),
      text,
      /**
       * Which control the key is for.
       *
       * Optional, and not a hint: the driver focuses the named element through
       * accessibility before posting the key. Without it a key is posted to the
       * application and lands on whatever happens to have focus, which is a
       * guess the model was already trying to replace — it sent `element_id`
       * and was told only that the field was unknown.
       */
      element_id: z.string().min(1).max(256).optional(),
      ...redundantTargetHints,
    })
    .strict(),
  z
    .object({
      action: z.literal('screenshot'),
      app: z.string().min(1).max(512).optional(),
      window_id: z.number().int().positive().optional(),
    })
    .strict()
    .refine((input) => input.app !== undefined || input.window_id !== undefined, {
      message: COMPUTER_USE_REFINEMENT_MESSAGES.screenshotTarget,
    }),
  z.object({ action: z.literal('cursor_position') }).strict(),
  z
    .object({
      action: z.literal('mouse_move'),
      observation_id: z.string().min(1).max(256),
      coordinate,
    })
    .strict(),
  pointerAction('left_click'),
  pointerAction('right_click'),
  pointerAction('middle_click'),
  pointerAction('double_click'),
  pointerAction('triple_click'),
  z
    .object({
      action: z.literal('left_mouse_down'),
      observation_id: z.string().min(1).max(256),
      coordinate,
    })
    .strict(),
  z
    .object({
      action: z.literal('left_mouse_up'),
      observation_id: z.string().min(1).max(256),
      coordinate,
    })
    .strict(),
  z
    .object({
      action: z.literal('left_click_drag'),
      observation_id: z.string().min(1).max(256),
      start_coordinate: coordinate,
      coordinate,
      text: text.optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal('type'),
      observation_id: z.string().min(1).max(256),
      text,
    })
    .strict(),
  z
    .object({
      action: z.literal('key'),
      observation_id: z.string().min(1).max(256),
      text,
    })
    .strict(),
  z
    .object({
      action: z.literal('hold_key'),
      observation_id: z.string().min(1).max(256),
      text,
      duration: z.number().min(0).max(60).optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal('scroll'),
      observation_id: z.string().min(1).max(256),
      coordinate,
      scroll_direction: z.enum(['up', 'down', 'left', 'right']).optional(),
      scroll_amount: z.number().int().min(0).max(100).optional(),
      text: text.optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal('wait'),
      duration: z.number().min(0).max(60).optional(),
      // A condition, so the wait can end when the thing happens rather than
      // when a guessed number of seconds runs out.
      wait_for_text: z.string().min(1).max(256).optional(),
      wait_for_text_gone: z.string().min(1).max(256).optional(),
    })
    .strict()
    .refine((input) => !(input.wait_for_text && input.wait_for_text_gone), {
      message: COMPUTER_USE_REFINEMENT_MESSAGES.waitOneCondition,
    }),
  z
    .object({
      action: z.literal('zoom'),
      observation_id: z.string().min(1).max(256),
      region: z.tuple([
        z.number().int().nonnegative(),
        z.number().int().nonnegative(),
        z.number().int().nonnegative(),
        z.number().int().nonnegative(),
      ]),
    })
    .strict(),
]);
export type ComputerParams = z.infer<typeof computerParams>;

/** Every action name this tool accepts, in schema order. */
export function computerActionNames(): string[] {
  const names: string[] = [];
  for (const option of computerParams.options) {
    const shape = option.shape as Record<string, { value?: unknown }>;
    const literal = shape.action;
    const value = literal?.value ?? (literal as { _def?: { value?: unknown } })?._def?.value;
    if (typeof value === 'string') names.push(value);
  }
  return names;
}

/**
 * The argument names one action accepts, or undefined if the action is unknown.
 *
 * Naming what was rejected leaves the model to guess what to send instead, and
 * guessing is what it does: a real run spent twenty of twenty-seven calls
 * re-sending shapes that had already been refused, because every refusal said
 * what was wrong and none said what was right. The schema already holds the
 * answer.
 */
export function computerActionFields(action: unknown): string[] | undefined {
  if (typeof action !== 'string') return undefined;
  for (const option of computerParams.options) {
    const shape = option.shape as Record<string, { value?: unknown }>;
    const literal = shape.action;
    const value = literal?.value ?? (literal as { _def?: { value?: unknown } })?._def?.value;
    if (value === action) return Object.keys(shape).filter((key) => key !== 'action');
  }
  return undefined;
}

/**
 * What was wrong with the arguments, in terms of the argument names only.
 *
 * Computer Use replaced the generic formatter with a fixed string, because the
 * generic one hands the model whatever the error carries and these arguments
 * can hold typed text. The cost was a model that could not learn: told only
 * "arguments failed validation", it re-sent the identical call three times in a
 * row on a real desktop run before guessing at a different shape.
 *
 * Field names and the schema's own constraints are the model's own input
 * vocabulary, not screen content, so they are safe to name. Values never are,
 * and none are read here — only `issue.path` and the issue's kind.
 */
export function describeComputerUseArgsViolation(
  error: unknown,
  args?: unknown,
): string | undefined {
  const issues = (error as { issues?: unknown })?.issues;
  if (!Array.isArray(issues) || issues.length === 0) return undefined;
  const parts: string[] = [];
  for (const raw of issues.slice(0, 6)) {
    const issue = raw as {
      code?: string;
      keys?: unknown;
      path?: unknown;
      expected?: unknown;
      message?: unknown;
    };
    const path = Array.isArray(issue.path) ? issue.path.filter((p) => typeof p === 'string') : [];
    const field = path.length > 0 ? path.join('.') : undefined;
    // A refinement carries the whole answer in its message and nothing in its
    // path, so the field-name branches below cannot see it and the generic
    // fallback used to replace it with "the argument shape does not match this
    // action" — a model told an `observe` needs one of two named arguments can
    // fix the call; a model told the shape is wrong cannot.
    //
    // Only messages this file wrote are passed through. A message is free
    // prose, and one from anywhere else could be quoting the arguments back.
    if (typeof issue.message === 'string' && REFINEMENT_MESSAGE_SET.has(issue.message)) {
      parts.push(issue.message);
      continue;
    }
    if (issue.code === 'unrecognized_keys' && Array.isArray(issue.keys)) {
      const keys = issue.keys.filter((k): k is string => typeof k === 'string');
      if (keys.length > 0) {
        // Naming the rejected key is half an answer. A model that reached for
        // `element_id` on `press_key` was trying to say where the key should
        // land, and telling it only that the field is unknown leaves it to
        // guess again — which on a real run it did.
        const recovery = keys.includes('element_id')
          ? ' — name the control through the action that acts on it, or click_element it first'
          : '';
        parts.push(
          `this action does not take ${keys.map((k) => `\`${k}\``).join(', ')}${recovery}`,
        );
        continue;
      }
    }
    if (issue.code === 'invalid_type' && field) {
      parts.push(
        typeof issue.expected === 'string'
          ? `\`${field}\` must be ${issue.expected}`
          : `\`${field}\` has the wrong type`,
      );
      continue;
    }
    if (field) {
      parts.push(`\`${field}\` is missing or out of range`);
      continue;
    }
    parts.push('the argument shape does not match this action');
  }
  const unique = [...new Set(parts)];
  if (unique.length === 0) return undefined;
  // The correction, not just the complaint. A model told only that four keys
  // are unrecognised has no way to know whether it got the whole dialect wrong
  // — which on a real run it had, sending every key in camelCase — and it will
  // keep sending the same shape. Listing the action's own field names ends
  // that in one round trip.
  const accepted = computerActionFields((args as { action?: unknown } | undefined)?.action);
  const guidance =
    accepted && accepted.length > 0
      ? `. This action takes ${accepted.map((field) => `\`${field}\``).join(', ')}`
      : accepted
        ? '. This action takes no other arguments'
        : '';
  return `${unique.join('; ')}${guidance}`;
}

const point = (c?: [number, number]): CuPoint | undefined => (c ? { x: c[0], y: c[1] } : undefined);

export function snapshotComputerParams(args: ComputerParams): ComputerParams {
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(args))) {
    if (descriptor.get || descriptor.set) {
      throw new Error(`invalid_computer_params: '${key}' must be a plain data property`);
    }
  }
  const cloneTuple = <T extends readonly number[] | undefined>(value: T): T =>
    (value ? Object.freeze([...value]) : value) as T;
  const source = args as ComputerParams & Record<string, unknown>;
  const snapshot = { ...source } as Record<string, unknown>;
  if (Object.hasOwn(source, 'coordinate')) {
    snapshot.coordinate = cloneTuple(source.coordinate as [number, number] | undefined);
  }
  if (Object.hasOwn(args, 'start_coordinate')) {
    snapshot.start_coordinate = cloneTuple(source.start_coordinate as [number, number] | undefined);
  }
  if (Object.hasOwn(source, 'region')) {
    snapshot.region = cloneTuple(source.region as [number, number, number, number] | undefined);
  }
  return Object.freeze(snapshot) as ComputerParams;
}

/**
 * Map the provider-neutral wire grammar onto the discriminated `CuAction` the
 * backend consumes. Throws on a malformed action (missing required field); the
 * runtime converts the throw into an error tool-result.
 */
export function adaptToCuAction(args: ComputerParams): CuAction {
  const need = (c?: [number, number]): CuPoint => {
    const p = point(c);
    if (!p) throw new Error(`invalid_coordinate: action '${args.action}' requires coordinate`);
    return p;
  };
  const needText = (value: string | undefined, action: string): string => {
    if (typeof value !== 'string' || value.length === 0) {
      // Not `invalid_coordinate`: nothing here is about a point on the screen,
      // and a model handed a coordinate code for a missing string goes and
      // checks its coordinates. The field that is missing is the one named.
      throw new Error(
        `invalid_arguments: action '${action}' requires text — the characters to type, or the key name, go in \`text\``,
      );
    }
    return value;
  };
  switch (args.action) {
    case 'list_apps':
    case 'launch_app':
    case 'observe':
    case 'click_element':
    case 'set_value':
    case 'select_text':
    case 'secondary_action':
    case 'scroll_element':
    case 'press_key':
      throw new Error(`semantic action '${args.action}' requires the semantic backend`);
    case 'screenshot':
      return { type: 'screenshot' };
    case 'cursor_position':
      return { type: 'cursor_position' };
    case 'mouse_move':
      return { type: 'mouse_move', coordinate: need(args.coordinate) };
    case 'left_click':
      return { type: 'left_click', coordinate: need(args.coordinate), text: args.text };
    case 'right_click':
      return { type: 'right_click', coordinate: need(args.coordinate), text: args.text };
    case 'middle_click':
      return { type: 'middle_click', coordinate: need(args.coordinate), text: args.text };
    case 'double_click':
      return { type: 'double_click', coordinate: need(args.coordinate), text: args.text };
    case 'triple_click':
      return { type: 'triple_click', coordinate: need(args.coordinate), text: args.text };
    case 'left_mouse_down':
      return { type: 'left_mouse_down', coordinate: need(args.coordinate) };
    case 'left_mouse_up':
      return { type: 'left_mouse_up', coordinate: need(args.coordinate) };
    case 'left_click_drag':
      return {
        type: 'left_click_drag',
        startCoordinate: need(args.start_coordinate),
        coordinate: need(args.coordinate),
        text: args.text,
      };
    case 'type':
      return { type: 'type', text: needText(args.text, args.action) };
    case 'key':
      return { type: 'key', text: needText(args.text, args.action) };
    case 'hold_key':
      return {
        type: 'hold_key',
        text: needText(args.text, args.action),
        durationMs: Math.round((args.duration ?? 0) * 1000),
      };
    case 'scroll':
      return {
        type: 'scroll',
        coordinate: need(args.coordinate),
        scrollDirection: args.scroll_direction ?? 'down',
        scrollAmount: args.scroll_amount ?? 3,
        text: args.text,
      };
    case 'wait':
      return { type: 'wait', durationMs: Math.round((args.duration ?? 0) * 1000) };
    case 'zoom': {
      if (!args.region) throw new Error("invalid_coordinate: action 'zoom' requires region");
      const [x1, y1, x2, y2] = args.region;
      return { type: 'zoom', region: { x1, y1, x2, y2 } };
    }
    default:
      // The action name is the one field the model always chooses for itself,
      // and the schema already holds the closed set it may choose from. Naming
      // it "unknown action" under a coordinate code sent the model looking at
      // its coordinates for a word it had misspelled.
      throw new Error(
        `invalid_arguments: unknown action — this tool takes one of: ${computerActionNames().join(', ')}`,
      );
  }
}

/**
 * Who a summary line is written for.
 *
 * `host` is the stored/journalled line and keeps everything an operator reading
 * a trace back needs. `model` is what goes into the conversation, and it drops
 * the fields the model has no move to make about.
 */
export type CuSummaryAudience = 'model' | 'host';

/** Concise summary of an outcome (S16-safe: no screen text here). */
export function summarizeEvidence(
  evidence: CuDispatchEvidence | undefined,
  audience: CuSummaryAudience = 'model',
): string {
  if (!evidence) return '';
  const safeToken = (value: string): string | undefined =>
    /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(value) ? value : undefined;
  const fields: string[] = [];
  // `cg_event_pid`, `ax_action`, `skylight_pid`: which macOS mechanism carried
  // the action. The model does not choose the route and cannot ask for another
  // one, so on the model face this is a token it can only copy back. On a real
  // run it was on every line — 23 of them in one scenario — and no call ever
  // changed because of it. It stays on the host face, where the question "which
  // route did this go out on" is the whole reason the field exists.
  if (audience === 'host') {
    const path = evidence.path ? safeToken(evidence.path) : undefined;
    if (path) fields.push(`path=${path}`);
  }
  // `effect` stays on both faces. It is the one field here the model acts on:
  // `suspected_noop` means a retry of the same thing is a retry of nothing.
  if (evidence.effect) fields.push(`effect=${evidence.effect}`);
  // Which of several conditions produced the error code, when the host
  // authored one. `target_changed` alone covers seven different situations —
  // the window moved, the tree changed under the observation, the element left
  // the window — and they call for different next moves.
  //
  // Host face only: what actually reached the model was `dispatch.key:none`
  // and its siblings — the executor's own RPC method names, which are neither
  // a condition nor a next move. The model-facing sentence for a refusal is
  // the executor's `message`, which `summarize` already carries.
  //
  // Passed through `safeToken`, which is what keeps this from becoming the
  // driver's free text: only a bounded identifier survives, never an AX label,
  // a window title, or anything else that was on screen.
  if (audience === 'host') {
    const reason = evidence.reason ? safeToken(evidence.reason) : undefined;
    if (reason) fields.push(`reason=${reason}`);
  }
  return fields.length > 0 ? `; dispatch ${fields.join(', ')}` : '';
}

export type ComputerSummaryAction = {
  type: CuAction['type'] | CuSemanticAction['type'];
};

export function summarize(
  action: ComputerSummaryAction,
  result: CuRunResult,
  audience: CuSummaryAudience = 'model',
): string {
  const { outcome } = result;
  const evidence = summarizeEvidence(outcome.evidence, audience);
  if (!outcome.ok) {
    // The code alone is not a recovery instruction. `unsupported_action` covers
    // a key name the host could not parse, an element that does not offer the
    // action, and an action this executor has no method for — three different
    // next moves. The sentence beside it says which, and the model was never
    // shown it.
    //
    // It is shown only when the backend declares its diagnostics carry no
    // application text (`maka.cu/2` §1.2 makes that a protocol rule). Absent
    // means withheld: a backend that says nothing is treated as one that
    // cannot promise it.
    const detail =
      outcome.messageIsAppTextFree === true && outcome.message ? ` — ${outcome.message}` : '';
    return (
      `maka_computer.${action.type} failed: ${outcome.error}${detail}${evidence}` +
      (typeof outcome.completedSubSteps === 'number'
        ? ` (completed ${outcome.completedSubSteps} sub-steps)`
        : '')
    );
  }
  const verified = outcome.verified === undefined ? 'n/a' : String(outcome.verified);
  const shot = result.screenshot
    ? `; screenshot ${result.screenshot.widthPx}x${result.screenshot.heightPx}`
    : '';
  const pointStr =
    action.type === 'cursor_position' && result.resolvedScreenPoint
      ? `; screen_point=${result.resolvedScreenPoint.x},${result.resolvedScreenPoint.y}`
      : '';
  // `ok` is what the model reads first, and for a dispatch that provably
  // changed nothing it is the wrong first word. The executor already says so —
  // `effect: "suspected_noop"` means the action was delivered and the tree
  // afterwards was the one from before — but that verdict sat inside the
  // evidence clause behind the word `ok`.
  //
  // Measured on a real run: `cmd+p` came back `ok ... suspected_noop` seven
  // times in a row, and the model sent it seven times, then switched to `key`
  // and sent it twice more. It was not guessing at the schema; it was believing
  // a success it had been handed. `ctrl+f2` did the same four times on another
  // model.
  const noop = outcome.evidence?.effect === 'suspected_noop';
  const verdict = noop ? 'delivered but nothing changed' : 'ok';
  // `coordinate-background`, `semantic-background`, `ax`: which tier of the
  // executor took the action. There is no argument that asks for a tier, so a
  // model reading this can only carry it around. `verified` is the part of the
  // same clause it can act on, and that stays on both faces.
  const via = audience === 'host' ? ` via ${outcome.tier}` : '';
  return (
    `maka_computer.${action.type} ${verdict}${via} (verified=${verified})${evidence}${pointStr}${shot}` +
    (outcome.verified === false
      ? ' — dispatch could not be confirmed; re-screenshot before retrying'
      : outcome.verified === true && outcome.evidence?.effect === 'confirmed'
        ? ' — effect confirmed; do not repeat this action'
        : '')
  );
}
