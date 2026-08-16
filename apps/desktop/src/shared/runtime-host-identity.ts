export interface DesktopHostRef {
  readonly hostId: string;
}

export interface DesktopTargetScope extends DesktopHostRef {
  readonly targetEpoch: string;
}

export interface DesktopSessionRef extends DesktopHostRef {
  readonly sessionId: string;
}

export interface DesktopTargetSessionRef extends DesktopSessionRef, DesktopTargetScope {}

export function desktopSessionKey(ref: DesktopSessionRef): string {
  return JSON.stringify([ref.hostId, ref.sessionId]);
}

export function parseDesktopSessionKey(value: string): DesktopSessionRef {
  const parsed: unknown = JSON.parse(value);
  if (
    !Array.isArray(parsed) ||
    parsed.length !== 2 ||
    typeof parsed[0] !== 'string' ||
    !parsed[0] ||
    typeof parsed[1] !== 'string' ||
    !parsed[1]
  ) {
    throw new Error('Invalid Desktop Host Session key');
  }
  return { hostId: parsed[0], sessionId: parsed[1] };
}

export function desktopSessionResourceKey(ref: DesktopTargetSessionRef): string {
  return JSON.stringify([ref.targetEpoch, ref.hostId, ref.sessionId]);
}

export function parseDesktopSessionResourceKey(value: string): DesktopTargetSessionRef {
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

export function requireDesktopTargetScope(
  value: unknown,
  expected?: DesktopTargetScope,
): DesktopTargetScope {
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
  const ref = value as DesktopTargetScope;
  if (
    expected !== undefined &&
    (ref.hostId !== expected.hostId || ref.targetEpoch !== expected.targetEpoch)
  ) {
    throw new Error('Desktop Runtime Host request belongs to a different target');
  }
  return ref;
}
