import type {
  ExtensionActivationContext,
  ExtensionDependencyDefinition,
  ExtensionRevisionDefinition,
} from './extension-lifecycle-kernel.js';
import type { MakaTool } from './tool-runtime.js';

const RESERVED_TOOL_NAMES = new Set([
  'exec',
  'invalid',
  'load_tools',
  'memory_extract',
  'memory_remember',
]);

export type ExtensionToolContributionErrorCode =
  | 'invalid_tool'
  | 'reserved_tool_name'
  | 'tool_name_conflict';

export class ExtensionToolContributionError extends Error {
  readonly name = 'ExtensionToolContributionError';

  constructor(
    readonly code: ExtensionToolContributionErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface ExtensionToolContributionInspection {
  readonly scopeId: string;
  readonly bindingId: string;
  readonly extensionId: string;
  readonly revision: string;
  readonly toolName: string;
}

interface RegisteredExtensionTool extends ExtensionToolContributionInspection {
  readonly key: string;
  readonly tool: MakaTool;
  readonly token: symbol;
  retired: boolean;
}

export interface ExtensionToolContributionRegistryOptions {
  /** Core Tool names protected from Extension shadowing at activation time. */
  readonly protectedToolNames?: (scopeId: string) => readonly string[];
}

/**
 * Typed contribution surface for trusted Extension Tools.
 *
 * The registry owns only extension entries. `compose` merges those entries with
 * the protected Core Tool catalog and rejects every ambiguous name instead of
 * relying on a later map conversion to choose a winner.
 */
export class ExtensionToolContributionRegistry {
  readonly #byScope = new Map<string, Map<string, RegisteredExtensionTool>>();

  constructor(private readonly options: ExtensionToolContributionRegistryOptions = {}) {}

  register(
    context: Pick<ExtensionActivationContext, 'bindingId' | 'scopeId' | 'extensionId' | 'revision'>,
    tool: MakaTool,
  ): () => void {
    validateContext(context);
    validateTool(tool);
    const key = toolNameKey(tool.name);
    if (RESERVED_TOOL_NAMES.has(key)) {
      throw new ExtensionToolContributionError(
        'reserved_tool_name',
        `Tool name "${tool.name}" is reserved by Runtime`,
      );
    }
    const protectedName = this.options
      .protectedToolNames?.(context.scopeId)
      .find((name) => toolNameKey(name) === key);
    if (protectedName) {
      throw new ExtensionToolContributionError(
        'tool_name_conflict',
        `Extension Tool "${tool.name}" conflicts with protected Core Tool "${protectedName}"`,
      );
    }
    let scope = this.#byScope.get(context.scopeId);
    if (!scope) {
      scope = new Map();
      this.#byScope.set(context.scopeId, scope);
    }
    const existing = scope.get(key);
    if (
      existing &&
      (existing.bindingId !== context.bindingId || existing.extensionId !== context.extensionId)
    ) {
      throw new ExtensionToolContributionError(
        'tool_name_conflict',
        `Tool name "${tool.name}" is already contributed by ${existing.extensionId}@${existing.revision}`,
      );
    }
    const token = Symbol(tool.name);
    const entry: RegisteredExtensionTool = {
      key,
      scopeId: context.scopeId,
      bindingId: context.bindingId,
      extensionId: context.extensionId,
      revision: context.revision,
      toolName: tool.name,
      tool,
      token,
      retired: false,
    };
    scope.set(key, entry);

    // Idempotent and generation-safe: a stale disposer cannot delete a newer
    // registration that reused the same name after this entry was removed.
    return () => {
      const currentScope = this.#byScope.get(context.scopeId);
      if (currentScope?.get(key)?.token !== token) {
        entry.retired = true;
        return;
      }
      if (existing && !existing.retired) currentScope.set(key, existing);
      else currentScope.delete(key);
      entry.retired = true;
      if (currentScope.size === 0) this.#byScope.delete(context.scopeId);
    };
  }

  compose(scopeId: string, coreTools: readonly MakaTool[]): readonly MakaTool[] {
    validateIdentity('scopeId', scopeId);
    const byName = new Map<string, MakaTool>();
    for (const tool of coreTools) {
      validateTool(tool);
      const key = toolNameKey(tool.name);
      const existing = byName.get(key);
      if (existing) {
        throw new ExtensionToolContributionError(
          'tool_name_conflict',
          `Core Tool names "${existing.name}" and "${tool.name}" conflict`,
        );
      }
      byName.set(key, tool);
    }
    for (const entry of this.#scopeEntries(scopeId)) {
      const existing = byName.get(entry.key);
      if (existing) {
        throw new ExtensionToolContributionError(
          'tool_name_conflict',
          `Extension Tool "${entry.toolName}" conflicts with Core Tool "${existing.name}"`,
        );
      }
      byName.set(entry.key, entry.tool);
    }
    return Object.freeze(
      [...byName.values()].sort((left, right) => compareString(left.name, right.name)),
    );
  }

  inspect(scopeId: string): readonly ExtensionToolContributionInspection[] {
    validateIdentity('scopeId', scopeId);
    return Object.freeze(
      this.#scopeEntries(scopeId).map((entry) =>
        Object.freeze({
          scopeId: entry.scopeId,
          bindingId: entry.bindingId,
          extensionId: entry.extensionId,
          revision: entry.revision,
          toolName: entry.toolName,
        }),
      ),
    );
  }

  #scopeEntries(scopeId: string): RegisteredExtensionTool[] {
    return [...(this.#byScope.get(scopeId)?.values() ?? [])].sort((left, right) =>
      compareString(left.toolName, right.toolName),
    );
  }
}

/** Register one Tool and make its registry entry activation-owned atomically. */
export function contributeExtensionTool(
  context: ExtensionActivationContext,
  registry: ExtensionToolContributionRegistry,
  tool: MakaTool,
): void {
  const unregister = registry.register(context, tool);
  try {
    context.ownEffect(`tool:${tool.name}`, unregister);
  } catch (error) {
    unregister();
    throw error;
  }
}

export interface TrustedToolExtensionRevisionInput {
  readonly registry: ExtensionToolContributionRegistry;
  readonly extensionId: string;
  readonly revision: string;
  readonly dependencies?: readonly ExtensionDependencyDefinition[];
  readonly tools: readonly MakaTool[];
  readonly healthCheck?: () => void | Promise<void>;
}

/**
 * Build a trusted, static Tool revision using the same lifecycle contract as
 * every later contribution adapter. Definition/install stays effect-free;
 * registry publication happens only in `activate`.
 */
export function defineTrustedToolExtensionRevision(
  input: TrustedToolExtensionRevisionInput,
): ExtensionRevisionDefinition {
  validateIdentity('extensionId', input.extensionId);
  if (!input.revision || typeof input.revision !== 'string') {
    throw new ExtensionToolContributionError('invalid_tool', 'Revision is required');
  }
  const tools = Object.freeze(input.tools.map((tool) => Object.freeze({ ...tool })));
  const names = new Set<string>();
  for (const tool of tools) {
    validateTool(tool);
    const key = toolNameKey(tool.name);
    if (RESERVED_TOOL_NAMES.has(key)) {
      throw new ExtensionToolContributionError(
        'reserved_tool_name',
        `Tool name "${tool.name}" is reserved by Runtime`,
      );
    }
    if (names.has(key)) {
      throw new ExtensionToolContributionError(
        'tool_name_conflict',
        `Tool revision declares conflicting name "${tool.name}"`,
      );
    }
    names.add(key);
  }
  return Object.freeze({
    extensionId: input.extensionId,
    revision: input.revision,
    ...(input.dependencies ? { dependencies: Object.freeze([...input.dependencies]) } : {}),
    contributions: Object.freeze(
      tools.map((_, index) =>
        Object.freeze({ id: `${input.extensionId}.tool-${index + 1}`, kind: 'tool' }),
      ),
    ),
    prepare: () => ({
      ...(input.healthCheck ? { healthCheck: input.healthCheck } : {}),
      activate: (context: ExtensionActivationContext) => {
        for (const tool of tools) contributeExtensionTool(context, input.registry, tool);
      },
    }),
  });
}

function validateContext(
  context: Pick<ExtensionActivationContext, 'bindingId' | 'scopeId' | 'extensionId' | 'revision'>,
): void {
  validateIdentity('bindingId', context.bindingId);
  validateIdentity('scopeId', context.scopeId);
  validateIdentity('extensionId', context.extensionId);
  if (!context.revision || typeof context.revision !== 'string') {
    throw new ExtensionToolContributionError('invalid_tool', 'Revision is required');
  }
}

function validateIdentity(label: string, value: string): void {
  if (typeof value !== 'string' || value.length === 0 || /[\r\n\0]/.test(value)) {
    throw new ExtensionToolContributionError('invalid_tool', `Invalid ${label}`);
  }
}

function validateTool(tool: MakaTool): void {
  if (!tool || typeof tool !== 'object') {
    throw new ExtensionToolContributionError('invalid_tool', 'Tool definition is required');
  }
  if (
    typeof tool.name !== 'string' ||
    tool.name.length === 0 ||
    tool.name.length > 128 ||
    /[\r\n\0]/.test(tool.name)
  ) {
    throw new ExtensionToolContributionError('invalid_tool', 'Tool requires a valid name');
  }
  if (typeof tool.description !== 'string' || typeof tool.impl !== 'function') {
    throw new ExtensionToolContributionError(
      'invalid_tool',
      `Tool "${tool.name}" requires a description and implementation`,
    );
  }
  if (tool.parameters === undefined) {
    throw new ExtensionToolContributionError(
      'invalid_tool',
      `Tool "${tool.name}" requires an input schema`,
    );
  }
  if (tool.providerTool) {
    throw new ExtensionToolContributionError(
      'invalid_tool',
      `Extension Tool "${tool.name}" cannot claim a provider-native Runtime protocol`,
    );
  }
}

function toolNameKey(name: string): string {
  return name.toLowerCase();
}

function compareString(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
