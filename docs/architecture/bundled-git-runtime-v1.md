# Bundled Git Runtime v1

Status: implementation slice for managed-workspace execution. This is a publication capability that
sits between M1.2 runtime-host composition and broad managed-workspace enablement; it is not M1.3
dependency/secret provisioning.

## 1. Invariant and owner

The Runtime Host may enable the managed-workspace owner only with the Maka-packaged Git toolchain for
the current platform and architecture. It must never discover or fall back to a Git executable through
`PATH`, a shell profile, a package manager, or the source workspace.

Ownership is split deliberately:

- `dugite@3.2.2` owns the upstream `dugite-native` release URL and archive SHA-256;
- `scripts/prepare-bundled-git.mjs` owns build-time version, executable, license, and digest validation;
- `bundled-git.json` binds one packaged artifact to platform, architecture, Git version, archive digest,
  executable path, and executable digest;
- Runtime Host resolves the manifest and refuses missing, malformed, mismatched, escaped, symlinked, or
  digest-mismatched artifacts;
- storage re-hashes the exact executable before every Git process and constructs the `dugite-native`
  helper environment without inheriting a system-Git `PATH`.

Two digests intentionally serve different purposes:

- `executableSha256` is rechecked immediately before every Git invocation. It proves which entry binary
  storage is about to execute;
- `runtimeIdentitySha256` is a canonical digest of the declared distribution identity: manifest
  protocol, provider, Git version, platform, architecture, executable location and digest, and the
  upstream archive digest. Managed repository, epoch, and worktree-binding artifacts persist this value
  as `gitRuntimeSha256`, so changing any of that provenance creates an explicit epoch incompatibility
  instead of silently reinterpreting an existing workspace.

The manifest is evidence about one packaged distribution, not a mutable preference and not a system Git
probe result.

## 2. Supply chain

The dependency is exact-pinned as `dugite@3.2.2`. Its `embedded-git.json` pins
`desktop/dugite-native@v2.53.0-3` and provides a SHA-256 for every supported archive. Dugite verifies that
archive before extraction. Maka then executes the extracted binary with `--version`, hashes that exact
binary, and emits the platform manifest used by packaging and runtime admission.

The archive checksum is not an independent trust root. `npm ci` first authenticates the exact dugite
package bytes against `package-lock.json` integrity; that pinned package supplies `embedded-git.json`,
which authenticates the native archive; Maka then regenerates `bundled-git.json` inside each platform's
release job immediately before packaging. Review and branch protection own lockfile changes. The signed
and notarized macOS application closes the artifact-publication chain. The current Windows release is
explicitly unsigned, so its published SHA-256 and GitHub release transport do not provide OS-level
publisher identity; that remains a release security limitation rather than something the runtime
manifest can repair.

The packaged runtime includes the complete `dugite-native` directory rather than copying only `git`.
Git subprograms, templates, MinGit libraries, certificates, and platform support files remain relative to
the same root. Runtime environment variables (`GIT_EXEC_PATH`, templates, Linux `PREFIX`/CA bundle, and
Windows MinGit paths) are derived only from that declared root.

Every managed Git process receives an isolated environment: an owner-specific `HOME` and
`XDG_CONFIG_HOME`, `GIT_CONFIG_NOSYSTEM=1`, non-interactive credential settings, a fixed hooks directory,
and a `PATH` containing only the declared runtime directories. Runtime Host does not merge the user's
shell environment into this map. On Windows, the MinGit DLL/helper directories are included explicitly;
the current working directory is the Maka-owned home rather than the source checkout or application
directory.

The execution profile is also injected at command priority and persisted on Maka-owned repositories:
`core.hooksPath` points at the owned empty hooks directory, credential helpers and interactive prompts
are disabled, `core.sshCommand` is empty, and `protocol.allow=never` prevents transport activation in
the current local-only workspace protocol. Operation-scoped environment values are merged before the
hermetic profile, so they cannot override its HOME, PATH, config, or prompt fences. Source repository
configuration is never copied into the independent managed repository; unsupported indirection such as
includes, alternates, replace refs, partial-clone state, and executable fsmonitor configuration is
rejected before baseline import.

Production never resolves Git through `node_modules`. Dugite is the build-time supplier; Electron copies
the complete extracted distribution to `resources/git`, and Runtime Host resolves only that signed
application resource root. Storage receives a narrow verified-runtime input and has no dependency on the
dugite npm package or its manifest format.

`VerifiedGitRuntime` is currently the Maka-owned adapter boundary between managed-workspace operations
and the distribution. A broader public `MakaGitRuntime` interface is intentionally deferred until a
second production implementation exists; introducing a swappable system-Git or libgit2 abstraction now
would create an unsupported execution mode rather than strengthen the present invariant.

## 3. Ordering and atomic boundary

Publication ordering is:

1. install the exact npm lockfile;
2. let dugite download and SHA-256 verify the platform archive;
3. run `prepare:bundled-git` and verify the executable version and digest;
4. package the complete Git directory, manifest, and notices in the signed application;
5. verify their presence in the packaged application;
6. at Runtime Host startup, resolve and verify the manifest before composing a managed-workspace owner;
7. immediately before each Git invocation, storage re-verifies the executable digest.

There is no cross-filesystem transaction spanning npm download and application packaging. A partially
prepared or mixed artifact is therefore not repaired in place: no `distributionReady: true` manifest is
accepted unless all build checks have completed, and runtime fails closed on any mismatch.

