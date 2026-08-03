import { createHash } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import {
  buildMcpTools,
  mcpProxyToolName,
  type MakaTool,
  type McpToolProvider,
  type ToolGroup,
} from '@maka/runtime';
import {
  type ClientCapabilityOffer,
  type ClientCapabilityReplaceInput,
  type ClientCapabilityServiceOffer,
  type ClientCapabilityToolDescriptor,
  type ClientCapabilityUnregisterInput,
} from '../protocol/index.js';
import {
  ClientCapabilityInvocationBroker,
  ClientCapabilityInvocationError,
  type ClientCapabilityInvocationFailure,
} from './client-capability-invocation-broker.js';
import type {
  ClientCapabilityOperationHandlerMap,
  ConnectionContext,
} from './operation-dispatcher.js';
import type { RuntimePolicyActivationGate } from './runtime-policy-activation-gate.js';
import type {
  ClientCapabilityConnection,
  ClientCapabilityConnectionSender,
  ClientCapabilityService,
} from './client-capability-service.js';

// Leave the Host deadline outside the provider's bounded action deadline so an
// accepted call can return its real terminal result instead of outcome_unknown.
const DEFAULT_CALL_TIMEOUT_MS = 150_000;

export { ClientCapabilityInvocationError };
export type { ClientCapabilityInvocationFailure };

export interface ClientCapabilitySnapshot {
  readonly registrationIds: readonly string[];
  readonly groups: readonly ToolGroup[];
  readonly tools: readonly MakaTool[];
  release(): void;
}

interface ClientProviderState {
  readonly connectionId: string;
  sender?: ClientCapabilityConnectionSender;
  current?: CapabilityRegistration;
  readonly registrations: Map<string, CapabilityRegistration>;
}

interface CapabilityRegistration {
  readonly connectionId: string;
  readonly registrationId: string;
  readonly offersByContract: ReadonlyMap<string, FrozenOfferBinding>;
  readonly servicesByContract: ReadonlyMap<string, ClientCapabilityServiceOffer>;
  current: boolean;
  snapshotRefs: number;
}

interface FrozenOfferBinding {
  readonly contractId: string;
  readonly offer: ClientCapabilityOffer;
  readonly toolsByIdentity: ReadonlyMap<string, FrozenToolBinding>;
}

interface FrozenToolBinding {
  readonly offerId: string;
  readonly descriptor: ClientCapabilityToolDescriptor;
}

type SessionCapabilityBinding =
  | { readonly kind: 'bound'; readonly connectionId: string }
  | { readonly kind: 'lost' };
type SessionBindingMode = 'strict' | 'degrade';

interface SessionCapabilityState {
  readonly initiatingConnectionId: string;
  readonly sessionBindings: ReadonlyMap<string, SessionCapabilityBinding>;
  readonly turnBindings: ReadonlyMap<string, SessionCapabilityBinding>;
}

type SessionBindingSelection =
  | {
      readonly ok: true;
      readonly state: SessionCapabilityState;
      readonly modelToolsChanged: boolean;
    }
  | { readonly ok: false; readonly message: string };

type SessionBindingResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly message: string };

export type SessionBindingPreview<T> =
  | {
      readonly ok: true;
      readonly value: T;
      commit(): Promise<SessionBindingResult>;
    }
  | { readonly ok: false; readonly message: string };

interface SelectedOfferBinding {
  readonly registration: CapabilityRegistration;
  readonly offer: FrozenOfferBinding;
}

interface SnapshotOfferBinding {
  readonly offer: FrozenOfferBinding;
  readonly registration?: CapabilityRegistration;
}

export interface HostClientCapabilityCoordinatorOptions {
  readonly activation: RuntimePolicyActivationGate;
  readonly onModelToolsChanged: () => void;
}

export interface ClientCapabilityServiceInvocationInput {
  readonly connectionId: string;
  readonly serviceId: string;
  readonly version: string;
  readonly method: string;
  readonly input: Record<string, unknown>;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

/**
 * Host-owned registry, selection authority, and reverse-call lifecycle for
 * open-world Client Capability providers.
 */
export class HostClientCapabilityCoordinator implements ClientCapabilityService {
  readonly handlers: ClientCapabilityOperationHandlerMap = {
    'client.capability.replace': (input, context) => this.#replace(input, context),
    'client.capability.unregister': (input, context) => this.#unregister(input, context),
  };

