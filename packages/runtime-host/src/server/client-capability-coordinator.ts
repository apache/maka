import { createHash, randomUUID } from 'node:crypto';
import {
  buildMcpTools,
  mcpProxyToolName,
  type MakaTool,
  type McpToolProvider,
  type ToolGroup,
} from '@maka/runtime';
import {
  CLIENT_CAPABILITY_MAX_RESULT_BYTES,
  CLIENT_CAPABILITY_RESULT_CHUNK_MAX_BYTES,
  decodeClientCapabilityResult,
  type ClientCapabilityCallResult,
  type ClientCapabilityClientFrame,
  type ClientCapabilityOffer,
  type ClientCapabilityReplaceInput,
  type ClientCapabilityToolDescriptor,
  type ClientCapabilityUnregisterInput,
  type ClientSurface,
} from '../protocol/index.js';
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

const DEFAULT_CALL_TIMEOUT_MS = 120_000;
const MAX_CONCURRENT_INVOCATIONS_PER_CONNECTION = 8;
const MAX_RETIRED_INVOCATIONS = 1_024;

export type ClientCapabilityInvocationFailure =
  | 'capability_ambiguous'
  | 'capability_lost'
  | 'outcome_unknown'
  | 'provider_overloaded'
  | 'provider_rejected'
  | 'provider_failed'
  | 'timed_out';

export class ClientCapabilityInvocationError extends Error {
  constructor(
    readonly code: ClientCapabilityInvocationFailure,
    message: string,
  ) {
    super(message);
    this.name = 'ClientCapabilityInvocationError';
  }
}

export interface ClientCapabilitySnapshot {
  readonly registrationIds: readonly string[];
  readonly groups: readonly ToolGroup[];
  readonly tools: readonly MakaTool[];
  release(): void;
}

interface ClientProviderState {
  readonly connectionId: string;
  surface?: ClientSurface;
  sender?: ClientCapabilityConnectionSender;
  current?: CapabilityRegistration;
  readonly registrations: Map<string, CapabilityRegistration>;
}

interface CapabilityRegistration {
  readonly connectionId: string;
  readonly registrationId: string;
  readonly offers: readonly ClientCapabilityOffer[];
  readonly offersByContract: ReadonlyMap<string, FrozenOfferBinding>;
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

interface SessionCapabilityBinding {
  readonly connectionId?: string;
}

interface SelectedOfferBinding {
  readonly registration: CapabilityRegistration;
  readonly offer: FrozenOfferBinding;
}

interface SnapshotOfferBinding {
  readonly offer: FrozenOfferBinding;
  readonly registration?: CapabilityRegistration;
}

interface InvocationState {
  readonly invocationId: string;
  readonly registration: CapabilityRegistration;
  readonly resolve: (result: ClientCapabilityCallResult) => void;
  readonly reject: (error: Error) => void;
  readonly signal?: AbortSignal;
  readonly onAbort?: () => void;
  readonly timer: NodeJS.Timeout;
  phase: 'dispatched' | 'accepted' | 'chunks';
  chunks?: {
    readonly byteLength: number;
    readonly chunkCount: number;
    readonly values: Buffer[];
    receivedBytes: number;
  };
}

export interface HostClientCapabilityCoordinatorOptions {
  readonly activation: RuntimePolicyActivationGate;
  readonly onRegistryChanged: () => void;
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
  readonly #onRegistryChanged: () => void;
  readonly #providers = new Map<string, ClientProviderState>();
  readonly #bindings = new Map<string, ReadonlyMap<string, SessionCapabilityBinding>>();
  readonly #turnBindings = new Map<string, ReadonlyMap<string, SessionCapabilityBinding>>();
  readonly #initiatingConnections = new Map<string, string>();
  readonly #invocations = new Map<string, InvocationState>();
  readonly #retiredInvocationIds = new Set<string>();
  #revision = 0;
  #draining = false;

  constructor(options: HostClientCapabilityCoordinatorOptions) {
    this.#activation = options.activation;
    this.#onRegistryChanged = options.onRegistryChanged;
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
    let closed = false;
    return {
      accept: (frame) => {
        if (closed) return;
        this.#accept(connectionId, frame);
      },
      close: () => {
        if (closed) return;
        closed = true;
        this.releaseConnection(connectionId);
      },
    };
  }

