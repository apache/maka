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

// packages/mcp/src/oauth.ts
//
// OAuth support for remote MCP servers, following the MCP authorization
// model (OAuth 2.1 + RFC 9728 protected-resource discovery, PKCE always).
//
// Split of responsibilities:
// - The SDK owns the protocol: discovery, dynamic registration, PKCE,
//   token exchange and refresh all live in `client/auth.js`.
// - This module owns persistence and the interactive boundary. Tokens,
//   registered-client records and in-flight PKCE verifiers go through an
//   injected `McpOAuthStorage` (the desktop app backs it with the shared
//   CredentialStore; tests use memory). Interaction is a mode switch:
//   a background connect must never open a browser, so its provider
//   REFUSES the redirect (surfacing `needs-auth`), while a user-initiated
//   login CAPTURES the authorization URL for the caller to open.

import type {
  OAuthClientMetadata,
  OAuthClientProvider,
  OAuthDiscoveryState,
  StoredOAuthClientInformation,
  StoredOAuthTokens,
} from '@modelcontextprotocol/client';
import type { McpOAuthConfig } from '@maka/core/mcp';

/** Everything the provider persists for one server, as one JSON document. */
export interface McpOAuthRecord {
  /** Monotonic write version, stamped by the credential coordinator on
   * every transition and validated against the read basis — the CAS handle
   * that keeps an external writer from being silently overwritten. */
  version?: number;
  /** Persisted revocation generation, owned by the credential coordinator.
   * Logout/removal advances it and leaves the record as a tombstone that
   * carries nothing else; every flow captures the generation on its first
   * read and every later write verifies it — so a flow raced by a logout in
   * ANOTHER process cannot resurrect revoked credentials. Deletion alone
   * cannot encode cross-process revocation. */
  generation?: number;
  /** The MCP server URL these credentials were issued for. Every read path
   * refuses (and drops) the record when the configured URL no longer
   * matches, so an offline edit of mcp.json cannot replay a token against
   * a different endpoint. Absent only on records written before this field
   * existed; they bind on their next save. */
  serverUrl?: string;
  tokens?: StoredOAuthTokens;
  clientInformation?: StoredOAuthClientInformation;
  /** RFC 9728 / AS metadata discovered on a previous round — including the
   * custom resource_metadata URL a 401's WWW-Authenticate advertised, which
   * a later interactive login could not re-learn on its own. */
  discovery?: OAuthDiscoveryState;
  codeVerifier?: string;
  /** The exact redirect URL the pending authorization was started with. */
  pendingRedirectUrl?: string;
  /** The server URL the pending authorization was started against, so the
   * token exchange refuses to complete against a URL that changed under it. */
  pendingServerUrl?: string;
  /** The OAuth state of the pending round, so a restarted app can rebind
   * the loopback listener and still verify the browser's callback. */
  pendingState?: string;
}

export interface McpOAuthStorage {
  get(serverId: string): Promise<McpOAuthRecord | undefined>;
  set(serverId: string, record: McpOAuthRecord): Promise<void>;
  delete(serverId: string): Promise<void>;
  /** Optional atomic read-modify-write. The credential coordinator provides
   * it on the storage views it hands to auth flows; base backends may omit
   * it (callers fall back to read + set). */
  update?(
    serverId: string,
    apply: (record: McpOAuthRecord) => McpOAuthRecord,
  ): Promise<McpOAuthRecord>;
  /** Optional compare-and-set keyed on the record's version basis
   * (`null` asserts absence). Backends over a store with native CAS map it
   * through so cross-process writers cannot be clobbered. */
  compareAndSet?(
    serverId: string,
    expectedVersion: number | null,
    record: McpOAuthRecord,
  ): Promise<'committed' | 'conflict' | 'gone'>;
}

export function createMemoryMcpOAuthStorage(): McpOAuthStorage {
  const records = new Map<string, McpOAuthRecord>();
  return {
    async get(serverId) {
      const record = records.get(serverId);
      return record ? structuredClone(record) : undefined;
    },
    async set(serverId, record) {
      records.set(serverId, structuredClone(record));
    },
    async delete(serverId) {
      records.delete(serverId);
    },
  };
}

/** Thrown (via the SDK's UnauthorizedError path) when a background connect
 * would need the user in a browser. The manager maps it to `needs-auth`. */
export class McpAuthRequiredError extends Error {
  constructor(readonly serverId: string) {
    super(`MCP server "${serverId}" requires interactive authorization`);
    this.name = 'McpAuthRequiredError';
  }
}

