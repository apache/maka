import json, subprocess, sys, pathlib

OUT = pathlib.Path("/Users/ggbdpq/cc/guahub/fork/docs/hub/magpie/issues/hunt-123/audit-5103/rework")
OLD_HEAD, NEW_HEAD = "724edc87d", "ac22f82f3"
OLD_SHA, NEW_SHA = "e72581f4aaa2a8e4", "3c33a12b051a0b3c"
OLD_NOTE = "needs test isolation before landing"
OLD_LOOP = "leaked keep-alive renewal loop"

ok = True
for cid, name in (("6627934214","rb1"), ("6627961774","rb2")):
    raw = subprocess.run(["gh","api",f"repos/yetone/magpie/issues/comments/{cid}"],capture_output=True,text=True,check=True).stdout
    (OUT/f"{name}-after.json").write_text(raw)
    b = json.loads(raw)["body"]
    checks = {
        "old head gone": OLD_HEAD not in b,
        "new head present": NEW_HEAD in b,
    }
    if name == "rb1":
        checks["old audit note gone"] = OLD_NOTE not in b
        checks["wrong keeper attribution gone"] = OLD_LOOP not in b
        checks["x3 green row present"] = "three consecutive full runs" in b
        checks["credit kept"] = "Credit to @Jirentian" in b
        checks["attribution kept"] = "**Attribution**" in b
    else:
        checks["old sha gone"] = OLD_SHA not in b
        checks["new sha present"] = NEW_SHA in b
        checks["patch block new head"] = f"From {NEW_HEAD} Mon Sep 17" in b
        checks["patch ends with signature"] = "2.50.1 (Apple Git-155)" in b
        checks["not-verified kept"] = "Not verified: the Playwright GUI pass" in b
    for k, v in checks.items():
        print(f"{name}: {k}: {'OK' if v else 'MISS'}")
        ok = ok and v
print("ALL OK" if ok else "ASSERTION FAILED")
sys.exit(0 if ok else 1)