  readonly #activation: RuntimePolicyActivationGate;
  readonly #onModelToolsChanged: () => void;
  readonly #providers = new Map<string, ClientProviderState>();
  readonly #sessions = new Map<string, SessionCapabilityState>();
  readonly #previewSessions = new AsyncLocalStorage<ReadonlyMap<string, SessionCapabilityState>>();
  readonly #pendingConnectionReleases = new Set<Promise<void>>();
  readonly #invocations: ClientCapabilityInvocationBroker<CapabilityRegistration>;
  #revision = 0;
  #draining = false;

  constructor(options: HostClientCapabilityCoordinatorOptions) {
    this.#activation = options.activation;
    this.#onModelToolsChanged = options.onModelToolsChanged;
    this.#invocations = new ClientCapabilityInvocationBroker({
      senderFor: (connectionId) => this.#providers.get(connectionId)?.sender,
      onRegistrationIdle: (registration) => this.#releaseRegistrationIfUnused(registration),
    });
  }

  attachConnection(
    connectionId: string,
    sender: ClientCapabilityConnectionSender,
  ): ClientCapabilityConnection {
    if (this.#draining) throw new Error('Client Capability registry is draining');
    const provider = this.#provider(connectionId);
    if (provider.sender && provider.sender !== sender) {
      throw new Error('Client Capability connection already has a sender');
    }
    provider.sender = sender;
    let closeTask: Promise<void> | undefined;
    return {
      accept: (frame) => {
        if (closeTask) return;
        this.#invocations.accept(connectionId, frame);
      },
      close: () => {
        closeTask ??= this.releaseConnection(connectionId);
        return closeTask;
      },
    };
  }

  async bindSession(
    sessionId: string,
    initiatingConnectionId: string,
  ): Promise<{ readonly ok: true } | { readonly ok: false; readonly message: string }> {
    return this.#bindSession(sessionId, initiatingConnectionId, 'strict');
  }

  async bindConfirmedFollowup(sessionId: string, initiatingConnectionId: string): Promise<void> {
    const result = await this.#bindSession(sessionId, initiatingConnectionId, 'degrade');
    if (!result.ok) {
      throw new Error(`Confirmed follow-up capability binding failed: ${result.message}`);
    }
  }

  async #bindSession(
    sessionId: string,
    initiatingConnectionId: string,
    mode: SessionBindingMode,
  ): Promise<SessionBindingResult> {
    return this.#activation.runMutation(async () => {
      const selection = this.#selectSessionState(sessionId, initiatingConnectionId, mode);
      if (!selection.ok) return selection;
      this.#storeSessionState(sessionId, selection.state);
      if (selection.modelToolsChanged) this.#onModelToolsChanged();
      return { ok: true };
    });
  }

  async runWithSessionBindingPreview<T>(
    sessionId: string,
    initiatingConnectionId: string,
    operation: () => Promise<T>,
  ): Promise<SessionBindingPreview<T>> {
    return this.#activation.runReadActivation(async () => {
      const registryRevision = this.#revision;
      const selection = this.#selectSessionState(sessionId, initiatingConnectionId, 'strict');
      if (!selection.ok) return selection;
      const inherited = this.#previewSessions.getStore();
      const preview = new Map(inherited ?? []);
      preview.set(sessionId, selection.state);
      return {
        ok: true,
        value: await this.#previewSessions.run(preview, operation),
        commit: () =>
          this.#commitSessionBindingPreview(
            sessionId,
            initiatingConnectionId,
            registryRevision,
            selection.state,
          ),
      };
    });
  }

  #commitSessionBindingPreview(
    sessionId: string,
    initiatingConnectionId: string,
    registryRevision: number,
    previewState: SessionCapabilityState,
  ): Promise<SessionBindingResult> {
    return this.#activation.runMutation(async () => {
      if (this.#revision !== registryRevision) {
        return {
          ok: false,
          message: 'Client Capability registry changed after continuation safety preview',
        };
      }
      const selection = this.#selectSessionState(sessionId, initiatingConnectionId, 'strict');
      if (!selection.ok) return selection;
      if (!sessionCapabilityStatesEqual(selection.state, previewState)) {
        return {
          ok: false,
          message: 'Client Capability Session binding changed after continuation safety preview',
        };
      }
      this.#storeSessionState(sessionId, selection.state);
      if (selection.modelToolsChanged) this.#onModelToolsChanged();
      return { ok: true };
    });
  }

  #selectSessionState(
    sessionId: string,
    initiatingConnectionId: string,
    mode: SessionBindingMode,
  ): SessionBindingSelection {
    const previousState = this.#sessions.get(sessionId);
    const previous = previousState?.sessionBindings ?? new Map();
    const eligible = this.#eligibleOffersByContract();
    const next = new Map<string, SessionCapabilityBinding>();
    const selected: SelectedOfferBinding[] = [];
    const sessionContractIds = new Set([
      ...previous.keys(),
      ...[...eligible]
        .filter(([, candidates]) => candidates[0]?.offer.offer.affinity === 'session')
        .map(([contractId]) => contractId),
    ]);

    for (const contractId of [...sessionContractIds].sort()) {
      const previousBinding = previous.get(contractId);
      const candidates = eligible.get(contractId) ?? [];
      let candidate: SelectedOfferBinding | undefined;
      if (previousBinding?.kind === 'bound') {
        candidate = candidates.find(
          (entry) => entry.registration.connectionId === previousBinding.connectionId,
        );
        if (!candidate) {
          if (mode === 'degrade') {
            next.set(contractId, { kind: 'lost' });
            continue;
          }
          return {
            ok: false,
            message:
              'A Session-bound Client Capability provider is no longer available for its frozen contract',
          };
        }
      } else if (previousBinding?.kind === 'lost') {
        candidate =
          candidates.find((entry) => entry.registration.connectionId === initiatingConnectionId) ??
          (candidates.length === 1 ? candidates[0] : undefined);
        if (!candidate) {
          if (mode === 'degrade') {
            next.set(contractId, previousBinding);
            continue;
          }
          return {
            ok: false,
            message:
              'A lost Client Capability binding requires a compatible initiating Client to rebind',
          };
        }
      } else {
        candidate =
          candidates.find((entry) => entry.registration.connectionId === initiatingConnectionId) ??
          (candidates.length === 1 ? candidates[0] : undefined);
        if (!candidate && candidates.length > 1) {
          if (mode === 'degrade') continue;
          return {
            ok: false,
            message:
              'Multiple Client Capability providers offer the same contract and no initiating provider can be selected',
          };
        }
      }
      if (!candidate) continue;
      next.set(contractId, {
        kind: 'bound',
        connectionId: candidate.registration.connectionId,
      });
      selected.push(candidate);
    }

    const proxyNames = new Map<string, string>();
    for (const candidate of selected) {
      if (offerConflictsWithProxyNames(candidate.offer, proxyNames)) {
        if (mode === 'degrade') {
          if (previous.has(candidate.offer.contractId)) {
            next.set(candidate.offer.contractId, { kind: 'lost' });
          } else {
            next.delete(candidate.offer.contractId);
          }
          continue;
        }
        return {
          ok: false,
          message: 'Client Capability contracts expose conflicting model tool identities',
        };
      }
      rememberOfferProxyNames(candidate.offer, proxyNames);
    }

    const previousTurn = previousState?.turnBindings ?? new Map();
    const nextTurn = new Map<string, SessionCapabilityBinding>();
    for (const [contractId, candidates] of [...eligible].sort(([left], [right]) =>
      left.localeCompare(right),
    )) {
      if (candidates[0]?.offer.offer.affinity !== 'turn') continue;
      const candidate =
        candidates.find((entry) => entry.registration.connectionId === initiatingConnectionId) ??
        (candidates.length === 1 ? candidates[0] : undefined);
      if (!candidate || offerConflictsWithProxyNames(candidate.offer, proxyNames)) continue;
      nextTurn.set(contractId, {
        kind: 'bound',
        connectionId: candidate.registration.connectionId,
      });
      rememberOfferProxyNames(candidate.offer, proxyNames);
    }

    return {
      ok: true,
      state: {
        initiatingConnectionId,
        sessionBindings: next,
        turnBindings: nextTurn,
      },
      modelToolsChanged:
        !bindingMapsEqual(previous, next) ||
        !bindingMapsEqual(previousTurn, nextTurn) ||
        (previousState?.initiatingConnectionId !== initiatingConnectionId &&
          [...eligible.values()].some(
            (candidates) => candidates[0]?.offer.offer.affinity === 'call',
          )),
    };
  }

  snapshotForSession(sessionId: string): ClientCapabilitySnapshot | undefined {
    const state = this.#previewSessions.getStore()?.get(sessionId) ?? this.#sessions.get(sessionId);
    const bindings = state?.sessionBindings;
    const turnBindings = state?.turnBindings;
    const selected: SnapshotOfferBinding[] = [];
    const proxyNames = new Map<string, string>();
    for (const [contractId, binding] of [...(bindings ?? [])].sort(([left], [right]) =>
      left.localeCompare(right),
    )) {
      if (binding.kind === 'lost') continue;
      const provider = this.#providers.get(binding.connectionId);
      const registration = provider?.current;
      const offer = registration?.offersByContract.get(contractId);
      if (!provider?.sender || !registration || !offer) {
        throw new ClientCapabilityInvocationError(
          'capability_lost',
          'A Session-bound Client Capability provider is unavailable',
        );
      }
      selected.push({ registration, offer });
      rememberOfferProxyNames(offer, proxyNames);
    }
    for (const [contractId, binding] of [...(turnBindings ?? [])].sort(([left], [right]) =>
      left.localeCompare(right),
    )) {
      const provider =
        binding.kind === 'bound' ? this.#providers.get(binding.connectionId) : undefined;
      const registration = provider?.current;
      const offer = registration?.offersByContract.get(contractId);
      if (
        !provider?.sender ||
        !registration ||
        !offer ||
        offerConflictsWithProxyNames(offer, proxyNames)
      ) {
        continue;
      }
      selected.push({ registration, offer });
      rememberOfferProxyNames(offer, proxyNames);
    }
    const eligible = this.#eligibleOffersByContract();
    for (const [contractId, candidates] of [...eligible].sort(([left], [right]) =>
      left.localeCompare(right),
    )) {
      const offer = candidates[0]?.offer;
      if (
        !offer ||
        offer.offer.affinity !== 'call' ||
        offerConflictsWithProxyNames(offer, proxyNames)
      ) {
        continue;
      }
      selected.push({ offer });
      rememberOfferProxyNames(offer, proxyNames);
    }
    if (selected.length === 0) return;
    const proxyProvider = this.#snapshotProvider(state?.initiatingConnectionId, selected);
    const tools = buildMcpTools(proxyProvider, {
      callTimeoutMs: DEFAULT_CALL_TIMEOUT_MS,
      categoryHint: 'client_capability',
      recoveryMode: 'outcome_unknown',
    });
    const groups = selected.map(({ offer: binding }) => ({
      id: binding.contractId,
      toolNames: binding.offer.tools.map((tool) => mcpProxyToolName(tool.serverId, tool.name)),
      label: binding.offer.label,
      ...(binding.offer.description ? { description: binding.offer.description } : {}),
    }));
    const registrations = [
      ...new Set(selected.flatMap(({ registration }) => (registration ? [registration] : []))),
    ];
    for (const registration of registrations) registration.snapshotRefs += 1;
    let released = false;
    return Object.freeze({
      registrationIds: Object.freeze(
        registrations.map((registration) => registration.registrationId),
      ),
      groups: Object.freeze(groups),
      tools: Object.freeze(tools),
      release: () => {
        if (released) return;
        released = true;
        for (const registration of registrations) {
          if (registration.snapshotRefs === 0) {
            throw new Error('Client Capability snapshot residency underflow');
          }
          registration.snapshotRefs -= 1;
          this.#releaseRegistrationIfUnused(registration);
        }
      },
    });
  }

  async callService(
    input: ClientCapabilityServiceInvocationInput,
  ): Promise<Record<string, unknown>> {
    const provider = this.#providers.get(input.connectionId);
    const registration = provider?.current;
    const service = registration?.servicesByContract.get(
      serviceContract(input.serviceId, input.version),
    );
    if (!provider?.sender || !registration || !service) {
      throw new ClientCapabilityInvocationError(
        'capability_lost',
        'Client Capability service is unavailable on the initiating connection',
      );
    }
    const result = await this.#invocations.invokeService(
      registration,
      service.serviceId,
      service.version,
      input.method,
      input.input,
      input.signal,
      input.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS,
    );
    if (
      result.content.length !== 0 ||
      !result.structuredContent ||
      typeof result.structuredContent !== 'object' ||
      Array.isArray(result.structuredContent)
    ) {
      throw new ClientCapabilityInvocationError(
        'provider_failed',
        'Client Capability service returned an invalid payload',
      );
    }
    return result.structuredContent as Record<string, unknown>;
  }

  hasService(connectionId: string, serviceId: string, version: string): boolean {
    const provider = this.#providers.get(connectionId);
    return Boolean(
      provider?.sender &&
        provider.current?.servicesByContract.has(serviceContract(serviceId, version)),
    );
  }

  retireSessions(sessionIds: readonly string[]): void {
    for (const sessionId of new Set(sessionIds)) this.#sessions.delete(sessionId);
  }

  releaseConnection(connectionId: string): Promise<void> {
    this.#invocations.releaseConnection(connectionId);
    let task!: Promise<void>;
    task = this.#activation
      .runMutation(() => this.#releaseConnectionState(connectionId))
      .finally(() => this.#pendingConnectionReleases.delete(task));
    this.#pendingConnectionReleases.add(task);
    void task.catch(() => undefined);
    return task;
  }

  #releaseConnectionState(connectionId: string): void {
    const provider = this.#providers.get(connectionId);
    if (!provider) return;
    provider.sender = undefined;
    if (provider.current) {
      const registration = provider.current;
      registration.current = false;
      provider.current = undefined;
      this.#markBindingsLost(connectionId);
      this.#removeTurnBindings(connectionId);
      this.#revision += 1;
      if (hasModelToolOffers(registration)) this.#onModelToolsChanged();
    }
    for (const registration of [...provider.registrations.values()]) {
      this.#releaseRegistrationIfUnused(registration);
    }
    if (provider.registrations.size === 0) this.#providers.delete(connectionId);
    this.#pruneEmptySessions();
  }

  beginDrain(): void {
    this.#draining = true;
  }

  async close(): Promise<void> {
    this.beginDrain();
    for (const connectionId of [...this.#providers.keys()]) {
      this.releaseConnection(connectionId);
    }
    await Promise.allSettled([...this.#pendingConnectionReleases]);
    this.#invocations.close();
    this.#sessions.clear();
  }

  #replace(
    input: ClientCapabilityReplaceInput,
    context: ConnectionContext,
  ): ReturnType<ClientCapabilityOperationHandlerMap['client.capability.replace']> {
    return this.#activation.runMutation(async () => {
      if (this.#draining) {
        return {
          ok: false,
          error: {
            code: 'host_draining',
            message: 'Client Capability registry is draining',
          },
        };
      }
      const provider = this.#provider(context.connectionId);
      if (!provider.sender) {
        return {
          ok: false,
          error: {
            code: 'operation_unavailable',
            message: 'Client Capability reverse-call channel is unavailable',
          },
        };
      }
      if (provider.registrations.has(input.registrationId)) {
        return {
          ok: false,
          error: {
            code: 'invalid_request',
            message: 'Client Capability registration identity already exists',
          },
        };
      }
      let registration: CapabilityRegistration;
      try {
        registration = freezeRegistration(context.connectionId, input);
      } catch (error) {
        return {
          ok: false,
          error: {
            code: 'invalid_request',
            message: asError(error).message,
          },
        };
      }
      const previous = provider.current;
      if (previous) previous.current = false;
      provider.current = registration;
      if (previous) {
        const currentContracts = new Set(registration.offersByContract.keys());
        this.#retireBindings(
          context.connectionId,
          new Set(
            [...previous.offersByContract.keys()].filter(
              (contractId) => !currentContracts.has(contractId),
            ),
          ),
        );
        this.#removeTurnBindings(
          context.connectionId,
          new Set(
            [...previous.offersByContract.keys()].filter(
              (contractId) => !currentContracts.has(contractId),
            ),
          ),
        );
      }
      provider.registrations.set(registration.registrationId, registration);
      this.#revision += 1;
      if (hasModelToolOffers(previous) || hasModelToolOffers(registration)) {
        this.#onModelToolsChanged();
      }
      if (previous) this.#releaseRegistrationIfUnused(previous);
      this.#pruneEmptySessions();
      return {
        ok: true,
        result: {
          registrationId: registration.registrationId,
          revision: this.#revision,
        },
      };
    });
  }

  #unregister(
    input: ClientCapabilityUnregisterInput,
    context: ConnectionContext,
  ): ReturnType<ClientCapabilityOperationHandlerMap['client.capability.unregister']> {
    return this.#activation.runMutation(async () => {
      const provider = this.#providers.get(context.connectionId);
      if (!provider?.current || provider.current.registrationId !== input.registrationId) {
        return {
          ok: false,
          error: {
            code: 'invalid_request',
            message: 'Client Capability registration is not current',
          },
        };
      }
      const registration = provider.current;
      registration.current = false;
      provider.current = undefined;
      this.#retireBindings(context.connectionId, new Set(registration.offersByContract.keys()));
      this.#removeTurnBindings(context.connectionId, new Set(registration.offersByContract.keys()));
      this.#revision += 1;
      if (hasModelToolOffers(registration)) this.#onModelToolsChanged();
      this.#releaseRegistrationIfUnused(registration);
      this.#pruneEmptySessions();
      return {
        ok: true,
        result: {
          registrationId: registration.registrationId,
          revision: this.#revision,
        },
      };
    });
  }

  #snapshotProvider(
    initiatingConnectionId: string | undefined,
    selected: readonly SnapshotOfferBinding[],
  ): McpToolProvider {
    const tools = selected.flatMap(({ offer }) => offer.offer.tools);
    const bindings = new Map<
      string,
      {
        readonly contractId: string;
        readonly registration?: CapabilityRegistration;
        readonly tool: FrozenToolBinding;
      }
    >();
    for (const { registration, offer } of selected) {
      for (const [identity, tool] of offer.toolsByIdentity) {
        if (bindings.has(identity)) {
          throw new Error('Client Capability snapshot contains a duplicate tool identity');
        }
        bindings.set(identity, { contractId: offer.contractId, registration, tool });
      }
    }
    return {
      tools: () => tools,
      callTool: (serverId, toolName, args, options) => {
        const selectedBinding = bindings.get(toolIdentity(serverId, toolName));
        if (!selectedBinding) {
          return Promise.reject(
            new ClientCapabilityInvocationError(
              'capability_lost',
              'Client Capability tool is not part of the frozen offer',
            ),
          );
        }
        if (!options?.context) {
          return Promise.reject(new Error('Client Capability invocation context is missing'));
        }
        const dynamicBinding = selectedBinding.registration
          ? {
              registration: selectedBinding.registration,
              tool: selectedBinding.tool,
            }
          : this.#selectCallBinding(
              selectedBinding.contractId,
              initiatingConnectionId,
              toolIdentity(serverId, toolName),
            );
        return this.#invocations.invoke(
          dynamicBinding.registration,
          dynamicBinding.tool,
          args,
          options.context,
          options.signal,
          options.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS,
        );
      },
    };
  }

  #provider(connectionId: string): ClientProviderState {
    let provider = this.#providers.get(connectionId);
    if (!provider) {
      provider = {
        connectionId,
        registrations: new Map(),
      };
      this.#providers.set(connectionId, provider);
    }
    return provider;
  }

  #eligibleOffersByContract(): Map<string, SelectedOfferBinding[]> {
    const eligible = new Map<string, SelectedOfferBinding[]>();
    for (const provider of this.#providers.values()) {
      const registration = provider.current;
      if (!provider.sender || !registration) continue;
      for (const offer of registration.offersByContract.values()) {
        const candidates = eligible.get(offer.contractId) ?? [];
        candidates.push({ registration, offer });
        eligible.set(offer.contractId, candidates);
      }
    }
    for (const candidates of eligible.values()) {
      candidates.sort((left, right) =>
        `${left.registration.connectionId}\0${left.registration.registrationId}`.localeCompare(
          `${right.registration.connectionId}\0${right.registration.registrationId}`,
        ),
      );
    }
    return eligible;
  }

  #selectCallBinding(
    contractId: string,
    initiatingConnectionId: string | undefined,
    identity: string,
  ): { readonly registration: CapabilityRegistration; readonly tool: FrozenToolBinding } {
    const candidates = this.#eligibleOffersByContract().get(contractId) ?? [];
    const candidate =
      candidates.find((entry) => entry.registration.connectionId === initiatingConnectionId) ??
      (candidates.length === 1 ? candidates[0] : undefined);
    if (!candidate) {
      throw new ClientCapabilityInvocationError(
        candidates.length > 1 ? 'capability_ambiguous' : 'capability_lost',
        candidates.length > 1
          ? 'Multiple Client Capability providers offer this call-affine contract'
          : 'Client Capability provider is unavailable',
      );
    }
    const tool = candidate.offer.toolsByIdentity.get(identity);
    if (!tool) {
      throw new ClientCapabilityInvocationError(
        'capability_lost',
        'Client Capability tool is not part of the selected contract',
      );
    }
    return { registration: candidate.registration, tool };
  }

  #markBindingsLost(connectionId: string, contracts?: ReadonlySet<string>): void {
    for (const [sessionId, state] of this.#sessions) {
      const bindings = state.sessionBindings;
      let next: Map<string, SessionCapabilityBinding> | undefined;
      for (const [contractId, binding] of bindings) {
        if (
          binding.kind !== 'bound' ||
          binding.connectionId !== connectionId ||
          (contracts && !contracts.has(contractId))
        ) {
          continue;
        }
        next ??= new Map(bindings);
        next.set(contractId, { kind: 'lost' });
      }
      if (next) this.#storeSessionState(sessionId, { ...state, sessionBindings: next });
    }
  }

  #retireBindings(connectionId: string, contracts: ReadonlySet<string>): void {
    for (const [sessionId, state] of this.#sessions) {
      const bindings = state.sessionBindings;
      const next = new Map(bindings);
      for (const [contractId, binding] of bindings) {
        if (
          binding.kind === 'bound' &&
          binding.connectionId === connectionId &&
          contracts.has(contractId)
        ) {
          next.delete(contractId);
        }
      }
      if (next.size === bindings.size) continue;
      this.#storeSessionState(sessionId, { ...state, sessionBindings: next });
    }
  }

  #removeTurnBindings(connectionId: string, contracts?: ReadonlySet<string>): void {
    for (const [sessionId, state] of this.#sessions) {
      const bindings = state.turnBindings;
      const next = new Map(bindings);
      for (const [contractId, binding] of bindings) {
        if (
          binding.kind === 'bound' &&
          binding.connectionId === connectionId &&
          (!contracts || contracts.has(contractId))
        ) {
          next.delete(contractId);
        }
      }
      if (next.size === bindings.size) continue;
      this.#storeSessionState(sessionId, { ...state, turnBindings: next });
    }
  }

  #storeSessionState(sessionId: string, state: SessionCapabilityState): void {
    if (
      state.sessionBindings.size === 0 &&
      state.turnBindings.size === 0 &&
      !this.#hasCallOffers()
    ) {
      this.#sessions.delete(sessionId);
      return;
    }
    this.#sessions.set(sessionId, state);
  }

  #pruneEmptySessions(): void {
    if (this.#hasCallOffers()) return;
    for (const [sessionId, state] of this.#sessions) {
      if (state.sessionBindings.size === 0 && state.turnBindings.size === 0) {
        this.#sessions.delete(sessionId);
      }
    }
  }

  #hasCallOffers(): boolean {
    return [...this.#eligibleOffersByContract().values()].some(
      (candidates) => candidates[0]?.offer.offer.affinity === 'call',
    );
  }

  #releaseRegistrationIfUnused(registration: CapabilityRegistration): void {
    if (
      registration.current ||
      registration.snapshotRefs !== 0 ||
      this.#invocations.holdsRegistration(registration)
    ) {
      return;
    }
    const provider = this.#providers.get(registration.connectionId);
    if (!provider?.registrations.delete(registration.registrationId)) return;
    void provider.sender
      ?.send({
        kind: 'client.capability.registration_release',
        registrationId: registration.registrationId,
      })
      .catch(() => {});
    if (!provider.current && !provider.sender && provider.registrations.size === 0) {
      this.#providers.delete(provider.connectionId);
    }
  }
}

