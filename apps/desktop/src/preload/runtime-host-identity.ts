export interface DesktopHostRef {
  readonly hostId: string;
}

export interface DesktopSessionRef extends DesktopHostRef {
  readonly sessionId: string;
}

export function desktopSessionResourceKey(ref: DesktopSessionRef): string {
  return JSON.stringify([ref.hostId, ref.sessionId]);
}

export function parseDesktopSessionResourceKey(value: string): DesktopSessionRef {
  const parsed: unknown = JSON.parse(value);
  if (
    !Array.isArray(parsed) ||
    parsed.length !== 2 ||
    typeof parsed[0] !== 'string' ||
    !parsed[0] ||
    typeof parsed[1] !== 'string' ||
    !parsed[1]
  ) {
    throw new Error('Invalid Desktop Host Session resource key');
  }
  return { hostId: parsed[0], sessionId: parsed[1] };
}

export function requireDesktopHostRef(value: unknown, expectedHostId?: string): DesktopHostRef {
  if (
    !value ||
    typeof value !== 'object' ||
    typeof (value as { hostId?: unknown }).hostId !== 'string' ||
    !(value as { hostId: string }).hostId
  ) {
    throw new Error('Desktop Runtime Host request is missing its Host identity');
  }
  const ref = value as DesktopHostRef;
  if (expectedHostId !== undefined && ref.hostId !== expectedHostId) {
    throw new Error('Desktop Runtime Host request belongs to a different Host');
  }
  return ref;
}
