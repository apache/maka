---
doc_id: architecture.cloud-native-provider-auth
title: "Cloud-native provider auth: Amazon Bedrock and Azure AI Foundry"
language: en
source_language: en
implementation_status: proposed
document_status: draft
translation_status: source-only
last_verified: 2026-10-23
owners:
  - maka-backend
---
<!--
  Licensed to the Apache Software Foundation (ASF) under one
  or more contributor license agreements.  See the NOTICE file
  distributed with this work for additional information
  regarding copyright ownership.  The ASF licenses this file
  to you under the Apache License, Version 2.0 (the
  "License"); you may not use this file except in compliance
  with the License.  You may obtain a copy of the License at

      http://www.apache.org/licenses/LICENSE-2.0

  Unless required by applicable law or agreed to in writing,
  software distributed under the License is distributed on an
  "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
  KIND, either express or implied.  See the License for the
  specific language governing permissions and limitations
  under the License.
-->

# Cloud-native provider auth: Amazon Bedrock and Azure AI Foundry

## 1. Status and scope

> **Status: draft design, not implemented.** This document is the contract for review in
> #6072. No production code lands until the contract is accepted. Implementation then lands in
> the slices of §9, each as its own pull request.

In scope:

- **Amazon Bedrock with AWS IAM Identity Center** (`amazon-bedrock`): device-authorization
  sign-in, account and role selection, SigV4 signing with short-lived role credentials.
- **Azure AI Foundry with Microsoft Entra ID** (`azure-foundry-entra`): device-code sign-in,
  tenant selection, token refresh, resource and project endpoints.

Out of scope:

- The API-key entries `amazon-bedrock-api-key` and `azure-foundry` from #6032. This design does
  not change them.
- Portable export of a cloud sign-in session between Hosts (see §5.4).

This design replaces the implementation in #3370. That pull request was closed by the stale bot,
not rejected. Its review findings are kept here as invariants (§6), so the new slices start from
them and do not find them again in review.

## 2. Decisions

These answer the three open questions in #6072.

| Question | Decision |
| --- | --- |
| One entry per cloud, or one entry per auth method? | **One entry per auth method.** Each `providerType` keeps exactly one `authKind`, as `deriveProviderAuthContract` (`packages/core/src/provider-auth.ts`) requires today. No connection changes its auth kind in place. |
| Where do credentials and refresh live? | **In the Runtime Host.** The Host owns the device flow, the refresh material, and the short-lived credentials. Desktop and the CLI show only the user code and the verification URL. |
| What happens to an existing API-key connection? | **Coexistence, no migration.** The ids differ, so an API-key connection keeps working next to a new cloud-native connection. A user switches by adding the new connection. |

### 2.1 Provider entries

| `providerType` | Auth | Owner | Source |
| --- | --- | --- | --- |
| `amazon-bedrock-api-key` | Bedrock API key | existing vault (`api_key`) | #6032 |
| `amazon-bedrock` | IAM Identity Center → SigV4 | Runtime Host | this design |
| `azure-foundry` | Foundry API key | existing vault (`api_key`) | #6032 |
| `azure-foundry-entra` | Entra ID → bearer token | Runtime Host | this design |

## 3. Core contract changes

### 3.1 Auth kind

Add one registry auth kind, `cloud_identity`, to `ProviderDefaults.authKind`
(`packages/core/src/provider-registry.ts`). `deriveProviderAuthContract` treats it like
`oauth_token` for availability:

- `test_credentials` and `fetch_models` are available only when a session is stored.
- `start_oauth` is **not** used. Sign-in goes through the operations in §5.1, so the generic
  OAuth path cannot start a cloud sign-in by accident.

A new auth kind, and not `oauth_token`, keeps two rules simple: the generic OAuth coordinator
never sees these providers, and the export denial in §5.4 is a kind check, not a list of
provider ids.

### 3.2 Credential vault kind

Add one connection credential kind, `cloud_identity_session`, to `decodeCredentialLocator`
(`packages/core/src/runtime-policy/credential-vault-codec.ts`). The secret is a versioned,
provider-tagged document:

