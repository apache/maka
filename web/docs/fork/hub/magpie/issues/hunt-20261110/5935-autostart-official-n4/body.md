This post and its patch are written by an AI (GLM-5.3-Flash via ZCode) and authored by ggbdpq. The report and its live Windows reproduction are Leelili-BY's; this is a diagnosis and a fix built here from the report, with the race reproduced by fixture rather than by rebooting.

**What's wrong**

With magpie set to start at boot on Windows, requests now and then go to the signed-in account's quota instead of the configured API provider's (#5935). "Now and then" is the shape of a start-up race, not of a wrong setting: the same request routed to the provider on most boots lands on the official account on others.

**Root cause: a providers.json read that fails is routed as an empty catalog**

Every read of providers.json that goes on without its error (`provider.load`) takes an unreadable file as an empty catalog — the code says so itself: "One that can't be read is taken as empty there: start-up, the gateway, the catalog". At a boot, another program (an antivirus, a sync client, an indexer) holds the file for a moment, and on Windows that makes the read fail while the file is fine. In that state the user's providers drop out of every routing read, while the built-in subscriptions do not — their sign-ins are read from files beside providers.json and answer whether the file does or not. `allProviders` is `load()` (the file) plus `Accounts()` (the sign-ins), so the catalog in the window is the built-in subscriptions alone, and three guesses then route a model the user's provider serves to the official account:

1. a bare model's name goes to the agent's own subscription (`ownFirst` → `provider.OwnRoute`) — the groups, picks and applied records that would have redirected it are unreadable with the file;
2. a bare name resolves to the first provider exposing it, or to the one provider that lists it (`resolveIn`'s fall-through branches) — the built-in subscription;
3. a bare name names a routing group (`GroupFor`), and the groups in view are found among the entries left — built-ins alone (two of them serving one model: codex and copilot, gemini and antigravity); a found group's own id resolves through the same built-in-only view.

The subscription's quota is then spent in the provider's place, without a word. And the state outlives the lock itself: the catalog built while the file failed is kept across requests for up to a minute (`keptOf`, whose stamp — the file's time and size — is unchanged by the lock), so the minutes after a boot can all go there.

**The fix: routing stops guessing from what an unreadable file leaves**

Where `provider.FileError()` says the file is there and can't be read, routing refuses to answer from the built-ins alone — the requests come back as 503 with the file's own error ("…can't be read… fix it or move it aside"), so the agent asks again and is served once the file reads again, which is the waiting the issue asked for, with the reason said:

- `OwnRoute` picks no subscription for a bare name;
- `resolveIn` answers only ids that name a provider it can see ("claude/…" still goes), and neither its fall-through branches nor a found group's id nor `GroupFor` guesses;
- a file that isn't there reads as before (first use, FileError nil); one that parses answers as before; nothing else about routing changes.

**Reproduction and verification** (this machine, darwin, `-tags nogui`; the fixture puts a folder where providers.json is, so every read of it fails — the locked-file state, deterministic, no reboot lottery)

| Check | Result |
| --- | --- |
| `TestUnreadableProvidersFileRefusesRatherThanTheOwnSubscription` (new) | red before the change: readable, `relay/gpt-6-luna` answered by the relay; file unreadable, the bare `gpt-6-luna` came back **200 from the subscription** (the issue's shape) while `relay/gpt-6-luna` was a plain 404; after the change, both are 503 naming providers.json, the subscription and the relay are asked **zero** times, and once the file reads again the relay answers as before |
| `TestUnreadableProvidersFileTakesTheBareNamePickAway` (new) | red before (ownFirst still picked `codex/gpt-6-luna`), green after: `OwnRoute`, `Resolve`, `GroupFor` all refuse while `FileError` reads one |
| `OwnFirst*`, `OwnRoute*`, `BareName*`, `GroupFor*`, `AutoStandIn*`, `UnknownModel*` (the routing family around the change) | all green, then green again with `-race` |
| whole `internal/gateway` and `internal/provider` packages, `-tags nogui` | provider: ok. gateway: the same two failures on the patched tree and on the clean parent `db0f2f20d` alike — `TestClientPathCoversHandler` and `TestReadOnlyKeyEveryRoute`, the `/magpie-ca.crt` route-table gap upstream's own `4623f5419` left (verified red on the clean parent, full suite both times); everything else green |
| rebased base check | two unrelated commits (`5b28e8599`, `025123431`) landed upstream while this was in progress; the commit is rebased onto `025123431` and the named list re-ran green there |
| real Windows boot with a file-holding process | NOT-RUNNABLE here — the fixture is the same failure the lock produces (any non-missing read error takes the same path), and the fix's condition is that error, not the lock |

**Ablation** (each gate taken out alone, the build staying green, so the reds are semantic)

- without `resolveIn`'s gate: the bare name was answered **200 by the subscription** — the issue's shape, in isolation; restored → green.
- without `OwnRoute`'s gate: `ownFirst` picked the subscription again; both tests red; restored → green.
- without the gateway's 503 refusal: the same requests were refused, but as a 404 "magpie knows no model … add a provider in magpie first" — the misleading answer; restored → green.
- `GroupFor`'s gate alone stays green in this fixture (one built-in serves the model, so no group forms among the built-ins): it closes the same guess where two built-ins serve one model, and its necessity is the code path above, not this fixture.

**Sibling scan** (`rg` over every reader that could pick an account in the window)

- all 48 `provider.Resolve` callers in the gateway resolve through the gated `resolveIn`; the ones that only ask whether an id resolves (vision, codex memory, desktop subagent picks) now get "no" in the window and stand down — fail-closed the same way;
- `ownFirst`'s two callers (`grouped`, `countTokens`) share the gated `OwnRoute`; `keyGroupFor` shares the gated `GroupFor`;
- `AutoStandInFor` never sees a bare name (`GroupIDOf` refuses non-refs; `CanonicalRef` passes a bare id through unchanged), and an agent-configured found-group ref it does see returns ids that resolve through the same gates;
- the Groups-adjacent refusal shapers (`idOff`, `DisabledGroup`, `unserved`, the stand-in guard) answering "no group" in the window only move the request onto the same 503;
- `groupsAfter` adds user-built groups — none exist in the window, nothing to add;
- a missing file (first use) and a file that parses (including its `.bak` generation) take the old paths — unchanged;
- `git log --since=2026-11-01` over `gateway.go`, `ownroute.go`, `routing.go`, `models.go`, `group.go`: no upstream commit touches these hunks' lines (the nearest, an agent's own provider in model names and a cap keeping a provider out of a group, are different lines), so the gap is current main's, not a rebase artifact.

`gateway: an unreadable providers.json is not answered from the built-in subscriptions (Leelili-BY on GitHub, #5935)`, branch [`fix/5935-unreadable-providers-file`](https://github.com/ggbdpq/magpie/commit/99c5704db8787f05ce8a815f57430f4116332fb1) on current main `025123431`:

```sh
git am https://github.com/ggbdpq/magpie/commit/99c5704db8787f05ce8a815f57430f4116332fb1.patch
```

sha256[:16] = `1a0c517572e8adf7` (the `git am` file above, `--zero-commit`) · applied into a clean tree at `025123431` from that URL: zero conflict, and the new test passes there.

Generated-by: GLM-5.3-Flash (ZCode)
