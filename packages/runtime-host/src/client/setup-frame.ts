import { z } from 'zod';

export const RUNTIME_HOST_SETUP_FRAME_PREFIX = 'MAKA_RUNTIME_HOST_SETUP_V1 ';
const SETUP_FRAME_MAX_BYTES = 16 * 1024;
const SETUP_FIELD_MAX_BYTES = 1024;
const SETUP_CREDENTIAL_MAX_BYTES = 8 * 1024;
const SETUP_PHASES = [
  'checking_environment',
  'installing_package',
  'installing_service',
  'pairing_client',
  'verifying_connection',
] as const;

export type RuntimeHostSetupPhase = (typeof SETUP_PHASES)[number];

export type RuntimeHostSetupFrame =
  | {
      readonly schemaVersion: 1;
      readonly sequence: number;
      readonly kind: 'progress';
      readonly phase: RuntimeHostSetupPhase;
    }
  | {
      readonly schemaVersion: 1;
      readonly sequence: number;
      readonly kind: 'complete';
      readonly version: string;
      readonly rootId: string;
      readonly endpoint: string;
      readonly serviceManager: 'systemd_user' | 'launch_agent';
      readonly credentialId: string;
      readonly credential: string;
    }
  | {
      readonly schemaVersion: 1;
      readonly sequence: number;
      readonly kind: 'error';
      readonly error: { readonly code: string; readonly message: string };
    };

const boundedString = (maxBytes: number) =>
  z
    .string()
    .min(1)
    .refine((value) => Buffer.byteLength(value, 'utf8') <= maxBytes);
const frameBase = {
  schemaVersion: z.literal(1),
  sequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
} as const;
const SETUP_FRAME_SCHEMA = z.discriminatedUnion('kind', [
  z
    .object({
      ...frameBase,
      kind: z.literal('progress'),
      phase: z.enum(SETUP_PHASES),
    })
    .strict(),
  z
    .object({
      ...frameBase,
      kind: z.literal('complete'),
      version: boundedString(128),
      rootId: z.string().regex(/^[a-f0-9]{64}$/u),
      endpoint: boundedString(SETUP_FIELD_MAX_BYTES).refine(isLoopbackWebSocketUrl),
      serviceManager: z.enum(['systemd_user', 'launch_agent']),
      credentialId: boundedString(SETUP_FIELD_MAX_BYTES),
      credential: boundedString(SETUP_CREDENTIAL_MAX_BYTES),
    })
    .strict(),
  z
    .object({
      ...frameBase,
      kind: z.literal('error'),
      error: z
        .object({
          code: boundedString(128),
          message: boundedString(SETUP_FIELD_MAX_BYTES),
        })
        .strict(),
    })
    .strict(),
]);

export function encodeRuntimeHostSetupFrame(frame: RuntimeHostSetupFrame): string {
  return `${RUNTIME_HOST_SETUP_FRAME_PREFIX}${Buffer.from(JSON.stringify(frame)).toString('base64url')}\n`;
}

export function decodeRuntimeHostSetupFrame(line: string): RuntimeHostSetupFrame | undefined {
  const marker = line.indexOf(RUNTIME_HOST_SETUP_FRAME_PREFIX);
  if (marker === -1) return undefined;
  try {
    const encoded = line.slice(marker + RUNTIME_HOST_SETUP_FRAME_PREFIX.length).trim();
    if (encoded.length === 0 || Buffer.byteLength(encoded, 'utf8') > SETUP_FRAME_MAX_BYTES) {
      return undefined;
    }
    const value: unknown = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    const decoded = SETUP_FRAME_SCHEMA.safeParse(value);
    return decoded.success ? decoded.data : undefined;
  } catch {
    return undefined;
  }
}

function isLoopbackWebSocketUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'ws:' &&
      (url.hostname === '127.0.0.1' || url.hostname === '[::1]' || url.hostname === '::1')
    );
  } catch {
    return false;
  }
}