export interface McpOAuthProviderOptions {
  serverId: string;
  /** The configured MCP server URL. Credentials are bound to it: a stored
   * record whose serverUrl differs is dropped instead of replayed. */
  serverUrl: string;
  storage: McpOAuthStorage;
  config?: McpOAuthConfig;
  clientName: string;
  clientVersion: string;
  /**
   * Absent for background connects: the provider then refuses interactive
   * redirects with McpAuthRequiredError instead of opening anything.
   * Present during a user-initiated login: the redirect URL the loopback
   * callback server is listening on, plus a sink that receives the
   * authorization URL for the caller to open in the system browser.
   */
  interactive?: {
    redirectUrl: string;
    onAuthorizationUrl(url: URL): void;
    /** OAuth `state` for the authorization URL; the callback listener
     * verifies the round-trip before accepting a code. */
    state?: string;
  };
}

/** Stands in for `redirectUrl` on background connects. The SDK reads an
 * undefined redirectUrl as "non-interactive grant" and goes straight to the
 * token endpoint — before ever consulting the stored refresh token — which
 * turns every background connect with a known client into
 * "Either provider.prepareTokenRequest() or authorizationCode is required".
 * A defined value keeps the SDK on the authorization-code path: refresh
 * runs first, and the interactive round it may then want is refused by
 * redirectToAuthorization. The URL itself is never opened or sent in a
 * token request. */
const BACKGROUND_REDIRECT_URL = 'http://127.0.0.1/maka-mcp-oauth-noninteractive';

export class McpOAuthProvider implements OAuthClientProvider {
  /** Present only when an interactive state was supplied — the SDK treats
   * a defined method as "client uses state". */
  state?: () => string;

  constructor(private readonly options: McpOAuthProviderOptions) {
    const state = options.interactive?.state;
    if (state) this.state = () => state;
  }

