Could not reproduce this one: the `[1m]` mark never reaches an upstream — the relay is asked for the bare id. Two layers take it off:

1. **Claude Code drops it before asking.** `[1m]` is Claude Code's own convention for a 1M window; a build that knows the mark sends the plain id in the request body.
2. **magpie's gateway drops it regardless.** Everything Claude Code sends while it runs on magpie goes through the gateway, and the one place a model is resolved there — `provider.Resolve` — takes the mark off whatever id comes in, before anything is asked. That holds on every route: a relay speaking Anthropic's API itself, an OpenAI-compatible one (New API, litellm) the request is translated for, `count_tokens` too. So the body that leaves magpie carries `claude-opus-4.6-us`, never `claude-opus-4.6-us[1m]`.

The mark lives only in what magpie writes on this machine: `settings.json`, the `/model` picker, the `/v1/models` listing Claude Desktop reads. Taking it off there would hand the 200K thrash back to older Claude Code builds — the reason you noted yourself — so I would keep it.

Tests: `internal/gateway/claude_dashed_test.go` already holds a native relay to the dotted id when asked `relay/claude-opus-4-6-us[1m]`. I have added one for the shape you named (New API / litellm, OpenAI-compatible): a relay and a native Anthropic relay, both models of a 1M window, asked by the marked ids magpie writes — both upstreams are held to the bare id. With the strip lifted from `provider.Resolve` the new test fails with your exact symptom (`the relay asked for "claude-opus-4.6-us[1m]"`). Patch below.

If a `[1m]` really did reach your relay, I would like to pin down where it came from:

- which magpie version, and was Claude Code routed through magpie (`ANTHROPIC_BASE_URL` = magpie's gateway) or pointed at the relay directly? Pointed directly, magpie writes nothing into that `settings.json` — every write is gated on the routing — so the marked id would have been set by hand.
- the request magpie's Routing / usage log archived for a failing call: its `model` field is what actually went out.

A client that is not Claude Code, pointed straight at the relay with an id copied from magpie's UI, would send the label as it is — that request never goes through magpie, so there is nothing on magpie's way to strip.

---

Attribution: AI-written; I've read the whole diff and the tests pass. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>.`

Patch: gateway tests: the [1m] id an agent asks a relay by reaches it bare (#5058) — git am applies it as is; SHA-256 first 16: 32e0ceb57cb5fcc4

Branch with the commit: [fix/5058-claude-1m-suffix](https://github.com/ggbdpq/magpie/tree/fix/5058-claude-1m-suffix) (head `ec654d6910a47b005d627f7585db7fc192452d1a`).
