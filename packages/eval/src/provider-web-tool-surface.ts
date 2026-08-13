const DISALLOWED_WEB_TOOL_NAMES = new Set(['websearch', 'webfetch', 'fetchurl']);

export function removeEvalWebTools(body: Buffer): {
  readonly body: Buffer;
  readonly removed: number;
  readonly model?: string;
  readonly toolNames: readonly string[];
} {
  if (body.length === 0) return { body, removed: 0, toolNames: [] };
  let value: unknown;
  try {
    value = JSON.parse(body.toString('utf8'));
  } catch {
    return { body, removed: 0, toolNames: [] };
  }
  if (!isRecord(value)) return { body, removed: 0, toolNames: [] };
  const model = typeof value.model === 'string' ? value.model : undefined;
  if (!Array.isArray(value.tools))
    return { body, removed: 0, toolNames: [], ...(model ? { model } : {}) };
  const tools = value.tools.filter((tool) => !isDisallowedWebTool(tool));
  const removed = value.tools.length - tools.length;
  const toolNames = tools.flatMap(toolName);
  if (removed === 0) return { body, removed: 0, toolNames, ...(model ? { model } : {}) };
  return {
    body: Buffer.from(JSON.stringify({ ...value, tools }), 'utf8'),
    removed,
    toolNames,
    ...(model ? { model } : {}),
  };
}

function isDisallowedWebTool(tool: unknown): boolean {
  if (!isRecord(tool)) return false;
  const names = [tool.name, isRecord(tool.function) ? tool.function.name : undefined];
  if (
    names.some((name) => typeof name === 'string' && DISALLOWED_WEB_TOOL_NAMES.has(normalize(name)))
  ) {
    return true;
  }
  if (typeof tool.type !== 'string') return false;
  const type = normalize(tool.type);
  return [...DISALLOWED_WEB_TOOL_NAMES].some((name) => type === name || type.startsWith(name));
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/gu, '');
}

function toolName(tool: unknown): string[] {
  if (!isRecord(tool)) return [];
  if (typeof tool.name === 'string') return [tool.name];
  if (isRecord(tool.function) && typeof tool.function.name === 'string') {
    return [tool.function.name];
  }
  return typeof tool.type === 'string' ? [tool.type] : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