function freezeRegistration(
  connectionId: string,
  input: ClientCapabilityReplaceInput,
): CapabilityRegistration {
  const offers = input.offers.map((offer) =>
    Object.freeze({
      ...offer,
      tools: Object.freeze(
        offer.tools.map((tool) =>
          Object.freeze({
            ...tool,
            inputSchema: structuredClone(tool.inputSchema),
            ...(tool.annotations ? { annotations: Object.freeze({ ...tool.annotations }) } : {}),
          }),
        ),
      ),
    }),
  );
  const offersByContract = new Map<string, FrozenOfferBinding>();
  const servicesByContract = new Map<string, ClientCapabilityServiceOffer>();
  const proxyNames = new Map<string, string>();
  for (const offer of offers) {
    const toolsByIdentity = new Map<string, FrozenToolBinding>();
    for (const descriptor of offer.tools) {
      const identity = toolIdentity(descriptor.serverId, descriptor.name);
      const proxyName = mcpProxyToolName(descriptor.serverId, descriptor.name);
      const collision = proxyNames.get(proxyName);
      if (collision && collision !== identity) {
        throw new Error(`Client Capability proxy tool name collision: ${proxyName}`);
      }
      proxyNames.set(proxyName, identity);
      toolsByIdentity.set(identity, {
        offerId: offer.offerId,
        descriptor,
      });
    }
    const contractId = capabilityGroupId(offer);
    if (offersByContract.has(contractId)) {
      throw new Error('Client Capability registration contains a duplicate contract');
    }
    offersByContract.set(contractId, {
      contractId,
      offer,
      toolsByIdentity,
    });
  }
  for (const service of input.services ?? []) {
    servicesByContract.set(
      serviceContract(service.serviceId, service.version),
      Object.freeze({ ...service }),
    );
  }
  return {
    connectionId,
    registrationId: input.registrationId,
    offersByContract,
    servicesByContract,
    current: true,
    snapshotRefs: 0,
  };
}