```ts
type CloudIdentitySession =
  | {
      v: 1;
      provider: 'aws-iam-identity-center';
      startUrl: string; ssoRegion: string;
      clientId: string; clientSecret: string; clientSecretExpiresAt: number;
      accessToken: string; accessTokenExpiresAt: number;
      refreshToken?: string;
    }
  | {
      v: 1;
      provider: 'entra-id';
      authority: string; tenantId: string; clientId: string;
      refreshToken: string; scope: string;
    };
```

Only the Host decodes this document. Short-lived credentials (AWS role credentials, Entra access
tokens) are **never** in it.

### 3.3 Connection configuration

Non-secret identity lives in the connection entry, so the catalog shows which identity a
connection uses without reading the vault:

| Provider | Configuration fields |
| --- | --- |
| `amazon-bedrock` | `ssoStartUrl`, `ssoRegion`, `region`, `accountId`, `roleName` |
| `azure-foundry-entra` | `tenantId`, `endpoint` (resource or project), `endpointKind` (`resource` \| `project`) |

`decodeCanonicalConnectionCatalogEntry` accepts exactly one canonical connection per provider
for these two entries (see I8).

### 3.4 Compatibility epoch

Slice S1 raises `RUNTIME_HOST_COMPATIBILITY_EPOCH` (228 on `main` at the time of writing), because
older clients reject catalog pages with the new provider types and the new vault kind. The value
is rechecked against `main` and open pull requests (#6032 also raises it) immediately before
merge.

## 4. Ownership and data classes

| Data | Lives in | Persisted | Crosses the Host protocol |
| --- | --- | --- | --- |
| Device code, OIDC client secret, access and refresh tokens | Host | vault (`cloud_identity_session`), `0600`, atomic write | **Never** |
| AWS role credentials, Entra access tokens | Host memory | **Never** | **Never** |
| User code, verification URL, expiry | Host attempt | No | Yes, attempt projection |
| Account, role, tenant lists | Host attempt | No | Yes, bounded projections |
| Selected identity (account + role, or tenant + endpoint) | connection entry | Yes | Yes |

**Remote (SSH) Host.** The device flow runs on the Host. The client only opens the verification
URL in a local browser, so sign-in works from any machine. The Host never opens a browser. A
credential chain is always the Host machine's chain, never the client's (see Q2).

## 5. Host protocol contract

### 5.1 Operations

One operation family serves both clouds. The provider-specific steps are typed inputs, not
separate families.

| Operation | Mode | Input | Output |
| --- | --- | --- | --- |
| `cloud_identity.login.start` | command | `attemptId`, `providerType`, provider start fields | attempt projection |
| `cloud_identity.login.query` | query | `attemptId` | attempt projection |
| `cloud_identity.login.cancel` | control | `attemptId` | attempt projection |
| `cloud_identity.scopes.list` | query | `attemptId`, optional parent scope (AWS: `accountId`) | AWS: accounts, or roles of one account. Entra: tenants |
| `cloud_identity.models.fetch` | command | `attemptId`, selected identity, `manualModelIds` | `models`, `inventoryId` |
| `cloud_identity.onboarding.commit` | command | `attemptId`, selected identity, `inventoryId`, `enabledModelIds` | `connectionId`, `slug`, `outcome: 'created' \| 'reauthorized'` |

Provider start fields:

- `amazon-bedrock`: `ssoStartUrl`, `ssoRegion`, `region`.
- `azure-foundry-entra`: `tenant` (id, domain, or `organizations`), `endpoint`.

Attempt projection:

```ts
interface CloudIdentityLoginProjection {
  attemptId: string;
  phase: 'awaiting_authorization' | 'authenticated' | 'cancelled' | 'failed' | 'expired';
  userCode?: string;          // only in awaiting_authorization
  verificationUri?: string;   // only in awaiting_authorization
  expiresAt?: number;         // only in awaiting_authorization
  failure?: 'authorization_failed' | 'provider_rejected' | 'internal_failure';
}
```

Every decoder is exact and bounded (lists ≤ 1,024 items, projections ≤ 256 KiB), as in the
#3370 decoders.

### 5.2 Error codes

`attempt_not_found`, `attempt_superseded`, `selection_stale`, `inventory_stale`,
`provider_rejected`, `permission_denied`, `persistence_failed`, `host_closing`,
`internal_failure`.

### 5.3 Access authority

All six operations are available to the local owner and to a `remote_owner`, because no output
carries secret material. They are not available to `capability_provider` or `session_guest`.

### 5.4 Credential export

`configuration.credentials.export` (`packages/runtime-host/src/server/configuration-coordinator.ts`)
**rejects** a `cloud_identity_session` locator with a typed `credential_not_exportable` error,
before it reads the vault. Desktop configuration export omits these sessions, and import marks
the connection as needing sign-in again. Portable session export needs its own authorization and
encryption design and is out of scope.

## 6. Invariants

Each invariant names the #3370 finding it comes from. Each one has a regression test in §8.

| # | Invariant | From |
| --- | --- | --- |
| I1 | **Serialized admission.** `login.start` takes an admission lease. A superseding start waits for the in-flight start and its settlement before it clears the attempt. No device flow polls without an owning attempt. | P2, coordinator `#start` |
| I2 | **One abort signal per attempt.** Device polling, scope listing, role credential resolution, model discovery, and manual probes all take the attempt signal. `login.cancel` aborts all of them. An attempt that is not committed expires after a bounded TTL. | P1, cancel scope |
| I3 | **Commit binds the selected identity.** `models.fetch` returns an `inventoryId` bound to the identity it used. `onboarding.commit` sends the selected identity and `inventoryId`. The Host validates both atomically and returns `selection_stale` on a mismatch. The UI clears the model list when the account, role, tenant, or endpoint changes. | P1, role switch |
| I4 | **Commit is tracked by shutdown.** Commit takes an immutable snapshot of the attempt, then registers the whole mutation and backend invalidation as in-flight work. `close()` waits for it. After durable commit starts, cancel does not change the snapshot. | P1, untracked commit |
| I5 | **Durable outcome first.** The commit result is recorded and replayable before backend invalidation. If invalidation fails, the durable success stays and activation is poisoned, the same rule as `runtime-policy-coordinator.ts`. | P1, persistence failure |
| I6 | **No ambient identity.** A `cloud_identity` connection uses only its explicit credential provider. Bedrock execution and discovery force SigV4, so `AWS_BEARER_TOKEN_BEDROCK` and other `AWS_*` variables have no effect. Entra execution does not use an environment or default credential chain. | P1, ambient bearer |
| I7 | **No export of sessions.** See §5.4. | P1, export |
| I8 | **One canonical connection.** A second sign-in for the same provider re-authorizes the existing canonical connection. It never derives a `-2` slug. Commit returns the committed connection by id. | P1, canonical storage |
| I9 | **Bounded, abortable refresh.** Session refresh and short-lived credential requests (`GetRoleCredentials`, Entra token refresh) use the existing operation and connection deadlines, are single-flight per connection, and are aborted by Host close. | P2, refresh deadline |
| I10 | **Generation-bound refresh.** Refresh writes with compare-and-swap on the credential generation. Logout or a new sign-in invalidates in-memory credentials, and a late refresh cannot bring back an old generation. | #3370 design |
| I11 | **Short-lived credentials stay in memory.** They refresh 5 minutes before expiry and are never persisted, logged, or sent in a protocol frame. | #6072 comment |
| I12 | **No request mutation after signing.** Signed connections reject custom request headers and body overlays. Bearer connections reject a custom `Authorization` header. | #3370 design |
| I13 | **Control-plane traffic uses the scoped fetch.** AWS SDK and Entra token traffic goes through Maka's scoped fetch and proxy boundary. | #3370 design |

## 7. Execution

### 7.1 Amazon Bedrock

- Inference uses Bedrock Converse and ConverseStream through `@ai-sdk/amazon-bedrock`, with an
  explicit `credentialProvider` and SigV4 forced (I6). The `ai` dependency stays at the workspace
  version.
- Discovery lists foundation models and inference profiles for the selected role and region.
  Manual model ids are validated with a minimal Converse probe that uses the attempt signal (I2).
- Inference profiles inherit capabilities and pricing from their source model.

### 7.2 Azure AI Foundry with Entra ID

- Sign-in uses the OAuth 2.0 device authorization grant against the selected tenant.
- The token audience follows the endpoint kind:
  - resource endpoint (`/openai/v1`, `/anthropic`): `https://cognitiveservices.azure.com/.default`;
  - project endpoint (`…/api/projects/<project>`): `https://ai.azure.com/.default`.
  Both values are confirmed in the S4 live run before merge.
- Execution reuses the protocol adapters of the `azure-foundry` entry. Only the credential source
  changes: a bearer token from the Host authority instead of an API key.
- Discovery uses the protocol model list where the endpoint offers one, and manual model ids
  otherwise.

### 7.3 Model metadata and pricing

Bedrock metadata and pricing come from the existing `sync:model-metadata`,
`refresh:model-metadata`, and `check:model-metadata` authority (`scripts/sync-model-metadata.mjs`).
There is no second generator script.

## 8. Required tests

| Area | Test |
| --- | --- |
| Core | `deriveProviderAuthContract` for `cloud_identity`. Locator decoding of `cloud_identity_session`. Canonical catalog decoding for both entries. |
| Protocol | Exact and bounded decoders. Export of `cloud_identity_session` returns `credential_not_exportable` (I7). No secret field in any projection (protocol secret-boundary test). Mixed-epoch handshake is refused. |
| Host lifecycle | Concurrent start (I1). Cancel after authentication aborts scope listing and probes (I2). Role switch then commit returns `selection_stale` (I3). Close during commit waits (I4). Invalidation failure keeps success and poisons activation (I5). Second setup reads back one canonical connection (I8). Stalled refresh is bounded and aborted by close (I9). Logout during refresh does not revive (I10). |
| Execution | With `AWS_BEARER_TOKEN_BEDROCK` set, requests are SigV4-signed and the explicit provider is called (I6). Custom headers are rejected (I12). |
| Renderer | Drive sign-in through a fake bridge to role selection. Select role A, load models, select role B: the model list is cleared (I3). |
| Live evidence | Bedrock: one plain turn, one tool call and tool result, with SSO credentials. Foundry Entra: the same on a resource endpoint and a project endpoint. Results are recorded in the pull request without account ids, tokens, or request ids. |

## 9. Delivery slices

| Slice | Content | Depends on |
| --- | --- | --- |
| S0 | This document. | — |
| S1 | Core: registry entries, `cloud_identity` auth kind, vault kind, catalog decoding, export denial, epoch raise. | S0 accepted, #6032 |
| S2 | Host: Bedrock coordinator and execution authority (I1–I13), Runtime Bedrock adapter, metadata through §7.3. | S1 |
| S3 | Desktop and CLI sign-in flow on Astryx primitives, with screenshots in the pull request. | S2 |
| S4 | Foundry Entra: Host authority, endpoint kinds, Desktop and CLI flow, live evidence. | S1, S3 |

Rules for every slice:

- Each new source and generated file has the ASF header (`npm run check:asf-headers`).
- `SECURITY.md` gets one description of the cloud credential authority, written once in S2 and
  extended in S4.
- No unrelated surface. The Claude subscription additions that were in #3370 are not carried
  over.

## 10. Open questions

1. **Entra client id.** Device-code sign-in needs a public client application registration.
   Does the project register one multi-tenant Maka application, or does the user supply a
   client id (with an optional default)?
2. **Host credential chain.** Is a `host_default_chain` credential source (`~/.aws`,
   environment, Azure CLI, managed identity on the Host machine) part of the first release, or a
   later option? If included, it is an explicit choice per connection and is never a fallback for
   the device flow (I6).
3. **Operation family.** Is one `cloud_identity.*` family (§5.1) preferred, or separate
   `bedrock.sso.*` and `azure.entra.*` families as in #3370?
4. **Foundry deployment discovery.** Is listing deployments through Azure Resource Manager
   needed, or are the protocol model list and manual model ids enough for the first release?
