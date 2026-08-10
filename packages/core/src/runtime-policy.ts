import type {
  ConnectionLastTestStatus,
  ConnectionTestErrorClass,
  ModelDiscoveryResult,
  ModelInfo,
} from './llm-connections.js';
import type { ThinkingLevel } from './model-thinking.js';
import type { ProviderType } from './provider-registry.js';
import type { RelayModelProfile } from './model-thinking.js';
import type { ChatDefaultPermissionMode, ProxyProtocol } from './settings.js';
import type { SubagentSettings } from './subagent-settings.js';
import type { JsonObject } from './request-customization.js';
import {
  WEB_SEARCH_PROVIDERS,
  type WebSearchCredentialProvider,
  type WebSearchProvider,
} from './web-search.js';

export { WEB_SEARCH_PROVIDERS };
export type { ConnectionTestErrorClass, ModelDiscoverySource } from './llm-connections.js';
export {
  decodeRuntimePolicyEntityId,
  RuntimePolicyDomainDecodeError,
} from './runtime-policy/domain-codec.js';
export {
  decodeCanonicalRuntimePolicy,
  normalizeRuntimePolicyMutation,
} from './runtime-policy/policy-codec.js';
export {
  CONNECTION_CATALOG_MAX_CONNECTIONS,
  CONNECTION_CATALOG_MAX_ENABLED_MODEL_IDS,
  CONNECTION_CATALOG_MAX_MODELS_PER_CONNECTION,
  CONNECTION_MODEL_ID_MAX_LENGTH,
  CONNECTION_NAME_MAX_LENGTH,
  decodeCanonicalConnectionBaseUrl,
  decodeCanonicalConnectionCatalogEntry,
  decodeConnectionCredentialProfileEntry,
  decodeConnectionCredentialRouting,
  decodeConnectionModelId,
  decodeCredentialProfileLabel,
  decodeCredentialProfileVersionBasis,
  decodeCredentialProfileWeight,
  decodeRelayModelProfilesTable,
  decodeConnectionModel,
  decodeConnectionName,
  decodeConnectionSlug,
  decodeConnectionTarget,
  decodeConnectionTestSummary,
  decodeConnectionVersionBasis,
  decodeProviderType,
  normalizeCatalogConnectionBaseUrl,
  normalizeConnectionCatalogEntryDraft,
  normalizeConnectionCatalogEntryUpdate,
  normalizeConnectionCatalogEntryUpdateForProvider,
  normalizeConnectionModelDiscoveryResult,
  normalizeCreateCatalogConnectionInput,
  normalizeCreateCredentialProfileInput,
  normalizeRemoveCatalogConnectionInput,
  normalizeRemoveCredentialProfileInput,
  normalizeSetCredentialProfileEnabledInput,
  normalizeSetCredentialRoutingModeInput,
  normalizeSetDefaultConnectionTargetInput,
  normalizeUpdateCatalogConnectionInput,
  normalizeUpdateCredentialProfileInput,
} from './runtime-policy/connection-catalog-codec.js';
export {
  decodeCredentialLocator,
  decodeCredentialStatus,
  decodeCredentialVersionBasis,
  normalizeCredentialSecret,
  normalizeDeleteCredentialInput,
  normalizeSetCredentialInput,
} from './runtime-policy/credential-vault-codec.js';
export {
  normalizeRequestBodyOverlay,
  normalizeOptionalRequestBodyOverlay,
  normalizeRequestHeaderUpdates,
  normalizeRequestHeaders,
  parseRequestHeaders,
  REQUEST_BODY_OVERLAY_MAX_BYTES,
  REQUEST_HEADERS_MAX_BYTES,
  RequestCustomizationValidationError,
  serializeRequestHeaders,
} from './request-customization.js';
export type {
  JsonArray,
  JsonObject,
  JsonPrimitive,
  JsonValue,
  RequestHeaderUpdate,
  SavedRequestHeaders,
} from './request-customization.js';

export type Revision = number;
export type EntityId = string;

export interface RevisionConflict {
  readonly kind: 'revision_conflict';
  readonly expectedRevision: Revision;
  readonly actualRevision: Revision;
}

