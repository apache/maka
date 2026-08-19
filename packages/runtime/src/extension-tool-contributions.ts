import type { MakaContributionContext } from './plugin-runtime.js';
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
  readonly entryId: string;
  readonly extensionId: string;
  readonly generation: number;
  readonly toolName: string;
}

interface RegisteredExtensionTool extends ExtensionToolContributionInspection {
  readonly key: string;
  readonly tool: MakaTool;
  readonly token: symbol;
  retired: boolean;
  failures: number;
  circuitOpen: boolean;
}

export interface ExtensionToolContributionRegistryOptions {
  /** Core Tool names protected from Extension shadowing at activation time. */
  readonly protectedToolNames?: (scopeId: string) => readonly string[];
  readonly invocationTimeoutMs?: number;
  readonly failureThreshold?: number;
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
    context: Pick<MakaContributionContext, 'entryId' | 'scopeId' | 'extensionId' | 'generation'>,
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
      (existing.entryId !== context.entryId || existing.extensionId !== context.extensionId)
    ) {
      throw new ExtensionToolContributionError(
        'tool_name_conflict',
        `Tool name "${tool.name}" is already contributed by entry ${existing.entryId}`,
      );
    }
    const token = Symbol(tool.name);
    let entry!: RegisteredExtensionTool;
    const guardedTool: MakaTool =
      this.options.invocationTimeoutMs === undefined && this.options.failureThreshold === undefined
        ? tool
        : {
            ...tool,
            impl: async (args: any, context: Parameters<typeof tool.impl>[1]) => {
              if (entry.retired)
                throw new Error(`Extension Tool "${tool.name}" is no longer active`);
              if (entry.circuitOpen)
                throw new Error(
                  `Extension Tool "${tool.name}" circuit is open after repeated failures`,
                );
              const timeoutMs = this.options.invocationTimeoutMs ?? 30_000;
              let timer: ReturnType<typeof setTimeout> | undefined;
              try {
                const result = await Promise.race([
                  Promise.resolve(tool.impl(args, context)),
                  new Promise<never>((_, reject) => {
                    timer = setTimeout(
                      () => reject(new Error(`Extension Tool "${tool.name}" timed out`)),
                      timeoutMs,
                    );
                  }),
                ]);
                entry.failures = 0;
                return result;
              } catch (error) {
                entry.failures += 1;
                if (entry.failures >= (this.options.failureThreshold ?? 3))
                  entry.circuitOpen = true;
                throw error;
              } finally {
                if (timer) clearTimeout(timer);
              }
            },
          };
    entry = {
      key,
      scopeId: context.scopeId,
      entryId: context.entryId,
      extensionId: context.extensionId,
      generation: context.generation,
      toolName: tool.name,
      tool: guardedTool,
      token,
      retired: false,
      failures: 0,
      circuitOpen: false,
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
      validateTool(tool, { allowProviderTool: true });
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
          entryId: entry.entryId,
          extensionId: entry.extensionId,
          generation: entry.generation,
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
  context: MakaContributionContext,
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

function validateContext(
  context: Pick<MakaContributionContext, 'entryId' | 'scopeId' | 'extensionId' | 'generation'>,
): void {
  validateIdentity('entryId', context.entryId);
  validateIdentity('scopeId', context.scopeId);
  validateIdentity('extensionId', context.extensionId);
  if (!Number.isSafeInteger(context.generation) || context.generation <= 0) {
    throw new ExtensionToolContributionError('invalid_tool', 'Fiber generation is required');
  }
}

function validateIdentity(label: string, value: string): void {
  if (typeof value !== 'string' || value.length === 0 || /[\r\n\0]/.test(value)) {
    throw new ExtensionToolContributionError('invalid_tool', `Invalid ${label}`);
  }
}

function validateTool(tool: MakaTool, options: { allowProviderTool?: boolean } = {}): void {
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
  if (tool.providerTool && !options.allowProviderTool) {
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
