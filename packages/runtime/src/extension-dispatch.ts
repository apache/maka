export const EXTENSION_DISPATCH_MODES = [
  'emit',
  'parallel',
  'serial',
  'bail',
  'transform',
  'observe',
  'gate',
] as const;

export type ExtensionDispatchMode = (typeof EXTENSION_DISPATCH_MODES)[number];

export interface ExtensionDispatchHandler<TIdentity> {
  readonly identity: TIdentity;
  invoke(value: unknown): Promise<unknown>;
}

export interface ExtensionDispatchSettlement<TIdentity> {
  readonly identity: TIdentity;
  readonly status: 'fulfilled' | 'rejected';
  readonly value?: unknown;
  readonly error?: unknown;
}

export interface ExtensionDispatchResult<TIdentity> {
  readonly mode: ExtensionDispatchMode;
  /** Final transform value, first bail result, serial/parallel results, or the original payload. */
  readonly value: unknown;
  readonly stopped: boolean;
  readonly denied: boolean;
  readonly reason?: string;
  readonly settlements: readonly ExtensionDispatchSettlement<TIdentity>[];
}

/**
 * Product-independent Extension dispatch kernel.
 *
 * Handler failures are contained in settlements. Abort is the only exceptional
 * path because the caller no longer owns authority to continue dispatching.
 */
export async function dispatchExtensionHandlers<TIdentity>(input: {
  readonly mode: ExtensionDispatchMode;
  readonly payload: unknown;
  readonly handlers: readonly ExtensionDispatchHandler<TIdentity>[];
  readonly signal: AbortSignal;
}): Promise<ExtensionDispatchResult<TIdentity>> {
  if (!EXTENSION_DISPATCH_MODES.includes(input.mode)) {
    throw new Error(`Unsupported Extension dispatch mode: ${String(input.mode)}`);
  }
  throwIfAborted(input.signal);
  if (input.mode === 'parallel') return await dispatchParallel(input);

  const settlements: ExtensionDispatchSettlement<TIdentity>[] = [];
  const serialValues: unknown[] = [];
  // A bail lane has no answer until a handler supplies one. Using the input
  // payload as its initial value makes an unhandled bail indistinguishable from
  // a listener answer and can violate an unrelated result schema.
  let current = input.mode === 'bail' ? undefined : clone(input.payload);
  let stopped = false;
  let denied = false;
  let reason: string | undefined;

  for (const handler of input.handlers) {
    throwIfAborted(input.signal);
    try {
      const argument = input.mode === 'transform' ? clone(current) : clone(input.payload);
      const value = await handler.invoke(argument);
      settlements.push(Object.freeze({ identity: handler.identity, status: 'fulfilled', value }));
      switch (input.mode) {
        case 'serial':
          serialValues.push(clone(value));
          break;
        case 'bail':
          if (value !== undefined && value !== null) {
            current = clone(value);
            stopped = true;
          }
          break;
        case 'transform':
          if (value !== undefined && value !== null) current = clone(value);
          break;
        case 'gate': {
          const decision = gateDecision(value);
          if (decision?.decision === 'deny') {
            denied = true;
            reason = decision.reason;
            current = clone(value);
            stopped = true;
          }
          break;
        }
        case 'emit':
        case 'observe':
          break;
      }
    } catch (error) {
      if (input.signal.aborted) throwIfAborted(input.signal);
      settlements.push(Object.freeze({ identity: handler.identity, status: 'rejected', error }));
    }
    if (stopped) break;
  }

  const value =
    input.mode === 'serial'
      ? Object.freeze(serialValues)
      : input.mode === 'emit' || input.mode === 'observe'
        ? clone(input.payload)
        : current;
  return Object.freeze({
    mode: input.mode,
    value,
    stopped,
    denied,
    ...(reason ? { reason } : {}),
    settlements: Object.freeze(settlements),
  });
}

async function dispatchParallel<TIdentity>(input: {
  readonly mode: 'parallel' | ExtensionDispatchMode;
  readonly payload: unknown;
  readonly handlers: readonly ExtensionDispatchHandler<TIdentity>[];
  readonly signal: AbortSignal;
}): Promise<ExtensionDispatchResult<TIdentity>> {
  const settlements = await Promise.all(
    input.handlers.map(async (handler): Promise<ExtensionDispatchSettlement<TIdentity>> => {
      throwIfAborted(input.signal);
      try {
        const value = await handler.invoke(clone(input.payload));
        return Object.freeze({ identity: handler.identity, status: 'fulfilled', value });
      } catch (error) {
        if (input.signal.aborted) throwIfAborted(input.signal);
        return Object.freeze({ identity: handler.identity, status: 'rejected', error });
      }
    }),
  );
  throwIfAborted(input.signal);
  return Object.freeze({
    mode: 'parallel',
    value: Object.freeze(
      settlements.filter((item) => item.status === 'fulfilled').map((item) => clone(item.value)),
    ),
    stopped: false,
    denied: false,
    settlements: Object.freeze(settlements),
  });
}

function gateDecision(value: unknown): { decision: 'allow' | 'deny'; reason?: string } | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (record.decision !== 'allow' && record.decision !== 'deny') return undefined;
  return {
    decision: record.decision,
    ...(typeof record.reason === 'string' && record.reason.length > 0
      ? { reason: record.reason.slice(0, 4_000) }
      : {}),
  };
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
}

function clone<T>(value: T): T {
  return value === undefined ? value : structuredClone(value);
}