  async bindSession(
    sessionId: string,
    initiatingConnectionId: string,
  ): Promise<{ readonly ok: true } | { readonly ok: false; readonly message: string }> {
    return this.#activation.runMutation(async () => {
      const previous = this.#bindings.get(sessionId) ?? new Map();
      const eligible = this.#eligibleOffersByContract();
      const previousInitiatingConnection = this.#initiatingConnections.get(sessionId);
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
        if (previousBinding?.connectionId) {
          candidate = candidates.find(
            (entry) => entry.registration.connectionId === previousBinding.connectionId,
          );
          if (!candidate) {
            return {
              ok: false,
              message:
                'A Session-bound Client Capability provider is no longer available for its frozen contract',
            };
          }
        } else if (previousBinding) {
          candidate = candidates.find(
            (entry) => entry.registration.connectionId === initiatingConnectionId,
          );
          if (!candidate) {
            return {
              ok: false,
              message:
                'A lost Client Capability binding requires a compatible initiating Client to rebind',
            };
          }
        } else {
          candidate =
            candidates.find(
              (entry) => entry.registration.connectionId === initiatingConnectionId,
            ) ?? (candidates.length === 1 ? candidates[0] : undefined);
          if (!candidate && candidates.length > 1) {
            return {
              ok: false,
              message:
                'Multiple Client Capability providers offer the same contract and no initiating provider can be selected',
            };
          }
        }
        if (!candidate) continue;
        next.set(contractId, { connectionId: candidate.registration.connectionId });
        selected.push(candidate);
      }

      const proxyNames = new Map<string, string>();
      for (const candidate of selected) {
        for (const descriptor of candidate.offer.offer.tools) {
          const proxyName = mcpProxyToolName(descriptor.serverId, descriptor.name);
          const existingContract = proxyNames.get(proxyName);
          if (existingContract && existingContract !== candidate.offer.contractId) {
            return {
              ok: false,
              message: 'Client Capability contracts expose conflicting model tool identities',
            };
          }
          proxyNames.set(proxyName, candidate.offer.contractId);
        }
      }

      const previousTurn = this.#turnBindings.get(sessionId) ?? new Map();
      const nextTurn = new Map<string, SessionCapabilityBinding>();
      for (const [contractId, candidates] of [...eligible].sort(([left], [right]) =>
        left.localeCompare(right),
      )) {
        if (candidates[0]?.offer.offer.affinity !== 'turn') continue;
        const candidate =
          candidates.find((entry) => entry.registration.connectionId === initiatingConnectionId) ??
          (candidates.length === 1 ? candidates[0] : undefined);
        if (!candidate || offerConflictsWithProxyNames(candidate.offer, proxyNames)) continue;
        nextTurn.set(contractId, { connectionId: candidate.registration.connectionId });
        rememberOfferProxyNames(candidate.offer, proxyNames);
      }

