import type { ExtensionActivationContext } from './extension-lifecycle-kernel.js';

export const EXTENSION_HOOK_EVENTS = [
  'UserPromptSubmit',
  'RunStart',
  'PreToolUse',
  'PostToolUse',
  'RunEnd',
] as const;

export type ExtensionHookEventName = (typeof EXTENSION_HOOK_EVENTS)[number];
export type ExtensionHookDispatchMode = 'observe' | 'gate' | 'transform';

export interface ExtensionHookInvocationContext {
  readonly sessionId: string;
  readonly runId?: string;
  readonly turnId: string;
  readonly cwd: string;
  readonly permissionMode: string;
  readonly origin: 'provider' | 'code_mode' | 'host';
  readonly configuration: Readonly<Record<string, string | number | boolean>>;
  readonly signal: AbortSignal;
  readonly eventDepth?: number;
  readonly serviceDepth?: number;
}

export interface ExtensionHookInvocationResult {
  readonly decision?: 'allow' | 'deny';
  readonly reason?: string;
  /** Replacement payload for transform hooks. Gate and observe hooks must omit it. */
  readonly payload?: unknown;
}

export interface ExtensionHookContribution {
  readonly id: string;
  readonly event: ExtensionHookEventName;
  readonly mode: ExtensionHookDispatchMode;
  readonly handler: string;
  readonly matcher?: string;
  readonly priority: number;
  readonly timeoutMs: number;
  invoke(
    payload: unknown,
    context: ExtensionHookInvocationContext,
  ): Promise<ExtensionHookInvocationResult | undefined>;
}

export interface ExtensionHookContributionInspection {
  readonly bindingId: string;
  readonly scopeId: string;
  readonly extensionId: string;
  readonly revision: string;
  readonly id: string;
  readonly event: ExtensionHookEventName;
  readonly mode: ExtensionHookDispatchMode;
  readonly handler: string;
  readonly matcher?: string;
  readonly priority: number;
  readonly timeoutMs: number;
  invoke(
    payload: unknown,
    context: ExtensionHookInvocationContext,
  ): Promise<ExtensionHookInvocationResult | undefined>;
}

interface RegisteredHook extends ExtensionHookContributionInspection {
  readonly token: symbol;
}

export class ExtensionHookContributionError extends Error {
  readonly name = 'ExtensionHookContributionError';

  constructor(
    readonly code: 'invalid_hook' | 'hook_conflict',
    message: string,
  ) {
    super(message);
  }
}

/** Lifecycle-owned registry for typed Host Hook contributions. */
export class ExtensionHookContributionRegistry {
  readonly #scopes = new Map<string, RegisteredHook[]>();

  register(
    context: ExtensionActivationContext,
    contribution: ExtensionHookContribution,
  ): () => void {
    validateExtensionHookContribution(contribution);
    const current = this.#scopes.get(context.scopeId) ?? [];
    const conflict = current.find(
      (entry) =>
        entry.event === contribution.event &&
        entry.id === contribution.id &&
        (entry.bindingId !== context.bindingId || entry.extensionId !== context.extensionId),
    );
    if (conflict) {
      throw new ExtensionHookContributionError(
        'hook_conflict',
        `Hook contribution "${contribution.id}" for ${contribution.event} is already owned by ${conflict.extensionId}@${conflict.revision}`,
      );
    }
    const entry: RegisteredHook = Object.freeze({
      bindingId: context.bindingId,
      scopeId: context.scopeId,
      extensionId: context.extensionId,
      revision: context.revision,
      id: contribution.id,
      event: contribution.event,
      mode: contribution.mode,
      handler: contribution.handler,
      ...(contribution.matcher ? { matcher: contribution.matcher } : {}),
      priority: contribution.priority,
      timeoutMs: contribution.timeoutMs,
      invoke: contribution.invoke,
      token: Symbol(contribution.id),
    });
    this.#scopes.set(context.scopeId, [...current, entry]);
    return () => {
      const active = this.#scopes.get(context.scopeId);
      if (!active) return;
      const next = active.filter((candidate) => candidate.token !== entry.token);
      if (next.length > 0) this.#scopes.set(context.scopeId, next);
      else this.#scopes.delete(context.scopeId);
    };
  }

  inspect(
    scopeIds: readonly string[],
    committed?: readonly { readonly bindingId: string; readonly revision: string }[],
  ): readonly ExtensionHookContributionInspection[] {
    const revisions = committed
      ? new Map(committed.map(({ bindingId, revision }) => [bindingId, revision]))
      : undefined;
    const entries = scopeIds
      .flatMap((scopeId) => this.#scopes.get(scopeId) ?? [])
      .filter((entry) => !revisions || revisions.get(entry.bindingId) === entry.revision);
    return Object.freeze(
      entries.map(({ token: _token, ...entry }) => Object.freeze(entry)).sort(compareHook),
    );
  }
}

export function contributeExtensionHook(
  context: ExtensionActivationContext,
  registry: ExtensionHookContributionRegistry,
  contribution: ExtensionHookContribution,
): void {
  const unregister = registry.register(context, contribution);
  try {
    context.ownEffect(`hook:${contribution.event}:${contribution.id}`, unregister);
  } catch (error) {
    unregister();
    throw error;
  }
}

export function validateExtensionHookContribution(contribution: ExtensionHookContribution): void {
  if (!contribution || typeof contribution !== 'object') invalid('Hook contribution is required');
  if (!canonicalId(contribution.id)) invalid('Hook contribution id is invalid');
  if (!EXTENSION_HOOK_EVENTS.includes(contribution.event)) invalid('Hook event is invalid');
  if (!canonicalId(contribution.handler)) invalid('Hook handler is invalid');
  const requiredMode = modeForEvent(contribution.event);
  if (contribution.mode !== requiredMode) {
    invalid(`${contribution.event} requires ${requiredMode} dispatch mode`);
  }
  if (
    contribution.matcher !== undefined &&
    (typeof contribution.matcher !== 'string' ||
      contribution.matcher.length === 0 ||
      Buffer.byteLength(contribution.matcher, 'utf8') > 256)
  ) {
    invalid('Hook matcher is invalid');
  }
  if (!Number.isSafeInteger(contribution.priority) || Math.abs(contribution.priority) > 10_000) {
    invalid('Hook priority is invalid');
  }
  if (
    !Number.isSafeInteger(contribution.timeoutMs) ||
    contribution.timeoutMs < 10 ||
    contribution.timeoutMs > 120_000
  ) {
    invalid('Hook timeout is invalid');
  }
  if (typeof contribution.invoke !== 'function') invalid('Hook invoke function is required');
}

export function modeForEvent(event: ExtensionHookEventName): ExtensionHookDispatchMode {
  switch (event) {
    case 'PreToolUse':
      return 'gate';
    case 'UserPromptSubmit':
    case 'PostToolUse':
      return 'transform';
    case 'RunStart':
    case 'RunEnd':
      return 'observe';
  }
}

function compareHook(
  left: ExtensionHookContributionInspection,
  right: ExtensionHookContributionInspection,
): number {
  return (
    left.event.localeCompare(right.event) ||
    right.priority - left.priority ||
    left.extensionId.localeCompare(right.extensionId) ||
    left.revision.localeCompare(right.revision) ||
    left.id.localeCompare(right.id)
  );
}

function canonicalId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= 128 &&
    /^[A-Za-z][A-Za-z0-9._-]{0,127}$/u.test(value)
  );
}

function invalid(message: string): never {
  throw new ExtensionHookContributionError('invalid_hook', message);
}
