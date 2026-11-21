import pathlib

art = pathlib.Path(__file__).resolve().parent
patch = (art / "patch-5085-capcareful-stale.patch").read_text()

post = """Fixed on `87407ed09` (rebased onto tip `248853225`, the single original commit `be674dccf` unchanged apart from one doc conflict resolved by keeping both sides; patch below). A usage reading that was kept from before because nobody asked a saved account again is no longer counted as a failed read, so capCareful stops holding such an account while it is under its cap, and the Routing page says the usage can't be told instead of "past the cap" when a hold is an unread one.

**What changed**

- `internal/provider/login_usage.go`: `state()` counted every reading with `AsOf` set as a failed one. That is right for a reading shown in place of one that failed (`keepLast`'s fallback after a real failure, `ReadDeferred` unset), but a saved Claude account's standing reading — what `keepLast` hands over when `claudeWindows` declines to read (#1630: a saved account is read only when its card is refreshed, when the switch off a spent one needs it, or when the keep-alive runs) — carries `AsOf` with `ReadDeferred` set, and nothing failed. It now stands as the account's reading, dated as the rounds see it, the way a kept reading in memory already behaves, so a careful provider passes it while it is under its cap and holds it by its age near one. What can't be told is still not spent, as before.
- `internal/gui/assets/plugins/routing/client.js`: `leftWhy` and `unlistedWord` said "past the cap" of a held account whenever `capped` was set, even when the trace's `unread` said the usage couldn't be told — #5085's 「已用 30%，超过 90% 上限」. Both take the `unread` branch first now, with the four translations added to `i18n.js`.
- `docs/subsystems/gateway-routing.md`: the caps row names the distinction.

**Red without the fix** (product file `internal/provider/login_usage.go` reverted to tip `248853225`, new test in `internal/provider/pool_read_test.go` kept; a reading shaped the way `keepLast` hands a saved Claude account's over — windows kept, `AsOf` set, `ReadDeferred` set — through the same seam careful reads (`LoginUsageVia` -> `Allowances` -> `UsageRead`)):
| Test | Without the fix | With the fix |
| --- | --- | --- |
| `TestUsageReadDeferredIsNotAFailedRead` (kept reading) | FAIL: `a kept reading no one asked for again: failed true ok true` | PASS |
| same test, a failed read answered from what was kept (`ReadDeferred` unset) | PASS (still failed, fail-closed unchanged) | PASS |

**Verified** (rebased run, head `87407ed09` on tip `248853225`): `go test -tags nogui -count=1 ./internal/provider/` and `./internal/gateway/` pass apart from tests already failing on this Windows machine at the clean tip — macOS-keychain, git-on-disk, daemon-env, Codex-app-switch and hand-off environment reds, each reproduced one-for-one at `248853225` (and `TestRestartSwitchedCodexAppReal` panics there too, a Windows `ps` issue), so no new red; `TestCareful*`, `TestCapStop*`, `TestUsageRead*` ok, `TestPageFilesRevalidate` ok; `gofmt -l` clean on the Go files; `node --check` clean on the two edited plugin files; `go vet -tags nogui` of provider, gateway and cli clean; `go build -tags nogui` ok on linux/amd64, windows/amd64 and darwin/arm64; `git am -3` of the mbox onto `248853225` applies clean and its tree matches the branch head's. The whole `internal/gui` package was not run on this machine, as before, only its assets-revalidate test; no `-race` run — this Windows lane has no C compiler for cgo (the original run's note stands: the change is a boolean branch in a pure function, nothing concurrent).

**Not verified**: no real two-account Claude subscription was available, so #5085's routing-log line was not reproduced live; the deferred reading's shape (windows kept, `AsOf` with `ReadDeferred`) stands in for it, the way `keepLast` hands it over. The near-cap end of a saved account under capCareful — its reading can only age until one of the three reads runs — is left as it is, the gap #5079 already names; this composes with that one, touching neither `ReadUsageNow` nor `claudeWindows`.

**Attribution**: AI-written; I've read the whole diff and the tests pass. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`.

<details><summary>patch: provider: a usage reading kept from before no one asked for again is not a failed one (#5085) — git am applies it as is; SHA-256 first 16: b10acc893f612a97</summary>

```patch
""" + patch + """```

</details>

Branch with the commit: [fix/5085-capcareful-stale](https://github.com/ggbdpq/magpie/tree/fix/5085-capcareful-stale) (head `87407ed09`, rebased onto tip `248853225`).
"""

(art / "comment-draft.md").write_text(post, encoding="utf-8", newline="\n")
print("written", len(post))
