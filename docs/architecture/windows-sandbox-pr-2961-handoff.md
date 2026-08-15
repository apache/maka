# Windows Sandbox PR #2961 Handoff

## 1. Scope

This handoff covers the Windows AppContainer sandbox work on PR #2961 and the
related acceptance work for issue #2142.

The goal is to run Maka tools through a Windows broker and AppContainer while
enforcing filesystem, network, process, and timeout boundaries.

Current branch: `feat/windows-sandbox-w0-spike`

Latest pushed commit: `2e50cc90a`

## 2. Completed Work

The following pieces are implemented and have passed the available local or CI
checks:

- AppContainer and atomic Job launch path.
- Broker-local manifest and client PID/nonce validation.
- Filesystem root validation, including exact and subtree roots.
- Windows path rejection for UNC/device/ADS/reparse-point cases covered by the
  current tests.
- Network restricted mode and fail-closed behavior.
- Windows profile compilation and broker manifest generation.
- Package verifier launch policy now includes `exactReadRoots` and
  `exactWriteRoots`, fixing the known digest input mismatch in the verifier.
- ACL ledger lock contention now waits with a bounded timeout.
- ACL ledger records the owner PID and can identify an exited owner before
  taking over a stale lock.
- ACL state is saved before grants and restored afterward instead of blindly
  removing every ACE for the AppContainer SID.

## 3. Verification Completed

Local checks completed:

```text
npm run build --workspace @maka/runtime
node --test packages/runtime/dist/__tests__/windows-sandbox.test.js packages/runtime/dist/__tests__/windows-sandbox-profile.test.js
```

Result: 7 tests passed, 0 failed.

Rust Windows-target check:

```text
cargo check --manifest-path experiments/windows-sandbox/launcher/Cargo.toml --target x86_64-pc-windows-gnu
```

Result: passed.

Formatting and `git diff --check` also pass.

The previous GitHub package failure was:

```text
profile_digest_mismatch:
profileDigest does not match the canonical launch policy
```

That failure was from the pre-`2e50cc90a` revision. A new CI run is required to
confirm the verifier fix in the packaged Windows artifact.

## 4. Known Remaining Blockers

The PR is not yet ready to merge or for final approval. These items remain:

### 4.1 Filesystem worker standard-stream relay

`CreateProcessW` currently does not configure `STARTF_USESTDHANDLES` or relay
stdin/stdout/stderr pipes to the actual filesystem worker. The TypeScript client
expects one JSON response on stdout, while the broker may also emit diagnostics.

Required work:

- Create inheritable stdin/stdout/stderr pipes.
- Configure the child startup info with the correct handles.
- Forward the request JSON and close stdin for EOF.
- Return worker stdout as the response and keep diagnostics on stderr.
- Preserve cancellation, timeout, non-zero exit, and large-payload behavior.

### 4.2 ACL recovery and compatibility tests

The new ACL backup/restore path needs Windows integration tests covering:

- An ACE that existed before launch remains after launch.
- Exact directory grants do not recursively remove child ACEs.
- Concurrent launches (8-20 tasks) succeed or wait rather than fail immediately.
- A killed broker leaves recoverable state for the next launch.
- Old or malformed ledger files fail closed without deleting unrelated ACLs.

### 4.3 Packaged Windows E2E

The packaged artifact must exercise real `Read`, `Glob`, `Grep`, and `Bash`
through `FilesystemWorkerClient`, not only the AppContainer smoke probe.

### 4.4 Remaining consistency work

- Share one canonical Windows path implementation between core permissions and
  the Windows sandbox compiler.
- Align Runtime and broker timeout values and error classification.
- Rebuild and package the native launcher; do not rely on the old untracked
  binary under `apps/desktop/resources/windows-sandbox/`.

## 5. Acceptance Commands

After pushing the next changes, run or inspect:

```text
gh pr checks 2961 --repo maka-agent/maka-agent
npm run verify:windows-x64 -- apps/desktop/release/Maka-<version>-win-x64.exe
```

The PR should not be approved until the `package` job and the real packaged
Windows filesystem-worker E2E are green.

## 6. Reviewer Context

The Windows acceptance report recommended `Request changes`. It confirmed that
the basic AppContainer boundary works, but also reproduced concurrency failures,
stale lock recovery failures, ACL rollback damage, and the missing worker
standard-stream relay. Those findings are product-level blockers rather than
cosmetic CI issues.

The current Maka experiment may still contain an old native sandbox binary.
Always rebuild the launcher, replace the packaged resource, restart Maka, and
use a clean session before judging end-to-end behavior.

