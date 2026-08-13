import type { ConnectionCredentialRouting } from '@maka/core/runtime-policy';
import type {
  ProviderFailureRoutingHint,
  ProviderCredentialLease,
  ProviderCredentialOutcome,
  ProviderCredentialResolver,
  ProviderCredentialRouteContext,
  ProviderCredentialSelectionReason,
  ProviderProfileBinding,
} from '@maka/core/provider-credential-routing';

/**
 * Credential material resolved for one Profile at acquire time. The Router
 * never persists or retains it beyond the produced lease.
 */
export interface RouterCredentialMaterial {
  readonly credentialId: string;
  readonly credentialRevision: number;
  readonly apiKey: string;
  readonly requestHeaders?: Readonly<Record<string, string>>;
  readonly fetch?: typeof fetch;
}

/**
 * The Host-facing world view the Router composes: routing declaration,
 * eligibility (health + verification), and per-profile credential material.
 * PR 2 keeps this as an injected seam; PR 3 wires Catalog/Vault/Health into
 * it.
 */
export interface RouterProfileProvider {
  /** Read the Connection's credentialRouting; null means legacy single. */
  getRouting(connectionId: string): Promise<ConnectionCredentialRouting | null>;
  /**
   * Filter candidate profileIds down to those eligible for `modelId`
   * (enabled + configured + verified + health-allowed). An empty result
   * means the pool is exhausted for this model.
   */
  getEligibleProfileIds(
    connectionId: string,
    profileIds: readonly string[],
    modelId: string,
  ): Promise<ReadonlySet<string>>;
  /** Resolve the current credential for a Profile (null when unconfigured). */
  resolveCredential(
    connectionId: string,
    profileId: string,
  ): Promise<RouterCredentialMaterial | null>;
  /** Persist the outcome into the routing Health authority. */
  settleHealth(lease: ProviderCredentialLease, outcome: ProviderCredentialOutcome): Promise<void>;
  /**
   * Profiles whose circuit is open with the probe time elapsed (RFC 8.3):
   * candidates for a half-open probe. `claimHalfOpenProbe` atomically admits
   * exactly one probe per circuit.
   */
  probeEligibleProfiles(
    connectionId: string,
    profileIds: readonly string[],
    modelId: string,
  ): Promise<ReadonlyMap<string, string>>;
  /** Atomically claim a half-open probe; false when another probe holds it. */
  claimHalfOpenProbe(
    connectionId: string,
    profileId: string,
    circuitModelId: string,
    modelId: string,
  ): Promise<boolean>;
}

export interface CreateProviderCredentialRouterOptions {
  /** Maximum turn bindings retained before LRU eviction. */
  maxTurnBindings?: number;
  now?: () => number;
}

const DEFAULT_MAX_TURN_BINDINGS = 1_024;
const DEFAULT_NOW = () => Date.now();

interface SwrrEntry {
  readonly weight: number;
  currentWeight: number;
}

interface SwrrAccumulator {
  readonly totalWeight: number;
  readonly entries: Map<string, SwrrEntry>;
}

interface TurnBindingRecord extends ProviderProfileBinding {
  readonly connectionId: string;
  readonly sessionId: string;
  readonly turnId: string;
  lastUsedAt: number;
}

/**
 * Turn-granular smooth weighted round-robin Router (RFC sections 6 and 7).
 *
 * - `acquireAttempt` revalidates Connection/Profile/model/credential health
 *   on every physical attempt and resolves the newest credential, so a stale
 *   turn binding never reuses an old secret.
 * - `releaseTurn` frees bindings; an LRU backstop reclaims leaked ones.
 * - SWRR accumulators are process-local and reset safely across restarts.
 * - Legacy single / `legacy_primary` connections use a fast path that never
 *   touches weighted state and never fabricates failover (RFC 7.3).
 */
export class ProviderCredentialRouter implements ProviderCredentialResolver {
  readonly #provider: RouterProfileProvider;
  readonly #maxTurnBindings: number;
  readonly #now: () => number;
  readonly #swrr = new Map<string, SwrrAccumulator>();
  readonly #turnBindings = new Map<string, TurnBindingRecord>();

