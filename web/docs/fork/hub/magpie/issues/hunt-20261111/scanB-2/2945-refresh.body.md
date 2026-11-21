Rebased onto current `upstream/main` (`60559ee73`), head `eeebcd424`, branch [`fix/2945-upstream-hammer`](https://github.com/ggbdpq/magpie/tree/fix/2945-upstream-hammer). Same change, refreshed — no redesign: the cherry-pick applied with zero conflicts across the 541 commits since `803d7747e`.

Drift check on the touched seams (why the composition still holds on this tip):

- `25c36e862` now reads a relay's pooled 503 refusal by its body words and rests only that model (`Rest.there`, restID): those rests leave the backoff ladder, so `outageRest` sees fewer rests, not a different class. Its remote-model rests only ever carry quota/credit/rate/restricted/verify whys (`remoteModelRest`), never `failOther` — the classes are disjoint, so `outageHeld` correctly takes no `there` exclusion where `quotaHeld`/`vendorTimed` do.
- `6d7862769` (an empty reply on two accounts ends the request) bounds in-loop empty replies upstream of the hold chain; it reads none of the rests `outageHeld` does.
- `rest_probe.go`'s `probeable` still gates on exactly the class this patch reads (now via the shared `outageRest`), so the background list-ask still lifts an outage rest as soon as the vendor answers.

Verification on the new base (head `eeebcd424`):

- `TestAllRestingOutageAnswersFromRest` green; the rest / plain5xx / proxy-down / backoff-ladder / patience / probe / `quotaHeld` / `timedHeld` / fallback family green (`-count=1`), and `-race -count=3` on the same family green.
- Ablation on a detached tree at `60559ee73` carrying only the test file: `--- FAIL: the key resting twice failed was really asked ([eof-b eof-a eof-b eof-a eof-b eof-a eof-b eof-a])` — the hammer, verbatim; restored → green.
- `gofmt -l` clean, `go vet -tags nogui` clean, `GOOS=linux` / `GOOS=windows` builds ok.
- Full `./internal/gateway -tags nogui` suite on this head: one failure, `TestKeyLimitReservationsStayInTheirWindow` — the red that's been failing on this machine since `da169135a` (single-run confirmed there too, not from this patch); everything else green (1448s).
- Fresh patch `git am`s clean onto a tree at `60559ee73`; sha256[:16] `385e6547d8189c23`.

Generated-by: GLM-5.3-Flash (ZCode)
