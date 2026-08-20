# Cryptography export inventory

Inventory of cryptographic functionality and dependencies in the Maka source tree, prepared to support the ASF export-control review tracked in [#3273](https://github.com/apache/maka/issues/3273) (G6 of #2974).

**Outcome: mentor guidance is that no BIS notification and no exports-matrix entry are required for Maka**, on the basis that it develops no cryptographic algorithm of its own. See §K. This document is the record of that determination and of the evidence behind it, so a later reviewer can check the reasoning rather than take it on trust. Progress tracking and the remaining exit criteria live in #3273.

## Scope and method

- **Snapshot:** `main` at `52c0e3275`, package version `0.1.11`. All counts are against that fixed tree (`git grep <pattern> 52c0e3275`), not a working checkout.
- **Population:** the 2706 files tracked by Git, across **all** file types — the crypto surface includes shell, Python, PowerShell, Rust, Swift, and Dockerfiles, and an earlier revision missed a TLS interception path by scanning only the TypeScript family.
- **Lockfiles:** all three tracked lockfiles — `package-lock.json`, [packages/eval/harbor/deepseek-harness-toolchain/package-lock.json](../packages/eval/harbor/deepseek-harness-toolchain/package-lock.json), and [experiments/windows-sandbox/launcher/Cargo.lock](../experiments/windows-sandbox/launcher/Cargo.lock) — derived from `git ls-tree` rather than assumed by ecosystem.
- **Known method limit:** call-site counts match literal forms such as `createHash('sha256')`. Forms where the algorithm arrives as a variable are invisible to that pattern and were searched separately; see §C.

**The source artifact is now defined.** [#3278](https://github.com/apache/maka/pull/3278) added `scripts/asf-source-release.mjs` and the `release:asf:source` / `verify` / `sign` scripts, which build `apache-maka-<version>-incubating-src.tar.gz` from a commit via `git archive`. [.gitattributes](../.gitattributes) marks only `/.claude`, `/.maka-shots`, and `/maka-proposal-zh-review.txt` as `export-ignore`. **Therefore `experiments/` and `packages/eval/harbor/` are inside the source artifact**, including the CA-generation path in §B1. Binary and container artifacts are separate populations and carry more (§J).

## Three questions, kept separate

An earlier revision collapsed the first two, and a filing must not:

1. **Is a path *controlled*?** Decided by what the product does, including code "specially designed" to work with controlled cryptographic software. ASF's FAQ pulls in binding and orchestration code even when the primitive ships elsewhere: a project shipping bindings to OpenSSL without OpenSSL's own source or binaries still owes notification for the Apache project code.
2. **Which crypto *item* does a given artifact contain?** Decided per artifact — the source tarball, the CLI npm tarball, the macOS and Windows apps, and the eval container each contain different third-party crypto.
3. **Who *built* that item?** This is the `MANUFACTURER(S)` field. ASF's wording is who "built the crypto item included in the ASF product" — which follows the artifact's contents, not the authorship of the underlying algorithm.

These distinctions did not end up deciding the outcome (§K), but they are what a filing would have turned on, and they are recorded so a revisit does not have to rederive them. Sections A and B list paths that perform cryptography. Sections C, D, and F record surfaces that were examined and found exempt, integrity-only, or unencrypted — they are not controlled paths. Sections E and B3–B5 are unresolved between (1) and (3). Section J addresses (2) and (3).

## Governing criteria, and a conflict between them

Read on 2026-08-20 from [infra.apache.org/crypto.html](https://infra.apache.org/crypto.html), [apache.org/licenses/exports/](https://www.apache.org/licenses/exports/), and [15 CFR §742.15](https://www.law.cornell.edu/cfr/text/15/742.15).

> **Broken reference.** #3273 cites `https://www.apache.org/licenses/exports/crypto.html`, which returns HTTP 404. The live guidance is at `https://infra.apache.org/crypto.html`. #2974 cites only `exports/` and is unaffected.

**ASF's published process** requires a BIS notification, an exports-matrix entry, and a README notice for software under ECCN 5D002 — symmetric algorithms over 56-bit keys, asymmetric over 512-bit factorisation or discrete log or 112-bit ECC, software specially designed for the development, production or use of such software, and cryptanalytic functions. It excludes digests explicitly: "One-way algorithms such as MD5 or SHA1, or more sophisticated implementations, do not require notification. Only encryption algorithms do." Timing is "before placing such code on any ASF server, including commits to subversion or git."

**Current EAR appears narrower.** §742.15(b)(1) provides that publicly available 5D002 encryption source code is not subject to the EAR, "[s]ubject to the notification requirements of paragraph (b)(2)"; (b)(2) limits that obligation to source code "that provides or performs 'non-standard cryptography'" as §772.1 defines it. **§772.1 reaches proprietary or unpublished cryptographic *protocols*, not only algorithms** — so an enumeration of algorithm names cannot settle the question. See §K.

**The two do not agree, and the ASF page says so about itself.** It states that "The latest modification of this page, to describe the current state of regulations, was May 24, 2019," and that it "describes the process which should be continued until the Apache VP Legal Affairs approves an updated version."

## A. Encryption — data confidentiality

| # | Location | Purpose | Algorithm |
|---|---|---|---|
| A1 | [packages/storage/src/encrypted-file-managed-secret-store.ts:359,404](../packages/storage/src/encrypted-file-managed-secret-store.ts) | Managed Secret envelope encryption at rest. 32-byte key from an injected provider, 12-byte random IV, 16-byte auth tag, AAD bound to secret reference, owner, and revision. Envelope labelled `A256GCM`; the AAD construction is Maka's own, and is published in this source. | AES-256-GCM |
| A2 | [apps/desktop/src/main/qq-bot-scan-login.ts:77](../apps/desktop/src/main/qq-bot-scan-login.ts) | Decrypts the QQ Bot AppSecret returned by Tencent's **proprietary** bind-task protocol. Maka generates the 32-byte key (`randomBytes(32)`, line 29) and sends it to Tencent, which returns the secret encrypted under it. | AES-256-GCM |
| A3 | [apps/desktop/src/main/\_\_tests\_\_/qq-bot-scan-login.test.ts:10](../apps/desktop/src/main/__tests__/qq-bot-scan-login.test.ts) | Test-only: encrypts a fixture secret so A2's decryption path can be exercised. | AES-256-GCM |

These three are the complete set of cipher constructions in the tracked tree, and there is no `subtle.encrypt`, `subtle.deriveKey`, or `subtle.deriveBits` anywhere.

A1 is exported from the package's public surface ([index.ts:160](../packages/storage/src/index.ts)) but **no non-test caller instantiates it**. Recorded because it bears on remediation options, not on classification.

## B. TLS — including one interception path with CA generation

| # | Location | Role |
|---|---|---|
| B1 | [packages/eval/harbor/egress-proxy/entrypoint.sh:19–24,38](../packages/eval/harbor/egress-proxy/entrypoint.sh) | **Generates an RSA-2048 CA** via `CertStore.from_store(<dir>, "mitmproxy", 2048)`, publishes `mitmproxy-ca-cert.pem` into a volume the eval subject mounts and trusts, then `exec mitmdump` to intercept and re-originate all subject TLS traffic. Asymmetric key generation over 512 bits, plus TLS termination on both sides. **Inside the source artifact.** |
| B2 | [packages/eval/harbor/egress-proxy/Dockerfile](../packages/eval/harbor/egress-proxy/Dockerfile) | Pins `mitmproxy==12.2.3`; [egress_filter.py](../packages/eval/harbor/egress_filter.py) is a mitmproxy addon enforcing the egress allowlist. |
| B3 | [packages/runtime-host/src/server/websocket-listener.ts:40–42](../packages/runtime-host/src/server/websocket-listener.ts) | TLS server. Serves `wss://` from a caller-supplied certificate and private key; Maka neither generates nor stores that material. |
| B4 | [packages/runtime/src/network/proxy-dispatcher.ts:52](../packages/runtime/src/network/proxy-dispatcher.ts) | TLS client wrapping a proxy `CONNECT` tunnel, SNI derived from the host. |
| B5 | `undici` ^8.7.0, `ws` ^8.21.1, `https-proxy-agent` ^9.1.0, `socks-proxy-agent` ^10.1.0, `socks` ^2.8.9 | HTTPS and WebSocket transports. `ws` uses SHA-1 for the RFC 6455 handshake accept key and non-cryptographic frame masking. |

B1 is the strongest TLS finding, since CA generation is asymmetric key generation rather than TLS client use. No `rejectUnauthorized: false`, `NODE_TLS_REJECT_UNAUTHORIZED`, or custom CA bundle appears outside this deliberate interception path.

## C. Digests — exempt under ASF's stated exclusion

- **204 literal `createHash('<alg>')` call sites across 137 tracked files** — 200 SHA-256, 4 SHA-512. Of those files, 41 are tests and 14 are under `scripts/`.
- **SHA-1 is present**, reached indirectly: [scripts/release-cli-publication.mjs:162](../scripts/release-cli-publication.mjs) calls a helper (line 469) as `digest('sha1', bytes, 'hex')` to verify the npm registry `shasum`. No MD5 appears in Maka's own code.
- **Other languages:** `hashlib.sha256` in the eval harness ([relay_agent.py:512,542](../packages/eval/harbor/relay_agent.py), [run_trial.py:30,50](../packages/eval/harbor/run_trial.py)); .NET SHA-256 in [stdio-relay-smoke.ps1:73](../experiments/windows-sandbox/stdio-relay-smoke.ps1); the `sha2` crate in [Cargo.toml](../experiments/windows-sandbox/launcher/Cargo.toml).
- **PKCE S256** ([oauth-login.ts:71](../packages/runtime/src/oauth-login.ts)) and WebCrypto digests ([subscription-cloaked-request.ts:138](../packages/runtime/src/subscription-cloaked-request.ts), [local-memory-digest.ts:5](../apps/desktop/src/renderer/local-memory-digest.ts)) are digest-only.

## D. Authentication and integrity

| # | Location | Purpose |
|---|---|---|
| D1 | [packages/eval/src/metering-checkpoint.ts:58,70](../packages/eval/src/metering-checkpoint.ts) | HMAC-SHA256 over eval metering checkpoints, keyed by the host-issued relay result token. |
| D2 | [packages/runtime-host/src/server/session-transcript-pager.ts:455](../packages/runtime-host/src/server/session-transcript-pager.ts) | HMAC-SHA256 signing of opaque pagination cursors, keyed by a per-process `randomBytes(32)` secret. |
| D3 | [access-authority.ts:79](../packages/runtime-host/src/server/access-authority.ts), [cdp-bridge.ts:227](../apps/desktop/src/main/browser/cdp-bridge.ts) | `timingSafeEqual` comparison of a stored SHA-256 credential hash and of the CDP bridge bearer secret. |

⚠️ ASF's exemption text names one-way algorithms; HMAC is a keyed construction over one, and is not an encryption algorithm. Under EAR, authentication-only functionality is generally outside 5A002/5D002 confidentiality controls. Nothing turns on it here — §A and §B are independent — and it should not reach BIS as settled. Note that the §772.1 protocol question (§K) is distinct from this one and is **not** resolved by "authentication only".

**CSPRNG:** 18 non-test `randomBytes` sites generate tokens, nonces, IDs, and the A1 IV and A2 key.

## E. SSH

[packages/runtime-host/src/client/ssh-tunnel.ts](../packages/runtime-host/src/client/ssh-tunnel.ts) spawns the host's own `ssh` executable as a child process (`spawn` at line 201 with `executable: 'ssh'` at line 108; `execFile('ssh', …)` at line 291). Key material, host verification, and all SSH cryptography belong to the user's OpenSSH installation.

⚠️ **This holds for Maka's own code and the source artifact, but has not been verified for the Windows binary artifact.** The bundled Git payload (§J, `dugite`) is MinGit on Windows, which may itself carry an SSH client; the macOS payload examined here does not. Per §"Three questions", OpenSSH being the builder does not by itself decide whether Maka's tunnel orchestration is a controlled path.

## F. Credential storage — two stores, both plaintext

**Neither production credential store encrypts at rest.**

| # | Store | Contents | At rest |
|---|---|---|---|
| F1 | `credential-vault.json` — [credential-vault-document.ts](../packages/storage/src/runtime-policy/credential-vault-document.ts), written by [document-io.ts:133](../packages/storage/src/runtime-policy/document-io.ts) | Runtime Policy credentials: Connection API and OAuth material, request headers, web-search keys, proxy passwords. Entries hold `secret: string` directly. | Plaintext JSON, file 0600, directory 0700. Confirmed by [README.md:196](../README.md). |
| F2 | `credentials.json` — [credential-store.ts](../packages/storage/src/credential-store.ts) | Runtime Host client profile access credentials. | Plaintext JSON at 0600. Header comment: "At rest this is plaintext JSON behind 0600 file perms… The OS user account is the security boundary (SECURITY.md)." |

Electron `safeStorage` is not used; pre-existing `safeStorage` files are deliberately not imported ([README.md:197](../README.md)). Access credentials are stored hashed (D3). The A1 Managed Secret store is a third, separate store.

## G. Packaging, signing, and auto-update

- **Source release** ([scripts/asf-source-release.mjs](../scripts/asf-source-release.mjs), added by #3278): produces a SHA-512 checksum file and, via `release:asf:sign`, a **GPG detached signature** (`.asc`) using the releaser's own `gpg` and key. Asymmetric signing; the key material and implementation are the releaser's, not shipped.
- **macOS:** `forceCodeSigning`, `hardenedRuntime`, `notarize`, `dmg.sign` ([electron-builder.config.mjs:145](../apps/desktop/electron-builder.config.mjs)). Apple's `codesign` and notary toolchain.
- **Windows:** **no Authenticode certificate is configured**, and the config records that `electron-updater` therefore skips update signature verification ([electron-builder.config.mjs:168–178](../apps/desktop/electron-builder.config.mjs)).
- **Auto-update** ([app-update-service.ts](../apps/desktop/src/main/app-update-service.ts), `electron-updater` ^6.8.9) verifies artifact integrity by SHA-512 checksums in `latest-*.yml`.

## H. Native code

- **Rust** ([Cargo.toml](../experiments/windows-sandbox/launcher/Cargo.toml)): `sha2 = "0.10"` (digest); `windows-sys` with `Win32_Security_Cryptography` enabled, per the in-file comment, solely for `BCryptGenRandom` — OS CSPRNG.
- **Swift** ([ax-oracle.swift](../scripts/computer-use/ax-oracle.swift), [physical-input-age.swift](../scripts/computer-use/physical-input-age.swift), [real-e2e-monitor.swift](../scripts/computer-use/real-e2e-monitor.swift)): imports are `Cocoa`, `CoreGraphics`, `AppKit`, `ApplicationServices`, `Foundation`, `Darwin` only. **No CryptoKit, no Security.framework.**
- **PowerShell** ([windows-runtime-host-local-ipc-trust.ps1:106](../scripts/windows-runtime-host-local-ipc-trust.ps1)): `ConvertTo-SecureString -AsPlainText -Force` converts a generated password into a `SecureString` for `New-LocalUser`. This parameter set performs no encryption.

## J. Third-party cryptography, by artifact

### Shipped at runtime

| Package | Introduced by | Crypto |
|---|---|---|
| `dugite` 3.2.2 | Root [package.json:81](../package.json) `devDependencies`, but bundled into the shipped desktop app via `extraResources` ([electron-builder.config.mjs:20](../apps/desktop/electron-builder.config.mjs)) and resolved on the product path by [bundled-git-runtime.ts](../packages/runtime-host/src/server/bundled-git-runtime.ts) | **A complete Git distribution, ~141 MB.** Carries `libSystem.Security.Cryptography.Native.OpenSsl.dylib`, `libSystem.Security.Cryptography.Native.Apple.dylib`, the `System.Security.Cryptography.*` .NET assemblies (git-credential-manager), and `git-remote-http` for TLS transport. Windows uses MinGit, whose payload differs and was not examined. **Largest third-party crypto payload in the product.** |
| `@jackwener/opencli` 1.8.6 | [apps/desktop/package.json:48](../apps/desktop/package.json), direct dependency | **Vendor-private API signing with hardcoded key material** — see §K. Instagram private-API `signed_body` HMAC-SHA256 under `INSTAGRAM_STORY_SIG_KEY` (`clis/instagram/_shared/private-publish.js:16`); Tieba MD5 request signing under `TIEBA_PC_SIGN_SALT` (`clis/tieba/utils.js:6`); Flomo salt/MD5 signing (`clis/flomo/memos.js:62`); YouTube `SAPISIDHASH` SHA-1 write auth (`clis/youtube/utils.js:189`); Bilibili WBI query signing (`clis/bilibili/utils.js`); Douyin upload HMAC-SHA256 (`clis/douyin/_shared/tos-upload.js:47`). The list is illustrative, not complete. |
| `@larksuiteoapi/node-sdk` 1.72.0 | [packages/runtime](../packages/runtime/package.json) | AES-256-CBC `createDecipheriv` for Lark event-callback decryption — 1 site in `lib/index.js`, 1 in `es/index.js`. ⚠️ Maka configures no encrypt key, so the path appears unreachable as configured. |
| `@wecom/aibot-node-sdk` 1.0.7 | [packages/runtime](../packages/runtime/package.json) | AES-256-CBC for WeCom callback encryption. ⚠️ Also exposes per-message `aesKey` file decryption (`decryptFile`, `downloadFile`), which does not depend on a global callback key, so unreachability cannot be inferred from configuration alone. |
| `jose` 6.2.3 | `@modelcontextprotocol/sdk` 1.30.0, `@modelcontextprotocol/client` 2.0.0 | JOSE — JWS signing and JWE encryption, via MCP OAuth. v6 delegates to the runtime WebCrypto/`node:crypto`. |
| `openai` 6.49.0 | `@openai/agents-core` 0.14.3 via [packages/runtime](../packages/runtime/package.json); present in the desktop third-party notices | Webhook signature verification — `subtle.importKey` with HMAC-SHA256 and `subtle.verify` (`resources/webhooks/webhooks.mjs:65`). Integrity, per §D. |
| `uuid` 14.0.1 | Transitive, production closure | Carries MD5 and SHA-1 implementations for name-based UUIDs. Digests, exempt per §C. |
| `@ai-sdk/code-mode`, `cookie-signature` | [packages/code-mode](../packages/code-mode/package.json); `express` via `@modelcontextprotocol/sdk` | HMAC-SHA256 continuation signing and cookie signing. Integrity, per §D. |
| Node.js ≥22.19.0 | `engines` — user-supplied for the CLI | **OpenSSL.** Backs every `node:crypto`, `node:tls`, `node:https` call. |
| Electron 43.2.0 | [apps/desktop](../apps/desktop/package.json), embedded in packaged binaries | **BoringSSL**, plus Node's OpenSSL. Not in the source artifact. |
| OpenSSH | User's system, spawned (§E) | All SSH cryptography. Neither shipped nor linked by Maka's own code. |

### Eval harness — second lockfile and container image

`mitmproxy==12.2.3` (§B1–B2); `jose`; `jws`/`jwa` (JWS signing); `@aws-crypto/sha256-js` and `@aws-crypto/sha256-browser` (digests); `@smithy/signature-v4` and `@aws-sdk/signature-v4-multi-region` (HMAC request signing).

### Rust — third lockfile

[Cargo.lock](../experiments/windows-sandbox/launcher/Cargo.lock) adds digest and CSPRNG only (`sha2`, `windows-sys` CNG). No confidentiality primitive.

### Build and dev only

`pkijs` 3.4.0, `@peculiar/webcrypto` 1.7.1 (a full WebCrypto implementation including AES-CBC/CTR/GCM/KW), `asn1js`, `@noble/hashes` via `app-builder-lib` / electron-builder 26.15.3; `aws4` 1.13.2 via `electron-publish`.

### Coverage limit

Sections §A–§H are exhaustive for the tracked source. **§J is not exhaustive for transitive dependencies.** It covers all three lockfiles' direct and notable transitive crypto plus a scan for common crypto-implementing package names. Three successive revisions of this document each missed a shipped dependency that a name-based scan does not surface — `dugite`, whose crypto is a bundled binary payload rather than JavaScript; `@jackwener/opencli`, whose crypto is inline vendor protocol code; and `openai`, reached transitively through `@openai/agents-core`. **A closed manufacturer set must be generated per artifact from a frozen install and from the actual packaged output, not taken from this list.**

## K. Determination

**Mentor guidance: no BIS notification and no exports-matrix entry are required for Maka.** The basis given is that Maka develops no cryptographic algorithm of its own and uses existing third-party dependencies, so the ASF notification process does not apply to it.

#3273 allows closing on "the authoritative determination that no entry is needed" rather than on a filed notification. This document records that determination and the evidence behind it; the approving review on this pull request is what places it on the public record. The authority is the mentors', not this document's.

**What the exports matrix actually shows.** Two patterns, and they point in different directions, so both are recorded rather than only the convenient one.

Recent projects are simply absent: OpenDAL, Doris, Iceberg, Pekko, Kvrocks, Celeborn, StreamPark, and Answer have no entry, and OpenDAL carries no crypto notice in its repository. But the historical entries do **not** draw a line at implementing or bundling cryptography. The most common annotation on the page is "designed for use with encryption library" — 59 entries across its two capitalisations — and Apache Impala's own entry reads `2.7.0 and later / 5D002 / ASF`, annotated "Designed for use with OpenSSL." Merely using a cryptographic library was historically enough to file, which is the same posture Maka is in. Podling status was never a barrier either: Hop, Impala, and Milagro all have incubating-era entries. Seventeen products do name The OpenSSL Project as a co-manufacturer — Cassandra, Commons Crypto, httpd, Ignite, ORC, Tomcat native connector and others — but Impala is not among them.

Read together, the gap between the historical entries and the recent absences is evidence that the published process has fallen out of use, not that it draws a boundary Maka sits outside of. That is consistent with the page dating its own regulatory description to May 24, 2019. **This context does not establish the determination; the determination rests on the guidance above.**

**The facts this rests on, restated for a later reviewer:**

- Maka implements no cryptographic primitive. Every algorithm resolves to OpenSSL, BoringSSL, mitmproxy/OpenSSL, Windows CNG, a public Rust crate, or the user's OpenSSH (§A–§J).
- Maka's own source does perform AES-256-GCM encryption (§A) and generate an RSA-2048 CA (§B1), both past the 5D002 thresholds. The determination turns on who implemented the cryptography, not on whether Maka invokes it.
- The basis above speaks to who implemented the cryptography. On what each artifact contains: the source artifact carries no third-party cryptographic implementation, while the desktop convenience binary bundles a Git distribution including OpenSSL native libraries (§J).
- Every algorithm found is a published standard. §772.1 also reaches proprietary or unpublished *protocols*, and three constructions touch that boundary: `@jackwener/opencli`'s vendor-private API signing with hardcoded key material (§J), Tencent's undocumented QQ Bot bind-task protocol (§A2), and Maka's own Managed Secret envelope construction (§A1, published in this source). The guidance above treats none of these as disqualifying.

**Not required, therefore:** the BIS notification email, the exports-matrix `.yaml` entry, and the ASF README crypto notice. No such notice exists today in `README.md`, `README.zh-CN.md`, `NOTICE`, `LICENSE`, or `DISCLAIMER-WIP`, and on this determination none is needed.

If a closed manufacturer set is ever needed, it must be generated per artifact from a frozen install and the actual packaged output, not taken from §J.

---

*Produced with AI assistance (Claude, via Claude Code), and revised across three rounds of adversarial review by Claude Fable and OpenAI Codex. Findings were verified against the source, the ASF pages, and the regulatory text before being applied; that is not independent human review. The human contributor of record owns the accuracy of this inventory; the determination in §K is the mentors'.*
