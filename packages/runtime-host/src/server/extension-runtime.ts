import {
  ExtensionLifecycleKernel,
  type ExtensionBindingInput,
  type ExtensionBindingInspection,
  type ExtensionActivationContext,
  type ExtensionCompositionSnapshot,
  type ExtensionPreparationContext,
  type ExtensionRevisionDefinition,
  type ExtensionDependencyDefinition,
} from '@maka/runtime/extension-lifecycle-kernel';
import {
  contributeExtensionTool,
  ExtensionToolContributionRegistry,
  defineTrustedToolExtensionRevision,
  type ExtensionToolContributionInspection,
  type ExtensionToolContributionRegistryOptions,
  type TrustedToolExtensionRevisionInput,
} from '@maka/runtime/extension-tool-contributions';
import type { MakaTool } from '@maka/runtime/tool-runtime';
import {
  contributeExtensionUi,
  defineTrustedUiExtensionRevision,
  ExtensionUiContributionRegistry,
  type ExtensionUiContribution,
  type ExtensionUiContributionInspection,
} from '@maka/runtime/extension-ui-contributions';
import {
  contributeExtensionHook,
  ExtensionHookContributionRegistry,
  type ExtensionHookContribution,
  type ExtensionHookContributionInspection,
} from '@maka/runtime/extension-hook-contributions';
import { createHash } from 'node:crypto';

export type HostTrustedToolExtensionRevisionInput = Omit<
  TrustedToolExtensionRevisionInput,
  'registry'
>;

export interface HostPreparedToolExtensionRevisionInput {
  readonly extensionId: string;
  readonly revision: string;
  readonly toolNames: readonly string[];
  readonly dependencies?: readonly ExtensionDependencyDefinition[];
  /** Optional client contribution carried by the exact same immutable package Revision. */
  readonly ui?: readonly ExtensionUiContribution[];
  /** Runtime Hook contribution identities carried by the exact same immutable package Revision. */
  readonly hookContributionIds?: readonly string[];
  readonly prepare: (context: ExtensionPreparationContext) => Promise<{
    readonly tools: readonly MakaTool[];
    readonly hooks?: readonly ExtensionHookContribution[];
    readonly healthCheck?: () => void | Promise<void>;
    readonly dispose?: () => void | Promise<void>;
  }>;
}

export type HostToolExtensionRevisionInput =
  | HostTrustedToolExtensionRevisionInput
  | HostPreparedToolExtensionRevisionInput;

export interface HostUiExtensionRevisionInput {
  readonly extensionId: string;
  readonly revision: string;
  readonly dependencies?: readonly ExtensionDependencyDefinition[];
  readonly ui: readonly ExtensionUiContribution[];
  readonly healthCheck?: () => void | Promise<void>;
}

export type HostExtensionRevisionInput =
  | HostToolExtensionRevisionInput
  | HostUiExtensionRevisionInput;

export interface HostExtensionToolResolver {
  resolveTools(
    scopeId: string,
    coreTools: readonly MakaTool[],
    options?: HostExtensionToolResolutionOptions,
  ): readonly MakaTool[];
}

export interface HostExtensionToolResolutionOptions {
  /** Preserve an exact caller-owned Tool ceiling without Host or Extension additions. */
  readonly exact?: boolean;
}

export const PROFILE_EXTENSION_SCOPE = 'profile';

/**
 * Runtime Host-owned Extension authority.
 *
 * This is deliberately an in-process seam rather than a product control plane.
 * It gives the Host one lifecycle owner, one typed Tool registry, and one close
 * boundary while later API/CLI/UI work decides how trusted definitions arrive.
 */
export class HostExtensionRuntime implements HostExtensionToolResolver {
  readonly #lifecycle = new ExtensionLifecycleKernel();
  readonly #tools: ExtensionToolContributionRegistry;
  readonly #ui = new ExtensionUiContributionRegistry();
  readonly #hooks = new ExtensionHookContributionRegistry();
  readonly #scopeIds = new Set<string>();
  #hostTools: readonly MakaTool[] = Object.freeze([]);
  #draining = false;
  #closed = false;
  #closeTask: Promise<void> | undefined;

  constructor(options: ExtensionToolContributionRegistryOptions = {}) {
    this.#tools = new ExtensionToolContributionRegistry(options);
  }

