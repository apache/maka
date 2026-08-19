import type { MakaContributionContext } from './plugin-runtime.js';

export interface ExtensionTimerInvocationContext {
  readonly sessionId: string;
  readonly turnId: string;
  readonly cwd: string;
  readonly permissionMode: string;
  readonly origin: 'host';
  readonly configuration: Readonly<Record<string, string | number | boolean>>;
  readonly signal: AbortSignal;
  readonly scheduledAt: number;
}

export interface ExtensionTimerContribution {
  readonly id: string;
  readonly intervalMs: number;
  readonly initialDelayMs: number;
  readonly timeoutMs: number;
  readonly handler: string;
  readonly configuration: Readonly<Record<string, string | number | boolean>>;
  readonly payload?: unknown;
  invoke(payload: unknown, context: ExtensionTimerInvocationContext): Promise<unknown>;
}

export interface ExtensionTimerContributionInspection {
  readonly entryId: string;
  readonly scopeId: string;
  readonly extensionId: string;
  readonly generation: number;
  readonly id: string;
  readonly intervalMs: number;
  readonly nextRunAt: number;
  readonly running: boolean;
  readonly lastStartedAt?: number;
  readonly lastSucceededAt?: number;
  readonly lastError?: string;
}

export interface ExtensionTimerAuthority {
  register(
    context: MakaContributionContext,
    contribution: ExtensionTimerContribution,
  ): Promise<() => void | Promise<void>>;
}

export async function contributeExtensionTimer(
  context: MakaContributionContext,
  authority: ExtensionTimerAuthority,
  contribution: ExtensionTimerContribution,
): Promise<void> {
  validateExtensionTimerContribution(contribution);
  const unregister = await authority.register(context, contribution);
  try {
    context.ownEffect(`timer:${contribution.id}`, unregister);
  } catch (error) {
    await unregister();
    throw error;
  }
}

export function validateExtensionTimerContribution(contribution: ExtensionTimerContribution): void {
  if (!contribution || typeof contribution !== 'object') invalid('Timer contribution is required');
  if (!canonicalId(contribution.id) || !canonicalId(contribution.handler))
    invalid('Timer identity is invalid');
  if (
    !Number.isSafeInteger(contribution.intervalMs) ||
    contribution.intervalMs < 1_000 ||
    contribution.intervalMs > 30 * 24 * 60 * 60 * 1_000
  )
    invalid('Timer intervalMs must be between 1 second and 30 days');
  if (
    !Number.isSafeInteger(contribution.initialDelayMs) ||
    contribution.initialDelayMs < 0 ||
    contribution.initialDelayMs > 30 * 24 * 60 * 60 * 1_000
  )
    invalid('Timer initialDelayMs is invalid');
  if (
    !Number.isSafeInteger(contribution.timeoutMs) ||
    contribution.timeoutMs < 10 ||
    contribution.timeoutMs > 120_000
  )
    invalid('Timer timeoutMs is invalid');
  if (contribution.payload !== undefined) {
    try {
      if (Buffer.byteLength(JSON.stringify(contribution.payload), 'utf8') > 64 * 1024)
        invalid('Timer payload is too large');
    } catch {
      invalid('Timer payload must be JSON serializable');
    }
  }
  if (typeof contribution.invoke !== 'function') invalid('Timer invoke function is required');
}

function canonicalId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z][A-Za-z0-9._-]{0,127}$/u.test(value);
}

function invalid(message: string): never {
  throw new Error(message);
}
