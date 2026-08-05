export type ToolMode = 'direct' | 'code_mode';

export const DEFAULT_TOOL_MODE: ToolMode = 'direct';

export function isToolMode(value: unknown): value is ToolMode {
  return value === 'direct' || value === 'code_mode';
}