  install(definition: ExtensionRevisionDefinition): Promise<void> {
    this.#assertMutable();
    return this.#lifecycle.install(definition);
  }

  installTrustedToolRevision(input: HostTrustedToolExtensionRevisionInput): Promise<void> {
    this.#assertMutable();
    return this.#lifecycle.install(
      defineTrustedToolExtensionRevision({
        ...input,
        registry: this.#tools,
      }),
    );
  }

  installToolRevision(input: HostToolExtensionRevisionInput): Promise<void> {
    if ('tools' in input) return this.installTrustedToolRevision(input);
    this.#assertMutable();
    const definition: ExtensionRevisionDefinition = Object.freeze({
      extensionId: input.extensionId,
      revision: input.revision,
      ...(input.dependencies ? { dependencies: input.dependencies } : {}),
      contributions: Object.freeze([
        ...input.toolNames.map((_, index) =>
          Object.freeze({ id: `${input.extensionId}.tool-${index + 1}`, kind: 'tool' }),
        ),
        ...(input.ui ?? []).map(({ id }) => Object.freeze({ id, kind: 'ui' })),
        ...(input.hookContributionIds ?? []).map((_, index) =>
          Object.freeze({ id: `${input.extensionId}.hook-${index + 1}`, kind: 'hook' }),
        ),
      ]),
      prepare: async (context: ExtensionPreparationContext) => {
        const prepared = await input.prepare(context);
        return {
          ...(prepared.healthCheck ? { healthCheck: prepared.healthCheck } : {}),
          activate: (activation: ExtensionActivationContext) => {
            for (const tool of prepared.tools)
              contributeExtensionTool(activation, this.#tools, tool);
            for (const contribution of input.ui ?? [])
              contributeExtensionUi(activation, this.#ui, contribution);
            for (const contribution of prepared.hooks ?? [])
              contributeExtensionHook(activation, this.#hooks, contribution);
          },
          ...(prepared.dispose ? { dispose: prepared.dispose } : {}),
        };
      },
    });
    return this.#lifecycle.install(definition);
  }

  installUiRevision(input: HostUiExtensionRevisionInput): Promise<void> {
    this.#assertMutable();
    return this.#lifecycle.install(
      defineTrustedUiExtensionRevision({ ...input, registry: this.#ui }),
    );
  }

  installRevision(input: HostExtensionRevisionInput): Promise<void> {
    return 'prepare' in input || 'tools' in input
      ? this.installToolRevision(input)
      : this.installUiRevision(input);
  }

  activate(input: ExtensionBindingInput): Promise<ExtensionBindingInspection> {
    this.#assertMutable();
    // Activation may leave a failed Binding behind for diagnosis/retry. Track
    // the scope before entering the kernel so Host close still owns cleanup.
    this.#scopeIds.add(input.scopeId);
    return this.#lifecycle.activate(input);
  }

  update(bindingId: string, revision: string): Promise<ExtensionBindingInspection> {
    this.#assertMutable();
    return this.#lifecycle.update(bindingId, revision);
  }

  start(bindingId: string): Promise<ExtensionBindingInspection> {
    this.#assertMutable();
    return this.#lifecycle.start(bindingId);
  }

  stop(bindingId: string): Promise<ExtensionBindingInspection> {
    this.#assertMutable();
    return this.#lifecycle.stop(bindingId);
  }

  async removeBinding(bindingId: string): Promise<void> {
    this.#assertMutable();
    const scopeId = this.#lifecycle.inspect(bindingId).scopeId;
    await this.#lifecycle.removeBinding(bindingId);
    if (this.#lifecycle.inspectScope(scopeId).length === 0) this.#scopeIds.delete(scopeId);
  }

  async disposeScope(scopeId: string): Promise<void> {
    this.#assertMutable();
    await this.#lifecycle.disposeScope(scopeId);
    this.#scopeIds.delete(scopeId);
  }

  uninstall(extensionId: string, revision: string): Promise<void> {
    this.#assertMutable();
    return this.#lifecycle.uninstall(extensionId, revision);
  }

  inspect(bindingId: string): ExtensionBindingInspection {
    return this.#lifecycle.inspect(bindingId);
  }

  inspectScope(scopeId: string): readonly ExtensionBindingInspection[] {
    return this.#lifecycle.inspectScope(scopeId);
  }

  inspectTools(scopeId: string): readonly ExtensionToolContributionInspection[] {
    return this.#tools.inspect(scopeId);
  }

  inspectUi(scopeId: string): readonly ExtensionUiContributionInspection[] {
    const committed = this.#lifecycle
      .inspectScope(scopeId)
      .flatMap((binding) =>
        binding.current
          ? [{ bindingId: binding.bindingId, revision: binding.current.revision }]
          : [],
      );
    return this.#ui.inspect(scopeId, committed);
  }

  inspectHooks(scopeId: string): readonly ExtensionHookContributionInspection[] {
    if (scopeId === PROFILE_EXTENSION_SCOPE) return this.#hooks.inspect([scopeId]);
    const resolved = new Map<string, ExtensionHookContributionInspection>();
    for (const hook of this.#hooks.inspect([PROFILE_EXTENSION_SCOPE, scopeId])) {
      const key = `${hook.event}\0${hook.extensionId}\0${hook.id}`;
      const current = resolved.get(key);
      if (!current || hook.scopeId === scopeId) resolved.set(key, hook);
    }
    return Object.freeze([...resolved.values()].sort(compareHookContribution));
  }

  installedRevisions(): readonly {
    readonly extensionId: string;
    readonly revision: string;
  }[] {
    return this.#lifecycle.installedRevisions();
  }

  composition(scopeId: string): ExtensionCompositionSnapshot {
    const scoped = this.#lifecycle.composition(scopeId);
    if (scopeId === PROFILE_EXTENSION_SCOPE) return scoped;
    const profile = this.#lifecycle.composition(PROFILE_EXTENSION_SCOPE);
    if (profile.entries.length === 0) return scoped;
    const entries = Object.freeze([...profile.entries, ...scoped.entries]);
    const digest = createHash('sha256').update(JSON.stringify(entries)).digest('hex');
    return Object.freeze({
      schemaVersion: 1,
      scopeId,
      digest: `sha256:${digest}`,
      entries,
    });
  }

  resolveTools(
    scopeId: string,
    coreTools: readonly MakaTool[],
    options: HostExtensionToolResolutionOptions = {},
  ): readonly MakaTool[] {
    if (this.#closed) throw new Error('Runtime Host Extension authority is closed');
    if (options.exact) return Object.freeze([...coreTools]);
    const profileTools = this.#tools.compose(PROFILE_EXTENSION_SCOPE, [
      ...coreTools,
      ...this.#hostTools,
    ]);
    return scopeId === PROFILE_EXTENSION_SCOPE
      ? profileTools
      : this.#tools.compose(scopeId, profileTools);
  }

  registerHostTools(tools: readonly MakaTool[]): void {
    this.#assertMutable();
    if (this.#hostTools.length > 0)
      throw new Error('Runtime Host Extension Tools are already registered');
    this.#hostTools = Object.freeze(tools.map((tool) => Object.freeze({ ...tool })));
  }

  beginDrain(): void {
    this.#draining = true;
  }

  close(): Promise<void> {
    if (this.#closed) return Promise.resolve();
    this.#closeTask ??= this.#closeOnce().finally(() => {
      if (!this.#closed) this.#closeTask = undefined;
    });
    return this.#closeTask;
  }

  async #closeOnce(): Promise<void> {
    this.beginDrain();
    const errors: unknown[] = [];
    for (const scopeId of [...this.#scopeIds].sort(compareString)) {
      try {
        await this.#lifecycle.disposeScope(scopeId);
        this.#scopeIds.delete(scopeId);
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length === 0) {
      for (const { extensionId, revision } of [...this.#lifecycle.installedRevisions()].reverse()) {
        try {
          await this.#lifecycle.uninstall(extensionId, revision);
        } catch (error) {
          errors.push(error);
        }
      }
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, 'Unable to close Runtime Host Extension authority');
    }
    this.#closed = true;
  }

  #assertMutable(): void {
    if (this.#closed) throw new Error('Runtime Host Extension authority is closed');
    if (this.#draining) throw new Error('Runtime Host Extension authority is draining');
  }
}

function compareString(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareHookContribution(
  left: ExtensionHookContributionInspection,
  right: ExtensionHookContributionInspection,
): number {
  return (
    compareString(left.event, right.event) ||
    right.priority - left.priority ||
    compareString(left.extensionId, right.extensionId) ||
    compareString(left.revision, right.revision) ||
    compareString(left.id, right.id)
  );
}