      const bindingsChanged = !bindingMapsEqual(previous, next);
      const turnBindingsChanged = !bindingMapsEqual(previousTurn, nextTurn);
      if (bindingsChanged) {
        if (next.size === 0) this.#bindings.delete(sessionId);
        else this.#bindings.set(sessionId, next);
      }
      if (turnBindingsChanged) {
        if (nextTurn.size === 0) this.#turnBindings.delete(sessionId);
        else this.#turnBindings.set(sessionId, nextTurn);
      }
      this.#initiatingConnections.set(sessionId, initiatingConnectionId);
      const callSelectionChanged =
        previousInitiatingConnection !== initiatingConnectionId &&
        [...eligible.values()].some((candidates) => candidates[0]?.offer.offer.affinity === 'call');
      if (bindingsChanged || turnBindingsChanged || callSelectionChanged) {
        this.#onRegistryChanged();
      }
      return { ok: true };
    });
  }

  snapshotForSession(sessionId: string): ClientCapabilitySnapshot | undefined {
    const bindings = this.#bindings.get(sessionId);
    const turnBindings = this.#turnBindings.get(sessionId);
    const selected: SnapshotOfferBinding[] = [];
    const proxyNames = new Map<string, string>();
    for (const [contractId, binding] of [...(bindings ?? [])].sort(([left], [right]) =>
      left.localeCompare(right),
    )) {
      const provider = binding.connectionId ? this.#providers.get(binding.connectionId) : undefined;
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
      const provider = binding.connectionId ? this.#providers.get(binding.connectionId) : undefined;
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
    const proxyProvider = this.#snapshotProvider(
      this.#initiatingConnections.get(sessionId),
      selected,
    );
    const tools = buildMcpTools(proxyProvider, {
      callTimeoutMs: DEFAULT_CALL_TIMEOUT_MS,
      categoryHint: 'client_capability',
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

  releaseConnection(connectionId: string): void {
    const provider = this.#providers.get(connectionId);
    if (!provider) return;
    provider.sender = undefined;
    if (provider.current) {
      provider.current.current = false;
      provider.current = undefined;
      this.#markBindingsLost(connectionId);
      this.#removeTurnBindings(connectionId);
      this.#revision += 1;
      this.#onRegistryChanged();
    }
    for (const invocation of [...this.#invocations.values()]) {
      if (invocation.registration.connectionId !== connectionId) continue;
      this.#settleInvocation(
        invocation,
        undefined,
        new ClientCapabilityInvocationError(
          invocation.phase === 'dispatched' ? 'capability_lost' : 'outcome_unknown',
          invocation.phase === 'dispatched'
            ? 'Client Capability provider disconnected before accepting the call'
            : 'Client Capability provider disconnected after accepting the call',
        ),
        false,
      );
    }
    for (const registration of [...provider.registrations.values()]) {
      this.#releaseRegistrationIfUnused(registration);
    }
    if (provider.registrations.size === 0) this.#providers.delete(connectionId);
  }

  beginDrain(): void {
    this.#draining = true;
  }

  close(): void {
    this.beginDrain();
    for (const connectionId of [...this.#providers.keys()]) {
      this.releaseConnection(connectionId);
    }
    if (this.#invocations.size !== 0) {
      throw new Error('Client Capability registry closed with active invocations');
    }
    this.#bindings.clear();
    this.#turnBindings.clear();
    this.#initiatingConnections.clear();
    this.#retiredInvocationIds.clear();
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
      provider.surface = context.surface;
      provider.registrations.set(registration.registrationId, registration);
      this.#revision += 1;
      this.#onRegistryChanged();
      if (previous) this.#releaseRegistrationIfUnused(previous);
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
      this.#onRegistryChanged();
      this.#releaseRegistrationIfUnused(registration);
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
        const context = options?.context;
        if (!context) {
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
        return this.#invoke(
          dynamicBinding.registration,
          dynamicBinding.tool,
          args,
          context,
          options?.signal,
          options?.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS,
        );
      },
    };
  }

  #invoke(
    registration: CapabilityRegistration,
    binding: FrozenToolBinding,
    args: Record<string, unknown>,
    context: NonNullable<Parameters<McpToolProvider['callTool']>[3]>['context'] & {},
    signal: AbortSignal | undefined,
    timeoutMs: number,
  ): Promise<ClientCapabilityCallResult> {
    const provider = this.#providers.get(registration.connectionId);
    const sender = provider?.sender;
    if (!sender) {
      return Promise.reject(
        new ClientCapabilityInvocationError(
          'capability_lost',
          'Client Capability provider is unavailable',
        ),
      );
    }
    if (signal?.aborted) return Promise.reject(abortReason(signal));
    const activeForConnection = [...this.#invocations.values()].filter(
      (invocation) => invocation.registration.connectionId === registration.connectionId,
    ).length;
    if (activeForConnection >= MAX_CONCURRENT_INVOCATIONS_PER_CONNECTION) {
      return Promise.reject(
        new ClientCapabilityInvocationError(
          'provider_overloaded',
          'Client Capability provider has too many active invocations',
        ),
      );
    }

    const invocationId = randomUUID();
    return new Promise<ClientCapabilityCallResult>((resolve, reject) => {
      const onAbort = signal
        ? () => {
            const invocation = this.#invocations.get(invocationId);
            if (!invocation) return;
            void sender.send({ kind: 'client.capability.cancel', invocationId }).catch(() => {});
            this.#settleInvocation(
              invocation,
              undefined,
              invocation.phase === 'dispatched'
                ? asError(abortReason(signal))
                : new ClientCapabilityInvocationError(
                    'outcome_unknown',
                    'Client Capability invocation was cancelled after provider acceptance',
                  ),
              true,
            );
          }
        : undefined;
      const timer = setTimeout(() => {
        const invocation = this.#invocations.get(invocationId);
        if (!invocation) return;
        void sender.send({ kind: 'client.capability.cancel', invocationId }).catch(() => {});
        this.#settleInvocation(
          invocation,
          undefined,
          invocation.phase === 'dispatched'
            ? new ClientCapabilityInvocationError(
                'timed_out',
                'Client Capability invocation timed out before provider acceptance',
              )
            : new ClientCapabilityInvocationError(
                'outcome_unknown',
                'Client Capability invocation timed out after provider acceptance',
              ),
          true,
        );
      }, timeoutMs);
      const invocation: InvocationState = {
        invocationId,
        registration,
        resolve,
        reject,
        signal,
        onAbort,
        timer,
        phase: 'dispatched',
      };
      this.#invocations.set(invocationId, invocation);
      if (onAbort) signal?.addEventListener('abort', onAbort, { once: true });
      void sender
        .send({
          kind: 'client.capability.call',
          invocationId,
          registrationId: registration.registrationId,
          offerId: binding.offerId,
          serverId: binding.descriptor.serverId,
          toolName: binding.descriptor.name,
          arguments: args,
          sessionId: context.sessionId,
          turnId: context.turnId,
          toolCallId: context.toolCallId,
          cwd: context.cwd,
        })
        .catch(() => {
          const current = this.#invocations.get(invocationId);
          if (!current) return;
          this.#settleInvocation(
            current,
            undefined,
            new ClientCapabilityInvocationError(
              'capability_lost',
              'Client Capability call could not be delivered',
            ),
            false,
          );
        });
    });
  }

  #accept(connectionId: string, frame: ClientCapabilityClientFrame): void {
    const invocation = this.#invocations.get(frame.invocationId);
    if (!invocation) {
      if (this.#retiredInvocationIds.has(frame.invocationId)) return;
      throw new Error('Client Capability provider returned an unmatched invocation frame');
    }
    if (invocation.registration.connectionId !== connectionId) {
      throw new Error('Client Capability provider returned another connection invocation');
    }
    switch (frame.kind) {
      case 'client.capability.accepted':
        if (invocation.phase !== 'dispatched') {
          throw new Error('Client Capability invocation was accepted more than once');
        }
        invocation.phase = 'accepted';
        const sender = this.#providers.get(invocation.registration.connectionId)?.sender;
        if (!sender) {
          this.#settleInvocation(
            invocation,
            undefined,
            new ClientCapabilityInvocationError(
              'capability_lost',
              'Client Capability provider disappeared during acceptance',
            ),
            false,
          );
          return;
        }
        void sender
          .send({
            kind: 'client.capability.admitted',
            invocationId: invocation.invocationId,
          })
          .catch(() => {
            const current = this.#invocations.get(invocation.invocationId);
            if (!current) return;
            this.#settleInvocation(
              current,
              undefined,
              new ClientCapabilityInvocationError(
                'outcome_unknown',
                'Client Capability acceptance acknowledgement could not be delivered',
              ),
              false,
            );
          });
        return;
      case 'client.capability.rejected':
        if (invocation.phase !== 'dispatched') {
          throw new Error('Accepted Client Capability invocation cannot be rejected');
        }
        this.#settleInvocation(
          invocation,
          undefined,
          new ClientCapabilityInvocationError('provider_rejected', frame.message),
          true,
        );
        return;
      case 'client.capability.failed':
        if (invocation.phase === 'dispatched') {
          throw new Error('Client Capability failure arrived before acceptance');
        }
        this.#settleInvocation(
          invocation,
          undefined,
          new ClientCapabilityInvocationError('provider_failed', frame.message),
          true,
        );
        return;
      case 'client.capability.result':
        if (invocation.phase !== 'accepted') {
          throw new Error('Client Capability result arrived outside the accepted phase');
        }
        this.#settleInvocation(invocation, frame.result, undefined, true);
        return;
      case 'client.capability.result_start':
        if (invocation.phase !== 'accepted') {
          throw new Error('Client Capability result chunks started outside the accepted phase');
        }
        invocation.phase = 'chunks';
        invocation.chunks = {
          byteLength: frame.byteLength,
          chunkCount: frame.chunkCount,
          values: [],
          receivedBytes: 0,
        };
        return;
      case 'client.capability.result_chunk':
        this.#acceptChunk(invocation, frame.index, frame.data);
    }
  }

  #acceptChunk(invocation: InvocationState, index: number, data: string): void {
    const chunks = invocation.chunks;
    if (invocation.phase !== 'chunks' || !chunks || index !== chunks.values.length) {
      throw new Error('Client Capability result chunk is out of sequence');
    }
    const value = Buffer.from(data, 'base64');
    const remaining = chunks.byteLength - chunks.receivedBytes;
    const expectedLength = Math.min(CLIENT_CAPABILITY_RESULT_CHUNK_MAX_BYTES, remaining);
    if (value.byteLength !== expectedLength || index >= chunks.chunkCount) {
      throw new Error('Client Capability result chunk has invalid bounds');
    }
    chunks.values.push(value);
    chunks.receivedBytes += value.byteLength;
    if (chunks.values.length !== chunks.chunkCount) return;
    if (
      chunks.receivedBytes !== chunks.byteLength ||
      chunks.receivedBytes > CLIENT_CAPABILITY_MAX_RESULT_BYTES
    ) {
      throw new Error('Client Capability chunked result length changed');
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(Buffer.concat(chunks.values).toString('utf8'));
    } catch {
      throw new Error('Client Capability chunked result is not valid JSON');
    }
    this.#settleInvocation(invocation, decodeClientCapabilityResult(decoded), undefined, true);
  }

  #settleInvocation(
    invocation: InvocationState,
    result: ClientCapabilityCallResult | undefined,
    error: Error | undefined,
    releaseRemote: boolean,
  ): void {
    if (this.#invocations.get(invocation.invocationId) !== invocation) return;
    this.#invocations.delete(invocation.invocationId);
    clearTimeout(invocation.timer);
    if (invocation.onAbort && invocation.signal) {
      invocation.signal.removeEventListener('abort', invocation.onAbort);
    }
    this.#rememberRetiredInvocation(invocation.invocationId);
    if (releaseRemote) {
      const sender = this.#providers.get(invocation.registration.connectionId)?.sender;
      void sender
        ?.send({
          kind: 'client.capability.release',
          invocationId: invocation.invocationId,
        })
        .catch(() => {});
    }
    if (error) invocation.reject(error);
    else if (result) invocation.resolve(result);
    else invocation.reject(new Error('Client Capability invocation settled without an outcome'));
    this.#releaseRegistrationIfUnused(invocation.registration);
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
    for (const [sessionId, bindings] of this.#bindings) {
      let next: Map<string, SessionCapabilityBinding> | undefined;
      for (const [contractId, binding] of bindings) {
        if (binding.connectionId !== connectionId || (contracts && !contracts.has(contractId))) {
          continue;
        }
        next ??= new Map(bindings);
        next.set(contractId, {});
      }
      if (next) this.#bindings.set(sessionId, next);
    }
  }

  #retireBindings(connectionId: string, contracts: ReadonlySet<string>): void {
    for (const [sessionId, bindings] of this.#bindings) {
      const next = new Map(bindings);
      for (const [contractId, binding] of bindings) {
        if (binding.connectionId === connectionId && contracts.has(contractId)) {
          next.delete(contractId);
        }
      }
      if (next.size === bindings.size) continue;
      if (next.size === 0) this.#bindings.delete(sessionId);
      else this.#bindings.set(sessionId, next);
    }
  }

  #removeTurnBindings(connectionId: string, contracts?: ReadonlySet<string>): void {
    for (const [sessionId, bindings] of this.#turnBindings) {
      const next = new Map(bindings);
      for (const [contractId, binding] of bindings) {
        if (binding.connectionId === connectionId && (!contracts || contracts.has(contractId))) {
          next.delete(contractId);
        }
      }
      if (next.size === bindings.size) continue;
      if (next.size === 0) this.#turnBindings.delete(sessionId);
      else this.#turnBindings.set(sessionId, next);
    }
  }

  #releaseRegistrationIfUnused(registration: CapabilityRegistration): void {
    if (
      registration.current ||
      registration.snapshotRefs !== 0 ||
      [...this.#invocations.values()].some((invocation) => invocation.registration === registration)
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

  #rememberRetiredInvocation(invocationId: string): void {
    this.#retiredInvocationIds.add(invocationId);
    if (this.#retiredInvocationIds.size <= MAX_RETIRED_INVOCATIONS) return;
    const oldest = this.#retiredInvocationIds.values().next().value;
    if (typeof oldest === 'string') this.#retiredInvocationIds.delete(oldest);
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
  return {
    connectionId,
    registrationId: input.registrationId,
    offers: Object.freeze(offers),
    offersByContract,
    current: true,
    snapshotRefs: 0,
  };
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
    if (right.get(contractId)?.connectionId !== binding.connectionId) return false;
  }
  return true;
}

function abortReason(signal: AbortSignal): unknown {
  return (
    signal.reason ?? new DOMException('Client Capability invocation was aborted', 'AbortError')
  );
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