export interface RuntimePolicy {
  readonly networkProxy: {
    readonly enabled: boolean;
    readonly protocol: ProxyProtocol;
    readonly host: string;
    readonly port: number;
    readonly authEnabled: boolean;
    readonly username: string;
    readonly bypassList: readonly string[];
    readonly autoBypassDomains: readonly string[];
  };
  readonly personalization: {
    readonly displayName: string;
    readonly assistantTone: string;
  };
  readonly memory: {
    readonly enabled: boolean;
    readonly agentReadEnabled: boolean;
  };
  readonly workspaceInstructions: {
    readonly enabled: boolean;
  };
  readonly privacy: {
    readonly incognitoActive: boolean;
  };
  readonly chatDefaults: {
    readonly permissionMode: ChatDefaultPermissionMode;
    readonly thinkingLevel?: ThinkingLevel;
  };
  readonly webSearch: {
    readonly enabled: boolean;
    readonly defaultProvider: WebSearchProvider;
  };
  readonly subagents: SubagentSettings;
}

export interface RuntimePolicySnapshot {
  readonly revision: Revision;
  readonly policy: RuntimePolicy;
}

export interface AgentRuntimeSettingsPatch {
  readonly personalization?: Partial<RuntimePolicy['personalization']>;
  readonly memory?: Partial<RuntimePolicy['memory']>;
  readonly workspaceInstructions?: Partial<RuntimePolicy['workspaceInstructions']>;
  readonly privacy?: Partial<RuntimePolicy['privacy']>;
  readonly webSearch?: Pick<Partial<RuntimePolicy['webSearch']>, 'enabled'>;
}

export type RuntimePolicyMutation =
  | { readonly kind: 'set_network_proxy'; readonly value: RuntimePolicy['networkProxy'] }
  | { readonly kind: 'set_personalization'; readonly value: RuntimePolicy['personalization'] }
  | { readonly kind: 'set_memory'; readonly value: RuntimePolicy['memory'] }
  | {
      readonly kind: 'set_workspace_instructions';
      readonly value: RuntimePolicy['workspaceInstructions'];
    }
  | { readonly kind: 'set_privacy'; readonly value: RuntimePolicy['privacy'] }
  | { readonly kind: 'set_chat_defaults'; readonly value: RuntimePolicy['chatDefaults'] }
  | { readonly kind: 'set_web_search'; readonly value: RuntimePolicy['webSearch'] }
  | { readonly kind: 'set_subagents'; readonly value: RuntimePolicy['subagents'] }
  | { readonly kind: 'patch_agent_settings'; readonly value: AgentRuntimeSettingsPatch };

export interface MutateRuntimePolicyInput {
  readonly expectedRevision: Revision;
  readonly operation: RuntimePolicyMutation;
}

export type MutateRuntimePolicyResult =
  | { readonly kind: 'committed'; readonly snapshot: RuntimePolicySnapshot }
  | RevisionConflict;

export function createDefaultRuntimePolicy(): RuntimePolicy {
  return {
    networkProxy: {
      enabled: false,
      protocol: 'http',
      host: '127.0.0.1',
      port: 7890,
      authEnabled: false,
      username: '',
      bypassList: ['metaso.cn', 'baidu.com'],
      autoBypassDomains: ['localhost', '127.0.0.1', '::1', '192.168.*', '10.*', '*.local'],
    },
    personalization: { displayName: '', assistantTone: '' },
    memory: { enabled: true, agentReadEnabled: false },
    workspaceInstructions: { enabled: true },
    privacy: { incognitoActive: false },
    chatDefaults: { permissionMode: 'ask' },
    webSearch: { enabled: false, defaultProvider: 'model' },
    subagents: { presets: [] },
  };
}

export type ConnectionModel = Readonly<ModelInfo>;

export type ConnectionModelDiscoveryResult = Readonly<
  Pick<ModelDiscoveryResult, 'source' | 'fetchedAt'>
> & {
  readonly models: readonly ConnectionModel[];
};

export interface ConnectionTestSummary {
  readonly status: ConnectionLastTestStatus;
  readonly checkedAt: string;
  readonly errorClass?: ConnectionTestErrorClass;
}

export interface ConnectionConfiguration {
  readonly slug: string;
  readonly name: string;
  readonly providerType: ProviderType;
  readonly baseUrl?: string;
  readonly enabled: boolean;
  readonly enabledModelIds: readonly string[];
  /**
   * Per-model relay declarations (thinking levels, vision, context window),
   * as a typed table scoped to `enabledModelIds` — never an extras bag.
   * Execution paths read it through the shared `relayModelProfile` seam.
   */
  readonly relayModelProfiles?: Readonly<Record<string, RelayModelProfile>>;
  readonly requestBodyOverlay?: JsonObject;
}