The v1 identity binds the SHA-256-verified upstream archive rather than hashing every extracted file at
startup. This avoids an important signing ambiguity: macOS code signing may legitimately rewrite Mach-O
bytes after the prepare step, so a pre-sign tree digest could make the signed application reject itself.
A future post-sign runtime-tree/Merkle manifest must be generated and verified inside the release-signing
pipeline, not added as an ordinary prepare-time hash. Until then, Maka does not claim per-file integrity
for every helper in the extracted tree.

That limitation is deliberate but security-relevant: v1 detects entry-binary replacement before every
Git process, while helper integrity relies on the authenticated upstream archive plus the packaged
application boundary. Closing it requires a dedicated publication slice that observes the final signed
helper bytes at the correct signing phase, binds that inventory into the outer application signature,
and verifies the inventory at managed-operation admission. Hashing the pre-sign extraction here would
be incorrect. The remaining verify-to-spawn window cannot be eliminated portably by a path-based handle;
the current threat model relies on packaged resources not being writable by the managed workspace and
on platform publisher authenticity. macOS supplies that authenticity today; Windows Authenticode is a
separate release-security prerequisite and is not synthesized by `bundled-git.json`.

## 4. Failure states and rollback

Stable runtime failure classes are:

- `bundled_git_unavailable`: manifest or executable is absent/unreadable;
- `bundled_git_manifest_invalid`: schema, path, or distribution metadata is invalid;
- `bundled_git_platform_mismatch`: artifact targets a different OS or architecture;
- `bundled_git_integrity_mismatch`: packaged executable differs from the build manifest.

These failures disable managed-workspace composition. They do not change attached mode and never cause a
system Git fallback. Rollback is release-level: ship the prior application bundle or disable the managed
workspace feature. Runtime must not rewrite the signed resources or silently regenerate the manifest.

## 5. Platform matrix

| Platform | Bundled executable | Helper environment | Current promise |
|---|---|---|---|
| Windows x64/arm64/ia32 | `git/cmd/git.exe` | MinGit `mingw*`/`clangarm64` bin and `libexec/git-core` | Supported by the pinned dugite-native archive; managed filesystem execution remains separately gated by the Windows sandbox capability |
| macOS x64/arm64 | `git/bin/git` | bundle `libexec/git-core` and templates | Supported; release must remain code-signed/notarized as one app bundle |
| Linux x64/arm64/arm/ia32 | `git/bin/git` | bundle `libexec`, templates, `PREFIX`, and CA file | Supported where the corresponding pinned archive and filesystem sandbox backend are available |

Power-loss durability is not created by bundling Git. Repository/worktree durability remains owned by the
managed-workspace artifact protocol and its crash tests.

## 6. Acceptance tests

- strict manifest happy path;
- platform/architecture mismatch;
- executable tampering;
- source-repository config and environment poisoning cannot override the managed execution profile;
- missing manifest with a system Git present (must still fail);
- path escape and symlink rejection;
- build preparation from the exact dugite platform record;
- Git version mismatch and unsupported platform rejection;
- packaged app contains the Git runtime, manifest, and license notices;
- production-shaped managed workspace open using the packaged runtime (required before broad enablement).

The production-shaped smoke exercises the real commands required by the current owner, including
repository creation, ref updates, tree/index operations, and worktree lifecycle. This is the capability
gate. Startup `--help` probes are deliberately not used: they are weaker than executing the actual
workflow, can invoke pagers or platform-specific help behavior, and would duplicate checks before every
application launch. Individual Git failures remain fail-closed at the operation boundary.

The last item is deliberately a release gate rather than evidence that managed execution is already the
default. Desktop/CLI activation remains a later, explicit product decision.

The future M2 `WorkspaceVersionAccepted` fact must carry the same Git runtime identity alongside its
parent version, accepted commit/tree, materialization profile, and policy identity. Repository/epoch
binding protects the current managed artifact; version-fact binding is separately required to make an
accepted mutation historically interpretable. It belongs to M2 and must not be approximated in this
publication PR before that fact has a production writer and consumer.

## 7. Licensing and size policy

The full `dugite-native` directory is packaged, including whatever component license directories its
platform archive supplies. Because those archives do not expose Git's license at one uniform path, Maka
also tracks the Git GPLv2 text and packages it consistently as `resources/licenses/git/LICENSE.txt`
alongside the Git/dugite notices. Prepare and final-package verification both require that stable asset.
A generated component inventory is useful release hardening, but it is not represented as a
runtime-authority guarantee in v1 and should be implemented as a dedicated supply-chain slice.

The first release keeps the full upstream distribution. Pruning shells, Perl, GUI programs, docs, or
helpers is deferred until Maka has an exact command/helper allowlist and the pruned artifact passes the
same production-shaped release smoke on Windows, macOS, and Linux. Package size alone is not sufficient
evidence that a helper is safe to remove.

An application upgrade currently replaces the packaged runtime. Existing managed artifacts whose
recorded runtime identity differs therefore fail closed and require an explicit future migration,
rebaseline, or compatible-runtime retention policy. V1 does not silently migrate them and does not ship
multiple runtime generations. A versioned `resources/git-runtime/<identity>` layout is a possible future
carrier, but adopting it requires an owner and retention/patching policy rather than a directory rename.
