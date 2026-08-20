# Cryptography export inventory

Inventory of cryptographic functionality and dependencies in the Maka source tree, prepared to support the ASF export-control review tracked in [#3273](https://github.com/apache/maka/issues/3273) (G6 of #2974).

This document records facts and identifies who owns each unresolved determination. **It does not make the export determination.** That belongs to the ASF VP of Legal Affairs, the PPMC, and the mentors. Progress tracking and the remaining exit criteria live in #3273, not here.

## Scope and method

- **Snapshot:** `main` at `a6f33c952`, package version `0.1.11`. All counts below are against that fixed tree (`git grep <pattern> a6f33c952`), not the working checkout.
- **Population:** the 2701 files tracked by Git. Scanning covers **all** tracked file types, not only TypeScript — the crypto surface includes shell, Python, PowerShell, Rust, Swift, and Dockerfiles, and an earlier draft of this inventory missed a TLS interception path by scanning only `*.ts`/`*.tsx`/`*.mjs`/`*.js`/`*.cjs`/`*.swift`/`*.toml`.
- **Known method limit:** call-site counts match literal forms such as `createHash('sha256')`. Indirect forms where the algorithm arrives as a variable are invisible to that pattern and were searched separately (`createHash(<identifier>)`, 2 sites); see §C.
- **Dependencies:** derived from both tracked lockfiles and the installed tree.

**The source artifact is not yet defined.** No source-release assembly script exists (`package.json` has `package:macos-arm64`, `package:windows-x64`, and `release:cli:*`, but nothing that assembles an ASF source distribution). This inventory therefore covers the whole tracked tree, and rows that depend on the artifact boundary are marked. Since a notification's URL must point at the applicable source, and manufacturers are determined by what a given artifact actually contains, **the artifact boundary has to be settled before any filing** — it is a release-management decision, not a legal one.

## Two questions, kept separate

An earlier draft conflated these, and it matters for what any filing says:

- **Is a path *controlled*?** Decided by what the product does — whether it provides or performs cryptographic functionality, including code "specially designed" to work with controlled cryptographic software. ASF's FAQ pulls in binding and orchestration code even when the underlying primitive ships elsewhere: it states that notification for the Apache project code is required for a project shipping bindings to OpenSSL without OpenSSL's own source or binaries.
- **Who is the *manufacturer* of the primitive?** Decided by who implemented the algorithm. This determines the `MANUFACTURER(S)` field and the matrix's source links. It does **not** decide whether Maka's own code is in scope.

Sections A–F below list controlled paths. Section J lists primitive origins. A path can be controlled while its primitive is manufactured entirely by someone else — that is the normal case here.

## Governing criteria, and a conflict between them

Read on 2026-08-20 from [infra.apache.org/crypto.html](https://infra.apache.org/crypto.html), [apache.org/licenses/exports/](https://www.apache.org/licenses/exports/), and [15 CFR §742.15](https://www.law.cornell.edu/cfr/text/15/742.15).

> **Broken reference.** #3273 cites `https://www.apache.org/licenses/exports/crypto.html`, which returns HTTP 404. The live guidance is at `https://infra.apache.org/crypto.html` (`https://www.apache.org/dev/crypto.html` 302-redirects there). #2974 cites only `exports/` and is unaffected.

**ASF's published process** requires a BIS notification, an exports-matrix entry, and a README notice for software under ECCN 5D002 — symmetric algorithms over 56-bit keys, asymmetric over 512-bit factorisation or discrete log or 112-bit ECC, software specially designed for the development, production or use of such software, and cryptanalytic functions. It excludes digests explicitly: "One-way algorithms such as MD5 or SHA1, or more sophisticated implementations, do not require notification. Only encryption algorithms do." Timing is "before placing such code on any ASF server, including commits to subversion or git" — not at release.

**Current EAR appears narrower.** 15 CFR §742.15(b)(1) provides that publicly available 5D002 encryption source code is not subject to the EAR, "[s]ubject to the notification requirements of paragraph (b)(2)"; (b)(2) in turn limits the notification obligation to publicly available 5D002 source code "that provides or performs 'non-standard cryptography'" as defined in §772.1. Maka uses only published, standards-body algorithms — AES-GCM and AES-CBC, SHA-2, HMAC, TLS, JOSE, SSH — and no proprietary or unpublished algorithm or protocol appears anywhere in §A–§F.

**These two do not agree, and the ASF page says so about itself.** It states that "The latest modification of this page, to describe the current state of regulations, was May 24, 2019," and that it "describes the process which should be continued until the Apache VP Legal Affairs approves an updated version." So ASF's own text presents its process as possibly ahead of what the regulation now requires, and directs projects to follow it regardless.

⚠️ **This conflict is not this document's to resolve.** The factual finding is that Maka's cryptography is standard, not that a notification is or is not legally required. See §K.

## A. Encryption — data confidentiality

The findings that put Maka's own code in 5D002. All use AES-256-GCM.

| # | Location | Purpose | Algorithm |
|---|---|---|---|
| A1 | [packages/storage/src/encrypted-file-managed-secret-store.ts:359,404](../packages/storage/src/encrypted-file-managed-secret-store.ts) | Managed Secret envelope encryption at rest. Seals and opens secret values with a 32-byte key from an injected key provider, 12-byte random IV, 16-byte auth tag, and AAD bound to secret reference, owner, and revision. Envelope is labelled `A256GCM`. | AES-256-GCM |
| A2 | [apps/desktop/src/main/qq-bot-scan-login.ts:77](../apps/desktop/src/main/qq-bot-scan-login.ts) | Decrypts the QQ Bot AppSecret returned by Tencent's bind-task protocol. Maka generates the 32-byte key (`randomBytes(32)`, line 29) and sends it to Tencent, which returns the secret encrypted under it. | AES-256-GCM |
| A3 | [apps/desktop/src/main/\_\_tests\_\_/qq-bot-scan-login.test.ts:10](../apps/desktop/src/main/__tests__/qq-bot-scan-login.test.ts) | Test-only: encrypts a fixture secret so A2's decryption path can be exercised. | AES-256-GCM |

These three are the complete set — `createCipheriv`/`createDecipheriv` appears in no other tracked file, and there is no `subtle.encrypt`, `subtle.deriveKey`, or `subtle.deriveBits` anywhere in the tree.

A1 is exported from the package's public surface ([packages/storage/src/index.ts:160](../packages/storage/src/index.ts)) but **no non-test caller instantiates it** in this snapshot. Recorded because it bears on remediation options, not on classification: ASF's trigger is code committed to an ASF repository, so removing the call path would not remove the code from the source artifact.

## B. TLS — including one interception path with CA generation

Maka is a TLS client, an optional TLS server, and — in the eval harness — a full TLS man-in-the-middle that generates its own certificate authority.

| # | Location | Role |
|---|---|---|
| B1 | [packages/eval/harbor/egress-proxy/entrypoint.sh:19–24](../packages/eval/harbor/egress-proxy/entrypoint.sh) | **Generates an RSA-2048 CA** via `CertStore.from_store(<dir>, "mitmproxy", 2048)`, publishes `mitmproxy-ca-cert.pem` into a volume the eval subject mounts and trusts, then `exec mitmdump` (line 38) to intercept and re-originate all subject TLS traffic. Asymmetric key generation over 512 bits, plus TLS termination on both sides. |
| B2 | [packages/eval/harbor/egress-proxy/Dockerfile](../packages/eval/harbor/egress-proxy/Dockerfile) | Pins `mitmproxy==12.2.3` as the interception engine; [egress_filter.py](../packages/eval/harbor/egress_filter.py) is a mitmproxy addon enforcing the egress allowlist. |
| B3 | [packages/runtime-host/src/server/websocket-listener.ts:40–42](../packages/runtime-host/src/server/websocket-listener.ts) | TLS server. Runtime Host serves `wss://` from a caller-supplied certificate and private key. Maka neither generates nor stores that key material. |
| B4 | [packages/runtime/src/network/proxy-dispatcher.ts:52](../packages/runtime/src/network/proxy-dispatcher.ts) | TLS client wrapping a proxy `CONNECT` tunnel, with SNI derived from the host. |
| B5 | `undici` ^8.7.0, `ws` ^8.21.1, `https-proxy-agent` ^9.1.0, `socks-proxy-agent` ^10.1.0, `socks` ^2.8.9 | HTTPS and WebSocket transports across [packages/runtime](../packages/runtime/package.json), [packages/eval](../packages/eval/package.json), [packages/runtime-host](../packages/runtime-host/package.json), [apps/desktop](../apps/desktop/package.json). `ws` uses SHA-1 for the RFC 6455 handshake accept key (a digest) and non-cryptographic frame masking. |

B1–B2 are the strongest TLS finding and the one most likely to matter to a reviewer, since CA generation is asymmetric key generation rather than mere TLS client use. Whether they are inside the source artifact is unresolved (§Scope). No `rejectUnauthorized: false`, `NODE_TLS_REJECT_UNAUTHORIZED`, or custom CA bundle appears in the tracked tree outside this deliberate interception path.

## C. Digests — exempt under ASF's stated exclusion

- **201 literal `createHash('<alg>')` call sites across 135 tracked files** — 200 SHA-256, 1 SHA-512. Of those files, 40 are tests and 12 are under `scripts/`.
- **SHA-1 is present**, reached indirectly: [scripts/release-cli-publication.mjs:162](../scripts/release-cli-publication.mjs) calls a helper (line 469) as `digest('sha1', bytes, 'hex')` to verify the npm registry `shasum`. The same helper is also called with `sha256` and `sha512`. No MD5 appears anywhere.
- **Other languages:** `hashlib.sha256` in the eval harness ([packages/eval/harbor/relay_agent.py:512,542](../packages/eval/harbor/relay_agent.py), [run_trial.py:30,50](../packages/eval/harbor/run_trial.py)); .NET SHA-256 in [experiments/windows-sandbox/stdio-relay-smoke.ps1:73](../experiments/windows-sandbox/stdio-relay-smoke.ps1); the `sha2` crate in [experiments/windows-sandbox/launcher/Cargo.toml](../experiments/windows-sandbox/launcher/Cargo.toml).
- **PKCE S256** ([packages/runtime/src/oauth-login.ts:71](../packages/runtime/src/oauth-login.ts)) and WebCrypto digests ([subscription-cloaked-request.ts:138](../packages/runtime/src/subscription-cloaked-request.ts), [local-memory-digest.ts:5](../apps/desktop/src/renderer/local-memory-digest.ts)) are digest-only.

## D. Authentication and integrity

Keyed MACs and constant-time comparison — integrity, not confidentiality.

| # | Location | Purpose |
|---|---|---|
| D1 | [packages/eval/src/metering-checkpoint.ts:58,70](../packages/eval/src/metering-checkpoint.ts) | HMAC-SHA256 over eval metering checkpoints, keyed by the host-issued relay result token, so a sandboxed subject cannot forge usage evidence. |
| D2 | [packages/runtime-host/src/server/session-transcript-pager.ts:455](../packages/runtime-host/src/server/session-transcript-pager.ts) | HMAC-SHA256 signing of opaque transcript pagination cursors, keyed by a per-process `randomBytes(32)` secret. |
| D3 | [access-authority.ts:79](../packages/runtime-host/src/server/access-authority.ts), [cdp-bridge.ts:227](../apps/desktop/src/main/browser/cdp-bridge.ts) | `timingSafeEqual` comparison of a stored SHA-256 credential hash and of the CDP bridge bearer secret. |

⚠️ ASF's exemption text names one-way algorithms; HMAC is a keyed construction over one, and is not an encryption algorithm. Under EAR, authentication-only functionality is generally outside 5A002/5D002 confidentiality controls. My reading is that D1–D3 do not independently trigger anything, but §A and §B trigger regardless, so nothing turns on it — and it should not reach BIS as settled.

**CSPRNG:** 18 non-test `randomBytes` sites generate tokens, nonces, IDs, and the A1 IV and A2 key. Random generation is not an encryption algorithm.

## E. SSH — no bundled cryptography

[packages/runtime-host/src/client/ssh-tunnel.ts](../packages/runtime-host/src/client/ssh-tunnel.ts) spawns the host's own `ssh` executable as a child process (`spawn` at line 201 with `executable: 'ssh'` at line 108; `execFile('ssh', …)` at line 291). Key material, host verification, and all SSH cryptography belong to the user's OpenSSH installation, which Maka neither ships nor links. UI copy states the same contract ([settings-projects-copy.ts:114–125](../apps/desktop/src/renderer/locales/settings-projects-copy.ts)).

Per §"Two questions", this makes OpenSSH the primitive manufacturer; it does not by itself decide whether Maka's tunnel orchestration is a controlled path under ASF's designed-to-use language. ⚠️ Flagged for the same determination as B3–B5.

## F. Credential storage — two stores, both plaintext

**Neither production credential store encrypts at rest.** This removes a potential trigger; it does not offset §A or §B.

| # | Store | Contents | At rest |
|---|---|---|---|
| F1 | `credential-vault.json` — [credential-vault-document.ts](../packages/storage/src/runtime-policy/credential-vault-document.ts), written by [document-io.ts:133](../packages/storage/src/runtime-policy/document-io.ts) | Runtime Policy credentials: Connection API and OAuth material, request headers, web-search keys, proxy passwords. Entries hold `secret: string` directly. | Plaintext JSON, file mode 0600, directory 0700. Confirmed by [README.md:196](../README.md). |
| F2 | `credentials.json` — [packages/storage/src/credential-store.ts](../packages/storage/src/credential-store.ts) | Runtime Host client profile access credentials, under `<Electron userData>/runtime-host-client/`. | Plaintext JSON at 0600. Its header comment states the design: "At rest this is plaintext JSON behind 0600 file perms… The OS user account is the security boundary (SECURITY.md)." |

- **Electron `safeStorage` is not used.** Pre-existing `safeStorage` credential files are deliberately not imported; affected users re-authenticate ([README.md:197](../README.md)). The only code reference left is a test comment describing the legacy shape.
- **Access credentials are stored hashed, not encrypted** — SHA-256 compared in constant time (D3).
- The A1 AES-256-GCM Managed Secret store is a third, separate store, and is not on either path above.

## G. Packaging, code signing, and auto-update

- **macOS:** `forceCodeSigning`, `hardenedRuntime`, `notarize`, and `dmg.sign` are on ([electron-builder.config.mjs:145](../apps/desktop/electron-builder.config.mjs)). Signing is performed by Apple's `codesign` and notary toolchain, not by ASF-distributed crypto.
- **Windows:** **no Authenticode certificate is configured**, and the config records that `electron-updater` therefore skips update signature verification, because without a certificate there is no publisher name to check ([electron-builder.config.mjs:168–178](../apps/desktop/electron-builder.config.mjs)).
- **Auto-update** ([app-update-service.ts](../apps/desktop/src/main/app-update-service.ts), `electron-updater` ^6.8.9) verifies artifact integrity by SHA-512 checksums published in `latest-*.yml` — a digest.

⚠️ **Binary artifacts carry crypto the source artifact does not.** The packaged desktop app embeds Electron 43.2.0 and therefore BoringSSL, plus Node's OpenSSL. This is the main input to the manufacturer question (§K).

## H. Native code

- **Rust** ([experiments/windows-sandbox/launcher/Cargo.toml](../experiments/windows-sandbox/launcher/Cargo.toml)): `sha2 = "0.10"` (digest); `windows-sys` with `Win32_Security_Cryptography` enabled, per the in-file comment, solely for `BCryptGenRandom` — OS CSPRNG, not encryption.
- **Swift** ([ax-oracle.swift](../scripts/computer-use/ax-oracle.swift), [physical-input-age.swift](../scripts/computer-use/physical-input-age.swift), [real-e2e-monitor.swift](../scripts/computer-use/real-e2e-monitor.swift)): imports are `Cocoa`, `CoreGraphics`, `AppKit`, `ApplicationServices`, `Foundation`, `Darwin` only. **No CryptoKit, no Security.framework, no cryptographic call.**
- **PowerShell:** [scripts/windows-runtime-host-local-ipc-trust.ps1:106](../scripts/windows-runtime-host-local-ipc-trust.ps1) uses `ConvertTo-SecureString` (DPAPI-backed, OS-provided) in a developer script.

## J. Third-party cryptographic primitives — origins

Two tracked lockfiles exist: the root `package-lock.json` and [packages/eval/harbor/deepseek-harness-toolchain/package-lock.json](../packages/eval/harbor/deepseek-harness-toolchain/package-lock.json) (588 packages), which an earlier draft missed.

### Shipped at runtime (root lockfile)

| Package | Introduced by | Crypto |
|---|---|---|
| `@larksuiteoapi/node-sdk` 1.72.0 | [packages/runtime](../packages/runtime/package.json) | AES-256-CBC `createDecipheriv` for Lark event-callback decryption — 1 site in `lib/index.js`, 1 in `es/index.js`. ⚠️ Maka configures no encrypt key (no `encryptKey`/`encrypt_key`/`EncodingAESKey` in the tracked tree), so the path appears unreachable as configured. The code still ships. |
| `@wecom/aibot-node-sdk` 1.0.7 | [packages/runtime](../packages/runtime/package.json) | AES-256-CBC for WeCom callback encryption. ⚠️ Also exposes per-message `aesKey` file decryption (`decryptFile`, `downloadFile`), which does not depend on a global callback encrypt key — so unlike Lark, unreachability cannot be inferred from Maka's configuration alone. |
| `jose` 6.2.3 | `@modelcontextprotocol/sdk` 1.30.0, `@modelcontextprotocol/client` 2.0.0 | JOSE — JWS signing and JWE encryption, reached through MCP OAuth. v6 delegates to the runtime WebCrypto/`node:crypto`. |
| `@ai-sdk/code-mode` | [packages/code-mode](../packages/code-mode/package.json) | HMAC-SHA256 continuation signing (`continuation-capability.ts:148`). Integrity, per §D. |
| `cookie-signature` | `express`, via `@modelcontextprotocol/sdk` | HMAC-SHA256 cookie signing. Integrity, per §D. |
| Node.js ≥22.19.0 | `engines` — user-supplied for the CLI | **OpenSSL.** Backs every `node:crypto`, `node:tls`, and `node:https` call above. |
| Electron 43.2.0 | [apps/desktop](../apps/desktop/package.json), embedded in packaged binaries | **BoringSSL**, plus Node's OpenSSL. Not in the source artifact. |
| OpenSSH | User's system, spawned (§E) | All SSH cryptography. Neither shipped nor linked. |

### Eval harness (second lockfile, and the container image)

`mitmproxy==12.2.3` (§B1–B2, the RSA-2048 CA and TLS interception engine); `jose`; `@aws-crypto/sha256-js` and `@aws-crypto/sha256-browser` (digests); `@smithy/signature-v4` and `@aws-sdk/signature-v4-multi-region` (HMAC request signing).

### Build and dev only — not in the runtime product

`pkijs` 3.4.0, `@peculiar/webcrypto` 1.7.1 (a full WebCrypto implementation including AES-CBC/CTR/GCM/KW), `asn1js`, and `@noble/hashes` — all reached through `app-builder-lib` / electron-builder 26.15.3 for Windows signing.

### Coverage limit

Sections §A–§H are exhaustive for the tracked source: every cipher construction, digest call, MAC, TLS entry point, and native crypto reference was enumerated across all tracked file types. **§J is not exhaustive for transitive npm dependencies.** It covers both lockfiles' direct and notable transitive crypto, plus a scan for ~25 common crypto-implementing package names. A dependency reaching crypto through an unusual path could still be missed. If a filing needs a closed manufacturer set, that set must be generated per artifact from a frozen install and from the actual packaged output — not from this list. See §K.

## K. What follows, and who owns it

**Established fact:** Maka's own committed source performs AES-256-GCM encryption (§A) and generates an RSA-2048 CA to terminate and re-originate TLS (§B1). Both are well past the 5D002 thresholds. Maka implements no cryptographic algorithm itself — every primitive resolves to OpenSSL, BoringSSL, mitmproxy/OpenSSL, Windows CNG, a public Rust crate, or the user's OpenSSH. What Maka contributes is composition: envelope formats, IV and AAD construction, key lifecycle, MAC protocols, and CA orchestration. Under ASF's designed-to-use language that composition is in scope; the delegation affects only the manufacturer field.

**Established fact:** every algorithm found is a published standard. No proprietary or unpublished algorithm or protocol appears anywhere in §A–§H.

**Unresolved, and not this document's to decide:**

1. **Whether a BIS notification is required at all.** ASF's published process says yes for 5D002 software. Current §742.15(b)(2) limits notification to source code providing or performing "non-standard cryptography" (§772.1), which on the facts above Maka does not. ASF's page is dated May 24, 2019 and directs projects to follow it "until the Apache VP Legal Affairs approves an updated version." **Owner: VP Legal Affairs, via the PPMC and mentors.** The question to put to them is narrow: does ASF intend its 2019 process to remain broader than the current regulation, and does Maka contain non-standard cryptography as §772.1 defines it? Until that is answered, the accurate statement is "ASF's currently published process directs a notification," not "the EAR requires one."
2. **The manufacturer set**, if a filing proceeds — ASF alone for the source artifact, or ASF plus the OpenSSL Project, Google (BoringSSL), and the mitmproxy project for binary and container artifacts. **Owner: release/packaging, then Legal.** This must be derived per artifact (source tarball, CLI npm tarball, macOS app, Windows app, eval container), not from §J.
3. **The source-artifact boundary** (§Scope), which determines both the notification URL and whether §B1–B2 and §H are in scope at all. **Owner: release management.**
4. **Whether §B3–B5 and §E are controlled paths** under ASF's binding/designed-to-use language, given that the primitives are external. **Owner: Legal.**
5. **Podling filing mechanics** — who files for a podling, and whether the matrix entry names Maka or Apache Incubator. **Owner: mentors.**

**If a filing proceeds**, ASF supplies the machinery: a `bisnotice.xsl` transform with `bisnotice.sh`/`bisnotice.cmd` helpers that generate the BIS notification template from the product name, and a `.yaml` behind `https://www.apache.org/licenses/exports/` editable by anyone with site-dev karma. Use those rather than hand-writing the fields. ASF also prescribes verbatim README wording; **no such notice exists today** in `README.md`, `README.zh-CN.md`, `NOTICE`, `LICENSE`, or `DISCLAIMER-WIP`. Note that the prescribed wording describes 5D002 as covering "asymmetric algorithms" — §B1's CA generation fits, §A's AES does not, so ask whether the boilerplate is used as-is.

**On timing.** ASF's rule is notification before code reaches an ASF server, and §A and §B code is already in `apache/maka`. If item 1 resolves toward filing, it is overdue rather than upcoming, and should not be sequenced behind the first release vote.

---

*Produced with AI assistance (Claude, via Claude Code): the agent ran the source and dependency searches, read the ASF and EAR sources, and drafted this document. Adversarial review by Claude Fable and OpenAI Codex found the missing TLS interception path (§B1), the missing credential vault (§F1), the missing second lockfile (§J), the SHA-1 omission (§C), and the regulatory conflict now recorded in §K — all since corrected. Every claim cites a file path, package name, or quoted source so it can be verified independently. The human contributor of record owns accuracy and the submission decision; the export determination belongs to the ASF VP of Legal Affairs, the PPMC, and the mentors.*