function serviceContract(serviceId: string, version: string): string {
  return `${serviceId}\0${version}`;
}

function hasModelToolOffers(registration: CapabilityRegistration | undefined): boolean {
  return (registration?.offersByContract.size ?? 0) > 0;
}

function toolIdentity(serverId: string, toolName: string): string {
  return `${serverId}\0${toolName}`;
}

function capabilityGroupId(offer: ClientCapabilityOffer): string {
  const tools = [...offer.tools].sort((left, right) =>
    toolIdentity(left.serverId, left.name).localeCompare(toolIdentity(right.serverId, right.name)),
  );
  const hash = createHash('sha256')
    .update(
      canonicalJson({
        offerId: offer.offerId,
        version: offer.version,
        affinity: offer.affinity,
        tools,
      }),
    )
    .digest('hex')
    .slice(0, 16);
  const label = offer.offerId.replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 96);
  return `client_${hash}_${label}`;
}

function offerConflictsWithProxyNames(
  offer: FrozenOfferBinding,
  proxyNames: ReadonlyMap<string, string>,
): boolean {
  return offer.offer.tools.some((descriptor) => {
    const proxyName = mcpProxyToolName(descriptor.serverId, descriptor.name);
    const existingContract = proxyNames.get(proxyName);
    return existingContract !== undefined && existingContract !== offer.contractId;
  });
}

