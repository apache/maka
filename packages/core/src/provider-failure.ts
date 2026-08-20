export const PROVIDER_FAILURE_CLASSES = [
  'Abort',
  'Auth',
  'ContextLength',
  'Network',
  'Other',
  'ProviderBilling',
  'ProviderPermission',
  'ProviderUnavailable',
  'RateLimit',
  'RequestRejected',
  'Timeout',
  'UsageLimit',
] as const;

export type ProviderFailureClass = (typeof PROVIDER_FAILURE_CLASSES)[number];

/**
 * One provider-owned failure interpretation produced at the Runtime boundary.
 * Consumers may project or persist these fields, but must not rebuild the
 * taxonomy from HTTP status or message text.
 */
export interface ProviderFailureResult {
  readonly errorClass: ProviderFailureClass;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
  readonly httpStatus?: number;
  readonly providerCode?: string;
  readonly providerRequestId?: string;
  readonly message?: string;
  /** Proves that `message` was allowlisted, redacted, and bounded by Runtime. */
  readonly boundedProviderMessage?: true;
}

export function isProviderFailureClass(value: unknown): value is ProviderFailureClass {
  return (PROVIDER_FAILURE_CLASSES as readonly unknown[]).includes(value);
}
