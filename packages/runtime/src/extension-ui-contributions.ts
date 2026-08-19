import { createHash } from 'node:crypto';
import type { MakaContributionContext } from './plugin-runtime.js';

export const EXTENSION_UI_DOCUMENT_MAX_BYTES = 1024 * 1024;
export const EXTENSION_UI_SURFACES = ['app.root', 'app.overlay', 'app.slot'] as const;
export type ExtensionUiSurface = (typeof EXTENSION_UI_SURFACES)[number];
export const EXTENSION_UI_SLOT_PATTERN = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/u;

export interface ExtensionUiContribution {
  readonly id: string;
  readonly surface: ExtensionUiSurface;
  /** Named composition seat. Required only for app.slot contributions. */
  readonly slot?: string;
  /** Child composition seats declared by this contribution. */
  readonly slots?: readonly string[];
  readonly priority: number;
  readonly document: string;
  /** Sandboxed documents are offline unless this explicit capability is true. */
  readonly network: boolean;
  readonly hostState?: boolean;
  readonly hostMethods?: readonly string[];
  /** Explicit authority for a full-root document to drive Maka Sessions. */
  readonly sessionAccess?: boolean;
}

export interface ExtensionUiContributionInspection {
  readonly scopeId: string;
  readonly entryId: string;
  readonly extensionId: string;
  readonly generation: number;
  readonly id: string;
  readonly surface: ExtensionUiSurface;
  readonly slot?: string;
  readonly slots: readonly string[];
  readonly priority: number;
  readonly document: string;
  readonly documentSha256: string;
  readonly network: boolean;
  readonly hostState: boolean;
  readonly hostMethods: readonly string[];
  readonly sessionAccess: boolean;
}

export type ExtensionUiReadiness = 'pending' | 'ready' | 'failed';

export interface ExtensionUiReadinessInspection {
  readonly entryId: string;
  readonly generation: number;
  readonly status: ExtensionUiReadiness;
  readonly diagnostic?: string;
}

export class ExtensionUiContributionError extends Error {
  readonly name = 'ExtensionUiContributionError';

  constructor(
    readonly code: 'invalid_ui' | 'ui_id_conflict',
    message: string,
  ) {
    super(message);
  }
}

interface RegisteredUi extends ExtensionUiContributionInspection {
  readonly token: symbol;
}

/**
 * Typed, renderer-agnostic UI contribution registry.
 *
 * Entries are retained by activation token rather than overwritten. That is
 * important during current/candidate updates: readers select only the exact
 * Fiber generations committed by the lifecycle kernel, so an activating candidate is
 * never exposed before the Entry commit and the current UI never blinks out.
 */
export class ExtensionUiContributionRegistry {
  readonly #byScope = new Map<string, RegisteredUi[]>();
  readonly #readiness = new Map<string, ExtensionUiReadinessInspection>();

