`magpie search move exa 2oops` moves Exa to position 2, and `move exa 1.5` to position 1: the `move` branch (`internal/cli/search_cli.go`) read the position with `fmt.Sscan` and ignored what it left behind, so any argument starting with a valid integer was taken, and the saved order was written all the same. Parse it with `strconv.Atoi` instead — what the other commands do: a whole number within the saved API count or the usual "n from 1 to N" error, the saved settings untouched. One commit: head `f99b654ce` on tip `12a9970d6`, branch [`fix/5354-search-move-validate`](https://github.com/ggbdpq/magpie/tree/fix/5354-search-move-validate). Patch below, `git am` applies it as is; SHA-256 first 16: `05c923ce15d1f442`.

**What changed**

- `internal/cli/search_cli.go`: the `move`/`mv` position is parsed with `strconv.Atoi`, which takes a whole number only: `2oops`, `1.5` and the overflow `99999999999999999999` land in the same refusal as `0` and out-of-range values, the same message, nothing written.
- `internal/cli/search_cli_test.go`: `TestSearchCLIMoveMalformedPosition`.

**Tests** (tavily, exa and brave saved, in that order)

| Test | on main `12a9970d6` | here `f99b654ce` |
| --- | --- | --- |
| `TestSearchCLIMoveMalformedPosition` (`2oops`, `1.5`, `-1`, overflow, out-of-range and empty, on both `move` and `mv`, the saved order checked after every refusal, `mv` still moving) | FAIL: `move 2oops taken`, `mv 2oops taken`, `move 1.5 taken` — and `move 1.5` had reordered the saved APIs to `[exa tavily brave]` | PASS |
| `TestSearchCLI`, `TestSearchCLIYouWithoutKey`, `TestSearchCLIOffAndMove` | PASS | PASS: valid first/last positions and every alias still move |

Ablation: with the product change alone checked back out to main's (the test kept), the new test fails with exactly that output; with the change back, it passes.

**Siblings** (every `fmt.Sscan` in the repo, compared)

- `internal/cli/webdav_cli.go` (`sync auto`): `fmt.Sscan` with an error check — but `Sscan` takes an integer prefix without an error, so `auto 3x` is taken as `3` there too. Same family, another command: left out of this scope per the issue, reported here for its own patch.
- `internal/provider/grouptemplate.go` (`sizeOf`): the regex (`^(\d+(?:\.\d+)?)b$`) hands `Sscan` digits only, so no prefix can survive it.
- `internal/mcpauth/mcpauth.go` (`expires_in`): an OAuth form field, not a command argument; a failed read leaves the zero value as before.
- every other numeric argument in `internal/cli` is `strconv.Atoi` already — this was the one `fmt.Sscan` left.

**Verified** (head `f99b654ce`, darwin/arm64, go1.26.8): `go test -tags nogui -count=1 -run '^TestSearchCLI' ./internal/cli` ok; `go test -tags nogui -count=1 ./internal/cli` ok (47s); `gofmt -l` clean; `go vet -tags nogui ./internal/cli` clean on GOOS=darwin and GOOS=windows; `go build -tags nogui ./...` ok on both. Not run: `-race` (the change parses one argument, no concurrency touched), the gateway and GUI suites (nothing outside `internal/cli` is changed).

Thanks @vizmoe for the report and the exact reproduction steps.

**Attribution**: AI-written; I've read the whole diff and the tests pass. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`.

<details><summary>patch: cli: search move takes a whole number only (#5354) — git am applies it as is; SHA-256 first 16: 05c923ce15d1f442</summary>

```text
From 0000000000000000000000000000000000000000 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Fri, 6 Nov 2026 22:46:38 +0800
Subject: [PATCH] cli: search move takes a whole number only

magpie search move (and mv) parsed the position with fmt.Sscan and
ignored what it left behind, so 2oops moved to 2 and 1.5 to 1, and the
saved order was written all the same (#5354). Parse with strconv.Atoi,
as the other commands do: a whole number within the saved API count or
the usual error, the saved settings untouched. TestSearchCLIMoveMalformed
Position pins it: the malformed inputs are refused, the order unchanged
after every one, and mv still moves.

Generated-by: GLM-5.3-Flash (ZCode)
---
 internal/cli/search_cli.go      |  5 ++++-
 internal/cli/search_cli_test.go | 36 +++++++++++++++++++++++++++++++++
 2 files changed, 40 insertions(+), 1 deletion(-)

diff --git a/internal/cli/search_cli.go b/internal/cli/search_cli.go
index c384a8b27..3f78915e0 100644
--- a/internal/cli/search_cli.go
+++ b/internal/cli/search_cli.go
@@ -4,6 +4,7 @@ import (
 	"context"
 	"fmt"
 	"slices"
+	"strconv"
 	"strings"
 	"time"
 
@@ -136,7 +137,9 @@ func searchCmd(args []string) error {
 	case "move", "mv":
 		n := 0
 		if len(args) == 3 {
-			fmt.Sscan(args[2], &n)
+			// a whole number only: an integer prefix like 2oops or 1.5
+			// must not be taken for a position (#5354)
+			n, _ = strconv.Atoi(args[2])
 		}
 		as := provider.StoredSearchAPIs()
 		i := slices.IndexFunc(as, func(x provider.SearchAPI) bool { return len(args) > 1 && x.Vendor == strings.ToLower(args[1]) })
diff --git a/internal/cli/search_cli_test.go b/internal/cli/search_cli_test.go
index 2d9f40d30..92083197b 100644
--- a/internal/cli/search_cli_test.go
+++ b/internal/cli/search_cli_test.go
@@ -139,3 +139,39 @@ func TestSearchCLIOffAndMove(t *testing.T) {
 		}
 	}
 }
+
+// magpie search move (and mv) takes a whole number only: 2oops or 1.5 is an
+// error and leaves the saved order unchanged (#5354).
+func TestSearchCLIMoveMalformedPosition(t *testing.T) {
+	t.Setenv("HOME", t.TempDir())
+	t.Setenv("USERPROFILE", os.Getenv("HOME"))
+	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
+	for _, args := range [][]string{{"add", "tavily", "tvly-1"}, {"add", "exa", "e-1"}, {"add", "brave", "b-1"}} {
+		if err := searchCmd(args); err != nil {
+			t.Fatalf("%v: %v", args, err)
+		}
+	}
+	order := func() (vs []string) {
+		for _, a := range provider.StoredSearchAPIs() {
+			vs = append(vs, a.Vendor)
+		}
+		return vs
+	}
+	for _, bad := range []string{"2oops", "1.5", "-1", "99999999999999999999", "4", ""} {
+		for _, cmd := range []string{"move", "mv"} {
+			if err := searchCmd([]string{cmd, "exa", bad}); err == nil {
+				t.Errorf("%s %s taken", cmd, bad)
+			}
+			if got := order(); !slices.Equal(got, []string{"tavily", "exa", "brave"}) {
+				t.Fatalf("%s %s reordered the saved APIs: %v", cmd, bad, got)
+			}
+		}
+	}
+	// mv still moves
+	if err := searchCmd([]string{"mv", "exa", "1"}); err != nil {
+		t.Fatal(err)
+	}
+	if got := order(); !slices.Equal(got, []string{"exa", "tavily", "brave"}) {
+		t.Fatalf("after mv %v", got)
+	}
+}
-- 
2.50.1 (Apple Git-155)

```

</details>

Generated-by: GLM-5.3-Flash (ZCode)
