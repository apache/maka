import { z } from 'zod';
import { type CuAction, type CuPoint } from '@maka/core';
import type { CuDispatchEvidence, CuRunResult, CuSemanticAction } from './computer-use-types.js';

export const coordinate = z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative()]);
export const text = z.string().max(8000);
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
  z.object({ action: z.literal('list_apps') }).strict(),
  z
    .object({
      action: z.literal('observe'),
      app: z.string().min(1).max(512).optional(),
      window_id: z.number().int().positive().optional(),
      include_screenshot: z.boolean().optional(),
    })
    .strict()
    .refine((input) => input.app !== undefined || input.window_id !== undefined, {
      message: 'observe requires app or window_id before approval',
    }),
  z
    .object({
      action: z.literal('click_element'),
      observation_id: z.string().min(1).max(256),
      element_id: z.string().min(1).max(256),
    })
    .strict(),
  z
    .object({
      action: z.literal('set_value'),
      observation_id: z.string().min(1).max(256),
      element_id: z.string().min(1).max(256),
      value: text,
    })
    .strict(),
  z
    .object({
      action: z.literal('select_text'),
      observation_id: z.string().min(1).max(256),
      element_id: z.string().min(1).max(256),
      text,
    })
    .strict(),
  z
    .object({
      action: z.literal('secondary_action'),
      observation_id: z.string().min(1).max(256),
      element_id: z.string().min(1).max(256),
      text,
    })
    .strict(),
  z
    .object({
      action: z.literal('press_key'),
      observation_id: z.string().min(1).max(256),
      text,
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
      message: 'screenshot requires app or window_id before approval',
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
    })
    .strict(),
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
      throw new Error(`invalid_coordinate: action '${action}' requires text`);
    }
    return value;
  };
  switch (args.action) {
    case 'list_apps':
    case 'observe':
    case 'click_element':
    case 'set_value':
    case 'select_text':
    case 'secondary_action':
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
      throw new Error('invalid_coordinate: unknown action');
  }
}

/** Concise, model-facing summary of an outcome (S16-safe: no screen text here). */
export function summarizeEvidence(evidence: CuDispatchEvidence | undefined): string {
  if (!evidence) return '';
  const safeToken = (value: string): string | undefined =>
    /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(value) ? value : undefined;
  const fields: string[] = [];
  const path = evidence.path ? safeToken(evidence.path) : undefined;
  if (path) fields.push(`path=${path}`);
  if (evidence.effect) fields.push(`effect=${evidence.effect}`);
  return fields.length > 0 ? `; dispatch ${fields.join(', ')}` : '';
}

export type ComputerSummaryAction = {
  type: CuAction['type'] | CuSemanticAction['type'];
};

export function summarize(action: ComputerSummaryAction, result: CuRunResult): string {
  const { outcome } = result;
  const evidence = summarizeEvidence(outcome.evidence);
  if (!outcome.ok) {
    // Driver messages and escalation reasons may contain AX labels, window
    // titles, or screen text. Keep them in internal evidence only; the
    // model/session summary exposes controlled codes and short identifiers.
    return (
      `computer.${action.type} failed: ${outcome.error}${evidence}` +
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
  return (
    `computer.${action.type} ok via ${outcome.tier} (verified=${verified})${evidence}${pointStr}${shot}` +
    (outcome.verified === false
      ? ' — dispatch could not be confirmed; re-screenshot before retrying'
      : outcome.verified === true && outcome.evidence?.effect === 'confirmed'
        ? ' — effect confirmed; do not repeat this action'
        : '')
  );
}
