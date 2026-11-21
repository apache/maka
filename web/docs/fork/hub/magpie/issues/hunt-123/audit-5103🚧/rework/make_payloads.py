import json, re, subprocess, sys, pathlib

OUT = pathlib.Path("/Users/ggbdpq/cc/guahub/fork/docs/hub/magpie/issues/hunt-123/audit-5103/rework")

def get_body(cid):
    raw = subprocess.run(["gh","api",f"repos/yetone/magpie/issues/comments/{cid}"],capture_output=True,text=True,check=True).stdout
    return json.loads(raw)["body"]

OLD_HEAD = "724edc87d"
NEW_HEAD = "ac22f82f3"
OLD_SHA  = "e72581f4aaa2a8e4"
NEW_SHA  = "3c33a12b051a0b3c"

mbox = (OUT/"patch-rework-b.mbox").read_text().rstrip("\n")

# ---------- post 1 ----------
b1 = get_body("6627934214")

old_head_note = f"head {OLD_HEAD} (the commit rebased; `git am -3`-tested against the rebased base)"
new_head_note = f"head {NEW_HEAD} (rebased onto current `upstream/main` with this rework folded in; `git am -3`-tested against that base)"
assert old_head_note in b1, "post1: head note not found"
b1 = b1.replace(old_head_note, new_head_note)

old_row = "| `go test -tags nogui ./internal/provider ./internal/plugin ./internal/agent` | provider and plugin green; the two failures (`TestHostToldTheGatewayAddress`, `TestMothX`) fail the same way on clean `upstream/main` (pre-existing, not touched by this patch). Audit re-run (macOS): with `TestPluginSaidIconName` included the provider package went red 3 of 3 — the test's own assertions pass (0.0s) but its TempDir cleanup races a leaked keep-alive renewal loop that writes into its temp HOME mid-run (green solo, and green with the test skipped, zero renewal attempts then); needs test isolation before landing |"
new_rows = ("| `go test -tags nogui ./internal/provider ./internal/plugin ./internal/agent` | provider and plugin green; the two failures (`TestHostToldTheGatewayAddress`, `TestMothX`) fail the same way on clean `upstream/main` (pre-existing, not touched by this patch) |\n"
"| the new test's isolation (rework after the audit) | the audit's reruns went red 3 of 3 with the test's assertions passing (0.0s) and only its TempDir removal failing (\"directory not empty\"). The rerun log's \"leaked renewal loop\" read was wrong: the writer was the test's own stub, which answered a success, so `pluginOwnIcon`'s background fetch goroutine went on after the test was over and kept the (empty) picture into the temp HOME — proved with a probe that watches `plugin-icons.json` land after the body has ended. The stub now refuses the fetch: nothing is written after the body ends, the test is green solo five times and under `-race`, and the TempDir failure has not come back in any run since |\n"
"| `go test -tags nogui -count=3 ./internal/provider` (rework) | the one failure left is `TestCodexSubagentModelsKept`, a pre-existing allocation-budget flake of the suite on this machine: it fails byte for byte the same (516096/1756568) on clean `upstream/main` under the same `-count=3`, and passes with this patch in a fully green full-suite run and in `-count=1` runs; not touched by this patch |")
assert old_row in b1, "post1: audit row not found"
b1 = b1.replace(old_row, new_rows)

(OUT/"payload-1.json").write_text(json.dumps({"body": b1}, ensure_ascii=False))

# ---------- post 2 ----------
b2 = get_body("6627961774")
assert OLD_SHA in b2, "post2: old sha not found"
b2 = b2.replace(OLD_SHA, NEW_SHA)

# replace the patch block: from "From <old-head> Mon Sep..." up to the signature line
pat = re.compile(r"From 724edc87d779c470b8067bd5e45a50c4b72f1c05 Mon Sep 17 00:00:00 2001\n.*?2\.50\.1 \(Apple Git-155\)", re.S)
assert pat.search(b2), "post2: patch block not found"
b2 = pat.sub(lambda m: mbox, b2, count=1)
assert OLD_HEAD not in b2, "post2: old head still present"
(OUT/"payload-2.json").write_text(json.dumps({"body": b2}, ensure_ascii=False))

print("payload-1.json bytes:", (OUT/"payload-1.json").stat().st_size)
print("payload-2.json bytes:", (OUT/"payload-2.json").stat().st_size)
print("post1 new head present:", NEW_HEAD in b1, "| audit note gone:", "needs test isolation before landing" not in b1)
print("post2 new sha present:", NEW_SHA in b2, "| new head patch present:", f"From {NEW_HEAD}" in b2)
