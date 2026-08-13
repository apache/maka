const DISALLOWED_WEB_TOOL_NAMES = new Set(['websearch', 'webfetch', 'fetchurl']);

export function removeEvalWebTools(body: Buffer): {
  readonly body: Buffer;
  readonly removed: number;
} {
  if (body.length === 0) return { body, removed: 0 };
  let value: unknown;
  try {
    value = JSON.parse(body.toString('utf8'));
  } catch {
    return { body, removed: 0 };
  }
  if (!isRecord(value) || !Array.isArray(value.tools)) return { body, removed: 0 };
  const tools = value.tools.filter((tool) => !isDisallowedWebTool(tool));
  const removed = value.tools.length - tools.length;
  if (removed === 0) return { body, removed: 0 };
  return { body: Buffer.from(JSON.stringify({ ...value, tools }), 'utf8'), removed };
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
