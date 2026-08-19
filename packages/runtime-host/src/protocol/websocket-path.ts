export const RUNTIME_HOST_WEBSOCKET_PATH_MAX_BYTES = 1_000;

export function isCanonicalRuntimeHostWebSocketPath(value: unknown): value is string {
  if (
    typeof value !== 'string' ||
    !value.startsWith('/') ||
    new TextEncoder().encode(value).byteLength > RUNTIME_HOST_WEBSOCKET_PATH_MAX_BYTES ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    return false;
  }
  try {
    const url = new URL(value, 'ws://runtime-host.invalid');
    return url.origin === 'ws://runtime-host.invalid' && url.pathname === value && !url.search;
  } catch {
    return false;
  }
}
