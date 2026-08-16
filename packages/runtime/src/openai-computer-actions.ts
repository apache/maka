import { z } from 'zod';
import type { CuAction, CuPoint } from '@maka/core/computer-use';

const pointSchema = z
  .object({
    x: z.number().int(),
    y: z.number().int(),
  })
  .strict();

const keysSchema = z.array(z.string().min(1)).nullable().optional();

export const openAIComputerActionSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('click'),
      button: z.enum(['left', 'right', 'wheel', 'back', 'forward']),
      x: z.number().int(),
      y: z.number().int(),
      keys: keysSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal('double_click'),
      x: z.number().int(),
      y: z.number().int(),
      keys: keysSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal('drag'),
      path: z.array(pointSchema).min(2),
      keys: keysSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal('keypress'),
      keys: z.array(z.string().min(1)).min(1),
    })
    .strict(),
  z
    .object({
      type: z.literal('move'),
      x: z.number().int(),
      y: z.number().int(),
      keys: keysSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal('screenshot'),
    })
    .strict(),
  z
    .object({
      type: z.literal('scroll'),
      x: z.number().int(),
      y: z.number().int(),
      scroll_x: z.number().int(),
      scroll_y: z.number().int(),
      keys: keysSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal('type'),
      text: z.string(),
    })
    .strict(),
  z
    .object({
      type: z.literal('wait'),
    })
    .strict(),
]);

export type OpenAIComputerAction = z.infer<typeof openAIComputerActionSchema>;

export type OpenAIComputerActionConversion =
  | { ok: true; actions: CuAction[] }
  | {
      ok: false;
      code:
        | 'unsupported_button'
        | 'unsupported_drag_path'
        | 'unsupported_keypress_chord'
        | 'unsupported_modifier_keys'
        | 'unsupported_scroll_delta'
        | 'unsupported_action_policy';
      message: string;
    };

const point = (x: number, y: number): CuPoint => ({ x, y });

export function isOpenAIComputerActionSafeByDefault(action: OpenAIComputerAction): boolean {
  return action.type === 'screenshot' || action.type === 'wait';
}

function unsupportedModifiers(
  action: OpenAIComputerAction,
): OpenAIComputerActionConversion | undefined {
  if (action.type !== 'keypress' && 'keys' in action && action.keys && action.keys.length > 0) {
    return {
      ok: false,
      code: 'unsupported_modifier_keys',
      message: `OpenAI ${action.type} keys cannot be represented by the current CuAction without losing hold/release semantics`,
    };
  }
  return undefined;
}

/**
 * Convert one OpenAI computer action into one or more existing CuActions.
 * Conversion is deliberately fail-closed when CuAction cannot preserve the
 * provider action's path, pixel delta, button, or modifier semantics.
 */
export function convertOpenAIComputerAction(
  action: OpenAIComputerAction,
): OpenAIComputerActionConversion {
  const modifierFailure = unsupportedModifiers(action);
  if (modifierFailure) return modifierFailure;

  switch (action.type) {
    case 'screenshot':
      // The provider loop owns one authoritative post-batch capture path.
      return { ok: true, actions: [] };
    case 'move':
      return { ok: true, actions: [{ type: 'mouse_move', coordinate: point(action.x, action.y) }] };
    case 'click': {
      const coordinate = point(action.x, action.y);
      if (action.button === 'left')
        return { ok: true, actions: [{ type: 'left_click', coordinate }] };
      if (action.button === 'right')
        return { ok: true, actions: [{ type: 'right_click', coordinate }] };
      if (action.button === 'wheel')
        return { ok: true, actions: [{ type: 'middle_click', coordinate }] };
      return {
        ok: false,
        code: 'unsupported_button',
        message: `OpenAI click button '${action.button}' has no lossless CuAction representation`,
      };
    }
    case 'double_click':
      return {
        ok: true,
        actions: [{ type: 'double_click', coordinate: point(action.x, action.y) }],
      };
    case 'drag':
      if (action.path.length !== 2) {
        return {
          ok: false,
          code: 'unsupported_drag_path',
          message: `OpenAI drag path has ${action.path.length} points; CuAction preserves only start and end`,
        };
      }
      return {
        ok: true,
        actions: [
          {
            type: 'left_click_drag',
            startCoordinate: action.path[0],
            coordinate: action.path[1],
          },
        ],
      };
    case 'scroll':
      return {
        ok: false,
        code: 'unsupported_scroll_delta',
        message: `OpenAI scroll delta (${action.scroll_x}, ${action.scroll_y}) is pixel-based and cannot be represented losslessly by CuAction scrollAmount`,
      };
    case 'keypress':
      if (action.keys.length !== 1) {
        return {
          ok: false,
          code: 'unsupported_keypress_chord',
          message: `OpenAI keypress chord has ${action.keys.length} keys; CuAction.key cannot preserve chord semantics`,
        };
      }
      return {
        ok: true,
        actions: [{ type: 'key', text: action.keys[0] }],
      };
    case 'type':
      return { ok: true, actions: [{ type: 'type', text: action.text }] };
    case 'wait':
      return { ok: true, actions: [{ type: 'wait', durationMs: 2000 }] };
  }
}
