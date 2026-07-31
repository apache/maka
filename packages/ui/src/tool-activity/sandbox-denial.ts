import type { ToolResultContent } from '@maka/core';
import type { ToolActivityItem } from '../materialize.js';

export function isSandboxDeniedToolResult(
  result: ToolResultContent | undefined,
): boolean {
  return (
    result !== undefined &&
    'sandboxDenial' in result &&
    result.sandboxDenial?.likely === true
  );
}

export function isSandboxDeniedTool(item: ToolActivityItem): boolean {
  return item.status === 'errored' && isSandboxDeniedToolResult(item.result);
}
