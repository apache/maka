/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import { createHash } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { buildMcpTools, mcpProxyToolName, type McpToolProvider } from '@maka/runtime/mcp-tools';
import { type MakaTool } from '@maka/runtime/tool-runtime';
import { type ToolGroup } from '@maka/runtime/tool-availability';
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
  ClientCapabilityConnectionIdentity,
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
  readonly providerId: string;
  readonly principalId: string;
  readonly clientInstanceId: string;
  readonly trustedProvider: boolean;
  activeConnectionId?: string;
  current?: CapabilityRegistration;
  readonly registrations: Map<string, CapabilityRegistration>;
}

interface ClientProviderConnection {
  readonly connectionId: string;
  readonly provider: ClientProviderState;
  readonly sender: ClientCapabilityConnectionSender;
  superseded: boolean;
}

interface CapabilityRegistration {
  readonly providerId: string;
  readonly connectionId: string;
  readonly registrationId: string;
  readonly trustedProvider: boolean;
  readonly offersByContract: ReadonlyMap<string, FrozenOfferBinding>;
  readonly servicesByContract: ReadonlyMap<string, ClientCapabilityServiceOffer>;
  snapshotRefs: number;
}

interface FrozenOfferBinding {
  readonly contractId: string;
  readonly offer: ClientCapabilityOffer;
  readonly toolsByIdentity: ReadonlyMap<string, FrozenToolBinding>;
}

interface FrozenToolBinding {
  readonly offerId: string;
  readonly hostPathAccess: ClientCapabilityOffer['hostPathAccess'];
  readonly descriptor: ClientCapabilityToolDescriptor;
}

type SessionCapabilityBinding =
  | { readonly kind: 'bound'; readonly providerId: string }
  | { readonly kind: 'lost'; readonly providerId: string };
type SessionBindingMode = 'strict' | 'degrade';

