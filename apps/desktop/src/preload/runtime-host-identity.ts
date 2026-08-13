export interface DesktopHostRef {
  readonly hostId: string;
  readonly targetEpoch: string;
}

export interface DesktopSessionRef extends DesktopHostRef {
  readonly sessionId: string;
}

export function desktopSessionResourceKey(ref: DesktopSessionRef): string {
  return JSON.stringify([ref.targetEpoch, ref.hostId, ref.sessionId]);
}

export function parseDesktopSessionResourceKey(value: string): DesktopSessionRef {
  const parsed: unknown = JSON.parse(value);
  if (
    !Array.isArray(parsed) ||
    parsed.length !== 3 ||
    typeof parsed[0] !== 'string' ||
    !parsed[0] ||
    typeof parsed[1] !== 'string' ||
    !parsed[1] ||
    typeof parsed[2] !== 'string' ||
    !parsed[2]
  ) {
    throw new Error('Invalid Desktop Host Session resource key');
  }
  return { targetEpoch: parsed[0], hostId: parsed[1], sessionId: parsed[2] };
}

export function requireDesktopHostRef(
  value: unknown,
  expected?: DesktopHostRef,
): DesktopHostRef {
  if (
    !value ||
    typeof value !== 'object' ||
    typeof (value as { hostId?: unknown }).hostId !== 'string' ||
    !(value as { hostId: string }).hostId ||
    typeof (value as { targetEpoch?: unknown }).targetEpoch !== 'string' ||
    !(value as { targetEpoch: string }).targetEpoch
  ) {
    throw new Error('Desktop Runtime Host request is missing its Host identity');
  }
  const ref = value as DesktopHostRef;
  if (
    expected !== undefined &&
    (ref.hostId !== expected.hostId || ref.targetEpoch !== expected.targetEpoch)
  ) {
    throw new Error('Desktop Runtime Host request belongs to a different target');
  }
  return ref;
}
