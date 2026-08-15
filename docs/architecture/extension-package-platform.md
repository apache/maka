# Unified Extension Package Platform

Maka Extensions have one product identity and one immutable content Revision.
Tool and UI are typed Contributions of that Revision, not separate plugin
products. `maka.extension.json` is the shared product contract; the existing
`maka.tool.json` and `maka.ui.json` remain the typed execution manifests.

## Unified contract

`maka.extension.json` declares:

- canonical `id`, semantic `version`, display name, and description;
- required package dependencies with exact, `^`, `~`, `*`, or `latest` ranges;
- a bounded, flat configuration Schema with defaults, required keys, enums,
  and secret markers.

`extension.contract.query` joins this metadata with the Tool and UI manifests
and returns one typed Contribution Catalog. Agent `inspect_tools` and
`inspect_ui` both expose the same Catalog, so authoring starts from one source
of truth instead of domain-specific guesses.

## Profile installation and dependencies

`extension.package.install` accepts either a safe local directory or a
`.maka-extension` Bundle. Package bytes are copied into root-private,
content-addressed storage. Installation never activates code.

Enabling a Revision resolves its declared dependency versions from installed
contracts, creates deterministic dependency Bindings in the same scope, and
converges dependencies before the requester. Cycles, missing versions, invalid
configuration, and conflicting scope ownership fail closed. A dependency in use
cannot be disabled or removed; deterministic dependency Bindings are reclaimed
after their final enabled requester is disabled or removed. Tool Contributions
installed from the Desktop are bound to the persistent `profile` scope and are
composed into every Session Tool snapshot. UI Contributions are independently
bound to `desktop-ui`; a combined package therefore retains typed scope and
permission separation while sharing one Revision.

Profile entries participate in the exact Run Composition digest. Restart
recovery restores desired/last-good Bindings, dependency Bindings, and
configuration before new Tool resolution.

## Configuration

Configuration is stored per Binding, allowing the same package to have
different settings in different scopes. Mutation is Schema-validated and
persisted before the Binding is restarted. Tool workers receive the complete
configuration inside their isolated invocation context. UI frames receive only
non-secret keys through `window.makaUI.getConfig()`; secret values never cross
into the Renderer.

## Distribution and management

`extension.package.export` emits a deterministic `.maka-extension` Bundle. It
contains bounded, path-safe files, per-file SHA-256 values, and a whole-package
digest. Import rejects traversal, symlinks, corruption, duplicate paths, and
oversized payloads before either typed Store installs the Revision. Export is
exclusive and never overwrites an existing target.

The Desktop Extensions page lists Tool and UI Contributions together and
supports directory/Bundle installation, Profile/Desktop activation, unified
enable/disable, per-scope Schema-backed JSON configuration, export, and removal. Agent
dynamic definitions write the same unified manifest and enter the same Store,
Catalog, lifecycle, dependency, configuration, and distribution paths.
