---
doc_id: architecture.amazon-bedrock-sso-auth
title: "Cloud-native provider auth: Amazon Bedrock with IAM Identity Center"
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

# Cloud-native provider auth: Amazon Bedrock with IAM Identity Center

## 1. Status and scope

> **Status: draft design, not implemented.** This document is the contract for review in
> #6072. No production code lands until the contract is accepted. Implementation then lands in
> the slices of §9, each as its own pull request.

In scope: **Amazon Bedrock with AWS IAM Identity Center** (`amazon-bedrock`). This covers
device-authorization sign-in, account and role selection, and SigV4 signing with short-lived
role credentials.

Out of scope:

- The API-key entries `amazon-bedrock-api-key` and `azure-foundry` from #6032. This design does
  not change them.
- Azure AI Foundry with Microsoft Entra ID (`azure-foundry-entra`). It is a follow-up that can
  reuse this contract (§10).
- Portable export of a sign-in session between Hosts (see §5.4).

This design replaces the implementation in #3370. That pull request was closed by the stale bot,
not rejected. Its review findings are kept here as invariants (§6), so the new slices start from
them and do not find them again in review.

## 2. Decisions

These answer the three open questions in #6072. They apply to every cloud-native entry, not only
to Bedrock.

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
| `azure-foundry-entra` | Entra ID → bearer token | Runtime Host | follow-up (§10) |

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
provider ids. The name is generic so that a later Entra entry uses the same kind.

### 3.2 Credential vault kind

Add one connection credential kind, `cloud_identity_session`, to `decodeCredentialLocator`
(`packages/core/src/runtime-policy/credential-vault-codec.ts`). The secret is a versioned,
provider-tagged document. This design defines only the AWS variant:

```ts
type CloudIdentitySession = {
  v: 1;
  provider: 'aws-iam-identity-center';
  startUrl: string;
  ssoRegion: string;
  clientId: string;
  clientSecret: string;
  clientSecretExpiresAt: number;
  accessToken: string;
  accessTokenExpiresAt: number;
  refreshToken?: string;
};
```

Only the Host decodes this document. AWS role credentials are **never** in it.

### 3.3 Connection configuration

Non-secret identity lives in the `amazon-bedrock` connection entry, so the catalog shows which
identity a connection uses without reading the vault: `ssoStartUrl`, `ssoRegion`, `region`,
`accountId`, `roleName`.

`decodeCanonicalConnectionCatalogEntry` accepts exactly one canonical `amazon-bedrock`
connection (see I8).

### 3.4 Compatibility epoch

