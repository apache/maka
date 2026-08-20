# Cryptography export inventory

Inventory of cryptographic functionality and dependencies in the Maka source tree, prepared to support the ASF export-control review tracked in [#3273](https://github.com/apache/maka/issues/3273) (G6 of #2974).

This document covers only the first exit criterion of #3273: the inventory itself, plus a recommendation on which filing path follows from it. It does not submit anything, and it is not a legal determination. The ASF VP of Legal Affairs, the PPMC, and the mentors own the determination.

## Scope and method

- **Snapshot:** `main` at `a6f33c952`, package version `0.1.11`.
- **Population:** files tracked by Git (`git ls-files`, 2701 files). Untracked working directories (`node_modules/`, `dist/`, `.worktree/`) are excluded from the source inventory but are examined separately where a shipped dependency matters.
- **Method:** targeted `git grep` over `*.ts`, `*.tsx`, `*.mjs`, `*.js`, `*.cjs`, `*.swift`, `*.toml`, plus dependency-graph queries against `package-lock.json`. Every row below cites a file path or a package name so it can be re-derived independently.

**Scope caveat — the source artifact is not yet defined.** There is no source-release assembly script in the repository (`package.json` has `package:macos-arm64`, `package:windows-x64`, and `release:cli:*`, but nothing that assembles an ASF source distribution). This inventory therefore covers the whole tracked tree. Whether `experiments/`, `scripts/`, `maka-eval/`, `notes/`, and `promo/` end up inside the source artifact is undecided; the findings that depend on that choice are marked below. This gap should be closed before the notification is sent, because the notification URL must point at the applicable source.

## Governing criteria

Read from [infra.apache.org/crypto.html](https://infra.apache.org/crypto.html) and [apache.org/licenses/exports/](https://www.apache.org/licenses/exports/) on 2026-08-20.

> **Broken reference.** #3273 and #2974 cite `https://www.apache.org/licenses/exports/crypto.html`, which returns HTTP 404. The live guidance is at `https://infra.apache.org/crypto.html` (`https://www.apache.org/dev/crypto.html` 302-redirects there). The issue references should be corrected.

The criteria that decide every row below:

1. **Only encryption triggers notification.** ASF states: "One-way algorithms such as MD5 or SHA1, or more sophisticated implementations, do not require notification. Only encryption algorithms do."
2. **ECCN 5D002** covers symmetric algorithms over 56-bit keys; asymmetric algorithms over 512-bit factorisation or discrete log, or over 112-bit ECC; software specially designed for the development, production or use of such software; and cryptanalytic functions.
3. **The exemption is EAR §742.15(b)** ("publicly available"), not §740.13(e)/TSU. ASF states that "Current ASF processes satisfy the 'publicly available' requirement."
4. **Timing:** notification is due "before placing such code on any ASF server, including commits to subversion or git" — not at release. Under this reading the obligation is already live, since the code below is already in `apache/maka`.
5. **Manufacturers:** the notification lists the origin of all crypto code in the product. If the product includes crypto items from several origins, all are listed (ASF's example: "the ASF and the OpenSSL project should be listed as manufacturers").

## A. Encryption — data confidentiality (the trigger set)

These are the findings that put Maka in 5D002. All three use AES-256-GCM.

| # | Location | Purpose | Algorithm | Crypto implementation |
|---|---|---|---|---|
| A1 | [packages/storage/src/encrypted-file-managed-secret-store.ts:359,404](../packages/storage/src/encrypted-file-managed-secret-store.ts) | Managed Secret envelope encryption at rest. Seals/opens secret values with a 32-byte key from an injected key provider, 12-byte random IV, 16-byte auth tag, and AAD bound to secret reference + owner + revision. Envelope is labelled `A256GCM`. | AES-256-GCM (symmetric, 256-bit) | `node:crypto` → Node.js → OpenSSL |
| A2 | [apps/desktop/src/main/qq-bot-scan-login.ts:77](../apps/desktop/src/main/qq-bot-scan-login.ts) | Decrypts the QQ Bot AppSecret returned by Tencent's bind-task protocol after the user scans and confirms. Maka generates the 32-byte key (`randomBytes(32)`, line 29) and sends it to Tencent; Tencent returns the secret encrypted under it. | AES-256-GCM (symmetric, 256-bit) | `node:crypto` → Node.js → OpenSSL |
| A3 | [apps/desktop/src/main/\_\_tests\_\_/qq-bot-scan-login.test.ts:10](../apps/desktop/src/main/__tests__/qq-bot-scan-login.test.ts) | Test-only: encrypts a fixture secret so A2's decryption path can be exercised. | AES-256-GCM | `node:crypto` → Node.js → OpenSSL |

Notes on A1: the store is exported from the package's public surface ([packages/storage/src/index.ts:160](../packages/storage/src/index.ts)) but **no non-test caller instantiates it** in this snapshot. That does not change the analysis — ASF's trigger is code committed to an ASF repository, not code on a live path — but it is worth recording, because it means removing the encryption from the product would not by itself remove it from the source artifact.

**No custom algorithm is implemented anywhere in A1–A3.** All three call Node's `node:crypto`, which is backed by OpenSSL. Maka contributes the envelope format, IV/AAD handling, and key lifecycle around a third-party primitive.

## B. Authentication and integrity — no confidentiality

Keyed MACs and constant-time comparison. These protect integrity, not confidentiality.

| # | Location | Purpose | Algorithm |
|---|---|---|---|
| B1 | [packages/eval/src/metering-checkpoint.ts:58,70](../packages/eval/src/metering-checkpoint.ts) | Signs eval metering checkpoints with the host-issued relay result token so a sandboxed subject cannot forge usage evidence. | HMAC-SHA256 |
| B2 | [packages/runtime-host/src/server/session-transcript-pager.ts:455](../packages/runtime-host/src/server/session-transcript-pager.ts) | Signs opaque transcript pagination cursors with a per-process random secret (`randomBytes(32)`, line 65) so clients cannot forge a cursor. | HMAC-SHA256 |
| B3 | [packages/runtime-host/src/server/access-authority.ts:79](../packages/runtime-host/src/server/access-authority.ts) | Constant-time comparison of a stored access-credential hash against a presented credential. | `timingSafeEqual` over SHA-256 digests |
| B4 | [apps/desktop/src/main/browser/cdp-bridge.ts:227](../apps/desktop/src/main/browser/cdp-bridge.ts) | Constant-time comparison of the CDP bridge bearer secret. | `timingSafeEqual` |

⚠️ **Uncertain — needs the legal determination, not my reading.** ASF's exemption text names one-way algorithms; HMAC is a keyed construction over a one-way algorithm, so it is not literally covered by the "MD5 or SHA1, or more sophisticated implementations" wording, and it is also not an encryption algorithm. Under EAR, items performing authentication only are generally outside 5A002/5D002 confidentiality controls. My reading is that B1–B4 do not independently trigger notification. This is moot in practice — section A triggers regardless — but the reasoning should not be presented to BIS as settled without confirmation.

## C. One-way digests — explicitly exempt

Not controlled, per ASF's explicit statement. Recorded for completeness and to show that the digest surface was examined rather than skipped.

- **Volume:** 201 literal `createHash('<alg>')` call sites across 135 tracked files — 200 × SHA-256, 1 × SHA-512. Of those 135 files, 40 are tests and 12 are under `scripts/`. **No MD5 or SHA-1 appears in Maka's own code.**
- **Representative product uses:** artifact and content addressing (`sha256:` identifiers) in [apps/desktop/src/main/managed-skill-sources.ts:172](../apps/desktop/src/main/managed-skill-sources.ts), [apps/desktop/src/main/runtime-host-client.ts:971](../apps/desktop/src/main/runtime-host-client.ts), [apps/desktop/src/main/runtime-host-memory-ipc-main.ts:405](../apps/desktop/src/main/runtime-host-memory-ipc-main.ts); computer-use host verification in [apps/desktop/src/main/computer-use-host.ts:86](../apps/desktop/src/main/computer-use-host.ts); git revision digests in [apps/desktop/src/main/git-review-main.ts:88](../apps/desktop/src/main/git-review-main.ts).
- **PKCE S256 challenge:** [packages/runtime/src/oauth-login.ts:71](../packages/runtime/src/oauth-login.ts) — SHA-256 over the verifier. A digest, not encryption.
- **WebCrypto digests:** [packages/runtime/src/subscription-cloaked-request.ts:138](../packages/runtime/src/subscription-cloaked-request.ts) and [apps/desktop/src/renderer/local-memory-digest.ts:5](../apps/desktop/src/renderer/local-memory-digest.ts) use `crypto.subtle.digest('SHA-256', …)`. Digest only; no `subtle.encrypt` / `subtle.deriveKey` call exists anywhere in the tracked tree.

## D. Random number generation

Not an encryption algorithm; recorded because CSPRNG output feeds A1, A2, and B2.

`randomBytes` appears at 18 non-test product sites, all generating tokens, nonces, IDs, or IVs — access credentials ([access-authority.ts:118](../packages/runtime-host/src/server/access-authority.ts)), OAuth state/verifier ([oauth-coordinator.ts:672](../packages/runtime-host/src/server/oauth-coordinator.ts)), eval relay tokens ([harness-executor.ts:267,390](../packages/eval/src/harness-executor.ts)), sandbox request nonces ([windows-sandbox.ts:141,142](../packages/runtime/src/sandbox/windows-sandbox.ts)), the A1 IV, and the A2 key. `randomUUID` appears 536 times, overwhelmingly for entity identifiers.

## E. TLS

Maka is a TLS client and, optionally, a TLS server. It implements no TLS logic — both paths delegate to Node's OpenSSL-backed modules.

| # | Location | Role | Implementation |
|---|---|---|---|
| E1 | [packages/runtime-host/src/server/websocket-listener.ts:40–42](../packages/runtime-host/src/server/websocket-listener.ts) | **TLS server.** Runtime Host serves `wss://` from a caller-supplied certificate and private key when `options.tls` is set. Maka neither generates nor stores the key material. | `node:https` → OpenSSL |
| E2 | [packages/runtime/src/network/proxy-dispatcher.ts:52](../packages/runtime/src/network/proxy-dispatcher.ts) | **TLS client.** Wraps a proxy `CONNECT` tunnel in TLS with SNI derived from the host. | `node:tls` → OpenSSL |
| E3 | `undici` ^8.7.0 — [packages/runtime](../packages/runtime/package.json), [packages/eval](../packages/eval/package.json) | HTTPS client for all model-provider and web traffic. | Node's TLS stack |
| E4 | `ws` ^8.21.1 — [packages/runtime](../packages/runtime/package.json), [packages/runtime-host](../packages/runtime-host/package.json), [apps/desktop](../apps/desktop/package.json) | WebSocket client/server, `wss://` over Node TLS. Uses SHA-1 for the RFC 6455 handshake accept key (a digest, exempt) and non-cryptographic frame masking. | Node's TLS stack |
| E5 | `https-proxy-agent` ^9.1.0, `socks-proxy-agent` ^10.1.0, `socks` ^2.8.9 — [packages/runtime](../packages/runtime/package.json) | Proxy transports. SOCKS5 username/password auth is plaintext by protocol design; no crypto of its own. | Node's TLS stack |

No `rejectUnauthorized: false`, no `NODE_TLS_REJECT_UNAUTHORIZED`, and no custom `createSecureContext` or CA bundle appears in the tracked tree.

## F. SSH

**Maka bundles no SSH implementation and no SSH cryptographic library.**

[packages/runtime-host/src/client/ssh-tunnel.ts](../packages/runtime-host/src/client/ssh-tunnel.ts) spawns the host's own `ssh` executable as a child process (`spawn(input.executable, …)` at line 201 with `executable: 'ssh'` at line 108; `execFile('ssh', …)` at line 291). Key material, host verification, and all SSH cryptography belong to the user's OpenSSH installation, which Maka neither ships nor configures. The desktop UI copy confirms the same contract ([apps/desktop/src/renderer/locales/settings-projects-copy.ts:114–125](../apps/desktop/src/renderer/locales/settings-projects-copy.ts)).

This is the "bindings, not source or binaries" case in ASF's FAQ, taken one step further: Maka does not even link OpenSSH, it execs a separate program the user already has.

## G. Credential storage

**The primary credential store is unencrypted.** This is the single most likely misconception to correct in the filing discussion.

[packages/storage/src/credential-store.ts](../packages/storage/src/credential-store.ts) persists API keys, OAuth tokens, request headers, bot tokens, bot app secrets, proxy passwords, and Runtime Host access credentials as **plaintext JSON at file mode 0600**, in a directory chmod'd to 0700. Its own header comment states the design: "At rest this is plaintext JSON behind 0600 file perms… The OS user account is the security boundary (SECURITY.md). At-rest encryption (an OS keychain via a pure-Node binding, or a passphrase) is a later addition."

Related facts:

- **Electron `safeStorage` is not used.** The only remaining mention is a test comment describing a legacy on-disk shape ([packages/storage/src/\_\_tests\_\_/credential-store.test.ts:74](../packages/storage/src/__tests__/credential-store.test.ts)). No macOS Keychain, Windows DPAPI, or libsecret binding is present.
- **Access credentials are stored hashed, not encrypted** — SHA-256 digests compared in constant time ([access-authority.ts:79](../packages/runtime-host/src/server/access-authority.ts)). A digest, exempt.
- **The AES-256-GCM path (A1) is a separate store** for Managed Secrets, not the credential store above.
- `fs-native-extensions` ^1.5.0 ([packages/storage](../packages/storage/package.json)) provides file locking primitives, no cryptography.

## H. Packaging, code signing, and auto-update

| # | Location | Finding |
|---|---|---|
| H1 | [apps/desktop/electron-builder.config.mjs:145](../apps/desktop/electron-builder.config.mjs) | macOS: `forceCodeSigning: true`, `hardenedRuntime: true`, `notarize: true`, `dmg.sign: true`. Signing is performed by Apple's `codesign`/notary toolchain, invoked by `electron-builder`. Apple's toolchain is not ASF-distributed crypto. |
| H2 | [apps/desktop/electron-builder.config.mjs:168–178](../apps/desktop/electron-builder.config.mjs) | Windows: **no Authenticode certificate is configured**, and the config comment records that `electron-updater` therefore skips update signature verification because there is no publisher name to check against. |
| H3 | [apps/desktop/src/main/app-update-service.ts](../apps/desktop/src/main/app-update-service.ts), `electron-updater` ^6.8.9 | Auto-update. Verifies artifact integrity by SHA-512 checksums published in `latest-*.yml` (a digest, exempt) and, on Windows, would verify the publisher signature if a certificate existed (H2). |
| H4 | Ad-hoc dev signing — [apps/desktop/scripts/dev-app-runtime.mjs:451](../apps/desktop/scripts/dev-app-runtime.mjs) | `codesign --sign -` for local development bundles. Developer tooling, not shipped. |

⚠️ **Binary artifacts bundle third-party crypto that the source artifact does not.** The packaged desktop app embeds Electron 43.2.0, whose Chromium/Node stack carries **BoringSSL**, and Node's OpenSSL. The CLI npm package runs on the user's own Node. Whether the notification must list Google (BoringSSL) and the OpenSSL Project as additional manufacturers depends on whether it covers only the ASF source artifact or also the binary convenience artifacts. **This is the main open question for legal.** See §K.

## I. Native code (Rust, Swift)

| # | Location | Finding |
|---|---|---|
| I1 | [experiments/windows-sandbox/launcher/Cargo.toml](../experiments/windows-sandbox/launcher/Cargo.toml) | `sha2 = "0.10"` — pure-Rust SHA-2 digest implementation. A one-way algorithm: exempt. |
| I2 | [experiments/windows-sandbox/launcher/Cargo.toml](../experiments/windows-sandbox/launcher/Cargo.toml) | `windows-sys` with feature `Win32_Security_Cryptography`, enabled — per the in-file comment — solely for `BCryptGenRandom`, a CSPRNG used for per-launch desktop names. Random generation, not encryption. Windows CNG is the OS's, not ASF-distributed. |
| I3 | [scripts/computer-use/ax-oracle.swift](../scripts/computer-use/ax-oracle.swift), [physical-input-age.swift](../scripts/computer-use/physical-input-age.swift), [real-e2e-monitor.swift](../scripts/computer-use/real-e2e-monitor.swift) | Imports are `Cocoa`, `CoreGraphics`, `AppKit`, `ApplicationServices`, `Foundation`, `Darwin` only. **No `CryptoKit`, no `Security.framework`, no cryptographic call.** |

I1 and I2 are inside `experiments/`, and I3 inside `scripts/` — both subject to the §Scope source-artifact caveat. Neither would change the classification if included.

## J. Third-party dependencies that carry cryptography

Verified against `package-lock.json` and the installed tree. Only packages that carry crypto relevant to the classification are listed; this is not a full dependency inventory.

### Shipped at runtime

| Package | Introduced by | Crypto | Assessment |
|---|---|---|---|
| `@larksuiteoapi/node-sdk` 1.72.0 | [packages/runtime](../packages/runtime/package.json) | `createDecipheriv` with **AES-256-CBC** (2 sites in `lib/index.js`) for Lark event-callback decryption | Third-party, open source, calls `node:crypto`. ⚠️ Maka does not configure an encrypt key — no `encryptKey`/`encrypt_key`/`EncodingAESKey` appears anywhere in the tracked tree — so the path appears unreachable in Maka's configuration. The code still ships. |
| `@wecom/aibot-node-sdk` 1.0.7 | [packages/runtime](../packages/runtime/package.json) | `createCipheriv`/`createDecipheriv` with **AES-256-CBC** (6 algorithm references in `dist/`) for WeCom callback encryption | Same as above: third-party, open source, `node:crypto`, and no encrypt key configured by Maka. |
| `jose` 6.2.3 | `@modelcontextprotocol/sdk` 1.30.0 and `@modelcontextprotocol/client` 2.0.0, both in [packages/runtime](../packages/runtime/package.json) / [packages/mcp](../packages/mcp/package.json) | JOSE — JWS signing and **JWE encryption** | Third-party, open source. `jose` v6 delegates to the runtime WebCrypto/`node:crypto` rather than implementing algorithms itself. Reached through MCP OAuth. |
| `@slack/web-api` ^8, `@slack/socket-mode` ^3 | [packages/runtime](../packages/runtime/package.json) | No `createCipheriv`/`createDecipheriv`/`createHmac` found in the installed tree | No encryption contribution. |
| Node.js ≥22.19.0 (`engines`) | Runtime prerequisite | OpenSSL — backs every `node:crypto`, `node:tls`, `node:https` call above | Not distributed by ASF for the CLI; the user supplies Node. |
| Electron 43.2.0 | [apps/desktop](../apps/desktop/package.json) (devDependency; embedded in packaged binaries) | BoringSSL, plus Node's OpenSSL | Not in the source artifact. Present in binary artifacts. See H4 and §K. |

### Build/dev only — not shipped

| Package | Introduced by | Crypto | Assessment |
|---|---|---|---|
| `pkijs` 3.4.0 | `app-builder-lib` (electron-builder 26.15.3) | PKI/ASN.1, certificate handling for Windows signing | Dev dependency. Not in the runtime product. |
| `@noble/hashes` 2.2.0 / 1.4.0 | `app-builder-lib`, `pkijs` | Pure-JS hash implementations | Dev dependency, and digests are exempt regardless. |

## K. Own implementation versus third-party implementation

This distinction changes what the notification says, so it is stated separately.

**Maka implements no cryptographic algorithm.** Every cryptographic primitive in the tracked tree resolves to a third-party implementation:

- `node:crypto` / `node:tls` / `node:https` → Node.js → **OpenSSL**
- `crypto.subtle` in the renderer → **Electron/Chromium → BoringSSL**
- `sha2` (Rust) → a public open-source SHA-2 crate; `BCryptGenRandom` → **Microsoft Windows CNG**
- `ssh` → the user's **OpenSSH** installation, spawned as a separate process

**What Maka does contribute** is cryptographic *composition*: the A256GCM envelope format, IV and AAD construction, and key-provider lifecycle in A1; the key-exchange and decryption sequence for Tencent's bind protocol in A2; and the HMAC-based checkpoint and cursor constructions in B1–B2. Under 5D002 this is "software specially designed … for the use of" controlled cryptographic software, which is inside the classification — so the composition-versus-implementation distinction narrows what is listed as *manufactured* crypto, not whether Maka is classified.

**Manufacturer question (open).** ASF's guidance says to list the origin of all crypto code included in the product, and if the product includes items from several origins, list all of them. Two readings:

- *ASF only.* The source artifact contains no third-party crypto code — only calls into crypto the user's Node or the OS supplies. This matches the ASF FAQ case of shipping bindings without the underlying source or binaries.
- *ASF plus OpenSSL plus Google (BoringSSL).* The packaged desktop binaries embed Electron and its BoringSSL, and the Lark/WeCom/`jose` dependencies ship inside the npm CLI package's dependency tree.

I do not think this is mine to settle. The precedent on the exports page cuts both ways: Accumulo lists ASF **and** Bouncy Castle, while ActiveMQ's entry is described as "designed for use with encryption library" — the closer analogue to Maka's source artifact.

## Recommendation

**Maka requires an ECCN 5D002 notification under EAR §742.15(b). It does not qualify for an exemption from notification.**

The reasoning, kept short because the criteria are quoted in full above:

1. Section A puts symmetric AES-256 encryption — well over the 56-bit threshold — in Maka's own committed source, at two independent product sites. That alone is 5D002.
2. The digest-only exemption does not rescue it. That exemption is what excludes sections C, and it correctly excludes the large SHA-256 surface, `sha2`, and the SHA-512 update checksums — but it says nothing about AES-GCM.
3. Nothing about §G helps either. The credential store being plaintext removes a *potential* trigger; it does not offset an actual one.
4. The §742.15(b) "publicly available" condition **is** satisfied: Maka's source is published without restriction on further dissemination, and ASF states that current ASF processes satisfy this requirement. So the correct outcome is *notification*, not license application.

Concretely, the remaining exit criteria of #3273 should produce:

1. **A BIS notification email** to `crypt@bis.doc.gov`, `enc@nsa.gov`, `web_site@bis.doc.gov`, cc the project list, subject `Section 742.15 NOTIFICATION - Encryption`, with `SUBMISSION TYPE: Section 742.15`, `SUBMITTED FOR: Apache Software Foundation`, `POINT OF CONTACT: Secretary, Apache Software Foundation`, `ECCN: 5D002`, `NOTIFICATION: https://www.apache.org/licenses/exports/`, and `MANUFACTURER(S)` per the open question in §K. ASF supplies a `bisnotice.xsl` transform and `bisnotice.sh`/`bisnotice.cmd` helpers that generate this template from the product name — use those rather than hand-writing it.
2. **An entry in the exports matrix** — the `.yaml` behind `https://www.apache.org/licenses/exports/`, editable by anyone with site-dev karma (which includes PMC chairs). Since Maka is a podling, confirm with mentors who performs this and whether the entry is filed under Incubator.
3. **A cryptography notice in the distribution README**, using ASF's prescribed wording verbatim. **No such notice currently exists** — `README.md`, `README.zh-CN.md`, `NOTICE`, `LICENSE`, and `DISCLAIMER-WIP` contain no mention of cryptography, ECCN, 5D002, or Wassenaar. Note that ASF's standard wording describes 5D002 as covering "asymmetric algorithms"; Maka's trigger is symmetric AES-256-GCM. Ask whether the boilerplate is used as-is or adjusted, and append the component detail ASF asks for at the end of that notice — sections A, E, and J of this document are the source material.

**Timing.** ASF's rule is notification before the code reaches an ASF server, and the code in section A is already in `apache/maka`. The practical consequence is that this should not be sequenced after the first release vote; treat it as overdue rather than upcoming, and say so plainly when raising it with mentors.

## Open questions and uncertainties

Listed so a reviewer can attack them directly rather than reconstructing what was assumed.

1. **Manufacturer list** (§K) — ASF alone, or ASF plus OpenSSL and Google/BoringSSL? Depends on whether the filing covers binary convenience artifacts. **Needs legal.**
2. **Source-artifact boundary** (§Scope) — no source-release assembly script exists, so it is undecided whether `experiments/`, `scripts/`, `maka-eval/`, `notes/`, and `promo/` are inside it. Affects I1–I3 and the notification URL. **Needs a release-management decision.**
3. **HMAC classification** (§B) — my reading is that authentication-only constructions do not independently trigger notification, but ASF's exemption wording addresses one-way algorithms, not keyed MACs. Moot given §A, but should not be asserted as settled.
4. **Podling filing mechanics** — who files for a podling, and whether the exports-matrix entry names Maka or Apache Incubator. **Needs mentors.**
5. **README notice wording** (§Recommendation 3) — whether ASF's asymmetric-algorithm boilerplate is used verbatim for a symmetric-only trigger.
6. **Dependency inventory is targeted, not exhaustive.** §J probes the dependencies with a plausible crypto surface, plus a scan for common crypto-implementing packages (`node-forge`, `tweetnacl`, `elliptic`, `sjcl`, `crypto-js`, `libsodium`, `bcrypt`, `jsonwebtoken`, `openpgp`, `secp256k1`, and others; only `jose`, `pkijs`, and `@noble/hashes` matched). A dependency that reaches crypto through an unusual path could have been missed. If the filing needs an exhaustive claim, that warrants a separate automated pass over the full installed tree.

## Corrections to assumptions in the issue thread

Recorded because each was checked and each is false, and someone reading #3273 would otherwise carry them into the filing:

- **`experimental_toolApprovalSecret` does not exist in this repository.** No `approvalSecret`, `approval_secret`, or `toolApprovalSecret` identifier appears in any tracked file. `packages/runtime/src/model-protocol.ts:132,140` defines `ToolApprovalRequest`/`ToolApprovalResponse`, neither of which carries a secret or a MAC. The two real HMAC-SHA256 sites are B1 and B2.
- **`https://www.apache.org/licenses/exports/crypto.html` is a dead link** (HTTP 404), and it is cited in both #3273 and #2974. Live URL: `https://infra.apache.org/crypto.html`.
- **Maka does have an SSH path, but bundles no SSH cryptography** — it execs the user's `ssh` binary (§F). Worth stating positively in the filing rather than leaving as an unexamined gap.

---

*This inventory was produced with AI assistance (Claude, via Claude Code): the agent performed the source and dependency searches, read the ASF guidance, and drafted this document. Every claim cites a file path, package name, or quoted source so it can be verified independently. The human contributor of record owns its accuracy and the submission decision, and the export determination itself belongs to the ASF VP of Legal Affairs, the PPMC, and the mentors.*