function rememberOfferProxyNames(offer: FrozenOfferBinding, proxyNames: Map<string, string>): void {
  for (const descriptor of offer.offer.tools) {
    proxyNames.set(mcpProxyToolName(descriptor.serverId, descriptor.name), offer.contractId);
  }
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') {
    return JSON.stringify(value);
  }
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(',')}}`;
  }
  throw new Error('Client Capability contract is not canonical JSON');
}

function bindingMapsEqual(
  left: ReadonlyMap<string, SessionCapabilityBinding>,
  right: ReadonlyMap<string, SessionCapabilityBinding>,
): boolean {
  if (left.size !== right.size) return false;
  for (const [contractId, binding] of left) {
    const candidate = right.get(contractId);
    if (
      !candidate ||
      candidate.kind !== binding.kind ||
      (binding.kind === 'bound' &&
        (candidate.kind !== 'bound' || candidate.connectionId !== binding.connectionId))
    ) {
      return false;
    }
  }
  return true;
}

function sessionCapabilityStatesEqual(
  left: SessionCapabilityState,
  right: SessionCapabilityState,
): boolean {
  return (
    left.initiatingConnectionId === right.initiatingConnectionId &&
    bindingMapsEqual(left.sessionBindings, right.sessionBindings) &&
    bindingMapsEqual(left.turnBindings, right.turnBindings)
  );
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