Slice S1 raises `RUNTIME_HOST_COMPATIBILITY_EPOCH` (228 on `main` at the time of writing), because
older clients reject catalog pages with the new provider type and the new vault kind. The value
is rechecked against `main` and open pull requests (#6032 also raises it) immediately before
merge.

## 4. Ownership and data classes

| Data | Lives in | Persisted | Crosses the Host protocol |
| --- | --- | --- | --- |
| Device code, OIDC client secret, access and refresh tokens | Host | vault (`cloud_identity_session`), `0600`, atomic write | **Never** |
| AWS role credentials | Host memory | **Never** | **Never** |
| User code, verification URL, expiry | Host attempt | No | Yes, attempt projection |
| Account and role lists | Host attempt | No | Yes, bounded projections |
| Selected identity (account + role) | connection entry | Yes | Yes |

**Remote (SSH) Host.** The device flow runs on the Host. The client only opens the verification
URL in a local browser, so sign-in works from any machine. The Host never opens a browser. A
credential chain is always the Host machine's chain, never the client's (see Q1).

## 5. Host protocol contract

### 5.1 Operations

The operation family has a generic name, so that a later Entra entry adds typed inputs instead of
a second family. This design defines only the `amazon-bedrock` inputs.

| Operation | Mode | Input | Output |
| --- | --- | --- | --- |
| `cloud_identity.login.start` | command | `attemptId`, `providerType`, `ssoStartUrl`, `ssoRegion`, `region` | attempt projection |
| `cloud_identity.login.query` | query | `attemptId` | attempt projection |
| `cloud_identity.login.cancel` | control | `attemptId` | attempt projection |
| `cloud_identity.scopes.list` | query | `attemptId`, optional `accountId` | accounts, or the roles of one account |
| `cloud_identity.models.fetch` | command | `attemptId`, `accountId`, `roleName`, `manualModelIds` | `models`, `inventoryId` |
| `cloud_identity.onboarding.commit` | command | `attemptId`, `accountId`, `roleName`, `inventoryId`, `enabledModelIds` | `connectionId`, `slug`, `outcome: 'created' \| 'reauthorized'` |

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
| I2 | **One abort signal per attempt.** Device polling, account and role listing, role credential resolution, model discovery, and manual probes all take the attempt signal. `login.cancel` aborts all of them. An attempt that is not committed expires after a bounded TTL. | P1, cancel scope |
| I3 | **Commit binds the selected identity.** `models.fetch` returns an `inventoryId` bound to the account and role it used. `onboarding.commit` sends the selected account, role, and `inventoryId`. The Host validates them atomically and returns `selection_stale` on a mismatch. The UI clears the model list when the account or role changes. | P1, role switch |
| I4 | **Commit is tracked by shutdown.** Commit takes an immutable snapshot of the attempt, then registers the whole mutation and backend invalidation as in-flight work. `close()` waits for it. After durable commit starts, cancel does not change the snapshot. | P1, untracked commit |
| I5 | **Durable outcome first.** The commit result is recorded and replayable before backend invalidation. If invalidation fails, the durable success stays and activation is poisoned, the same rule as `runtime-policy-coordinator.ts`. | P1, persistence failure |
| I6 | **No ambient identity.** An `amazon-bedrock` connection uses only its explicit credential provider. Execution and discovery force SigV4, so `AWS_BEARER_TOKEN_BEDROCK` and other `AWS_*` variables have no effect. | P1, ambient bearer |
| I7 | **No export of sessions.** See §5.4. | P1, export |
| I8 | **One canonical connection.** A second sign-in re-authorizes the existing canonical `amazon-bedrock` connection. It never derives an `amazon-bedrock-2` slug. Commit returns the committed connection by id. | P1, canonical storage |
| I9 | **Bounded, abortable refresh.** Session refresh and `GetRoleCredentials` use the existing operation and connection deadlines, are single-flight per connection, and are aborted by Host close. | P2, refresh deadline |
| I10 | **Generation-bound refresh.** Refresh writes with compare-and-swap on the credential generation. Logout or a new sign-in invalidates in-memory credentials, and a late refresh cannot bring back an old generation. | #3370 design |
| I11 | **Role credentials stay in memory.** They refresh 5 minutes before expiry and are never persisted, logged, or sent in a protocol frame. | #6072 comment |
| I12 | **No request mutation after signing.** `amazon-bedrock` connections reject custom request headers and body overlays. | #3370 design |
| I13 | **Control-plane traffic uses the scoped fetch.** AWS SDK traffic (SSO OIDC, SSO portal, Bedrock control plane) goes through Maka's scoped fetch and proxy boundary. | #3370 design |

## 7. Execution

### 7.1 Inference and discovery

- Inference uses Bedrock Converse and ConverseStream through `@ai-sdk/amazon-bedrock`, with an
  explicit `credentialProvider` and SigV4 forced (I6). The `ai` dependency stays at the workspace
  version.
- Discovery lists foundation models and inference profiles for the selected role and region.
  Manual model ids are validated with a minimal Converse probe that uses the attempt signal (I2).
- Inference profiles inherit capabilities and pricing from their source model.

### 7.2 Model metadata and pricing

Bedrock metadata and pricing come from the existing `sync:model-metadata`,
`refresh:model-metadata`, and `check:model-metadata` authority (`scripts/sync-model-metadata.mjs`).
There is no second generator script.

## 8. Required tests

| Area | Test |
| --- | --- |
| Core | `deriveProviderAuthContract` for `cloud_identity`. Locator decoding of `cloud_identity_session`. Canonical catalog decoding of `amazon-bedrock`. |
| Protocol | Exact and bounded decoders. Export of `cloud_identity_session` returns `credential_not_exportable` (I7). No secret field in any projection (protocol secret-boundary test). Mixed-epoch handshake is refused. |
| Host lifecycle | Concurrent start (I1). Cancel after authentication aborts listing and probes (I2). Role switch then commit returns `selection_stale` (I3). Close during commit waits (I4). Invalidation failure keeps success and poisons activation (I5). Second setup reads back one canonical connection (I8). Stalled refresh is bounded and aborted by close (I9). Logout during refresh does not revive (I10). |
| Execution | With `AWS_BEARER_TOKEN_BEDROCK` set, requests are SigV4-signed and the explicit provider is called (I6). Custom headers are rejected (I12). |
| Renderer | Drive sign-in through a fake bridge to role selection. Select role A, load models, select role B: the model list is cleared (I3). |
| Live evidence | One plain turn and one tool call with tool result, with IAM Identity Center credentials, on a foundation model and an inference profile. Results are recorded in the pull request without account ids, tokens, or request ids. |

## 9. Delivery slices

| Slice | Content | Depends on |
| --- | --- | --- |
| S0 | This document. | — |
| S1 | Core: `amazon-bedrock` registry entry, `cloud_identity` auth kind, vault kind, catalog decoding, export denial, epoch raise. | S0 accepted, #6032 |
| S2 | Host: Bedrock coordinator and execution authority (I1–I13), Runtime Bedrock adapter, metadata through §7.2. | S1 |
| S3 | Desktop and CLI sign-in flow on Astryx primitives, with screenshots in the pull request. Live evidence. | S2 |

Rules for every slice:

- Each new source and generated file has the ASF header (`npm run check:asf-headers`).
- `SECURITY.md` gets one description of the cloud credential authority, written once in S2.
- No unrelated surface. The Claude subscription additions that were in #3370 are not carried
  over.

## 10. Follow-up: Azure AI Foundry with Entra ID

Not in scope. A later `azure-foundry-entra` entry can reuse this contract without changing it:
the `cloud_identity` auth kind, a new `provider` variant of `cloud_identity_session`, typed
inputs on the `cloud_identity.*` operations, and the same Host ownership and invariants. Its own
questions (application registration, tenant selection, resource and project endpoints) belong
to that design.

## 11. Open questions

1. **Host credential chain.** Is a `host_default_chain` credential source (`~/.aws` and
   environment on the Host machine) part of the first release, or a later option? If included,
   it is an explicit choice per connection and is never a fallback for the device flow (I6).
2. **Operation family.** Is the generic `cloud_identity.*` family (§5.1) preferred, or a
   Bedrock-specific `bedrock.sso.*` family as in #3370?
