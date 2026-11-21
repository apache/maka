Thanks for the corrections and the archive — that repro settles the original report.

**The propagation face is closed.** With the version note corrected (the builds you filed against were 0.1.3444/0.1.3629, and 0.1.3941 for the fresh case), the build-version premise I reasoned from is moot. Your archived downstream stream settles it directly: magpie relayed `finish_reason: "length"` byte-for-byte and the silent stop lives in pi, downstream. Nothing left to fix on this face — thanks for nailing it.

**On the undeclared-cap ask, against current main (`1730c75b9`)** — what exists and what doesn't:

*Exists* — the declared-cap chain, and the knob for your local mitigation:

- A model's reply limit resolves: the vendor's list → models.dev (`catalog.OutputOf`, `internal/catalog/catalog.go:1560`; a vendor entry that says no output falls back to it, `internal/provider/models.go:1313`) → the user's setting (`SetModelOutput`, id `provider/model` or `provider/*`, `internal/provider/models.go:4007`), which wins over both.
- `/v1/models` rows carry `max_output_tokens` from `Entry.PublishedOutput()` when it is > 0, and omit the field when nothing declares it (`internal/gateway/gateway.go:1446`, `modelObject`) — no guessed number goes out.
- The user knob also reaches the agents, not just the list: setting it fires `catalog.Touched`, and agents keep reply limits in files of their own (Pi's maxTokens, OpenCode's limit) and reread them at start-up. So pinning 3200 (e.g. `vkteleapi/*`, since every member on that route cuts identically) is the designed path, and it lands everywhere a cap is read, `/v1/models` included.

*Doesn't exist* — learning a cap from observed length cuts. Nothing in the gateway or the catalog reacts to a `stop=length` row by remembering a number (`git grep` for any learned/observed-cap mechanism on current main comes up empty). A cut at exactly 3200 with `out == 3200` repeatedly is decent evidence of `cap == 3200`, and a learned cap could clamp `max_tokens` so the cut never happens. If that's wanted, the design calls I'd leave to @yetone: where learned caps live (settings vs runtime state), invalidation (vendors change caps, so a learned number goes stale in both directions), and how it squares with the #2972 review's stance ("the real cap belongs in the plugin's model limits", v0.1.3052) — learning would move part of that boundary into the gateway.

**On the out-of-band signal** — one physical limit worth noting: your fresh case was a streamed reply, and HTTP headers precede the body, so no header can carry a truncation signal on a stream; in-band `finish_reason` is the only channel a stream has. A header would cover non-streamed replies only (there is `X-Magpie-*` header precedent on other faces). Making streams carry a second, harder-to-miss signal would be a protocol change of its own — also @yetone's call.

With the propagation face confirmed closed by your archive, I'll leave the undeclared-cap question here rather than patch a policy.

*(All `file:line` refs are read-only reads of `upstream/main` at `1730c75b9`; nothing was run against a live gateway.)*

Attribution: written with GLM-5.3-Flash (ZCode).