interface SessionCapabilityState {
  readonly initiatingProviderId?: string;
  readonly serviceProviderId?: string;
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

type ClientCapabilityBoundTool = ReturnType<McpToolProvider['toolSnapshot']>['tools'][number];
type ClientCapabilityToolBinding = ClientCapabilityBoundTool['binding'];

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

export interface SessionClientCapabilityServiceInvocationInput
  extends Omit<ClientCapabilityServiceInvocationInput, 'connectionId'> {
  readonly sessionId: string;
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
  readonly #connections = new Map<string, ClientProviderConnection>();
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
      senderFor: (connectionId) => {
        const connection = this.#connections.get(connectionId);
        return connection && this.#activeConnection(connection.provider) === connection
          ? connection.sender
          : undefined;
      },
      onRegistrationIdle: (registration) => this.#releaseRegistrationIfUnused(registration),
    });
  }

  attachConnection(
    identity: ClientCapabilityConnectionIdentity,
    sender: ClientCapabilityConnectionSender,
  ): ClientCapabilityConnection {
    if (this.#draining) throw new Error('Client Capability registry is draining');
    if (this.#connections.has(identity.connectionId)) {
      throw new Error('Client Capability connection identity already exists');
    }
    const provider = this.#provider(identity);
    this.#connections.set(identity.connectionId, {
      connectionId: identity.connectionId,
      provider,
      sender,
      superseded: false,
    });
    let closeTask: Promise<void> | undefined;
    return {
      accept: (frame) => {
        if (closeTask) return;
        this.#invocations.accept(identity.connectionId, frame);
      },
      close: () => {
        closeTask ??= this.releaseConnection(identity.connectionId);
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
    const initiatingProviderId = this.#connections.get(initiatingConnectionId)?.provider.providerId;
    const initiatingProvider = initiatingProviderId
      ? this.#providers.get(initiatingProviderId)
      : undefined;
    const previousState = this.#sessions.get(sessionId);
    const serviceProviderId =
      previousState?.serviceProviderId ??
      (initiatingProvider?.current && initiatingProvider.current.servicesByContract.size > 0
        ? initiatingProviderId
        : undefined);
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
          (entry) => entry.registration.providerId === previousBinding.providerId,
        );
        if (!candidate) {
          if (mode === 'degrade') {
            next.set(contractId, { kind: 'lost', providerId: previousBinding.providerId });
            continue;
          }
          return {
            ok: false,
            message:
              'A Session-bound Client Capability provider is no longer available for its frozen contract',
          };
        }
      } else if (previousBinding?.kind === 'lost') {
        candidate = candidates.find(
          (entry) => entry.registration.providerId === previousBinding.providerId,
        );
        if (!candidate) {
          if (mode === 'degrade') {
            next.set(contractId, previousBinding);
            continue;
          }
          return {
            ok: false,
            message: 'A Session-bound Client Capability provider has not reconnected',
          };
        }
      } else {
        candidate =
          candidates.find((entry) => entry.registration.providerId === initiatingProviderId) ??
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
        providerId: candidate.registration.providerId,
      });
      selected.push(candidate);
    }

    const proxyNames = new Map<string, string>();
    for (const candidate of selected) {
      if (offerConflictsWithProxyNames(candidate.offer, proxyNames)) {
        if (mode === 'degrade') {
          if (previous.has(candidate.offer.contractId)) {
            next.set(candidate.offer.contractId, {
              kind: 'lost',
              providerId: candidate.registration.providerId,
            });
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
        candidates.find((entry) => entry.registration.providerId === initiatingProviderId) ??
        (candidates.length === 1 ? candidates[0] : undefined);
      if (!candidate || offerConflictsWithProxyNames(candidate.offer, proxyNames)) continue;
      nextTurn.set(contractId, {
        kind: 'bound',
        providerId: candidate.registration.providerId,
      });
      rememberOfferProxyNames(candidate.offer, proxyNames);
    }

    return {
      ok: true,
      state: {
        ...(initiatingProviderId ? { initiatingProviderId } : {}),
        ...(serviceProviderId ? { serviceProviderId } : {}),
        sessionBindings: next,
        turnBindings: nextTurn,
      },
      modelToolsChanged:
        !bindingMapsEqual(previous, next) ||
        !bindingMapsEqual(previousTurn, nextTurn) ||
        (previousState?.initiatingProviderId !== initiatingProviderId &&
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
      const provider = this.#providers.get(binding.providerId);
      const registration = provider?.current;
      const offer = registration?.offersByContract.get(contractId);
      if (!provider || !this.#activeConnection(provider) || !registration || !offer) {
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
        binding.kind === 'bound' ? this.#providers.get(binding.providerId) : undefined;
      const registration = provider?.current;
      const offer = registration?.offersByContract.get(contractId);
      if (
        !provider ||
        !this.#activeConnection(provider) ||
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
    const trusted = selected.filter((binding) => binding.registration?.trustedProvider === true);
    const interactive = selected.filter(
      (binding) => binding.registration?.trustedProvider !== true,
    );
    assertUniqueSnapshotToolIdentities(selected);
    const tools = [
      ...buildMcpTools(this.#snapshotProvider(state?.initiatingProviderId, interactive), {
        callTimeoutMs: DEFAULT_CALL_TIMEOUT_MS,
        categoryHint: 'client_capability',
        recoveryMode: 'outcome_unknown',
      }),
      ...buildMcpTools(this.#snapshotProvider(state?.initiatingProviderId, trusted), {
        callTimeoutMs: DEFAULT_CALL_TIMEOUT_MS,
        categoryHint: 'custom_tool',
        recoveryMode: 'outcome_unknown',
        executionLocation: 'remote',
      }),
    ];
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
    const connection = this.#connections.get(input.connectionId);
    const provider = connection?.provider;
    const registration = provider?.current;
    const service = registration?.servicesByContract.get(
      serviceContract(input.serviceId, input.version),
    );
    if (
      !connection ||
      !provider ||
      this.#activeConnection(provider) !== connection ||
      !registration ||
      !service
    ) {
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

  async callServiceForSession(
    input: SessionClientCapabilityServiceInvocationInput,
  ): Promise<Record<string, unknown>> {
    const state =
      this.#previewSessions.getStore()?.get(input.sessionId) ?? this.#sessions.get(input.sessionId);
    const preferred = state?.serviceProviderId;
    const candidates = [...this.#providers.values()].filter((provider) => {
      const connection = this.#activeConnection(provider);
      return Boolean(
        connection &&
          provider.current?.servicesByContract.has(serviceContract(input.serviceId, input.version)),
      );
    });
    const provider = preferred
      ? candidates.find((candidate) => candidate.providerId === preferred)
      : candidates.length === 1
        ? candidates[0]
        : undefined;
    const connection = provider ? this.#activeConnection(provider) : undefined;
    if (!connection) {
      throw new ClientCapabilityInvocationError(
        !preferred && candidates.length > 1 ? 'capability_ambiguous' : 'capability_lost',
        !preferred && candidates.length > 1
          ? 'Multiple Client Capability providers offer this service'
          : 'The initiating Client Capability service is unavailable for this Session',
      );
    }
    return this.callService({
      connectionId: connection.connectionId,
      serviceId: input.serviceId,
      version: input.version,
      method: input.method,
      input: input.input,
      ...(input.signal ? { signal: input.signal } : {}),
      ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
    });
  }

  async callWorkspaceService(
    input: Omit<ClientCapabilityServiceInvocationInput, 'connectionId'>,
  ): Promise<Record<string, unknown>> {
    const candidates = [...this.#providers.values()]
      .filter((provider) => {
        const connection = this.#activeConnection(provider);
        return Boolean(
          connection &&
            provider.current?.servicesByContract.has(
              serviceContract(input.serviceId, input.version),
            ),
        );
      })
      .sort((left, right) => left.providerId.localeCompare(right.providerId));
    const provider = candidates[0];
    const connection = provider ? this.#activeConnection(provider) : undefined;
    if (!connection) {
      throw new ClientCapabilityInvocationError(
        'capability_lost',
        'No Client Capability provider offers this workspace service',
      );
    }
    return this.callService({
      connectionId: connection.connectionId,
      serviceId: input.serviceId,
      version: input.version,
      method: input.method,
      input: input.input,
      ...(input.signal ? { signal: input.signal } : {}),
      ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
    });
  }

  hasWorkspaceService(serviceId: string, version: string): boolean {
    return [...this.#providers.values()].some((provider) => {
      const connection = this.#activeConnection(provider);
      return Boolean(
        connection && provider.current?.servicesByContract.has(serviceContract(serviceId, version)),
      );
    });
  }

  hasService(connectionId: string, serviceId: string, version: string): boolean {
    const connection = this.#connections.get(connectionId);
    const provider = connection?.provider;
    return Boolean(
      connection &&
        provider &&
        this.#activeConnection(provider) === connection &&
        provider.current?.servicesByContract.has(serviceContract(serviceId, version)),
    );
  }

  retireSessions(sessionIds: readonly string[]): void {
    for (const sessionId of new Set(sessionIds)) this.#sessions.delete(sessionId);
    for (const provider of this.#providers.values()) this.#deleteProviderIfUnused(provider);
  }

  releaseConnection(connectionId: string): Promise<void> {
    this.#invocations.releaseConnection(connectionId);
    const connection = this.#connections.get(connectionId);
    if (!connection) return Promise.resolve();
    let task!: Promise<void>;
    task = this.#activation
      .runMutation(() => this.#releaseConnectionState(connection))
      .finally(() => this.#pendingConnectionReleases.delete(task));
    this.#pendingConnectionReleases.add(task);
    void task.catch(() => undefined);
    return task;
  }

  #releaseConnectionState(connection: ClientProviderConnection): void {
    if (this.#connections.get(connection.connectionId) !== connection) return;
    const { provider } = connection;
    this.#connections.delete(connection.connectionId);
    if (provider.activeConnectionId !== connection.connectionId) {
      this.#deleteProviderIfUnused(provider);
      return;
    }
    provider.activeConnectionId = undefined;
    if (provider.current) {
      const registration = provider.current;
      provider.current = undefined;
      this.#markBindingsLost(provider.providerId);
      this.#removeTurnBindings(provider.providerId);
      this.#revision += 1;
      if (hasModelToolOffers(registration)) this.#onModelToolsChanged();
    }
    for (const registration of [...provider.registrations.values()]) {
      this.#releaseRegistrationIfUnused(registration);
    }
    this.#deleteProviderIfUnused(provider);
    this.#pruneEmptySessions();
  }

  beginDrain(): void {
    this.#draining = true;
  }

  async close(): Promise<void> {
    this.beginDrain();
    for (const connectionId of [...this.#connections.keys()]) {
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
      const connection = this.#connections.get(context.connectionId);
      if (!connection) {
        return {
          ok: false,
          error: {
            code: 'operation_unavailable',
            message: 'Client Capability reverse-call channel is unavailable',
          },
        };
      }
      const { provider } = connection;
      if (connection.superseded) {
        return {
          ok: false,
          error: {
            code: 'invalid_request',
            message: 'Client Capability connection has been superseded',
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
        if (
          provider.trustedProvider &&
          (input.services?.length ||
            input.offers.some(
              (offer) => offer.affinity !== 'session' || offer.hostPathAccess !== 'none',
            ))
        ) {
          throw new Error(
            'A trusted capability provider may publish only path-independent session capabilities',
          );
        }
        registration = freezeRegistration(
          provider.providerId,
          context.connectionId,
          input,
          provider.trustedProvider,
        );
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
      const previousConnectionId = provider.activeConnectionId;
      if (previousConnectionId && previousConnectionId !== context.connectionId) {
        const previousConnection = this.#connections.get(previousConnectionId);
        if (previousConnection) previousConnection.superseded = true;
        this.#invocations.releaseConnection(previousConnectionId);
      }
      provider.activeConnectionId = context.connectionId;
      provider.current = registration;
      const currentContracts = new Set(registration.offersByContract.keys());
      if (previous) {
        this.#retireBindings(
          provider.providerId,
          new Set(
            [...previous.offersByContract.keys()].filter(
              (contractId) => !currentContracts.has(contractId),
            ),
          ),
        );
        this.#removeTurnBindings(
          provider.providerId,
          new Set(
            [...previous.offersByContract.keys()].filter(
              (contractId) => !currentContracts.has(contractId),
            ),
          ),
        );
      }
      this.#restoreBindings(provider.providerId, currentContracts);
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
      const provider = this.#connections.get(context.connectionId)?.provider;
      if (
        provider?.activeConnectionId !== context.connectionId ||
        !provider.current ||
        provider.current.registrationId !== input.registrationId
      ) {
        return {
          ok: false,
          error: {
            code: 'invalid_request',
            message: 'Client Capability registration is not current',
          },
        };
      }
      const registration = provider.current;
      provider.current = undefined;
      this.#retireBindings(provider.providerId, new Set(registration.offersByContract.keys()));
      this.#removeTurnBindings(provider.providerId, new Set(registration.offersByContract.keys()));
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
    initiatingProviderId: string | undefined,
    selected: readonly SnapshotOfferBinding[],
  ): McpToolProvider {
    const boundTools: ClientCapabilityBoundTool[] = [];
    const bindings = new Map<
      ClientCapabilityToolBinding,
      {
        readonly contractId: string;
        readonly registration?: CapabilityRegistration;
        readonly tool: FrozenToolBinding;
      }
    >();
    for (const { registration, offer } of selected) {
      for (const tool of offer.toolsByIdentity.values()) {
        const binding = clientCapabilityToolBinding(offer.contractId, registration, tool);
        if (bindings.has(binding)) {
          throw new Error('Client Capability snapshot contains a duplicate tool binding');
        }
        bindings.set(binding, {
          contractId: offer.contractId,
          registration,
          tool,
        });
        boundTools.push(deepFreeze({ descriptor: structuredClone(tool.descriptor), binding }));
      }
    }
    const snapshot = Object.freeze({
      revision: this.#revision,
      tools: Object.freeze(boundTools),
    });
    return {
      toolSnapshot: () => snapshot,
      callTool: (binding, args, options) => {
        const selectedBinding = bindings.get(binding);
        if (!selectedBinding) {
          return Promise.reject(
            new ClientCapabilityInvocationError(
              'capability_lost',
              'Client Capability tool is not part of the frozen offer',
            ),
          );
        }
        const { serverId, name: toolName } = selectedBinding.tool.descriptor;
        const dynamicBinding = selectedBinding.registration
          ? {
              registration: selectedBinding.registration,
              tool: selectedBinding.tool,
            }
          : this.#selectCallBinding(
              selectedBinding.contractId,
              initiatingProviderId,
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

  #provider(identity: ClientCapabilityConnectionIdentity): ClientProviderState {
    const providerId = clientProviderId(identity.principalId, identity.clientInstanceId);
    const trustedProvider = identity.principalKind === 'capability_provider';
    let provider = this.#providers.get(providerId);
    if (!provider) {
      provider = {
        providerId,
        principalId: identity.principalId,
        clientInstanceId: identity.clientInstanceId,
        trustedProvider,
        registrations: new Map(),
      };
      this.#providers.set(providerId, provider);
    } else if (provider.trustedProvider !== trustedProvider) {
      throw new Error('Client Capability provider authority changed across connections');
    }
    return provider;
  }

  #eligibleOffersByContract(): Map<string, SelectedOfferBinding[]> {
    const eligible = new Map<string, SelectedOfferBinding[]>();
    for (const provider of this.#providers.values()) {
      const registration = provider.current;
      if (!this.#activeConnection(provider) || !registration) continue;
      for (const offer of registration.offersByContract.values()) {
        const candidates = eligible.get(offer.contractId) ?? [];
        candidates.push({ registration, offer });
        eligible.set(offer.contractId, candidates);
      }
    }
    for (const candidates of eligible.values()) {
      candidates.sort((left, right) =>
        `${left.registration.providerId}\0${left.registration.registrationId}`.localeCompare(
          `${right.registration.providerId}\0${right.registration.registrationId}`,
        ),
      );
    }
    return eligible;
  }

  #selectCallBinding(
    contractId: string,
    initiatingProviderId: string | undefined,
    identity: string,
  ): {
    readonly registration: CapabilityRegistration;
    readonly tool: FrozenToolBinding;
  } {
    const candidates = this.#eligibleOffersByContract().get(contractId) ?? [];
    const candidate =
      candidates.find((entry) => entry.registration.providerId === initiatingProviderId) ??
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

  #markBindingsLost(providerId: string, contracts?: ReadonlySet<string>): void {
    for (const [sessionId, state] of this.#sessions) {
      const bindings = state.sessionBindings;
      let next: Map<string, SessionCapabilityBinding> | undefined;
      for (const [contractId, binding] of bindings) {
        if (
          binding.kind !== 'bound' ||
          binding.providerId !== providerId ||
          (contracts && !contracts.has(contractId))
        ) {
          continue;
        }
        next ??= new Map(bindings);
        next.set(contractId, { kind: 'lost', providerId });
      }
      if (next) this.#storeSessionState(sessionId, { ...state, sessionBindings: next });
    }
  }

  #restoreBindings(providerId: string, contracts: ReadonlySet<string>): void {
    for (const [sessionId, state] of this.#sessions) {
      const next = new Map(state.sessionBindings);
      for (const [contractId, binding] of state.sessionBindings) {
        if (
          binding.kind === 'lost' &&
          binding.providerId === providerId &&
          contracts.has(contractId)
        ) {
          next.set(contractId, { kind: 'bound', providerId });
        }
      }
      if (bindingMapsEqual(state.sessionBindings, next)) continue;
      this.#storeSessionState(sessionId, { ...state, sessionBindings: next });
    }
  }

  #retireBindings(providerId: string, contracts: ReadonlySet<string>): void {
    for (const [sessionId, state] of this.#sessions) {
      const bindings = state.sessionBindings;
      const next = new Map(bindings);
      for (const [contractId, binding] of bindings) {
        if (
          binding.kind === 'bound' &&
          binding.providerId === providerId &&
          contracts.has(contractId)
        ) {
          next.delete(contractId);
        }
      }
      if (next.size === bindings.size) continue;
      this.#storeSessionState(sessionId, { ...state, sessionBindings: next });
    }
  }

  #removeTurnBindings(providerId: string, contracts?: ReadonlySet<string>): void {
    for (const [sessionId, state] of this.#sessions) {
      const bindings = state.turnBindings;
      const next = new Map(bindings);
      for (const [contractId, binding] of bindings) {
        if (
          binding.kind === 'bound' &&
          binding.providerId === providerId &&
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
      !state.serviceProviderId &&
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
      if (
        state.sessionBindings.size === 0 &&
        state.turnBindings.size === 0 &&
        !state.serviceProviderId
      ) {
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
    const provider = this.#providers.get(registration.providerId);
    if (
      provider?.current === registration ||
      registration.snapshotRefs !== 0 ||
      this.#invocations.holdsRegistration(registration)
    ) {
      return;
    }
    if (!provider?.registrations.delete(registration.registrationId)) return;
    void this.#connections
      .get(registration.connectionId)
      ?.sender?.send({
        kind: 'client.capability.registration_release',
        registrationId: registration.registrationId,
      })
      .catch(() => {});
    this.#deleteProviderIfUnused(provider);
  }

  #activeConnection(provider: ClientProviderState): ClientProviderConnection | undefined {
    const connection = provider.activeConnectionId
      ? this.#connections.get(provider.activeConnectionId)
      : undefined;
    return connection?.provider === provider && !connection.superseded ? connection : undefined;
  }

  #deleteProviderIfUnused(provider: ClientProviderState): void {
    if (
      provider.current ||
      provider.activeConnectionId ||
      provider.registrations.size > 0 ||
      [...this.#connections.values()].some((connection) => connection.provider === provider) ||
      this.#providerHasBindings(provider.providerId)
    ) {
      return;
    }
    this.#providers.delete(provider.providerId);
  }

  #providerHasBindings(providerId: string): boolean {
    for (const state of this.#sessions.values()) {
      for (const binding of [...state.sessionBindings.values(), ...state.turnBindings.values()]) {
        if (binding.providerId === providerId) return true;
      }
    }
    return false;
  }
}

function freezeRegistration(
  providerId: string,
  connectionId: string,
  input: ClientCapabilityReplaceInput,
  trustedProvider: boolean,
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
        hostPathAccess: offer.hostPathAccess,
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
    providerId,
    connectionId,
    registrationId: input.registrationId,
    trustedProvider,
    offersByContract,
    servicesByContract,
    snapshotRefs: 0,
  };
}

function clientProviderId(principalId: string, clientInstanceId: string): string {
  return `${principalId}\0${clientInstanceId}`;
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

function clientCapabilityToolBinding(
  contractId: string,
  registration: CapabilityRegistration | undefined,
  tool: FrozenToolBinding,
): ClientCapabilityToolBinding {
  const digest = createHash('sha256')
    .update(
      canonicalJson({
        contractId,
        registrationId: registration?.registrationId ?? null,
        offerId: tool.offerId,
        descriptor: tool.descriptor,
      }),
    )
    .digest('base64url');
  return `client-capability.${digest}` as ClientCapabilityToolBinding;
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
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
        hostPathAccess: offer.hostPathAccess,
        tools,
      }),
    )
    .digest('hex')
    .slice(0, 16);
  const label = offer.offerId.replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 96);
  return `client_${hash}_${label}`;
}

function assertUniqueSnapshotToolIdentities(selected: readonly SnapshotOfferBinding[]): void {
  const identities = new Set<string>();
  for (const { offer } of selected) {
    for (const descriptor of offer.offer.tools) {
      const identity = toolIdentity(descriptor.serverId, descriptor.name);
      if (identities.has(identity)) {
        throw new Error('Client Capability snapshot contains a duplicate tool identity');
      }
      identities.add(identity);
    }
  }
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
      candidate.providerId !== binding.providerId
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
    left.initiatingProviderId === right.initiatingProviderId &&
    left.serviceProviderId === right.serviceProviderId &&
    bindingMapsEqual(left.sessionBindings, right.sessionBindings) &&
    bindingMapsEqual(left.turnBindings, right.turnBindings)
  );
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
