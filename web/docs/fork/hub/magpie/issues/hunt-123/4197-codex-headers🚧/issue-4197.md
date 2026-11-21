## Summary

A plugin provider never gets Codex's own request headers, so a Responses relay that only admits the official Codex client rejects Codex's requests through it. The same key works through a custom provider. This is the Codex side of #2817.

## Context

A Responses relay serves both GPT and non-GPT models, and for GPT models it only admits the official Codex client. One key from it, configured two ways, with Codex → `gpt-*` on `/v1/responses`:

| How the key is configured | Result |
|---|---|
| custom provider (`responses: https://<relay>/v1`, `baseAPI: responses`, `key`) | 200, every time |
| plugin provider (`npm: "@ai-sdk/openai"`, loader returns `{baseURL, fetch}` and the fetch only sets `Authorization`) | **403** `{"error":{"message":"native codex clients only","type":"codex_harness_needed"}}` |

Non-GPT models on the same plugin account answer 200. In the routing log the 403s begin at exactly the moment the route moved from the custom provider to the plugin account.

## What the relay checks

Replaying a recorded `codex exec` request (Codex CLI 0.164.0) to the relay shows it requires Codex's identity headers (`user-agent`, `originator`, `session-id`, `thread-id`, `x-codex-window-id`) along with the body Codex sends. The body already reaches the plugin unchanged; only the headers are missing.

## Why (be8b0f38)

- `forwardOnce` copies Codex's client headers (`codexClientHeader`: `user-agent`, `originator`, `session-id`, `thread-id` and the `x-codex-*`/`x-openai-*` ones `codexHeader` lets through) only `if p.Account == nil && (to == provider.Responses || to == provider.Chat) && fromCodex(in)` (`internal/gateway/gateway.go:4377`).
- Without that, the User-Agent is magpie's own (`userAgentFor`, `internal/gateway/user_agent.go:22`).
- A plugin provider always has an account (`&Account{Agent: "plugin", …}`, `internal/provider/plugins.go:426`), so it gets none of them.
- The plugin can't add them itself. `pluginFetch` passes on the headers the gateway set, but by then Codex's original `session-id`, `thread-id`, `originator` and User-Agent are gone. Making them up in the plugin would not match the body's `prompt_cache_key` and `client_metadata`, and would be impersonating the client rather than relaying it.

## Possible direction

Let a plugin opt in, as `searches: true` does (#2027). Its `config` hook would set a provider flag (name to be decided, e.g. `codexClient: true`). The host passes it through on `plugin.Provider`, and `pluginProvider` sets it on the provider. The condition at `gateway.go:4377` becomes "custom provider, or a plugin provider with the flag". The forwarded headers stay `codexClientHeader`'s allowlist; the plugin's own key still signs the request, and the caller's ChatGPT sign-in and attestation never go on.

An opt-in rather than every plugin, because turning it on for all of them would start sending Codex's identity headers to vendors behind other plugins (Cursor, Grok, …) whose requests `internal/gateway/plugin_*_test.go` pin today.

Tests I'd expect: a Codex request to a plugin with the flag reaches the plugin's `fetch` with those headers; one without the flag, and a non-Codex caller, are unchanged. Plus a note in `docs/subsystems/provider-plugins.md`.

If a shared mechanism fits #2817 better (forwarding Claude Code's headers to a plugin), this could use the same flag or hook for both clients.

Related: #2817 (same problem for Claude Code), #1758 (`codexAsSent`, a relay checking the body's shape), #2027 (plugin opt-in via `config`).

