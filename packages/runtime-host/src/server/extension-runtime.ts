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
  contributeExtensionEvent,
  contributeExtensionEventListener,
  ExtensionEventContributionRegistry,
  type ExtensionEventDefinition,
  type ExtensionEventDefinitionInspection,
  type ExtensionEventInvocationContext,
  type ExtensionEventListenerContribution,
  type ExtensionEventListenerInspection,
} from '@maka/runtime/extension-event-contributions';
import {
  contributeExtensionService,
  ExtensionServiceContributionRegistry,
  type ExtensionServiceContribution,
  type ExtensionServiceContributionInspection,
  type ExtensionServiceInvocationContext,
} from '@maka/runtime/extension-service-contributions';
import { createHash } from 'node:crypto';
import { dispatchExtensionHandlers } from '@maka/runtime/extension-dispatch';
import {
  EXTENSION_CORE_EVENTS,
  isExtensionCoreEventName,
  validateExtensionCoreEventPayload,
  type ExtensionCoreEventName,
} from '@maka/runtime/extension-core-events';
import {
  contributeExtensionTimer,
  type ExtensionTimerAuthority,
  type ExtensionTimerContribution,
  type ExtensionTimerContributionInspection,
} from '@maka/runtime/extension-timer-contributions';

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
  /** Plugin-defined Event and Listener identities carried by the same immutable Revision. */
  readonly eventContributionIds?: readonly string[];
  readonly serviceContributionIds?: readonly string[];
  readonly timerContributionIds?: readonly string[];
  readonly prepare: (context: ExtensionPreparationContext) => Promise<{
    readonly tools: readonly MakaTool[];
    readonly events?: readonly ExtensionEventDefinition[];
    readonly listeners?: readonly ExtensionEventListenerContribution[];
    readonly services?: readonly ExtensionServiceContribution[];
    readonly timers?: readonly ExtensionTimerContribution[];
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

export interface HostExtensionEventDispatchResult {
  readonly event: string;
  readonly mode?: import('@maka/runtime/extension-event-contributions').ExtensionEventDispatchMode;
  readonly listenerCount: number;
  readonly delivered: number;
  readonly failed: number;
  readonly failures: readonly {
    readonly extensionId: string;
    readonly listenerId: string;
    readonly diagnostic: string;
  }[];
  readonly result?: unknown;
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
  readonly #ui = new ExtensionUiContributionRegistry();
  readonly #events = new ExtensionEventContributionRegistry();
  readonly #services = new ExtensionServiceContributionRegistry();
  readonly #scopeIds = new Set<string>();
  #hostTools: readonly MakaTool[] = Object.freeze([]);
  #draining = false;
  #closed = false;
  #closeTask: Promise<void> | undefined;

  constructor(
    options: ExtensionToolContributionRegistryOptions = {},
    private readonly timerAuthority?: ExtensionTimerAuthority & {
      inspect?(scopeId?: string): readonly ExtensionTimerContributionInspection[];
      beginDrain?(): void;
      close?(): Promise<void> | void;
    },
  ) {
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
        ...(input.eventContributionIds ?? []).map((_, index) =>
          Object.freeze({ id: `${input.extensionId}.event-${index + 1}`, kind: 'event' }),
        ),
        ...(input.serviceContributionIds ?? []).map((_, index) =>
          Object.freeze({ id: `${input.extensionId}.service-${index + 1}`, kind: 'service' }),
        ),
        ...(input.timerContributionIds ?? []).map((_, index) =>
          Object.freeze({ id: `${input.extensionId}.timer-${index + 1}`, kind: 'timer' }),
        ),
      ]),
      prepare: async (context: ExtensionPreparationContext) => {
        const prepared = await input.prepare(context);
        return {
          ...(prepared.healthCheck ? { healthCheck: prepared.healthCheck } : {}),
          activate: async (activation: ExtensionActivationContext) => {
            for (const tool of prepared.tools)
              contributeExtensionTool(activation, this.#tools, tool);
            for (const contribution of input.ui ?? [])
              contributeExtensionUi(activation, this.#ui, contribution);
            for (const definition of prepared.events ?? [])
              contributeExtensionEvent(activation, this.#events, definition);
            for (const listener of prepared.listeners ?? [])
              contributeExtensionEventListener(activation, this.#events, listener);
            for (const service of prepared.services ?? [])
              contributeExtensionService(activation, this.#services, service);
            if ((prepared.timers?.length ?? 0) > 0 && !this.timerAuthority)
              throw new Error('Extension Timer authority is unavailable');
            for (const timer of prepared.timers ?? [])
              await contributeExtensionTimer(activation, this.timerAuthority!, timer);
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

  inspectEvents(scopeId: string): readonly ExtensionEventDefinitionInspection[] {
    const { scopeIds, committed } = this.#resolvedScopeState(scopeId);
    return this.#events.inspectEvents(scopeIds, committed);
  }

  inspectEventListeners(scopeId: string): readonly ExtensionEventListenerInspection[] {
    const { scopeIds, committed } = this.#resolvedScopeState(scopeId);
    return this.#events.inspectListeners(scopeIds, committed);
  }

  inspectServices(scopeId: string): readonly ExtensionServiceContributionInspection[] {
    const { scopeIds, committed } = this.#resolvedScopeState(scopeId);
    return this.#services.inspect(scopeIds, committed);
  }

  inspectTimers(scopeId: string): readonly ExtensionTimerContributionInspection[] {
    return this.timerAuthority?.inspect?.(scopeId) ?? Object.freeze([]);
  }

  async callService(
    scopeId: string,
    service: string,
    method: string,
    input: unknown,
    context: ExtensionServiceInvocationContext,
  ): Promise<unknown> {
    if (this.#closed) throw new Error('Runtime Host Extension authority is closed');
    if (this.#draining) throw new Error('Runtime Host Extension authority is draining');
    if ((context.serviceDepth ?? 0) >= 8)
      throw new Error('Extension Service recursion limit exceeded');
    const { scopeIds, committed } = this.#resolvedScopeState(scopeId);
    return await this.#services.call(scopeIds, committed, service, method, input, context);
  }

  async emitEvent(
    scopeId: string,
    event: string,
    payload: unknown,
    context: ExtensionEventInvocationContext,
  ): Promise<HostExtensionEventDispatchResult> {
    if (this.#closed) throw new Error('Runtime Host Extension authority is closed');
    if (this.#draining) throw new Error('Runtime Host Extension authority is draining');
    if (context.signal.aborted)
      throw context.signal.reason ?? new Error('Event emission was aborted');
    if ((context.eventDepth ?? 0) > 8) throw new Error('Extension Event recursion limit exceeded');
    const { scopeIds, committed } = this.#resolvedScopeState(scopeId);
    const parsed = this.#events.parsePayload(scopeIds, committed, event, payload);
    const definition = this.#events.resolveDefinition(scopeIds, committed, event);
    const listeners = this.#events
      .inspectListeners(scopeIds, committed)
      .filter((listener) => listener.event === event);
    const dispatched = await dispatchExtensionHandlers({
      mode: definition.mode,
      payload: parsed,
      signal: context.signal,
      handlers: listeners.map((listener) => ({
        identity: listener,
        invoke: (value: unknown) => listener.invoke(value, context),
      })),
    });
    const failures = dispatched.settlements
      .filter((item) => item.status === 'rejected')
      .map((item) => ({
        extensionId: item.identity.extensionId,
        listenerId: item.identity.id,
        diagnostic: boundedDiagnostic(item.error),
      }));
    const delivered = dispatched.settlements.length - failures.length;
    const result =
      definition.mode === 'emit'
        ? undefined
        : this.#events.parseResult(scopeIds, committed, event, dispatched.value);
    return Object.freeze({
      event,
      ...(definition.mode === 'emit' ? {} : { mode: definition.mode }),
      listenerCount: listeners.length,
      delivered,
      failed: failures.length,
      failures: Object.freeze(failures.map((failure) => Object.freeze(failure))),
      ...(result === undefined ? {} : { result }),
    });
  }

  async dispatchCoreEvent(
    scopeId: string,
    event: ExtensionCoreEventName,
    payload: unknown,
    context: ExtensionEventInvocationContext,
  ): Promise<HostExtensionEventDispatchResult> {
    if (this.#closed) throw new Error('Runtime Host Extension authority is closed');
    if (this.#draining) throw new Error('Runtime Host Extension authority is draining');
    if (!isExtensionCoreEventName(event)) throw new Error(`Unknown core Extension Event: ${event}`);
    if (context.signal.aborted)
      throw context.signal.reason ?? new Error('Core Extension Event was aborted');
    const mode = EXTENSION_CORE_EVENTS[event];
    const { scopeIds, committed } = this.#resolvedScopeState(scopeId);
    const listeners = this.#events
      .inspectListeners(scopeIds, committed)
      .filter((listener) => listener.event === event);
    if (listeners.length === 0) {
      return Object.freeze({
        event,
        mode,
        listenerCount: 0,
        delivered: 0,
        failed: 0,
        failures: Object.freeze([]),
        result: mode === 'bail' ? undefined : payload,
      });
    }
    const parsed = validateExtensionCoreEventPayload(event, payload);
    const dispatched = await dispatchExtensionHandlers({
      mode,
      payload: parsed,
      signal: context.signal,
      handlers: listeners.map((listener) => ({
        identity: listener,
        invoke: (value: unknown) => listener.invoke(value, context),
      })),
    });
    const failures = dispatched.settlements
      .filter((item) => item.status === 'rejected')
      .map((item) => ({
        extensionId: item.identity.extensionId,
        listenerId: item.identity.id,
        diagnostic: boundedDiagnostic(item.error),
      }));
    return Object.freeze({
      event,
      mode,
      listenerCount: listeners.length,
      delivered: dispatched.settlements.length - failures.length,
      failed: failures.length,
      failures: Object.freeze(failures.map((failure) => Object.freeze(failure))),
      result: dispatched.value,
    });
  }

  async dispatchCoreMiddleware(
    scopeId: string,
    event: 'maka.tools.execute' | 'maka.llm.stream',
    payload: unknown,
    context: ExtensionEventInvocationContext,
    final: (value: unknown) => unknown | Promise<unknown>,
  ): Promise<unknown> {
    if (this.#closed) throw new Error('Runtime Host Extension authority is closed');
    if (this.#draining) throw new Error('Runtime Host Extension authority is draining');
    if (context.signal.aborted)
      throw context.signal.reason ?? new Error('Core Extension Middleware was aborted');
    const { scopeIds, committed } = this.#resolvedScopeState(scopeId);
    const listeners = this.#events
      .inspectListeners(scopeIds, committed)
      .filter((listener) => listener.event === event);
    const dispatched = await dispatchExtensionHandlers({
      mode: 'around',
      payload,
      signal: context.signal,
      handlers: listeners.map((listener) => ({
        identity: listener,
        invoke: (value, next) => listener.invoke(value, context, next),
      })),
      final,
    });
    return dispatched.value;
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

  #resolvedScopeState(scopeId: string): {
    scopeIds: readonly string[];
    committed: readonly { readonly bindingId: string; readonly revision: string }[];
  } {
    const scopeIds =
      scopeId === PROFILE_EXTENSION_SCOPE ? [scopeId] : [PROFILE_EXTENSION_SCOPE, scopeId];
    const committed = scopeIds.flatMap((resolvedScopeId) =>
      this.#lifecycle
        .inspectScope(resolvedScopeId)
        .flatMap((binding) =>
          binding.current
            ? [{ bindingId: binding.bindingId, revision: binding.current.revision }]
            : [],
        ),
    );
    return { scopeIds, committed };
  }

  beginDrain(): void {
    this.#draining = true;
    this.timerAuthority?.beginDrain?.();
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
    await this.timerAuthority?.close?.();
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

function boundedDiagnostic(error: unknown): string {
  const value = error instanceof Error ? error.message : String(error);
  const encoded = Buffer.from(value || 'Event Listener failed', 'utf8');
  if (encoded.byteLength <= 4096) return value || 'Event Listener failed';
  return `${encoded
    .subarray(0, 4093)
    .toString('utf8')
    .replace(/\uFFFD$/u, '')}...`;
}
