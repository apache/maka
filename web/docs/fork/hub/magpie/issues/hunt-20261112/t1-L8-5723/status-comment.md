This is fixed on main — and your own diagnosis is the fix that landed, point for point.

`4b1f3eca4` (first in **v0.1.3787**, "a ZCode call magpie routed is not counted again as a local session's") carries exactly your 建议修法 1, at the read layer: `readZCodeCalls` now gives each call the **bare** session id, so a gateway record (`<uuid>`) and its local copy (`sess_<uuid>`) share a session and `matchedBlocks` pairs them — your face 2 and face 3 together, and face 1 too: the commit's own words on your UUID-provider case are "Leaving out calls whose providerID is `magpie` (ocGatewayProvider) only helps when ZCode writes that id beside a reply; **with any other id the call was listed twice**". Subagent copies (`sess_subagent_agent_<id>`) are normalized the same way, and a new test pairs a gateway record against a ZCode-own provider id and a subagent (`TestZCodeCallsPairWithTheGatewaysRecords` — red on the old code: 4 rows for 2 routed calls).

Two details worth knowing for your retest:

- **Your doubled history corrects itself on upgrade**: the read is versioned, and ZCode's call-parse version went to 3 with this, so already-read shards are read again under the bare ids — you don't need the sessions to have been live on the new build for the pairing to work. On ≥ v0.1.3787 the 请求 page should show the gateway row with 来源 kept, and 「不经过 magpie」 should stop carrying the mirror.
- Your 建议修法 2 (drop local copies whose provider's baseUrl points at magpie, the #4800 way) was **not** taken — the landed fix is the pairing route, which keeps any gateway row's source as you asked ("保留网关行的来源") without magpie having to judge a provider by its URL.

Also, credit where due: @Gaoshou101's patch here (11-09, same root cause, rebased 11-11) reads as superseded by this — same diagnosis, landed independently from another report. And your #3246 cross-reference stands on its own: the wired-state rewrite by ZCode is a separate open face this fix does not touch.

Not verified: a real ZCode database against the new read (the fix's own note says its machine had none, tests ran on synthesized calls); your retest on ≥ v0.1.3787.

Attribution: written with GLM-5.3-Flash (ZCode); code read at `9c33839de`. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`.