  setReadiness(
    scopeId: string,
    entryId: string,
    generation: number,
    status: ExtensionUiReadiness,
    diagnostic?: string,
  ): void {
    validateIdentity('scopeId', scopeId);
    this.#readiness.set(
      `${scopeId}\u0000${entryId}`,
      Object.freeze({
        entryId,
        generation,
        status,
        ...(diagnostic ? { diagnostic } : {}),
      }),
    );
  }

  inspectReadiness(scopeId?: string): readonly ExtensionUiReadinessInspection[] {
    return Object.freeze(
      [...this.#readiness.entries()]
        .filter(([key]) => !scopeId || key.startsWith(`${scopeId}\u0000`))
        .map(([, value]) => value),
    );
  }

  register(
    context: Pick<MakaContributionContext, 'entryId' | 'scopeId' | 'extensionId' | 'generation'>,
    contribution: ExtensionUiContribution,
  ): () => void {
    validateContext(context);
    validateExtensionUiContribution(contribution);
    const entries = this.#byScope.get(context.scopeId) ?? [];
    const conflict = entries.find(
      (entry) =>
        entry.id === contribution.id &&
        (entry.entryId !== context.entryId || entry.extensionId !== context.extensionId),
    );
    if (conflict) {
      throw new ExtensionUiContributionError(
        'ui_id_conflict',
        `UI contribution "${contribution.id}" is already owned by entry ${conflict.entryId}`,
      );
    }
    const entry: RegisteredUi = Object.freeze({
      // ExtensionActivationContext also carries runtime-only capabilities such as
      // AbortSignal and effect/dependency functions. Never retain those in the UI
      // inspection record: inspections cross the durable Tool-result boundary.
      entryId: context.entryId,
      scopeId: context.scopeId,
      extensionId: context.extensionId,
      generation: context.generation,
      ...contribution,
      slots: Object.freeze([...(contribution.slots ?? [])]),
      hostState: contribution.hostState === true,
      hostMethods: Object.freeze([...(contribution.hostMethods ?? [])]),
      sessionAccess: contribution.sessionAccess === true,
      documentSha256: createHash('sha256').update(contribution.document).digest('hex'),
      token: Symbol(contribution.id),
    });
    entries.push(entry);
    this.#byScope.set(context.scopeId, entries);
    let disposed = false;
    return () => {
      if (disposed) return;
      disposed = true;
      const current = this.#byScope.get(context.scopeId);
      if (!current) return;
      const index = current.findIndex(({ token }) => token === entry.token);
      if (index >= 0) current.splice(index, 1);
      if (current.length === 0) this.#byScope.delete(context.scopeId);
      this.#readiness.delete(`${context.scopeId}\u0000${context.entryId}`);
    };
  }

  inspect(
    scopeId: string,
    committed: readonly { readonly entryId: string; readonly generation: number }[],
  ): readonly ExtensionUiContributionInspection[] {
    validateIdentity('scopeId', scopeId);
    const generations = new Map(committed.map(({ entryId, generation }) => [entryId, generation]));
    return Object.freeze(
      (this.#byScope.get(scopeId) ?? [])
        .filter((entry) => generations.get(entry.entryId) === entry.generation)
        .map(({ token: _token, ...entry }) => Object.freeze(entry))
        .sort(compareUi),
    );
  }
}

export function contributeExtensionUi(
  context: MakaContributionContext,
  registry: ExtensionUiContributionRegistry,
  contribution: ExtensionUiContribution,
): void {
  const unregister = registry.register(context, contribution);
  try {
    context.ownEffect(`ui:${contribution.id}`, unregister);
  } catch (error) {
    unregister();
    throw error;
  }
}

export function validateExtensionUiContribution(contribution: ExtensionUiContribution): void {
  if (!contribution || typeof contribution !== 'object') {
    throw new ExtensionUiContributionError('invalid_ui', 'UI contribution is required');
  }
  validateIdentity('UI contribution id', contribution.id);
  if (!EXTENSION_UI_SURFACES.includes(contribution.surface)) {
    throw new ExtensionUiContributionError('invalid_ui', 'UI surface is invalid');
  }
  if (contribution.surface === 'app.slot') {
    if (
      typeof contribution.slot !== 'string' ||
      !EXTENSION_UI_SLOT_PATTERN.test(contribution.slot) ||
      Buffer.byteLength(contribution.slot, 'utf8') > 128
    ) {
      throw new ExtensionUiContributionError('invalid_ui', 'UI slot name is invalid');
    }
  } else if (contribution.slot !== undefined) {
    throw new ExtensionUiContributionError(
      'invalid_ui',
      'Only an app.slot contribution may declare a slot name',
    );
  }
  if (
    contribution.slots !== undefined &&
    (!Array.isArray(contribution.slots) ||
      contribution.slots.length > 32 ||
      contribution.slots.some(
        (slot) =>
          typeof slot !== 'string' ||
          !EXTENSION_UI_SLOT_PATTERN.test(slot) ||
          Buffer.byteLength(slot, 'utf8') > 128,
      ) ||
      new Set(contribution.slots).size !== contribution.slots.length)
  ) {
    throw new ExtensionUiContributionError('invalid_ui', 'UI child slots are invalid');
  }
  if (!Number.isSafeInteger(contribution.priority) || Math.abs(contribution.priority) > 10_000) {
    throw new ExtensionUiContributionError('invalid_ui', 'UI priority is invalid');
  }
  if (
    typeof contribution.document !== 'string' ||
    contribution.document.length === 0 ||
    Buffer.byteLength(contribution.document, 'utf8') > EXTENSION_UI_DOCUMENT_MAX_BYTES
  ) {
    throw new ExtensionUiContributionError('invalid_ui', 'UI document is invalid or too large');
  }
  if (typeof contribution.network !== 'boolean') {
    throw new ExtensionUiContributionError('invalid_ui', 'UI network capability is invalid');
  }
  if (contribution.hostState !== undefined && typeof contribution.hostState !== 'boolean') {
    throw new ExtensionUiContributionError('invalid_ui', 'UI Host state capability is invalid');
  }
  if (contribution.sessionAccess !== undefined && typeof contribution.sessionAccess !== 'boolean') {
    throw new ExtensionUiContributionError('invalid_ui', 'UI Session access capability is invalid');
  }
  if (contribution.sessionAccess === true && contribution.surface !== 'app.root') {
    throw new ExtensionUiContributionError(
      'invalid_ui',
      'Only a complete app.root UI may request Session access',
    );
  }
  if (
    contribution.hostMethods !== undefined &&
    (!Array.isArray(contribution.hostMethods) ||
      contribution.hostMethods.length > 64 ||
      contribution.hostMethods.some(
        (method) => typeof method !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,127}$/u.test(method),
      ))
  ) {
    throw new ExtensionUiContributionError('invalid_ui', 'UI Host methods are invalid');
  }
}

function validateContext(
  context: Pick<MakaContributionContext, 'entryId' | 'scopeId' | 'extensionId' | 'generation'>,
): void {
  validateIdentity('entryId', context.entryId);
  validateIdentity('scopeId', context.scopeId);
  validateIdentity('extensionId', context.extensionId);
  if (!Number.isSafeInteger(context.generation) || context.generation <= 0) {
    throw new ExtensionUiContributionError('invalid_ui', 'Fiber generation is required');
  }
}

function validateIdentity(label: string, value: string): void {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    Buffer.byteLength(value, 'utf8') > 128 ||
    /[\r\n\0]/u.test(value)
  ) {
    throw new ExtensionUiContributionError('invalid_ui', `Invalid ${label}`);
  }
}

function compareUi(
  left: ExtensionUiContributionInspection,
  right: ExtensionUiContributionInspection,
): number {
  return (
    compareString(left.surface, right.surface) ||
    right.priority - left.priority ||
    compareString(left.extensionId, right.extensionId) ||
    compareString(left.id, right.id)
  );
}

function compareString(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
