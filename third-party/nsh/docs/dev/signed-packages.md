# Signed packages

For code an app downloads (first-party updates, third-party mini apps): `nsh_package` and `nsh publish`.

- **Bytecode is trusted input.** QuickJS does not validate bytecode; loading crafted bytecode corrupts memory. So
  `Bundle::bytecode` / `Bundle::read_trusted` are `unsafe` and only called for: the app's own signed resources
  (`nsh-ios-app`, `AppActivity`, `NshView.loadAssetBundle`, `NshAppView.loadBundle` for a path inside the main bundle —
  `nsh_platform_ios::in_app_bundle`), bytecode compiled in-process, the dev server the developer connected to (its
  handshake negotiates the version), and verified packages (`Bundle::from_package`). `Bundle::read` and
  `NshView.loadBundleFile` refuse `.nshc` files; downloaded code is either JS source or a signed package.
- **Keys, two levels**: a root key (offline; apps trust its public key, several may be trusted) certifies release keys
  (`nsh certify`: app id patterns `*` / `com.example.*` / an id, and a validity window). Packages are signed by a
  release key and carry its certificate, so release keys rotate without app updates. Key ids are derived (first 8
  bytes of the SHA-256 of the public key). Every signature is over `context \0 sha256(message)` with a context per kind
  (package, certificate, revocation list), so one can never pass for another.
- **Package** (`.nshpkg`, format in `nsh-package/src/lib.rs`): a JSON header (app id / name / version / build,
  declared capabilities, bytecode version, minimum runtime, signing time, the certificate, a file table with SHA-256s)
  then the files (source, bytecode, source map, assets), then the release key's signature over everything before it.
  The source is always included; the bytecode is only used when its version is the runtime's `BYTECODE_VERSION`.
  `nsh publish` compiles it with `nsh_js::Strip::Source`: the line tables stay (about +20% bytecode), so stacks read
  `bundle.js:L:C` and the package's map (or `nsh symbolicate` with the map kept out of it, `--source-map file`) maps
  them; `Strip::All` (`--strip-debug`) leaves `<null>:0:1`. The source the package carries is the same minified
  code, so stripping it from the bytecode as well hides nothing.
  The minimum runtime defaults to the signing CLI's version (`RUNTIME_VERSION`, the workspace version): the bundle
  links against that CLI's native modules, so only it is known to run it. `nsh publish --min-runtime` / `nsh.json`
  `minRuntime` lowers it (`MAJOR.MINOR.PATCH`, never above the signer's; suffixes are ignored when comparing).
  `nsh publish` refuses to sign what a device would refuse (the certificate must cover the app and the time).
- **Signing again** (`nsh_package::resign`, `nsh publish <package>`): CI builds and signs with keys of its own (test apps trust
  their root), a platform signs the package again with the key production apps trust. Only the header's
  `certificate` and `createdAt` and the signature change: the header is rewritten as JSON, not through `Header`,
  which drops the fields this runtime does not know (dropping one `critical` names would lift its restriction on
  runtimes that know it), the files' bytes are copied, and the minimum runtime stays the building CLI's (it may be
  newer than the re-signing one). The input must be intact (its own certificate's key signed it, the file table tiles
  the data, every hash matches); its certificate is not checked against a root. The new certificate must cover the
  app and the time, as for `build`. Signing again vouches for the package's bytecode, which is trusted input: a
  platform signs only what its own builds made.
- **Forward compatibility** ("Format evolution" in `nsh-package/src/lib.rs`): older runtimes ignore header and `app`
  fields they do not know, and leave files of unknown kinds or with unknown fields unused (still tiled and hashed),
  so additions are optional by default; a field older runtimes must not ignore is named in the header's `critical`
  (they refuse the package). Capabilities: `Capabilities::from_json_lenient`, see `sandbox.md`. What was left out is
  in `VerifiedPackage::ignored` and logged by `Bundle::from_package`. Incompatible changes bump the format version.
  Certificates and revocation lists still refuse unknown fields.
- **Verification** (`TrustStore::verify`): the certificate's root signature, the release key not revoked, the package
  signature, the app id as one path segment (`check_app_id`: no `/`, `\`, `:` or NUL, not `.` or `..`, since it names
  directories under the assets root and the data directory; `build` and `resign` refuse it too) and with the signing time
  against the certificate, the minimum runtime, the file table tiling the
  data exactly, each file's hash, the package hash not revoked, and the build not older than the highest accepted for
  that app (`accept` records it; rollback protection). Revocation lists (`nsh revoke`, signed by a root) only replace
  an older list (sequence numbers), so an old list cannot be replayed. The state (newest list, accepted builds)
  persists in the store's directory (`nsh-trust.json`, written atomically).
- `nsh_engine::load_package` verifies, extracts the assets once per package to `<root>/<app id>/<sha256>/assets`,
  accepts the build and returns the bundle (with the package's declared capabilities) and the asset directory: it is
  `verify_package` (all of that but accepting) then `accept_package`. Accepting after verifying is for hosts that run a
  new package and record it only once it proved healthy: `LoadedPackage::receipt` (`VerifiedPackage::receipt`, a
  `non_exhaustive` `PackageReceipt`: app, hash, key id; only a verified package makes one) goes to
  `TrustStore::accept_receipt`, which re-checks the revocations (a package or key revoked since it was verified is not
  accepted, so the floor never rises to a build the app cannot run) and only raises the accepted build. Rollback
  protection is unchanged: `verify` still refuses builds below the accepted one, so before accepting the app can only
  go back to what it accepted before, never further; a host that never accepts keeps the floor where it was.
- **Embedding**: verifying (hashing, extracting assets) is done off the UI thread, running on it. iOS (Swift)
  `NshTrust(stateDirectory:)` / `addRoot` / `updateRevocations` / `openPackage(at:) async throws -> NshPackage` (its
  `info`: id, name, version, build) and `NshAppView.run(_:)`, or `loadPackage(at:trust:) async throws`; Android
  `NshTrust(stateDir)` / `addRoot` / `updateRevocations` / `openPackage(file) throws NshPackage.RefusedException`
  (any thread) and `NshView.runPackage(pkg)`; GPUI (Rust) `nsh_platform_gpui::verify_package` / `load_package` (off the
  main thread), `AppView::run_package(&package)` (the package's assets become the view's asset base) and
  `accept_package`. A refused package throws; the running app stays. To try a package on a simulator / emulator: `nsh-ios-host --package <file> --root <root.pub>`, or
  `DevActivity` with the `package` (path on the device) and `root` (base64) extras; their trust state persists in
  the temporary / cache directory, so older builds are refused there too.
- **OTA updates of packaged apps' own code** (`nsh_engine::updates`, `docs/dev/updater.md` "OTA updates"): a packaged
  app whose `nsh.json` trusts roots (`"updater": { "packages": { "roots" } }`) downloads packages of its own code
  from its update source (`nsh/updater`'s `checkForPackage` / `downloadPackage`), and its launcher runs the newest
  verified one on trial, accepting it once healthy. Embedding apps still decide where their packages come from.

The format, the trust model and the key handling are documented in `crates/nsh-package/src/lib.rs`.
