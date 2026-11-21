Rebased onto current `upstream/main` (`10c331531`): three conflicts, all one shape — the tip's regexps moved to lazy compile (`lazyre.New`, `4847a087f`) and the SECRET rules gained `ok: secretValue`, while this patch adds `fix: queryValueAt` to the same three rules. Each merged as the union: `lazyre.New`, `ok` and `fix` together. Head `b5e33d814`, branch [`fix/5074-secret-url-scope`](https://github.com/ggbdpq/magpie/tree/fix/5074-secret-url-scope). Same change, refreshed — no redesign; `queryValueEnd`/`queryValueAt`/`inURLQuery` land where they were (fieldvalue.go), the model's span cut likewise (model.go).

Status note: this patch went out with Discord batch C (2026-11-07, the user's own post) and was rebased here again (the issue's earlier comment), but it is not in yet — upstream's `internal/redact/redact.go` at today's tip carries no `queryValueEnd`/`queryValueAt`. Refreshed to the current tip so the branch is reviewable as it stands.

Verification on the new base (head `b5e33d814`):

- The whole `internal/redact` package green (`-count=1`, and again under `-race -count=2`, 64s); the gateway's Redacted/PlaceholderNote/MaskedRequest family green.
- Ablation, the rules' wiring: the three `fix: queryValueAt` terms deleted → TestMask red on the four query cases (`&page=2`, `&page_size=20&sort=desc` sent inside the placeholder); restored → green.
- Ablation, the model's cut: the `queryValueEnd` gate in model.go deleted → TestModelQueryValueEndsAtAmpersand red (`sess=AbCdEf123456&page=2` taken as one value); restored → green.
- `gofmt -l` clean, `go vet -tags nogui` clean, `GOOS=linux` / `GOOS=windows` builds ok.
- Fresh patch `git am`s clean onto a tree at `10c331531`; sha256[:16] `3ad0e5d1d96810c0`.

NOT-RUNNABLE as before: a real vendor logging the request with the next parameters inside the placeholder; the test cases pin the shape (the query value cut at its `&`, a prose value keeping its own `&`, `%26` url-encoded).

Generated-by: GLM-5.3-Flash (ZCode)