export interface ConnectionCatalogEntry extends ConnectionConfiguration {
  readonly connectionId: EntityId;
  readonly revision: Revision;
  readonly models: ConnectionModelDiscoveryResult['models'];
  readonly modelSource?: ConnectionModelDiscoveryResult['source'];
  readonly modelsFetchedAt?: ConnectionModelDiscoveryResult['fetchedAt'];
  readonly lastTest?: ConnectionTestSummary;
  /**
   * Credential Profile routing declaration. Owned exclusively by the Catalog
   * authority through the dedicated Profile mutations in section 5.4 — it is
   * intentionally absent from `ConnectionConfiguration`,
   * `ConnectionCatalogEntryDraft` and `ConnectionCatalogEntryUpdate` so that
   * profile-blind writers can never inject or clobber Profile state.
   *
   * Absent means the legacy single-credential (implicit primary) mode.
   */
  readonly credentialRouting?: ConnectionCredentialRouting;
}

/**
 * Strategy name for Credential Profile selection. MVP accepts a single known
 * value; unknown values fail closed.
 */
export type CredentialRoutingStrategy = 'smooth_weighted_round_robin';

/** Maximum number of Credential Profiles per Connection. */
export const CONNECTION_CREDENTIAL_PROFILE_MAX = 32 as const;
/** Normalized `label` length bounds (1..64, case-insensitively unique). */
export const CONNECTION_CREDENTIAL_PROFILE_LABEL_MAX_LENGTH = 64 as const;
/** `weight` integer bounds (1..100), a configured traffic ratio. */
export const CONNECTION_CREDENTIAL_PROFILE_WEIGHT_MIN = 1 as const;
export const CONNECTION_CREDENTIAL_PROFILE_WEIGHT_MAX = 100 as const;

/**
 * One Credential Profile under a Connection. Only non-secret metadata lives
 * here; the secret lives in the Credential Vault under the matching locator.
 */
export interface ConnectionCredentialProfileEntry {
  readonly profileId: EntityId;
  readonly revision: Revision;
  readonly label: string;
  readonly enabled: boolean;
  readonly weight: number;
}

export interface ConnectionCredentialRouting {
  /**
   * `legacy_primary` keeps execution on the primary Profile only, while
   * secondary Profiles can still be configured and tested without changing
   * live behavior. `balanced` enables multi-Profile selection.
   */
  readonly mode: 'legacy_primary' | 'balanced';
  readonly strategy: CredentialRoutingStrategy;
  readonly profiles: readonly ConnectionCredentialProfileEntry[];
}

/**
 * Version basis for a Profile-scoped mutation. The primary Profile always has
 * `profileId === connectionId`; secondary Profile ids are generated by the
 * Catalog authority and are immutable after creation.
 */
export interface CredentialProfileVersionBasis {
  readonly connectionId: EntityId;
  readonly connectionRevision: Revision;
  readonly profileId: EntityId;
  readonly profileRevision: Revision;
}

export interface CreateCredentialProfileInput {
  /** Connection-level CAS basis. */
  readonly expected: ConnectionVersionBasis;
  readonly label: string;
  readonly weight: number;
}

export interface UpdateCredentialProfileInput {
  readonly expected: CredentialProfileVersionBasis;
  /** Absent keeps the stored label. */
  readonly label?: string;
  /** Absent keeps the stored weight. */
  readonly weight?: number;
}

export interface SetCredentialProfileEnabledInput {
  readonly expected: CredentialProfileVersionBasis;
  readonly enabled: boolean;
}

export interface RemoveCredentialProfileInput {
  readonly expected: CredentialProfileVersionBasis;
}

export interface SetCredentialRoutingModeInput {
  readonly expected: ConnectionVersionBasis;
  readonly mode: 'legacy_primary' | 'balanced';
}

export type CredentialProfileMutationResult =
  | { readonly kind: 'committed'; readonly snapshot: ConnectionCatalogSnapshot }
  | { readonly kind: 'connection_not_found' }
  | {
      readonly kind: 'connection_stale';
      readonly expected: ConnectionVersionBasis;
      readonly actual: ConnectionVersionBasis | null;
    }
  | {
      readonly kind: 'profile_not_found';
      readonly expected: CredentialProfileVersionBasis;
    }
  | {
      readonly kind: 'profile_stale';
      readonly expected: CredentialProfileVersionBasis;
      readonly actual: CredentialProfileVersionBasis | null;
    }
  | { readonly kind: 'profile_label_conflict'; readonly label: string }
  | { readonly kind: 'capacity_limit'; readonly max: number }
  | { readonly kind: 'primary_not_removable' }
  | {
      readonly kind: 'auth_not_supported';
      readonly providerType: ProviderType;
    }
  | { readonly kind: 'balanced_activation_rejected'; readonly reason: string };

