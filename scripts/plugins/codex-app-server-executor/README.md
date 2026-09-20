# Maka Executor for Codex (experimental)

This Maka Host plugin registers `codex.app-server` against the `ctx.executors` API introduced on
Maka `main` by PR #5283. It forwards root Sessions, WorkHub targets, ordinary child Agents, and
Graph operators to a user-installed, locally authenticated `codex app-server` process.

The bridge is an independent community integration. It is not an OpenAI product, is not endorsed by
OpenAI, and does not bundle the Codex binary, OpenAI marks, credentials, or protocol schemas. See the
[official App Server documentation](https://developers.openai.com/codex/app-server/) for the current
protocol and stability status.

## Requirements

- Maka with the `ctx.executors` API introduced by PR #5283.
- Codex for macOS or the official `codex` CLI, installed and authenticated by the local user.
- Node.js 22.19 or newer in the Maka Runtime Host.

Install this directory through Maka's Plugin Platform. Its profile entry registers `Codex App
Server` with id `codex.app-server`, and its desktop entry adds model and reasoning controls to the
Session and WorkHub composers. Selecting a Codex model switches that Session or the next new Session
to the plugin executor; selecting a native Maka model switches it back.

This is a repository-only example. Maka release packaging intentionally excludes `scripts/plugins`;
install it from a complete Git checkout instead of expecting it in an ASF source or desktop release.

## Configuration

- `codexPath`: executable name or absolute path; defaults to `codex`. On macOS, that default also
  auto-detects the system/user Codex app bundle and common Homebrew locations before falling back to
  PATH, so a Finder-launched Maka app does not depend on an interactive shell PATH.
- `model`: optional global Codex model fallback; a model selected on the Maka Session takes
  precedence, while an empty value preserves the user's native Codex configuration.
- `sandbox`: `read-only` (default), `workspace-write`, or `danger-full-access`.
- `ephemeralThreads`: keeps Codex threads in the shared app-server process only; defaults to `true`.
- `disposeGraceMs`: graceful process-tree shutdown window; defaults to 3000 ms.
- `rpcTimeoutMs`: handshake and control-request timeout; defaults to 30000 ms.
- `inheritEnvironmentCredentials`: forwards credential-shaped Host environment variables when true;
  defaults to false. Native Codex login files remain available.

The adapter uses `approvalPolicy: never` because the current minimal Maka executor contract has no
approval round-trip. Unexpected App Server approval, permission, user-input, and MCP elicitation
requests are declined instead of hanging. Choose a writable sandbox only when unattended file writes
are intended.

## Behavior and current limits

- One App Server process is shared by the plugin instance, with one Codex thread per Maka Session.
- The Composer reads the authenticated local Codex model catalog through `model/list`; no static
  model list or OpenAI credential is stored by Maka.
- The Session model and reasoning effort are sent on every turn, so changes take effect immediately
  even when the Codex thread is reused. An explicit null reasoning effort restores that model's
  default instead of retaining the previous turn's setting.
- Text, readable reasoning summaries, command/file/tool activity, cancellation, and terminal status
  are projected into Maka's canonical Session event stream.
- Attachments are rejected explicitly; they are never silently dropped.
- Ephemeral thread ids are not persisted across plugin or App Server restarts.
- Stderr content is consumed but never copied into Maka logs because it may contain sensitive data.

From this directory, run `npm run check && npm test` for the fake App Server protocol suite. A real
end-to-end probe should run in an isolated Maka storage root and use the local user's existing Codex
authentication.
