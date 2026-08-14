import { createHash } from 'node:crypto';
import type {
  ExtensionActivationContext,
  ExtensionDependencyDefinition,
  ExtensionRevisionDefinition,
} from './extension-lifecycle-kernel.js';

export const EXTENSION_UI_DOCUMENT_MAX_BYTES = 1024 * 1024;
export const EXTENSION_UI_SURFACES = ['app.root', 'app.panel', 'app.overlay'] as const;
export type ExtensionUiSurface = (typeof EXTENSION_UI_SURFACES)[number];

export interface ExtensionUiContribution {
  readonly id: string;
  readonly surface: ExtensionUiSurface;
  readonly priority: number;
  readonly document: string;
  /** Sandboxed documents are offline unless this explicit capability is true. */
  readonly network: boolean;
  readonly hostState?: boolean;
  readonly hostMethods?: readonly string[];
}

export interface ExtensionUiContributionInspection {
  readonly scopeId: string;
  readonly bindingId: string;
  readonly extensionId: string;
  readonly revision: string;
  readonly id: string;
  readonly surface: ExtensionUiSurface;
  readonly priority: number;
  readonly document: string;
  readonly documentSha256: string;
  readonly network: boolean;
  readonly hostState: boolean;
  readonly hostMethods: readonly string[];
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
 * revisions committed by the lifecycle kernel, so an activating candidate is
 * never exposed before the Binding commit and the current UI never blinks out.
 */
export class ExtensionUiContributionRegistry {
  readonly #byScope = new Map<string, RegisteredUi[]>();

  register(
    context: Pick<ExtensionActivationContext, 'bindingId' | 'scopeId' | 'extensionId' | 'revision'>,
    contribution: ExtensionUiContribution,
  ): () => void {
    validateContext(context);
    validateExtensionUiContribution(contribution);
    const entries = this.#byScope.get(context.scopeId) ?? [];
    const conflict = entries.find(
      (entry) =>
        entry.id === contribution.id &&
        (entry.bindingId !== context.bindingId || entry.extensionId !== context.extensionId),
    );
    if (conflict) {
      throw new ExtensionUiContributionError(
        'ui_id_conflict',
        `UI contribution "${contribution.id}" is already owned by ${conflict.extensionId}@${conflict.revision}`,
      );
    }
    const entry: RegisteredUi = Object.freeze({
      ...context,
      ...contribution,
      hostState: contribution.hostState === true,
      hostMethods: Object.freeze([...(contribution.hostMethods ?? [])]),
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
    };
  }

  inspect(
    scopeId: string,
    committed: readonly { readonly bindingId: string; readonly revision: string }[],
  ): readonly ExtensionUiContributionInspection[] {
    validateIdentity('scopeId', scopeId);
    const revisions = new Map(committed.map(({ bindingId, revision }) => [bindingId, revision]));
    return Object.freeze(
      (this.#byScope.get(scopeId) ?? [])
        .filter((entry) => revisions.get(entry.bindingId) === entry.revision)
        .map(({ token: _token, ...entry }) => Object.freeze(entry))
        .sort(compareUi),
    );
  }
}

export function contributeExtensionUi(
  context: ExtensionActivationContext,
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

export interface TrustedUiExtensionRevisionInput {
  readonly registry: ExtensionUiContributionRegistry;
  readonly extensionId: string;
  readonly revision: string;
  readonly dependencies?: readonly ExtensionDependencyDefinition[];
  readonly ui: readonly ExtensionUiContribution[];
  readonly healthCheck?: () => void | Promise<void>;
}

export function defineTrustedUiExtensionRevision(
  input: TrustedUiExtensionRevisionInput,
): ExtensionRevisionDefinition {
  validateIdentity('extensionId', input.extensionId);
  if (!input.revision || typeof input.revision !== 'string') {
    throw new ExtensionUiContributionError('invalid_ui', 'Revision is required');
  }
  if (!Array.isArray(input.ui) || input.ui.length === 0) {
    throw new ExtensionUiContributionError('invalid_ui', 'UI revision requires a contribution');
  }
  const ids = new Set<string>();
  const ui = Object.freeze(
    input.ui.map((item) => {
      validateExtensionUiContribution(item);
      if (ids.has(item.id)) {
        throw new ExtensionUiContributionError(
          'ui_id_conflict',
          `UI revision repeats contribution id "${item.id}"`,
        );
      }
      ids.add(item.id);
      return Object.freeze({ ...item });
    }),
  );
  return Object.freeze({
    extensionId: input.extensionId,
    revision: input.revision,
    ...(input.dependencies ? { dependencies: Object.freeze([...input.dependencies]) } : {}),
    contributions: Object.freeze(ui.map(({ id }) => Object.freeze({ id, kind: 'ui' }))),
    prepare: () => ({
      ...(input.healthCheck ? { healthCheck: input.healthCheck } : {}),
      activate: (context: ExtensionActivationContext) => {
        for (const contribution of ui) contributeExtensionUi(context, input.registry, contribution);
      },
    }),
  });
}

export function validateExtensionUiContribution(contribution: ExtensionUiContribution): void {
  if (!contribution || typeof contribution !== 'object') {
    throw new ExtensionUiContributionError('invalid_ui', 'UI contribution is required');
  }
  validateIdentity('UI contribution id', contribution.id);
  if (!EXTENSION_UI_SURFACES.includes(contribution.surface)) {
    throw new ExtensionUiContributionError('invalid_ui', 'UI surface is invalid');
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
  context: Pick<ExtensionActivationContext, 'bindingId' | 'scopeId' | 'extensionId' | 'revision'>,
): void {
  validateIdentity('bindingId', context.bindingId);
  validateIdentity('scopeId', context.scopeId);
  validateIdentity('extensionId', context.extensionId);
  if (!context.revision || typeof context.revision !== 'string') {
    throw new ExtensionUiContributionError('invalid_ui', 'Revision is required');
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
