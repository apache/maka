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

# PR-OAUTH-SUBSCRIPTION-0 Gate

> Archived on 2026-07-13. The gate predates the current subscription send path; source, tests, and `SECURITY.md` own current behavior.

Scope: Claude subscription authentication, account state, and quota display only.
The chat send path remains blocked until a later runtime-smoke PR.

## Product Decisions

- Claude subscription only. Codex, Gemini, and Copilot are separate PRs.
- Settings placement is `账号`; model settings only consume readiness.
- Cloaked Claude Code headers are default-off and must stay behind `MAKA_CLAUDE_SUBSCRIPTION_CLOAK=1`.
- Quota v1 displays only values returned by the provider endpoint: window utilization and fetch time.

## Blocking Gates

- Tokens stay in the main process. Renderer, preload, and shared UI must not expose `access_token`, `refresh_token`, `id_token`, or camelCase variants.
- Token persistence requires Electron `safeStorage` encryption and file mode `0o600`. If encryption is unavailable, login fails closed instead of writing plaintext.
- PKCE verifier and OAuth state are main-process only. Paste-code completion must validate TTL, strict shape, and state, then consume pending auth before the token exchange network call.
- The token exchange request must send the pasted OAuth state, not the PKCE verifier, when those values are distinct.
- Refresh failure sets `refresh_failed` and does not delete the token file automatically.
- `oauth_token` providers must not pass `isConnectionReady` / `requireReadyConnection` until the subscription send path is implemented and runtime-smoked.
- The cloak module must be isolated from the default request path. Default code must not statically import cloaked request helpers.
- Account UI must not claim operational readiness. Authenticated means account/quota visible only.

## Logout Revoke Gate

PR-OAUTH-SUBSCRIPTION-0 requires local clear:

- Delete the local token file. Missing file (`ENOENT`) counts as already cleared.
- Clear in-memory tokens, profile, quota, pending authorizations, and diagnostic state.
- If local deletion fails, return `storage_failed`; UI must not show logout success.

Remote OAuth revocation is not required for this PR because Anthropic does not expose a public RFC 7009 revocation endpoint as of 2026-05-28. reference implementation's `ld.logout` path also local-clears only (local reference excerpt). Do not call non-public or guessed revocation endpoints.

If Anthropic publishes a revocation endpoint, add `PR-OAUTH-SUBSCRIPTION-LOGOUT-REVOKE-0` with remote revoke, local clear fallback semantics, and negative tests.
