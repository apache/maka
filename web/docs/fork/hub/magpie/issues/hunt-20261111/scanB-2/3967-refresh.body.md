Rebased onto current `upstream/main` (`10c331531`): zero conflicts, head `1802ff375`, branch [`fix/3967-billing-200`](https://github.com/ggbdpq/magpie/tree/fix/3967-billing-200). Same change, refreshed — no redesign. All six seams landed where they were: the `usageReported` field and its carry through `Usage.add`/`plus` (ir.go, claude_subscription.go — where `Usage.plus` now lives on this tip), the Chat decoder and the relay sniffer setting it (chat.go, sniff.go), the walk's counted-nothing arm, the `translate` gate, and the `settle` read gated on `saidUsage`.

Drift adjudication on the seams since the last base (`0d99261dc`):

- `0706d7a35` (the ChatGPT card's image row) changed the usage-card reading in `internal/gui` and `internal/provider/quotas.go` — none of the wire-reading this patch keys on; `uncounted`/`usageReported` untouched.
- `6d7862769` (an empty reply on two accounts ends the request) bounds empty replies in the candidate loop, upstream of the walk's accounting arm; the arm's else-if order (the #733 broke-off arm, then this patch's counted-nothing arm, then `servedCandidate`) is unchanged.
- `25c36e862` / `2c05df52b` / `1f99f6f0b` touch failure classification beside the hold, not the usage evidence chain.
- This refresh re-ran the adjudication through `60559ee73` → `10c331531`: the gateway drift in between (the streamed-summary branching `e7980ed95`, the masking pair `319753d89`/`db58a88a8`, the lazy regexps `4847a087f`, the Grok rest test `729664580`) stays off the usage evidence chain — the patch reapplied with zero conflicts and its added/removed lines are identical to the previous rebase's, hunk context functions unchanged.

**One extension, found by the refresh itself.** The full suite on the new base turned `TestRemoteMagpieServesPluginModels` red (new upstream test, `53db4fda6`, three days after the first base): a plugin's models through a Remote magpie failed 502 and the remote was asked 15 times. The chain: magpie asks its Chat upstream streamed with `include_usage`; the plugin's vendor never reports a usage; the remote magpie renders the reply with its own usage member all zero (`Usage.chat()` embeds one whatever the wire said); the outer magpie's sniffer reads that member as the wire's word — reported, and every count zero — and the counted-nothing arm killed a reply that was generated and delivered. Exactly the trap the `settle` gate's comment already names ("what settle's held body carries is no evidence of its own"), one seam over. Fix, in the same evidence terms as the rest of the patch: a remote magpie's reply is such a rendering, not a witness — the three seams keying on the evidence leave it out (`IsRemoteMagpie()`, the provider's own word for it): the `settle` gate's carry, the walk's counted-nothing arm, and the `translate` gate. A reply whose upstream said nothing renders with its usage member all zero as before — untouched, the shape the suite's usage tests pin — but a magpie reading it no longer books the zero as evidence; it classifies the reply as never-reported, the exempt class.

One correction to the message from the earlier rounds: ablation on the settle gate alone turns `TestCountedNothingFailsOver` red (the billing notice delivered as the 200 answer), not the zenfree fakes — they stay green on both trees here; the message now says so.

Verification on the new base (head `1802ff375`):

- The five: TestCountedNothingFailsOver, TestCountedNothingTranslatedFailsOver, TestCountedNothingStreamDropsTheStick, TestCountedNothingTranslatedStreamDropsTheStick, and the exempt class TestUsageNeverReportedStaysAnAnswer — all green; the sniff/deferred-usage families and the zenfree set (TestZenFreeAsOpenCode225 among them) green; the targeted set green under `-race -count=3`; `TestRemoteMagpieServesPluginModels` green `-count=3`.
- Ablation, whole patch: product files reverted on a detached tree at the parent, tests kept (the two test files the patch touches reverted with it — deferred_usage_test.go reads the `usageReported` field) → all four counted-nothing tests red (the billing notice "Your subscription has expired. … 12.5 USDT" delivered as a 200 answer, stream case keeping the stick), the exempt-class test green on both trees (the mutation sits on the divergence lines); restored → green.
- Ablation, the `saidUsage` gate alone: deleting the serve line that carries the sniffer's read to the hold turns TestCountedNothingFailsOver red again (notice as answer); the zenfree fakes stay green.
- Ablation, the remote-magpie exclusion alone: deleting the three `IsRemoteMagpie()` terms turns TestRemoteMagpieServesPluginModels red again (the remote's reply killed as counted-nothing, remote asked 15 times); the counted-nothing five stay green.
- `gofmt -l` clean, `go vet -tags nogui` clean, `GOOS=linux` / `GOOS=windows` builds ok.
- Full gateway suite on this tree: 16028 tests, zero failures (894.7s) — TestRemoteMagpieServesPluginModels among them.
- Fresh patch `git am`s clean onto a tree at `10c331531`; sha256[:16] `52b5efa2987d77a7`.

Credit stands as taken: Gaudi-XIX for the report, aron-intframe for the reproduction and the seams thread above.

NOT-RUNNABLE as before: a real upstream that answers its billing notice with a 200 and zero usage; the fake upstreams pin the shape (relayed, translated, streamed, and the exempt class). Not exercised here: a real Remote-magpie-plus-plugin deployment (the upstream test's fakes pin the chain — streamed `include_usage` ask, no usage chunk back, zero rendered, outer verdict).

Generated-by: GLM-5.3-Flash (ZCode)