  constructor(
    provider: RouterProfileProvider,
    options: CreateProviderCredentialRouterOptions = {},
  ) {
    this.#provider = provider;
    this.#maxTurnBindings = options.maxTurnBindings ?? DEFAULT_MAX_TURN_BINDINGS;
    this.#now = options.now ?? DEFAULT_NOW;
  }

  async acquireAttempt(context: ProviderCredentialRouteContext): Promise<ProviderCredentialLease> {
    if (context.signal.aborted) {
      throw new RouterAbortedError('Router acquire aborted before dispatch');
    }
    const routing = await this.#provider.getRouting(context.connectionId);
    if (!routing || routing.mode === 'legacy_primary') {
      return this.#acquireLegacy(context, routing);
    }
    if (routing.mode !== 'balanced') {
      throw new RouterConfigurationError(`Unsupported routing mode: ${routing.mode}`);
    }
    const { candidates, probeReason, probeCircuitModelId } = await this.#balancedCandidates(
      context,
      routing,
      !this.#turnBindings.has(turnKey(context.sessionId, context.turnId)),
    );
    if (candidates.length === 0) {
      throw new RouterPoolExhaustedError(
        `no eligible credential profile for model ${context.modelId}`,
        {},
      );
    }
    const binding = this.#selectBinding(context, routing, candidates, probeReason);
    return this.#resolveBalancedBinding(context, routing, binding, candidates, probeCircuitModelId);
  }

  async settle(lease: ProviderCredentialLease, outcome: ProviderCredentialOutcome): Promise<void> {
    await this.#provider.settleHealth(lease, outcome);
  }

  releaseTurn(sessionId: string, turnId: string): void {
    this.#turnBindings.delete(turnKey(sessionId, turnId));
  }

  /** LRU/TTL backstop for leaked turn bindings. */
  reclaimStaleBindings(now: number = this.#now()): number {
    let reclaimed = 0;
    for (const [key, binding] of this.#turnBindings) {
      if (binding.lastUsedAt < now) {
        this.#turnBindings.delete(key);
        reclaimed += 1;
      }
    }
    return reclaimed;
  }

  async #acquireLegacy(
    context: ProviderCredentialRouteContext,
    routing: ConnectionCredentialRouting | null,
  ): Promise<ProviderCredentialLease> {
    const profileId =
      routing?.mode === 'legacy_primary'
        ? routing.profiles.find((profile) => profile.profileId === context.connectionId)?.profileId
        : context.connectionId;
    if (!profileId) {
      throw new RouterPoolExhaustedError('primary profile is missing', {});
    }
    if (routing?.mode === 'legacy_primary') {
      const primary = routing.profiles.find(
        (profile) => profile.profileId === context.connectionId,
      );
      // A legacy_primary connection dispatches the primary identity only: an
      // explicitly disabled primary must fail closed instead of keeping the
      // legacy fast path usable (RFC 4.1/7.3).
      if (!primary || !primary.enabled) {
        throw new RouterPoolExhaustedError('primary profile is disabled', {});
      }
    }
    const material = await this.#provider.resolveCredential(context.connectionId, profileId);
    if (!material) {
      throw new RouterPoolExhaustedError('primary credential is not configured', {});
    }
    const binding: TurnBindingRecord = {
      bindingId: createId('binding'),
      connectionId: context.connectionId,
      sessionId: context.sessionId,
      turnId: context.turnId,
      profileId,
      selectionReason: 'legacy_single',
      lastUsedAt: this.#now(),
    };
    return this.#leaseFromMaterial(context, binding, material);
  }

  async #balancedCandidates(
    context: ProviderCredentialRouteContext,
    routing: ConnectionCredentialRouting,
    newTurn: boolean,
  ): Promise<{
    readonly candidates: string[];
    readonly probeReason: boolean;
    readonly probeCircuitModelId?: string;
  }> {
    const allProfileIds = routing.profiles.map((profile) => profile.profileId);
    const eligible = await this.#provider.getEligibleProfileIds(
      context.connectionId,
      allProfileIds,
      context.modelId,
    );
    const excluded = new Set(context.excludedProfileIds);
    if (context.reason === 'half_open_probe') {
      // A half-open probe targets the previously failing Profile even though
      // it was excluded by the failover; it is the only candidate admitted.
      const failing = routing.profiles.find((profile) => excluded.has(profile.profileId));
      if (failing && eligible.has(failing.profileId)) {
        return { candidates: [failing.profileId], probeReason: true };
      }
      return { candidates: [], probeReason: true };
    }
    const normal = allProfileIds.filter(
      (profileId) => eligible.has(profileId) && !excluded.has(profileId),
    );
    // A recovered circuit must be able to rejoin while other Profiles remain
    // healthy. Probe at most one expired circuit on the first call of a new
    // turn; the store claim is atomic, so concurrent turns continue through
    // normal candidates while this one safe half-open request is in flight.
    // Existing turn bindings stay sticky and account-failover retries never
    // detour through an unrelated recovery probe.
    if (newTurn && context.reason === 'initial') {
      const recoveryProbe = await this.#claimProbeCandidate(
        context,
        allProfileIds.filter((profileId) => !excluded.has(profileId)),
      );
      if (recoveryProbe) return recoveryProbe;
    }
    if (normal.length > 0) {
      return { candidates: normal, probeReason: false };
    }
    // Pool exhausted for normal dispatch: admit at most one half-open probe
    // (RFC 8.3). The provider's claim is atomic per circuit, so concurrent
    // acquires cannot all probe the same credential. The claimed profile is
    // dispatched regardless of the eligibility filter (it was excluded only
    // because its circuit is open — the probe exists to test it).
    const exhaustedProbe = await this.#claimProbeCandidate(
      context,
      allProfileIds.filter((profileId) => !excluded.has(profileId)),
    );
    return exhaustedProbe ?? { candidates: [], probeReason: true };
  }

  async #claimProbeCandidate(
    context: ProviderCredentialRouteContext,
    profileIds: readonly string[],
  ): Promise<{
    readonly candidates: string[];
    readonly probeReason: true;
    readonly probeCircuitModelId?: string;
  } | null> {
    const probeEligible = await this.#provider.probeEligibleProfiles(
      context.connectionId,
      profileIds,
      context.modelId,
    );
    for (const [profileId, circuitModelId] of probeEligible) {
      if (
        await this.#provider.claimHalfOpenProbe(
          context.connectionId,
          profileId,
          circuitModelId,
          context.modelId,
        )
      ) {
        return {
          candidates: [profileId],
          probeReason: true,
          probeCircuitModelId: circuitModelId,
        };
      }
    }
    return null;
  }

  /**
   * Credential resolution is part of selecting an account, rather than a
   * provider request. In particular, an OAuth refresh can fail before the
   * model adapter gets a lease. Account-scoped resolution failures must still
   * settle health (including reopening a claimed half-open circuit) and allow
   * another verified Profile to serve the logical request.
   */
  async #resolveBalancedBinding(
    context: ProviderCredentialRouteContext,
    routing: ConnectionCredentialRouting,
    initialBinding: TurnBindingRecord,
    candidates: readonly string[],
    probeCircuitModelId?: string,
  ): Promise<ProviderCredentialLease> {
    let binding = initialBinding;
    let remaining = [...candidates];
    let lastFailure: string | undefined;
    while (remaining.length > 0) {
      try {
        const material = await this.#provider.resolveCredential(
          context.connectionId,
          binding.profileId,
        );
        if (material) {
          return this.#leaseFromMaterial(context, binding, material, probeCircuitModelId);
        }
      } catch (error) {
        if (!(error instanceof RouterCredentialResolutionError)) throw error;
        lastFailure = error.message;
        await this.#provider.settleHealth(
          this.#leaseFromMaterial(
            context,
            binding,
            {
              credentialId: error.credentialId,
              credentialRevision: error.credentialRevision,
              apiKey: '',
            },
            probeCircuitModelId,
          ),
          {
            kind: 'failure',
            failure: { kind: error.routingHint.kind, retryable: false },
            routingHint: error.routingHint,
          },
        );
      }
      // The Profile disappeared, became unconfigured, or its OAuth refresh
      // failed between eligibility and materialization. Remove only this
      // binding and select another already-verified candidate; no request was
      // sent with a stale credential.
      this.#discardBinding(context, binding);
      remaining = remaining.filter((profileId) => profileId !== binding.profileId);
      if (remaining.length === 0) break;
      binding = this.#selectCandidate(context, routing, remaining, 'binding_reselect');
    }
    throw new RouterPoolExhaustedError(
      'no eligible profile retained a usable credential',
      {},
      lastFailure,
    );
  }

  #selectBinding(
    context: ProviderCredentialRouteContext,
    routing: ConnectionCredentialRouting,
    candidates: readonly string[],
    probeReason: boolean,
  ): TurnBindingRecord {
    if (probeReason) {
      return this.#selectCandidate(context, routing, candidates, 'half_open_probe');
    }
    if (context.reason === 'account_failover' || context.reason === 'half_open_probe') {
      return this.#selectCandidate(
        context,
        routing,
        candidates,
        context.reason === 'half_open_probe' ? 'half_open_probe' : 'account_failover',
      );
    }
    if (context.reason === 'binding_invalidated') {
      return this.#selectCandidate(context, routing, candidates, 'binding_reselect');
    }
    // initial: turn-granular stickiness.
    const existing = this.#turnBindings.get(turnKey(context.sessionId, context.turnId));
    if (
      existing &&
      existing.connectionId === context.connectionId &&
      candidates.includes(existing.profileId)
    ) {
      existing.lastUsedAt = this.#now();
      return existing;
    }
    if (candidates.length === 1) {
      return this.#bind(context, candidates[0]!, 'single_eligible');
    }
    return this.#selectCandidate(context, routing, candidates, 'weighted');
  }

  #selectCandidate(
    context: ProviderCredentialRouteContext,
    routing: ConnectionCredentialRouting,
    candidates: readonly string[],
    reason: ProviderCredentialSelectionReason,
  ): TurnBindingRecord {
    const selected =
      routing.strategy === 'priority_failover'
        ? this.#prioritySelect(routing, candidates)
        : this.#swrrSelect(
            context.connectionId,
            routing,
            candidates,
            context.providerId === 'openai-codex',
          );
    return this.#bind(context, selected, reason);
  }

  /** Highest configured priority wins; ties retain the stable Profile order. */
  #prioritySelect(routing: ConnectionCredentialRouting, candidates: readonly string[]): string {
    const candidateSet = new Set(candidates);
    const selected = routing.profiles
      .filter((profile) => candidateSet.has(profile.profileId))
      .reduce<ConnectionCredentialRouting['profiles'][number] | undefined>(
        (best, profile) => (!best || profile.weight > best.weight ? profile : best),
        undefined,
      );
    if (!selected) throw new RouterConfigurationError('No priority credential candidate');
    return selected.profileId;
  }

  #bind(
    context: ProviderCredentialRouteContext,
    profileId: string,
    selectionReason: ProviderCredentialSelectionReason,
  ): TurnBindingRecord {
    const now = this.#now();
    const binding: TurnBindingRecord = {
      bindingId: createId('binding'),
      connectionId: context.connectionId,
      sessionId: context.sessionId,
      turnId: context.turnId,
      profileId,
      selectionReason,
      lastUsedAt: now,
    };
    this.#turnBindings.set(turnKey(context.sessionId, context.turnId), binding);
    this.#pruneTurnBindings();
    return binding;
  }

  #discardBinding(
    context: ProviderCredentialRouteContext,
    binding: Pick<ProviderProfileBinding, 'bindingId'>,
  ): void {
    const key = turnKey(context.sessionId, context.turnId);
    if (this.#turnBindings.get(key)?.bindingId === binding.bindingId) {
      this.#turnBindings.delete(key);
    }
  }

  /**
   * Smooth weighted round-robin (RFC 7.1): every round each candidate's
   * currentWeight += weight, the maximum is selected (first-max wins over the
   * stable candidate order for a deterministic tie-break), then the selected
   * entry's currentWeight -= totalWeight. State is re-normalized whenever the
   * eligible set or weights change: a recovered Profile joins with
   * currentWeight 0 instead of inheriting a stale burst.
   */
  #swrrSelect(
    connectionId: string,
    routing: ConnectionCredentialRouting,
    candidates: readonly string[],
    equalWeights = false,
  ): string {
    const effectiveRouting = equalWeights
      ? {
          ...routing,
          profiles: routing.profiles.map((profile) => ({
            ...profile,
            weight: 1,
          })),
        }
      : routing;
    const current = this.#swrr.get(connectionId);
    const accumulator =
      current && sameWeightShape(current, effectiveRouting, candidates)
        ? current
        : normalizeSwrr(effectiveRouting, candidates);
    this.#swrr.set(connectionId, accumulator);
    let best: string | undefined;
    let bestScore = Number.NEGATIVE_INFINITY;
    for (const candidate of candidates) {
      const entry = accumulator.entries.get(candidate);
      if (!entry) continue;
      entry.currentWeight += entry.weight;
      if (entry.currentWeight > bestScore) {
        best = candidate;
        bestScore = entry.currentWeight;
      }
    }
    const selected = best ?? candidates[0]!;
    accumulator.entries.get(selected)!.currentWeight -= accumulator.totalWeight;
    return selected;
  }

  #pruneTurnBindings(): void {
    if (this.#turnBindings.size <= this.#maxTurnBindings) return;
    const entries = [...this.#turnBindings.entries()].sort(
      (left, right) => left[1].lastUsedAt - right[1].lastUsedAt,
    );
    const overflow = this.#turnBindings.size - this.#maxTurnBindings;
    for (let index = 0; index < overflow; index += 1) {
      this.#turnBindings.delete(entries[index]![0]);
    }
  }

  #leaseFromMaterial(
    context: ProviderCredentialRouteContext,
    binding: Pick<ProviderProfileBinding, 'profileId' | 'selectionReason' | 'bindingId'>,
    material: RouterCredentialMaterial,
    probeCircuitModelId?: string,
  ): ProviderCredentialLease {
    return {
      leaseId: createId('lease'),
      // The lease must reference the exact turn binding it was selected by
      // (RFC 6.2), so diagnostics and health settlement can join lease -> binding.
      bindingId: binding.bindingId,
      profileId: binding.profileId,
      credentialId: material.credentialId,
      credentialRevision: material.credentialRevision,
      selectionReason: binding.selectionReason,
      apiKey: material.apiKey,
      ...(material.requestHeaders ? { requestHeaders: material.requestHeaders } : {}),
      ...(material.fetch ? { fetch: material.fetch } : {}),
      ...(context.modelId ? { modelId: context.modelId } : {}),
      // A probe lease carries the claimed circuit row so settle lands on it.
      ...(probeCircuitModelId !== undefined ? { healthCircuitModelId: probeCircuitModelId } : {}),
    };
  }
}

