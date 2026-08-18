import { Context, type Plugin } from '@maka/runtime/plugin-kernel';
import { MakaCompositionLoader } from '@maka/runtime/plugin-composition-loader';
import {
  type MakaContributionContext,
  type MakaCompositionSnapshot,
  type MakaCompositionApplyInput,
  type MakaCompositionEntryInspection,
  type MakaPluginMountInspection,
  type MakaPluginPackage,
  type MakaPluginRootId,
  type MakaRuntimeCompositionSnapshot,
  ownPluginEffect,
  pluginIdentity,
} from '@maka/runtime/plugin-runtime';
import { PluginToolService } from '@maka/runtime/plugin-tool-service';
import { PluginUiService } from '@maka/runtime/plugin-ui-service';
import { PluginHookService } from '@maka/runtime/plugin-hook-service';
import {
  type ExtensionToolContributionInspection,
  type ExtensionToolContributionRegistryOptions,
} from '@maka/runtime/extension-tool-contributions';
import type { MakaTool } from '@maka/runtime/tool-runtime';
import {
  type ExtensionUiContribution,
  type ExtensionUiContributionInspection,
} from '@maka/runtime/extension-ui-contributions';
import {
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
export interface HostTrustedToolExtensionRevisionInput {
  readonly extensionId: string;
  readonly revision: string;
  readonly dependencies?: readonly { readonly extensionId: string }[];
  readonly tools: readonly MakaTool[];
  readonly healthCheck?: () => void | Promise<void>;
}

export interface HostPreparedPluginPackageInput {
  readonly extensionId: string;
  readonly revision: string;
  readonly toolNames: readonly string[];
  readonly dependencies?: readonly { readonly extensionId: string }[];
  /** Optional client contribution carried by the exact same immutable package Revision. */
  readonly ui?: readonly ExtensionUiContribution[];
  /** Plugin-defined Event and Listener identities carried by the same immutable Revision. */
  readonly eventContributionIds?: readonly string[];
  readonly serviceContributionIds?: readonly string[];
  readonly timerContributionIds?: readonly string[];
  readonly load: (context: MakaContributionContext) => Promise<{
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
  | HostPreparedPluginPackageInput;

export interface HostUiExtensionRevisionInput {
  readonly extensionId: string;
  readonly revision: string;
  readonly dependencies?: readonly { readonly extensionId: string }[];
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

export interface HostExtensionRuntimeInspection {
  readonly runtime: readonly import('@maka/runtime/plugin-runtime').MakaCompositionEntryInspection[];
  readonly scopes: readonly MakaPluginMountInspection[];
  readonly tools: readonly ExtensionToolContributionInspection[];
  readonly ui: readonly ExtensionUiContributionInspection[];
  readonly uiReadiness: readonly import('@maka/runtime/extension-ui-contributions').ExtensionUiReadinessInspection[];
  readonly timers: readonly ExtensionTimerContributionInspection[];
  readonly events: readonly ExtensionEventDefinitionInspection[];
  readonly listeners: readonly ExtensionEventListenerInspection[];
  readonly services: readonly ExtensionServiceContributionInspection[];
}

/**
 * Runtime Host-owned Extension authority.
 *
 * This is deliberately an in-process seam rather than a product control plane.
 * It gives the Host one lifecycle owner, one typed Tool registry, and one close
 * boundary while later API/CLI/UI work decides how trusted definitions arrive.
 */
export class HostExtensionRuntime implements HostExtensionToolResolver {
  readonly #composition: MakaCompositionLoader;
  readonly #tools: PluginToolService;
  readonly #ui: PluginUiService;
  readonly #hooks: PluginHookService;
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
    const root = new Context();
    this.#tools = new PluginToolService(root, options);
    this.#ui = new PluginUiService(root);
    this.#hooks = new PluginHookService(root);
    this.#composition = new MakaCompositionLoader({ root });
  }

  installTrustedToolRevision(input: HostTrustedToolExtensionRevisionInput): Promise<void> {
    this.#assertMutable();
    const tools = Object.freeze(input.tools.map((tool) => Object.freeze({ ...tool })));
    return this.#composition.install(
      this.#package(input, (ctx) => {
        const setup = async () => {
          await input.healthCheck?.();
          for (const tool of tools) ctx.tools.register(tool);
        };
        return setup();
      }),
    );
  }

  installToolRevision(input: HostToolExtensionRevisionInput): Promise<void> {
    if ('tools' in input) return this.installTrustedToolRevision(input);
    this.#assertMutable();
    return this.#composition.install(
      this.#package(input, async (ctx) => {
        const activation = this.#activationContext(ctx);
        const loaded = await input.load(activation);
        await loaded.healthCheck?.();
        for (const tool of loaded.tools) ctx.tools.register(tool);
        for (const contribution of input.ui ?? []) ctx.ui.register(contribution);
        for (const definition of loaded.events ?? []) ctx.hooks.define(definition);
        for (const listener of loaded.listeners ?? []) ctx.hooks.on(listener);
        for (const service of loaded.services ?? [])
          contributeExtensionService(activation, this.#services, service);
        if ((loaded.timers?.length ?? 0) > 0 && !this.timerAuthority)
          throw new Error('Extension Timer authority is unavailable');
        for (const timer of loaded.timers ?? [])
          await contributeExtensionTimer(activation, this.timerAuthority!, timer);
        if (loaded.dispose) ownPluginEffect(ctx, 'package.dispose', loaded.dispose);
      }),
    );
  }

  installUiRevision(input: HostUiExtensionRevisionInput): Promise<void> {
    this.#assertMutable();
    return this.#composition.install(
      this.#package(input, async (ctx) => {
        await input.healthCheck?.();
        for (const contribution of input.ui) ctx.ui.register(contribution);
      }),
    );
  }

  installRevision(input: HostExtensionRevisionInput): Promise<void> {
    return 'load' in input || 'tools' in input
      ? this.installToolRevision(input)
      : this.installUiRevision(input);
  }

  async disposeScope(scopeId: string): Promise<void> {
    await this.applyComposition({
      operations: [...this.#composition.inspectTree(this.#rootId(scopeId))]
        .reverse()
        .map(({ id: entryId }) => ({ type: 'remove' as const, entryId })),
    });
  }

  async replaceCompositionSnapshot(snapshot: MakaCompositionSnapshot): Promise<void> {
    this.#assertMutable();
    await this.#composition.replaceSnapshot(snapshot);
    this.#refreshScopeIds();
  }

  /**
   * Applies an atomic batch to the EntryTree. All public extension mutations
   * should converge on this operation; the loader owns the runtime tree.
   */
  async applyComposition(
    input: MakaCompositionApplyInput,
  ): Promise<readonly MakaCompositionEntryInspection[]> {
    this.#assertMutable();
    const changed = await this.#composition.apply(input);
    this.#refreshScopeIds();
    return changed;
  }

  uninstall(extensionId: string, revision: string): Promise<void> {
    this.#assertMutable();
    return this.#composition.uninstall(extensionId, revision);
  }

  inspect(entryId: string): MakaPluginMountInspection {
    const entry = this.#composition.inspect(entryId);
    return this.#mountInspection(entry);
  }

  inspectScope(scopeId: string): readonly MakaPluginMountInspection[] {
    const rootId = this.#rootId(scopeId);
    return Object.freeze(
      this.#composition
        .inspectTree(rootId)
        .flatMap(flattenInspection)
        .filter((entry) => entry.packageId)
        .map((entry) => this.#mountInspection(entry)),
    );
  }

  inspectTools(scopeId: string): readonly ExtensionToolContributionInspection[] {
    return this.#tools.inspect(this.#rootId(scopeId));
  }

  inspectUi(scopeId: string): readonly ExtensionUiContributionInspection[] {
    const committed = this.inspectScope(scopeId).flatMap((entry) =>
      entry.current ? [{ entryId: entry.entryId, revision: entry.current.revision }] : [],
    );
    return this.#ui.inspect(this.#rootId(scopeId), committed);
  }

  reportUiReadiness(
    scopeId: string,
    entryId: string,
    revision: string,
    status: import('@maka/runtime/extension-ui-contributions').ExtensionUiReadiness,
    diagnostic?: string,
  ): void {
    this.#ui.setReadinessForRoot(this.#rootId(scopeId), entryId, revision, status, diagnostic);
  }

  inspectUiReadiness(scopeId?: string) {
    return this.#ui.inspectReadiness(scopeId ? this.#rootId(scopeId) : undefined);
  }

  inspectEvents(scopeId: string): readonly ExtensionEventDefinitionInspection[] {
    const { scopeIds, committed } = this.#resolvedScopeState(scopeId);
    return this.#hooks.inspectEvents(scopeIds, committed);
  }

  inspectEventListeners(scopeId: string): readonly ExtensionEventListenerInspection[] {
    const { scopeIds, committed } = this.#resolvedScopeState(scopeId);
    return this.#hooks.inspectListeners(scopeIds, committed);
  }

  inspectServices(scopeId: string): readonly ExtensionServiceContributionInspection[] {
    const { scopeIds, committed } = this.#resolvedScopeState(scopeId);
    return this.#services.inspect(scopeIds, committed);
  }

  inspectTimers(scopeId: string): readonly ExtensionTimerContributionInspection[] {
    return this.timerAuthority?.inspect?.(this.#rootId(scopeId)) ?? Object.freeze([]);
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
    const parsed = this.#hooks.parsePayload(scopeIds, committed, event, payload);
    const definition = this.#hooks.resolveDefinition(scopeIds, committed, event);
    const listeners = this.#hooks
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
        : this.#hooks.parseResult(scopeIds, committed, event, dispatched.value);
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
    const listeners = this.#hooks
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
    const listeners = this.#hooks
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
    return this.#composition
      .installedPackages()
      .map(({ packageId: extensionId, revision }) => Object.freeze({ extensionId, revision }));
  }

  composition(scopeId: string): MakaRuntimeCompositionSnapshot {
    const scoped = this.#runtimeComposition(scopeId);
    if (scopeId === PROFILE_EXTENSION_SCOPE) return scoped;
    const profile = this.#runtimeComposition(PROFILE_EXTENSION_SCOPE);
    if (profile.entries.length === 0) return scoped;
    const entries = Object.freeze([...profile.entries, ...scoped.entries]);
    const digest = createHash('sha256').update(JSON.stringify(entries)).digest('hex');
    return Object.freeze({
      schemaVersion: 1,
      rootId: scopeId,
      digest: `sha256:${digest}`,
      entries,
    });
  }

  inspectRuntime() {
    return this.#composition.inspectTree();
  }

  inspectAll(): HostExtensionRuntimeInspection {
    const scopes = this.#scopeIds.size === 0 ? [PROFILE_EXTENSION_SCOPE] : [...this.#scopeIds];
    return Object.freeze({
      runtime: this.inspectRuntime(),
      scopes: Object.freeze(scopes.flatMap((scopeId) => this.inspectScope(scopeId))),
      tools: Object.freeze(scopes.flatMap((scopeId) => this.inspectTools(scopeId))),
      ui: Object.freeze(scopes.flatMap((scopeId) => this.inspectUi(scopeId))),
      uiReadiness: this.inspectUiReadiness(),
      timers: Object.freeze(scopes.flatMap((scopeId) => this.inspectTimers(scopeId))),
      events: Object.freeze(scopes.flatMap((scopeId) => this.inspectEvents(scopeId))),
      listeners: Object.freeze(scopes.flatMap((scopeId) => this.inspectEventListeners(scopeId))),
      services: Object.freeze(scopes.flatMap((scopeId) => this.inspectServices(scopeId))),
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
      : this.#tools.compose(this.#rootId(scopeId), profileTools);
  }

  registerHostTools(tools: readonly MakaTool[]): void {
    this.#assertMutable();
    if (this.#hostTools.length > 0)
      throw new Error('Runtime Host Extension Tools are already registered');
    this.#hostTools = Object.freeze(tools.map((tool) => Object.freeze({ ...tool })));
  }

  #resolvedScopeState(scopeId: string): {
    scopeIds: readonly string[];
    committed: readonly { readonly entryId: string; readonly revision: string }[];
  } {
    const scopeIds =
      scopeId === PROFILE_EXTENSION_SCOPE
        ? [this.#rootId(scopeId)]
        : [this.#rootId(PROFILE_EXTENSION_SCOPE), this.#rootId(scopeId)];
    const committed = scopeIds.flatMap((resolvedScopeId) =>
      this.inspectScope(resolvedScopeId).flatMap((entry) =>
        entry.current ? [{ entryId: entry.entryId, revision: entry.current.revision }] : [],
      ),
    );
    return { scopeIds, committed };
  }

  #package(
    input: {
      readonly extensionId: string;
      readonly revision: string;
      readonly dependencies?: readonly { readonly extensionId: string }[];
    },
    apply: (ctx: Context) => void | Promise<void>,
  ): MakaPluginPackage {
    const inject = Object.freeze(['tools', 'ui', 'hooks']);
    const host: Plugin = Object.freeze({
      name: input.extensionId,
      inject,
      apply: async (ctx: Context) => {
        await apply(ctx);
      },
    });
    return Object.freeze({
      packageId: input.extensionId,
      revision: input.revision,
      host,
    });
  }

  #activationContext(ctx: Context): MakaContributionContext {
    const identity = pluginIdentity(ctx);
    return Object.freeze({
      ...identity,
      signal: new AbortController().signal,
      runtimeContext: ctx,
      ownEffect: (label: string, dispose: () => void | Promise<void>) =>
        ownPluginEffect(ctx, label, dispose),
      dependency: <T>(packageId: string) =>
        this.inspectScope(this.#scopeId(identity.scopeId)).some(
          ({ packageId: activePackage, current }) => activePackage === packageId && current,
        ) as T,
      dependencyRevision: (packageId: string) =>
        this.inspectScope(this.#scopeId(identity.scopeId)).find(
          ({ packageId: activePackage }) => activePackage === packageId,
        )?.current?.revision ?? '',
    });
  }

  #rootId(scopeId: string): MakaPluginRootId {
    if (scopeId === PROFILE_EXTENSION_SCOPE || scopeId === 'desktop-ui') return scopeId;
    return scopeId.startsWith('session:') ? (scopeId as MakaPluginRootId) : `session:${scopeId}`;
  }

  #scopeId(rootId: string): string {
    return rootId.startsWith('session:') ? rootId.slice('session:'.length) : rootId;
  }

  #refreshScopeIds(): void {
    this.#scopeIds.clear();
    for (const entry of this.#composition.inspectTree())
      this.#scopeIds.add(this.#scopeId(entry.rootId));
  }

  #mountInspection(entry: MakaCompositionEntryInspection): MakaPluginMountInspection {
    const active = entry.status === 'active';
    return Object.freeze({
      entryId: entry.id,
      rootId: this.#scopeId(entry.rootId),
      packageId: entry.packageId!,
      revision: entry.revision!,
      enabled: entry.status !== 'disabled' && entry.status !== 'disposed',
      status: entry.status,
      ...(active && entry.generation !== undefined
        ? { current: Object.freeze({ revision: entry.revision!, generation: entry.generation }) }
        : {}),
      waitingFor: entry.waitingFor,
      pendingCleanupEffects: 0,
      ...(entry.diagnostic ? { diagnostic: Object.freeze({ message: entry.diagnostic }) } : {}),
    });
  }

  #runtimeComposition(scopeId: string): MakaRuntimeCompositionSnapshot {
    const entries = this.inspectScope(scopeId)
      .flatMap((entry) => {
        if (!entry.current) return [];
        const pkg = this.#composition.package(entry.packageId, entry.current.revision);
        return [
          Object.freeze({
            entryId: entry.entryId,
            packageId: entry.packageId,
            revision: entry.current.revision,
            generation: entry.current.generation,
            contributions: Object.freeze([...(pkg.contributions ?? [])]),
          }),
        ];
      })
      .sort(
        (left, right) =>
          left.packageId.localeCompare(right.packageId) ||
          left.entryId.localeCompare(right.entryId),
      );
    const digest = createHash('sha256').update(JSON.stringify(entries)).digest('hex');
    return Object.freeze({
      schemaVersion: 1,
      rootId: scopeId,
      digest: `sha256:${digest}`,
      entries: Object.freeze(entries),
    });
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
        for (const entry of [...this.#composition.inspectTree(this.#rootId(scopeId))].reverse()) {
          await this.#composition.remove(entry.id);
        }
        this.#scopeIds.delete(scopeId);
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length === 0) {
      for (const { extensionId, revision } of [...this.installedRevisions()].reverse()) {
        try {
          await this.#composition.uninstall(extensionId, revision);
        } catch (error) {
          errors.push(error);
        }
      }
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, 'Unable to close Runtime Host Extension authority');
    }
    await this.timerAuthority?.close?.();
    await this.#composition.close();
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

function flattenInspection(
  entry: MakaCompositionEntryInspection,
): readonly MakaCompositionEntryInspection[] {
  return [entry, ...entry.children.flatMap(flattenInspection)];
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
