import {
  ExtensionLifecycleKernel,
  type ExtensionBindingInput,
  type ExtensionBindingInspection,
  type ExtensionCompositionSnapshot,
  type ExtensionRevisionDefinition,
} from '@maka/runtime/extension-lifecycle-kernel';
import {
  ExtensionToolContributionRegistry,
  defineTrustedToolExtensionRevision,
  type ExtensionToolContributionInspection,
  type ExtensionToolContributionRegistryOptions,
  type TrustedToolExtensionRevisionInput,
} from '@maka/runtime/extension-tool-contributions';
import type { MakaTool } from '@maka/runtime/tool-runtime';

export type HostTrustedToolExtensionRevisionInput = Omit<
  TrustedToolExtensionRevisionInput,
  'registry'
>;

export interface HostExtensionToolResolver {
  resolveTools(scopeId: string, coreTools: readonly MakaTool[]): readonly MakaTool[];
}

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
  readonly #scopeIds = new Set<string>();
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

  installedRevisions(): readonly {
    readonly extensionId: string;
    readonly revision: string;
  }[] {
    return this.#lifecycle.installedRevisions();
  }

  composition(scopeId: string): ExtensionCompositionSnapshot {
    return this.#lifecycle.composition(scopeId);
  }

  resolveTools(scopeId: string, coreTools: readonly MakaTool[]): readonly MakaTool[] {
    if (this.#closed) throw new Error('Runtime Host Extension authority is closed');
    return this.#tools.compose(scopeId, coreTools);
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