export class RouterError extends Error {}
export class RouterAbortedError extends RouterError {}
export class RouterConfigurationError extends RouterError {}
/** A credential that failed before a provider request received a lease. */
export class RouterCredentialResolutionError extends RouterError {
  constructor(
    readonly credentialId: string,
    readonly credentialRevision: number,
    readonly routingHint: ProviderFailureRoutingHint,
    message: string,
  ) {
    super(message);
  }
}
export class RouterPoolExhaustedError extends RouterError {
  constructor(
    message: string,
    readonly countsByReadiness: Readonly<Record<string, number>>,
    readonly lastFailure?: string,
    readonly nextRetryAt?: number,
  ) {
    super(message);
  }
}

function turnKey(sessionId: string, turnId: string): string {
  return `${sessionId}:${turnId}`;
}

let idCounter = 0;
function createId(kind: 'binding' | 'lease'): string {
  idCounter += 1;
  return `${kind}-${Date.now().toString(36)}-${idCounter.toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function sameWeightShape(
  accumulator: SwrrAccumulator,
  routing: ConnectionCredentialRouting,
  candidates: readonly string[],
): boolean {
  if (accumulator.entries.size !== candidates.length) return false;
  for (const candidate of candidates) {
    const configured = routing.profiles.find((profile) => profile.profileId === candidate);
    const entry = accumulator.entries.get(candidate);
    if (!entry || !configured || entry.weight !== configured.weight) return false;
  }
  return true;
}

function normalizeSwrr(
  routing: ConnectionCredentialRouting,
  candidates: readonly string[],
): SwrrAccumulator {
  const entries = new Map<string, SwrrEntry>();
  let totalWeight = 0;
  for (const candidate of candidates) {
    const configured = routing.profiles.find((profile) => profile.profileId === candidate);
    if (!configured) continue;
    entries.set(candidate, { weight: configured.weight, currentWeight: 0 });
    totalWeight += configured.weight;
  }
  return { totalWeight, entries };
}
