import type { MakaTool } from '@maka/runtime';

export function computerUseToolsForModel(
  tools: readonly MakaTool[],
  computerUseTools: readonly MakaTool[],
  supportsVision: boolean,
): MakaTool[] {
  if (supportsVision || computerUseTools.length === 0) return [...tools];
  const computerUseToolNames = new Set(computerUseTools.map((tool) => tool.name));
  return tools.filter((tool) => !computerUseToolNames.has(tool.name));
}
