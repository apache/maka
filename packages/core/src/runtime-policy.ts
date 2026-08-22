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

import type {
  ConnectionLastTestStatus,
  ConnectionTestErrorClass,
  ModelDiscoveryResult,
  ModelInfo,
} from './llm-connections.js';
import type { ThinkingLevel } from './model-thinking.js';
import type { ProviderType } from './provider-registry.js';
import type { RelayModelProfile } from './model-thinking.js';
import type { ChatDefaultPermissionMode, ProxyProtocol, ShellSettings } from './settings.js';
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
  decodeRuntimePolicyV2,
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
  decodeConnectionModelId,
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
  normalizeRemoveCatalogConnectionInput,
  normalizeSetDefaultConnectionTargetInput,
  normalizeUpdateCatalogConnectionInput,
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
  readonly shell: ShellSettings;
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
  | { readonly kind: 'set_shell'; readonly value: RuntimePolicy['shell'] }
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
    shell: { preference: 'auto', executable: '' },
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
}

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

/**
 * Built-in seed evolution as one atomic catalog mutation: a row still exactly
 * matching a historical system seed follows the current seed — enabled ids AND
 * the static inventory — and a system default the migration removes is
 * retargeted in the same document write. Any other inventory is a user
 * selection and is never touched; an already-null default stays null.
 */
export interface MigrateSystemSeedInput {
  readonly slug: string;
  readonly providerType: ProviderType;
  readonly legacyEnabledModelIds: readonly (readonly string[])[];
  readonly enabledModelIds: readonly string[];
  readonly defaultModelId: string;
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
