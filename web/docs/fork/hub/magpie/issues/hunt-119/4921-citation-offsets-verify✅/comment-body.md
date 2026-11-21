Verified skygunner's branch: cherry-picked `fcea11649` onto today's `main` (`cb7d7f9aa`) and ran it — **PASS**. The pick auto-merges clean (no conflicts; the drift since their base `8abdf53a8` is one usage-ledger commit, none of it touching these hunks), the build is ok, `gofmt` and `go vet -tags nogui` are clean, and every test is green at the tip:

| What (on `cb7d7f9aa` + their commit) | Result |
|---|---|
| Their three new tests — `TestCitationsWithoutOffsetsAskedAgainWithout`, `TestCitationsWithoutOffsetsNotSentToCodexBackend`, `TestWholeAsStreamDropsCitationsWithoutOffsets` | ok |
| The rewrite/scan harness with their new entry — `TestCodexRewritesAsBefore`, `TestCodexRewritesLeaveTurnUndecoded`, `FuzzCodexRewritesAsBefore` (seed corpus) | ok |

My patch (`57dc7b420`, posted above) also cherry-picks clean onto the same tip and its three tests pass there, so **both versions are current as of today's main**. Not re-run by me: their red-on-base ablation (their table records it on `8abdf53a8`); the full gateway suite on either tree (it carries the known host-dependent `TestCodexPoolSaysTheClientsVersion` on this machine, unrelated to both diffs).

The two patches agree on everything that matters and differ in one place — coverage breadth on the request side:

| | mine `57dc7b420` | theirs `fcea11649` |
|---|---|---|
| Reply side | `tidyCitations` inside the per-item loop of `responsesWholeEvents` — covers all four places a client reads (annotation.added, content_part.done, output_item.done, response.completed) | `dropOffsetlessCitations` pre-cleans the whole output before the same loop — the same four outlets, same rule |
| ChatGPT-backend path (codex member, own sign-in, compaction) | strip in `codexInputAs` | strip in `codexUpstreamOn` — same requests, one funnel later |
| Codex API-key base (api.openai.com/v1) | stripped (`codexInput` runs before base selection) | not stripped (theirs is gated on the ChatGPT base) |
| Passthrough to api.openai.com / Azure / a codex account | not covered | pre-stripped |
| Passthrough to any other relay upstream | not covered | asked once more without the citation on the exact 400, and the provider remembered — the same refuse-and-remember as #1411, in-process only, one extra ask per provider+model per process, bounded (their test asserts 2 asks, then 1) |
| Magpie models through codex accounts | left as they came (`!magpieModel` guard) | stripped too — harmless but lossy, those models accept offsetless citations |
| Drop, not fill 0/len | fail-closed, same reason | fail-closed, same reason |
| Tests | 3 (incl. a scan-predicate unit test) + fuzz marks | 3 end-to-end (relay retry with ask counts, backend pre-strip, whole-stream) + a rewrite-parity entry of their own + fuzz marks |

Both versions are here for the maintainer to pick from. They would coexist — disjoint helper names, different anchor hunks, each applies clean at the tip — but they double-strip at both seams, so one is enough. If theirs lands, mine is superseded on behavior except two narrow faces (the API-key base above, and the magpie-model guard), and my tests keep passing against their tree. If mine lands, their passthrough pre-strip + retry-without is a self-contained increment (the `gateway.go` hunks plus the `codexUpstreamOn` hunk) worth taking as a follow-up — relay coverage is the one face of the reporter's group shape mine doesn't reach.

**Not verified** (either side): a real Volcengine Ark account — both fixes are tested against the captured annotation shape through a strict fake upstream, and no real poisoned Codex-desktop thread replayed end to end.

This is a verification post, not a new delivery — the `take` stands from my earlier comment.