export type ConnectionCatalogEntryDraft = ConnectionConfiguration;

export interface ConnectionCatalogEntryUpdate {
  readonly name: string;
  readonly baseUrl?: string;
  readonly enabled: boolean;
  readonly enabledModelIds: readonly string[];
  /**
   * Profile-table instruction in three states: an absent key leaves the
   * stored table untouched (except that an endpoint change in the same update
   * retires it — declarations belong to the endpoint they were declared
   * against); `null` clears all declarations; a table replaces them wholly.
   * Profile-blind writers simply omit the key and can never clobber.
   */
  readonly relayModelProfiles?: Readonly<Record<string, RelayModelProfile>> | null;
  /** Absent leaves the overlay unchanged; null clears it; an object replaces it. */
  readonly requestBodyOverlay?: JsonObject | null;
}

export interface ConnectionVersionBasis {
  readonly connectionId: EntityId;
  readonly revision: Revision;
}

export interface ConnectionTarget {
  readonly connectionId: EntityId;
  readonly modelId: string;
}

export interface ConnectionCatalogSnapshot {
  readonly revision: Revision;
  readonly defaultTarget: ConnectionTarget | null;
  readonly connections: readonly ConnectionCatalogEntry[];
}

export interface CreateCatalogConnectionInput {
  readonly expectedCatalogRevision: Revision;
  readonly connection: ConnectionCatalogEntryDraft;
}

export interface UpdateCatalogConnectionInput {
  readonly expected: ConnectionVersionBasis;
  readonly changes: ConnectionCatalogEntryUpdate;
}

export interface RemoveCatalogConnectionInput {
  readonly expected: ConnectionVersionBasis;
}

export interface SetDefaultConnectionTargetInput {
  readonly expectedCatalogRevision: Revision;
  readonly target: ConnectionTarget | null;
}

export type ConnectionCatalogConflict =
  | RevisionConflict
  | { readonly kind: 'connection_exists'; readonly slug: string }
  | {
      readonly kind: 'connection_stale';
      readonly expected: ConnectionVersionBasis;
      readonly actual: ConnectionVersionBasis | null;
    }
  | { readonly kind: 'invalid_default_target'; readonly target: ConnectionTarget };

export type ConnectionCatalogMutationResult =
  | { readonly kind: 'committed'; readonly snapshot: ConnectionCatalogSnapshot }
  | ConnectionCatalogConflict;

export type CredentialLocator =
  | {
      readonly scope: 'connection';
      readonly connectionId: EntityId;
      readonly kind: 'api_key' | 'oauth_token' | 'request_headers';
    }
  | {
      readonly scope: 'connection_profile';
      readonly connectionId: EntityId;
      readonly profileId: EntityId;
      readonly kind: 'api_key' | 'oauth_token';
    }
  | {
      readonly scope: 'web_search';
      readonly provider: WebSearchCredentialProvider;
      readonly kind: 'api_key';
    }
  | { readonly scope: 'network_proxy'; readonly kind: 'password' };

export interface CredentialIdentity {
  readonly credentialId: EntityId;
}

export interface CredentialVersionBasis extends CredentialIdentity {
  readonly locator: CredentialLocator;
  readonly revision: Revision;
}

export type CredentialStatus =
  | {
      readonly locator: CredentialLocator;
      readonly configured: false;
      readonly credentialId: null;
      readonly revision: null;
      readonly updatedAt: null;
    }
  | {
      readonly locator: CredentialLocator;
      readonly configured: true;
      readonly credentialId: EntityId;
      readonly revision: Revision;
      readonly updatedAt: number;
    };

export interface CredentialVaultSnapshot {
  readonly revision: Revision;
  readonly entries: readonly CredentialStatus[];
}

export interface SetCredentialInput {
  readonly locator: CredentialLocator;
  readonly expected: (CredentialIdentity & { readonly revision: Revision }) | null;
  readonly secret: string;
}

export interface DeleteCredentialInput {
  readonly expected: CredentialVersionBasis;
}

export type CredentialMutationResult =
  | { readonly kind: 'committed'; readonly snapshot: CredentialVaultSnapshot }
  | { readonly kind: 'connection_not_found' }
  | {
      readonly kind: 'credential_stale';
      readonly expected: CredentialVersionBasis | null;
      readonly actual: CredentialVersionBasis | null;
    };