  get redirectUrl(): string {
    return this.options.interactive?.redirectUrl ?? BACKGROUND_REDIRECT_URL;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: this.options.clientName,
      client_uri: 'https://github.com/maka-agent/maka-agent',
      software_id: 'maka-desktop',
      software_version: this.options.clientVersion,
      redirect_uris: this.options.interactive ? [this.options.interactive.redirectUrl] : [],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: this.options.config?.clientSecret ? 'client_secret_post' : 'none',
      ...(this.options.config?.scopes?.length
        ? { scope: this.options.config.scopes.join(' ') }
        : {}),
    };
  }

  async clientInformation(): Promise<StoredOAuthClientInformation | undefined> {
    const configured = this.options.config;
    if (configured?.clientId) {
      return {
        client_id: configured.clientId,
        ...(configured.clientSecret ? { client_secret: configured.clientSecret } : {}),
      };
    }
    const stored = (await this.read()).clientInformation;
    // A background connect with no client at all is already decided: the
    // interactive round is unavoidable. Refusing here (rather than at the
    // redirect) stops the SDK from dynamically registering a throwaway
    // client with no usable redirect URI.
    if (!stored && !this.options.interactive) {
      throw new McpAuthRequiredError(this.options.serverId);
    }
    return stored;
  }

  async saveClientInformation(clientInformation: StoredOAuthClientInformation): Promise<void> {
    await this.mutate((record) => {
      record.clientInformation = clientInformation;
    });
  }

  async tokens(): Promise<StoredOAuthTokens | undefined> {
    return (await this.read()).tokens;
  }

  async saveTokens(tokens: StoredOAuthTokens): Promise<void> {
    await this.mutate((record) => {
      record.tokens = tokens;
      // A fresh token set settles any pending interactive round.
      delete record.codeVerifier;
      delete record.pendingRedirectUrl;
      delete record.pendingServerUrl;
      delete record.pendingState;
    });
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    const interactive = this.options.interactive;
    if (!interactive) throw new McpAuthRequiredError(this.options.serverId);
    interactive.onAuthorizationUrl(authorizationUrl);
  }

  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    // A background connect only reaches here on its way to refusing the
    // redirect; persisting its verifier would clobber a live interactive
    // round's pending record.
    if (!this.options.interactive) return;
    await this.mutate((record) => {
      record.codeVerifier = codeVerifier;
      record.pendingRedirectUrl = this.options.interactive?.redirectUrl;
      record.pendingServerUrl = this.options.serverUrl;
      record.pendingState = this.options.interactive?.state;
    });
  }

  /** Persisted so an interactive login after a background 401 reuses the
   * discovery that round already did — including a custom resource_metadata
   * URL from WWW-Authenticate that a from-scratch discovery cannot find. */
  async discoveryState(): Promise<OAuthDiscoveryState | undefined> {
    return (await this.read()).discovery;
  }

  async saveDiscoveryState(state: OAuthDiscoveryState): Promise<void> {
    await this.mutate((record) => {
      // A dynamically registered client belongs to the authorization server
      // that issued it. When discovery moves the resource to a DIFFERENT
      // authorization server, carrying the old registration over would send
      // one AS's client credentials (and any secret) to another. Static
      // config-supplied clients are unaffected — they never live in the
      // record.
      const previousIssuer = record.discovery?.authorizationServerUrl;
      const nextIssuer = state.authorizationServerUrl;
      if (previousIssuer && nextIssuer && `${previousIssuer}` !== `${nextIssuer}`) {
        delete record.clientInformation;
        delete record.tokens;
      }
      record.discovery = state;
    });
  }

  async codeVerifier(): Promise<string> {
    const value = (await this.read()).codeVerifier;
    if (!value) {
      throw new Error(`No pending authorization for MCP server "${this.options.serverId}"`);
    }
    return value;
  }

  async invalidateCredentials(
    scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery',
  ): Promise<void> {
    if (scope === 'all') {
      await this.options.storage.delete(this.options.serverId);
      return;
    }
    await this.mutate((record) => {
      if (scope === 'tokens') delete record.tokens;
      if (scope === 'client') delete record.clientInformation;
      if (scope === 'discovery') delete record.discovery;
      if (scope === 'verifier') {
        delete record.codeVerifier;
        delete record.pendingRedirectUrl;
        delete record.pendingServerUrl;
        delete record.pendingState;
      }
    });
  }

  /** The redirect URL a pending authorization was started with, so the
   * token exchange after the callback reuses the exact registered value. */
  async pendingRedirectUrl(): Promise<string | undefined> {
    return (await this.read()).pendingRedirectUrl;
  }

  /** Reads the record, enforcing the endpoint binding: a record issued for
   * a different server URL is dropped, never replayed — the config may have
   * been edited (even offline) to point the same id at a new endpoint. A
   * record carrying credential material with NO binding at all fails closed
   * the same way: provenance cannot be established after first use, so a
   * legacy or hand-written record is revoked rather than adopted — the user
   * logs in again and the fresh record binds on its first save. */
  private async read(): Promise<McpOAuthRecord> {
    const record = await this.options.storage.get(this.options.serverId);
    if (!record) return {};
    if (this.bindingMismatch(record)) {
      await this.options.storage.delete(this.options.serverId);
      return {};
    }
    return record;
  }

  private bindingMismatch(record: McpOAuthRecord): boolean {
    const boundable =
      record.tokens ||
      record.clientInformation ||
      record.codeVerifier ||
      record.discovery ||
      record.pendingRedirectUrl ||
      record.pendingServerUrl ||
      record.pendingState;
    return Boolean(boundable) && record.serverUrl !== this.options.serverUrl;
  }

  /** The same fail-closed binding rule as read(), applied to a mutation
   * basis: a record bound elsewhere contributes NOTHING to the new write —
   * only the coordinator's bookkeeping survives. Without this, an atomic
   * update after an offline endpoint change would carry the old endpoint's
   * tokens, client and discovery into the record it re-stamps for the new
   * URL — a rebinding read() alone cannot prevent. */
  private stripUnbound(record: McpOAuthRecord): McpOAuthRecord {
    if (!this.bindingMismatch(record)) return record;
    const kept: McpOAuthRecord = {};
    if (record.version !== undefined) kept.version = record.version;
    if (record.generation !== undefined) kept.generation = record.generation;
    return kept;
  }

  private async mutate(apply: (record: McpOAuthRecord) => void): Promise<void> {
    const stamp = (record: McpOAuthRecord): McpOAuthRecord => {
      apply(record);
      record.serverUrl = this.options.serverUrl;
      return record;
    };
    // The coordinator-provided storage view makes read-apply-write one
    // atomic lane operation; plain backends (tests) fall back to two calls.
    if (this.options.storage.update) {
      await this.options.storage.update(this.options.serverId, (record) =>
        stamp(this.stripUnbound({ ...record })),
      );
      return;
    }
    const record = await this.read();
    await this.options.storage.set(this.options.serverId, stamp(record));
  }
}
