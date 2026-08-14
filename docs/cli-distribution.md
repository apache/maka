# CLI/TUI distribution contract

Maka ships its CLI/TUI as a required artifact of the same product release as Desktop. Phase 1
publishes one signed and notarized Apple Silicon artifact:

`Maka-<version>-cli-mac-arm64.zip`

The ZIP contains an exactly pinned official Node runtime and the production workspace/npm
dependency closure derived from repository manifests and `package-lock.json`. It does not use a
system Node installation or a single-file/SEA build.

## Public contract

Only these surfaces are stable:

- `bin/maka`, including invocation through a symlink outside the extracted archive;
- the documented `RELEASE.json` fields below.

`libexec/**` is private and may change between releases. There is no public `maka-agent` launcher.
The TUI is the default interactive mode of `maka`, not a separate artifact.

`RELEASE.json` fields:

| Field | Meaning |
| --- | --- |
| `schemaVersion` | Metadata schema version, initially `1` |
| `product` | Product name, `Maka` |
| `version` | Root `package.json` product version |
| `sourceCommit` | Exact source commit shared by every release artifact |
| `platform` / `architecture` | Artifact target, `macos` / `arm64` |
| `publicCommands` | Public command list; exactly `["maka"]` in Phase 1 |
| `node` | Official Node version, source URL, archive name, and archive SHA-256 |
| `npmVersion` | Exact npm version used to materialize the production closure |
| `dependencyPatches` | Sorted repository patches applied to the staged dependencies |
| `productionDependencies` | Sorted external `name@version` production closure |
| `thirdPartyNoticesSha256` | Digest binding notices to this artifact |
| `workspacePackages` | Sorted manifest-derived production workspace closure |
| `machOBinaries` | Sorted paths of every Mach-O file that must be signed and verified |
| `signing` | `developer-id-notarized` for release artifacts; `development` for local checks |

The CLI-specific `THIRD_PARTY_NOTICES.txt` must enumerate exactly the external production
dependencies recorded in `RELEASE.json`. The checksum is generated only after signing and
notarization complete.

## Release and installation boundary

Root `package.json` is the sole version authority. Desktop and CLI manifests must match before
packaging. Desktop, CLI/TUI, and source jobs build independently from one commit; one publish job
collects their verified outputs and creates one Draft GitHub Release.

The GitHub Release ZIP is the immutable distribution source. Future Homebrew or npm channels must
consume the same artifact, version, layout contract, and release line; they do not define a second
release or block Phase 1.
