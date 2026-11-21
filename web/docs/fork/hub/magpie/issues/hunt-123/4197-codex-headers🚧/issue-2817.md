## Summary

A plugin provider never gets Claude Code's own request headers, so an upstream that only admits the official Claude Code client rejects every request through it. The same key works through a custom provider.

## Context

sub2api, which the [magpie-sub2api](https://github.com/broven/magpie-sub2api) plugin connects to, can restrict a group to the official Claude Code client. With one key from such a group, configured two ways:

| How the key is configured | Result for Claude Code → `group/…` → `claude-opus-5-5` |
|---|---|
| custom provider (`{"id":"private-claude","anthropic":"https://api.jmds.dev","key":"sk-…"}`) | 200, every time (thousands of requests) |
| plugin provider (`api.npm: "@ai-sdk/anthropic"`, loader returns `{baseURL, apiKey}`) | **403** `This group is restricted to the official Claude Code client.` |

The routing log then backs off the subscription account and falls through to the next account, here a pay-as-you-go wallet. Session affinity keeps the session there, so a subscription the user pays for is silently skipped.

## Why (d783df46)

- Both cases take the same relay path. `passthrough` (`internal/gateway/gateway.go:4006`) keeps the body, including `metadata.user_id` and the system prompt.
- But `forwardOnce` copies Claude Code's headers (`user-agent`, `x-app`, `anthropic-*`, `x-stainless-*`, `x-claude-code-*`) only `if p.Account == nil && fromClaudeCode(in)` (`gateway.go:3827`, from #179). `?beta=true` is added only when `p.Account == nil` (`gateway.go:4172`). The User-Agent passes through only when `p.Account == nil` (`internal/provider/user_agent.go:10`).
- A plugin provider always has an account (`&Account{Agent: "plugin", …}`, `internal/provider/plugins.go:339`), so it gets none of them. The plugin can't add them itself either: its loader and `chat.headers` hooks never see the agent's original headers.

## Possible directions

1. Treat a plugin account whose model speaks Anthropic (`@ai-sdk/anthropic`) and that authenticates with an API key like a custom provider here: forward Claude Code's headers and `?beta=true`.
2. Or let a plugin opt in, e.g. a provider or model flag meaning "pass the agent's headers through as for a custom provider".
3. Or hand the agent's original headers to the plugin's `chat.headers` hook, so the plugin can decide.

Related: #179 (the custom-provider fix), #1851 (pass the caller's User-Agent through).

