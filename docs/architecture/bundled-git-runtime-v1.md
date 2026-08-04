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

The manifest is evidence about one packaged distribution, not a mutable preference and not a system Git
probe result.

## 2. Supply chain

The dependency is exact-pinned as `dugite@3.2.2`. Its `embedded-git.json` pins
`desktop/dugite-native@v2.53.0-3` and provides a SHA-256 for every supported archive. Dugite verifies that
archive before extraction. Maka then executes the extracted binary with `--version`, hashes that exact
binary, and emits the platform manifest used by packaging and runtime admission.

The packaged runtime includes the complete `dugite-native` directory rather than copying only `git`.
Git subprograms, templates, MinGit libraries, certificates, and platform support files remain relative to
the same root. Runtime environment variables (`GIT_EXEC_PATH`, templates, Linux `PREFIX`/CA bundle, and
Windows MinGit paths) are derived only from that declared root.

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
- missing manifest with a system Git present (must still fail);
- path escape and symlink rejection;
- build preparation from the exact dugite platform record;
- Git version mismatch and unsupported platform rejection;
- packaged app contains the Git runtime, manifest, and license notices;
- production-shaped managed workspace open using the packaged runtime (required before broad enablement).

The last item is deliberately a release gate rather than evidence that managed execution is already the
default. Desktop/CLI activation remains a later, explicit product decision.
