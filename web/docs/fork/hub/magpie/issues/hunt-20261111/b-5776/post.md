**Verdict** — the report's three root-cause points all check out against the tree, and the fix is an image/distribution decision (which runtime, which tag, what to document), not something to patch from an issue; what I can add is how magpie's own npx machinery shapes that decision.

## The report's analysis, confirmed at `036b69154`

- The runtime stage is `debian:12-slim` with only `ca-certificates` and `curl` (Dockerfile) — no `node`/`npm`/`npx`, and no `uv`/`uvx` either.
- `stdioProgram` (`internal/library/mcp_check.go:514`) is `exec.LookPath(name)`, with `proc.FindTool` as the Windows fallback only — in the container both miss, and the check reports `failed("notfound", "npx")`, the row the report pasted.
- The MCP router runs command servers on the machine magpie runs on, which in Docker is the container — same miss.
- One thing the report adds that is worth underlining: magpie has its own `npx` machinery (`internal/library/mcp_npx.go`) that rewrites `npx -y pkg` into **node running the package's bin directly** (to drop the ~92 MB npx wrapper per server instance, #3885), installing the package with the npm beside npx into `settings.Dir()/mcp-npm/<hash>`. Every link of that chain — `npm` to install, `node` to run — assumes a Node on PATH. With no Node in the image, the whole story is dark, not just the `npx` lookup.

## How that shapes the options

| Option | What it buys | What it costs / watch out |
| --- | --- | --- |
| Install `nodejs npm` in the image | every `npx -y pkg` server works, and magpie's own rewrite (fewer processes, no npx wrapper) engages for free | Debian 12's `nodejs` is 18.x — fine for most MCP servers today, a ceiling to watch; +~90 MB on a deliberately slim image; same question then repeats for `uv`/`uvx`, which the report rightly names as equally absent |
| A second image tag with Node (report's option 2, à la #1190) | `latest` stays lean | a matrix to build and keep current; users must know to pick it — which lands back on docs anyway |
| Document it (report's option 3) | honest, zero weight | `docs/docker` / `docs/library` / `docs/mcp-router` don't exist as named; the real homes are `docs/subsystems/library.md` and `docs/subsystems/mcp-router.md`, plus a line in the image section of the README where the volume and ports are described |
| A `bunx` fallback when `npx` is missing (report's option 4, via the plugins' Bun) | no image change | Bun is **not** shipped in the image — it is fetched into the volume's cache on demand by the plugin runtime (`XDG_CACHE_HOME`), so a first-run `npx` server would still fail; and `bunx` is a compatible-but-not-identical `npx` (package lifecycle, some Node APIs), so a silent rewrite can fail in ways that look like the server's fault. Not a drop-in; if ever done, it should be explicit per server, not a fallback |

My read: the honest minimal step is the documentation (option 3, at the real doc paths above), and the image decision (Node in `latest` vs a fat tag) is the maintainer's — it trades image weight against a class of servers, and the `uvx` question should be answered in the same decision rather than a second round.

Related issues, for the family picture: #2834 (glibc loader, fixed by the Debian switch), #1190 (a tag with a bundled agent CLI), #2685 (Windows path/fnm — different root), #5841 (the library replacing a hand-written `node script` dsh entry with bare node — different root, same "command server can't spawn" symptom).

## Verification

| Check | Result |
| --- | --- |
| Image has no Node | Dockerfile runtime stage: `ca-certificates curl` only |
| Check path | `mcp_check.go:514` `stdioProgram` — LookPath, Windows-only FindTool fallback |
| npx machinery needs Node | `mcp_npx.go`: install via `npm`, run via `node`; "the library itself, and a server's check, keep npx" |
| Bun is not preinstalled | Dockerfile: cache volume "holding Bun"; fetched on demand by the plugin runtime |
| Doc paths the report names | `docs/docker`, `docs/library`, `docs/mcp-router` do not exist; `docs/subsystems/library.md` and `mcp-router.md` do |
| Container reproduction | NOT-RUN — no Docker build/pull in this lane's sandbox; the report's one-liner (`command -v npx` → NO_NPX) matches the Dockerfile directly |

**Source**: Dockerfile, internal/library/mcp_check.go (`stdioProgram`), internal/library/mcp_npx.go, docs/subsystems/library.md, docs/subsystems/mcp-router.md at upstream/main `036b69154`.
**Not verified**: a live `docker run` of the published image; whether Debian 12's nodejs 18 satisfies the specific MCP servers the report names (`@modelcontextprotocol/server-filesystem` states its Node floor in its own package.json, which I could not check from here).
**Attribution**: AI-written analysis; I can answer questions on it myself.
