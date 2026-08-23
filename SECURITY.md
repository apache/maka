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

# Maka Security Policy

This document names the trust boundaries Maka treats as load-bearing,
the in-process safety nets it ships but does NOT treat as boundaries,
and how to report a vulnerability.

It is modeled after [hermes-agent's SECURITY.md][hermes-agent-sec] and
shares the same honesty principle: the only enforcement boundary
against an adversarial LLM is the operating system. Anything the
agent process screens internally is a heuristic operating on an
attacker-influenced string.

[hermes-agent-sec]: https://github.com/NousResearch/hermes-agent/security

## 1. Reporting a vulnerability

Report privately by emailing **security@maka.app** (or open a
private GitHub Security Advisory once that's enabled). Please do
NOT open public issues for security vulnerabilities.

Useful reports include:

- A concise description and severity assessment.
- The affected component, identified by file path and line range
  (e.g. `apps/desktop/src/main/main.ts:120-145`).
- Environment details (`maka` version from the About page, OS,
  Node / Electron version, recent commit SHA).
- A reproduction against `main` or the latest release.
- Which boundary in §2 you believe is crossed.

Read §2 and §3 before submitting. Reports that demonstrate limits
of an in-process heuristic this policy does not treat as a
boundary will be closed as out-of-scope, but they are still
welcome as ordinary issues or pull requests.

## 2. Trust model

Maka is a single-tenant personal desktop AI assistant. It runs as
the user's own OS account. The trust model has multiple layers,
and they are NOT equally load-bearing.

### 2.1 Definitions

- **Agent process.** The Electron main process and any code it
  loads (`@maka/core`, `@maka/runtime`, `@maka/storage`,
  `@maka/ui`, builtin tools, user skills).
- **Renderer process.** Electron's sandboxed renderer. Receives
  data only through the preload IPC bridge in
  `apps/desktop/src/preload/preload.ts`.
- **Permission engine.** `@maka/core/permission` evaluates each tool
  category against the selected mode. `PERMISSION_MODES`,
  `TOOL_CATEGORIES`, and `PERMISSION_POLICY` are the exact authority;
  this policy does not duplicate their inventory.
- **Permission mode.** Per-session user setting. `ask` is the default;
  its exact allow, prompt, and block decisions come from
  `PERMISSION_POLICY`.
- **Input surface.** Any channel through which content enters the
  agent's context: chat input, file reads, web fetches, enabled bot-platform
  messages, tool results, and future external integrations.
- **Trust envelope.** The set of resources Maka inherits from the
  user's OS account: filesystem, network, OS permissions
  (Keychain / Microphone / Screen recording).

### 2.2 The boundary: the OS user account

**The only enforcement boundary against an adversarial LLM is the
operating system.** Nothing inside the agent process constitutes
containment — not the permission engine, not output redaction,
not URL allowlists, not query normalization, not the WebSearch
fail-closed chain.

Every in-process component that screens LLM output is a heuristic
operating on a string the LLM partially controlled. We ship them
because they are useful UX safety nets — they catch accidental
output and slow down adversarial output enough for a human to
notice — but we do not ship them as guarantees.

Maka does not run tools in a separate process or container by default. The
runtime exposes a macOS Seatbelt command transformer for restricted profiles,
but current product compositions do not yet route command execution through
it, so it is not a product boundary today. Externally isolated runtimes may
supply their own boundary. See
[`packages/runtime/src/sandbox/README.md`](./packages/runtime/src/sandbox/README.md).

### 2.3 Boundaries we DO treat as load-bearing

1. **OS user account.** Tools run with the user's privileges. The
   user is expected to run Maka as a non-admin account on systems
   where that matters.
2. **Credential-at-rest boundaries.** The provider credential store
   writes `credentials.json` as versioned plaintext JSON under the
   user's workspace directory. Its load-bearing boundary is the OS
   user account plus filesystem controls: directory mode 0o700,
   file mode 0o600, atomic writes, and no symlink/traversal escape.
   Subscription OAuth tokens (Claude, Codex, GitHub Copilot, and xAI) live in
   the same store: `credentials.json`
   is the single authority every Runtime Host surface — Desktop, TUI, CLI —
   reads and writes, under the same OS-account and 0o700/0o600 boundary
   as other runtime credentials. Electron safeStorage is not part of
   this boundary anymore. Pre-existing safeStorage-encrypted credential
   or token files are not imported; users with only those copies must
   re-authenticate.
3. **Renderer process sandbox + preload IPC bridge.** The
   renderer cannot reach files, network, or shell directly. Every
   IPC handler in `apps/desktop/src/main/main.ts` is the trust
   boundary between renderer-controlled input and main-process
   action. Renderer code is treated as semi-trusted: it can read
   masked / sanitized data, but cleartext secrets never cross the
   boundary in the main-to-renderer direction (see §4).
4. **Settings sensitive masking.** Tokens, API keys, and proxy
   passwords are masked at the IPC store boundary
   (`maskAppSettings` in `apps/desktop/src/main/settings-ipc-helpers.ts`).
   Re-submitting the mask sentinel `••••••` is interpreted as
   "keep current" by the merge logic; an empty string is
   interpreted as an explicit clear. The Tavily API key follows the
   same boundary.
5. **Network egress through user-configured proxies.** The
   `network.proxy` settings drive Electron's session proxy. Tools
   that bypass `proxiedFetch` (Tavily lives in main, uses
   standard fetch) are individually audited.

### 2.4 Heuristics we ship but DO NOT treat as boundaries

These are valuable UX safety nets. Reports that limit one of them
are welcome as ordinary issues, not security advisories.

1. **Permission engine.** Prompts the user before
   destructive / file-write / shell-unsafe / web-egress tools. A
   determined adversarial LLM can still construct tool sequences that
   the user accepts (social engineering). The OS is the boundary,
   the engine is the UX.
2. **`redactSecrets()` output sanitizer.** Best-effort pattern
   matcher applied at every text→DOM crossing
   (`packages/ui/src/redact.ts`). Slows down accidental token
   echo; does not catch novel formats.
3. **`normalizeSearchUrl()` URL allowlist.** Filters non-http(s)
   URLs out of agent tool results before they reach a renderer
   `<a href>`.
4. **`PermissionMode.ask`** as default. Mode names are UX controls,
   not security boundaries; even permissive modes remain subject to
   the current policy table and OS isolation boundary.
5. **Modal-lifecycle contract test.** Catches the React
   `useEffect`-before-`if (!open) return null` pattern that can
   violate React hook ordering. Static analysis only.
6. **WebSearch fail-closed chain.** `invalid_query →
   incognito_active → not_configured → invalid_credentials`. All
   four return generalized Chinese copy without ever revealing
   the API key, the raw provider body, or which gate tripped.

### 2.5 Privacy contract

Beyond security, Maka treats the following as user-facing
privacy commitments:

- **Workspace state stays local.** Session messages, tool
  results, telemetry, settings are stored under
  `app.getPath('userData')`. Cloud sync is not shipped.
- **Tool query strings are NEVER logged.** The WebSearch tool's
  `argsSummary` is scrubbed at the `recordToolInvocation` hook.
- **Incognito context.** When the workspace privacy context
  reports `incognitoActive: true`, the WebSearch tool fails
  closed before any network call. Main composition and focused
  consumer tests own the full enforcement inventory.
- **Token boundary.** Cleartext API keys / OAuth tokens / bot
  tokens NEVER cross the main→renderer IPC boundary.
  `apps/desktop/src/main/__tests__/web-search-boundary.test.ts` and
  `claude-subscription-ipc-boundary.test.ts` enforce this for Tavily
  and Claude subscription credentials.

## 3. Scope of vulnerability reports

A report is in scope when it demonstrates that a load-bearing
boundary in §2.3 was crossed. Examples:

- A renderer-supplied IPC payload reaches the filesystem outside
  the workspace or beyond an explicit user approval.
- `credentials.json` is written outside the workspace credential
  path, through a symlink/traversal escape, or with POSIX permissions
  looser than the 0o700/0o600 boundary.
- A production OAuth path writes or requires a safeStorage-encrypted
  token copy again. `credentials.json` is the single documented token
  authority; there is no safeStorage legacy import fallback.
- A cleartext secret crosses main→renderer IPC under any
  circumstance (including error paths, settings preview, IPC
  result envelopes, log lines).
- A tool intended to be permission-gated bypasses the
  PermissionEngine.

Reports against the §2.4 heuristics are out of scope as security
advisories. They are welcome as ordinary issues or pull requests.

## 4. Token boundary policy

This policy is explicit because it is the most frequent source of
misunderstanding.

**Cleartext bot / API / OAuth tokens cross the
main↔renderer IPC boundary in exactly one direction: the renderer
SUBMITS a token when the user pastes it into a Settings input.
The main process NEVER returns the cleartext token to the
renderer.**

Reads of `settings:get` return the bullet-mask sentinel `••••••`
for all sensitive fields. The renderer can detect "has a stored
value" vs "empty" by comparing against the sentinel, but cannot
ever see the value. An update payload that contains exactly the
sentinel is interpreted by
`mergeWebSearchSettings` (and its peers in `mergeSettings`) as
"keep current", so a round-trip through `settings:get →
settings:update` cannot accidentally overwrite the stored value.

Credential-test requests may submit an unsaved cleartext token so the
user can verify it before saving. The main process accepts it for that
single request and does not echo it in the response.

The static-analysis contract tests for this policy:
- `apps/desktop/src/main/__tests__/web-search-boundary.test.ts`
- `apps/desktop/src/main/__tests__/claude-subscription-ipc-boundary.test.ts`

## 5. Versioning

This policy applies to the current `main` branch and the latest
release. Older releases are not under active security maintenance.
If we ever cut a long-term support release we will say so in the
release notes.

## 6. Acknowledgement

The structure and several phrases of this document are adapted
from the [hermes-agent SECURITY.md][hermes-agent-sec]. Thanks to the
Nous Research team for setting the bar on honest agent security
framing.
