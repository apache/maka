What's wrong
---

With "find with a local model" on, common words went out as personal-data placeholders, and came back that way in every request after: over three days and about 1,900 requests, `白名单` was replaced 821 times as a *name*, `node_modules` 7,833 times as a *user name*, `连续` / `时按` / `时隐藏` as *names*. Adding `白名单` to "never mask" did not stop its placeholder from coming back (tianyk, #4087).

Root cause
---

Two halves:

1. The local model (AstrLink Guard) took 白名单 for a name. `internal/redact/zhname.go`'s word lists (zhWords / zhDict, `zhWordShaped`) had no word for it — `白名` isn't in them and `单` isn't in `zhNounEnds` (zhname.go:40, zhname.go:93) — so `zhWordNotName`, the gate `modelSpans` asks (model.go:87), let it through.
2. A value masked once is masked again wherever it stands (known.go): once 白名单 had gone out masked, `knownSpans` re-masked it in every request after, at any place, whatever the words around it. That gate asks the kind, the slider, the letter shape and the packages (known.go:183, `packageAt` v0.1.1965, `wordsOnly` v0.1.1976 for SECRET) — never the words — so the reader's own "this is a word, not a name" judgment (zhWordNotName) was asked no more.

`连续` is already in zhWords here and is left as written; Allow already lets an allowed value go in `apply` (redact.go:1588); and nothing at this tree masks `node_modules` any more — I probed it as a home folder (`/home/node_modules`), a `User:` line, `用户名:` line, `user@host`, `C:\Users\…` and bare path parts: all go as written. The reporter's version predates the wordsOnly (v0.1.1976) and package-in-place (v0.1.1965) fixes that cover it.

The fix
---

`knownSpans` asks `zhWordNotName` at the place a PERSON value stands — the same gate `modelSpans` asks, the way it asks `packageAt`: a word the reader reads as one there goes as written, whatever found it before, and where a role before it or a title after it says a person is meant it is masked again still. And `白名` enters zhWords with `单` in zhNounEnds, so the model's find goes as written to begin with and never becomes known at all.

<details>
<summary>git am applies it as is; SHA-256 first 16: e1217f3ac10ae43e</summary>

```diff
diff --git a/internal/redact/known.go b/internal/redact/known.go
index ec7c5c870..bf1604eb6 100644
--- a/internal/redact/known.go
+++ b/internal/redact/known.go
@@ -218,6 +218,15 @@ func knownSpans(s string, o Options) []span {
 				// secret (dniray, v0.1.1965)
 				continue
 			}
+			if k.kind == "PERSON" && zhWordNotName(s, i, i+len(k.v)) {
+				// a word the reader reads as one where it stands goes as
+				// written, as modelSpans leaves it: the model took 白名单
+				// for a name once, and it went as its placeholder in every
+				// request after (tianyk, #4087). Where a role before it or
+				// a title after it says a person is meant, it is masked
+				// again still.
+				continue
+			}
 			best = &known[s[i:i+minKnown]][j]
 		}
 		if best != nil {
diff --git a/internal/redact/zhname.go b/internal/redact/zhname.go
index 067d685a1..79d0825ee 100644
--- a/internal/redact/zhname.go
+++ b/internal/redact/zhname.go
@@ -34,7 +34,9 @@ const zhNotGiven = "的了在是和与跟同说他她它我你您们这那个不
 // candidate's first two are looked up (zhWord). 毛利 is a gross margin
 // (毛利低 went as a name, _kaichen on X, 10-28) and a Japanese surname
 // too (毛利兰): the rules leave both, and the model, which reads the
-// sentence, finds the name.
+// sentence, finds the name. 白名 is the first two characters of 白名单,
+// a setting's word the model took for a name wherever it stood (tianyk,
+// #4087).
 var zhWords = runes2(
 	"张量", "张开", "张贴", "高度", "高效", "高级", "高速", "高亮", "高手", "高兴", "王国", "王者",
 	"黄河", "黄色", "方法", "方向", "方式", "方案", "方便", "方面", "程序", "程度", "温度", "白色",
@@ -54,7 +56,7 @@ var zhWords = runes2(
 	"范例", "游戏", "游客", "商品", "商店", "商业", "左边", "左侧", "焦点", "毕竟", "尚未",
 	"陆续", "连续", "连线", "林间", "林区", "谢谢", "顾客", "顾问", "房间", "房子", "高端", "高层",
 	"古代", "古典", "农业", "司法", "施工", "卫生", "荣誉", "宗旨", "齐全", "凌晨", "冷却", "蒙版",
-	"曲线", "黄金", "白天", "白板", "金钱", "石油", "夏天", "夏季", "唐朝", "宋朝", "秦朝", "申请",
+	"曲线", "黄金", "白天", "白板", "白名", "金钱", "石油", "夏天", "夏季", "唐朝", "宋朝", "秦朝", "申请",
 	"符号", "景色", "费用", "舒服", "辛苦", "纪律", "席位", "车间", "管道", "何时", "何况", "于是",
 	"余下", "杜绝", "罗列", "程式", "叶片", "涂层", "沙发", "池子", "巩固", "迟到", "仲裁", "钟点",
 	"钟表", "向导", "史诗", "易懂", "马路", "马虎", "汤汁", "朱红", "阳光", "任职", "董事",
@@ -86,8 +88,9 @@ var zhDict = func() map[string]bool {
 const zhColours = "红橙黄绿蓝紫黑白灰褐棕粉赤"
 
 // zhNounEnds are what makes a word a longer one (关键 → 关键词, 边界 →
-// 边界线, 毛利 → 毛利率), and no given name ends with (毛利兰 does not).
-const zhNounEnds = "词字性率值码型键框栏库器类表量度点线层期区图版式页数论员价计费件名夹帧戳"
+// 边界线, 白名 → 白名单, 毛利 → 毛利率), and no given name ends with
+// (毛利兰 does not).
+const zhNounEnds = "词单字性率值码型键框栏库器类表量度点线层期区图版式页数论员价计费件名夹帧戳"
 
 // zhWordShaped says v, a Chinese name the model or the cues took, is an
 // ordinary word: a colour (黄绿色, hh05928822 on X), a word that starts
```

The tests (a row in `TestModelMisreadsNotMasked` and `TestModelFindsStillMasked`, and `internal/redact/zhword_known_test.go`) are in the patch; `git am` brings them along.
</details>

Verification
---

| Check | Result |
| --- | --- |
| RED (tests first, at 2741b749f) | TestModelMisreadsNotMasked and TestKnownWordTakenForANameGoesAsWritten fail: 白名单 masked `开启{{PERSON_…}}之后` |
| Ablation (product files back to 2741b749f, tests kept) | both red again; gate and 白名 restored: green |
| Targeted | TestModelMisreadsNotMasked, TestModelFindsStillMasked, TestKnownWordTakenForANameGoesAsWritten: pass |
| Package `go test -tags nogui -count=1 -timeout 25m ./internal/redact/...` (after the rebase too) | ok |
| Neighbours `./internal/pii/... ./internal/masking/...` | ok (pii 22.4s, guard, coreml, masking) |
| gofmt (tr -d '\r' on each touched file) | clean |
| go vet -tags nogui ./internal/redact/... | clean |
| go build ./... | ok (only this Mac's pre-existing ld macOS-version warnings) |
| Hot-path cost | zhWordNotName runs only where a known value already matched (gram bits, coversKind, slider, standsAlone all passed) and reads a rune pair plus two map lookups and suffix checks — no scan of the text before it, so nothing of #4766's shape comes back |
| Sibling surfaces (rg over the redact reader) | zhWords/zhNounEnds are read only by zhWordShaped/zhWord (zhname.go), so 白名/单 reach no other finder; knownSpans' new gate is PERSON-only, USERNAME keeps nameAlone, SECRET keeps wordsOnly+assignedSecret |

What is still broken, on purpose here
---

`时按` and `时隐藏` are the model's finds of two words it cut as one (超时+按住, 超时+隐藏): not dictionary words, and every shape I tried for them (a word's tail completing with the character before it, or a given name that is a common word) also unmasks real names like 李文明 or 白求恩 in unmarked places, so I left them to the guard model rather than narrow the reader. A 3-character name of two common words (王建国) is untouched: `建国` isn't in the lists, whose words all begin with a surname character. And 白名单 standing where a role or title says a person is meant (`客户白名单`-shaped) is masked still, by zhWordNotName's own escape — a person named so is rare, but the gate keeps it.

Not verified
---

Not run against the reporter's own AstrLink Guard build or their three days of requests: the finds here are the fake model the suite uses, so what the real guard scores 白名单 at is not measured. This patch does not reproduce their `node_modules` row (nothing masks it at this tree — probes above), so it cannot confirm the fix against that half; the `时按`/`时隐藏` rows stay as written in this patch. Rebased onto upstream/main (247794c61) and re-run after.

AI use: the patch and its tests were written by GLM-5.3-Flash (ZCode) and reviewed and run by me.

Attribution: AI-written; I've read the whole diff and the tests pass. Please keep the author (ggbdpq) or add Co-authored-by: ggbdpq ggbdpq@gmail.com.

The whole patch, `git am` applies it as is:

<details>
<summary>0001-redact-and-words-like-it-are-no-name-found-or-known-.patch — SHA-256 first 16: e1217f3ac10ae43e</summary>

```text
From b9b79150c2d728062a185db5b49b070b5a1fb81a Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Wed, 4 Nov 2026 10:19:06 +0800
Subject: [PATCH] redact: 白名单 and words like it are no name, found or
 known (tianyk, #4087)

tianyk's masking, three days of it: 白名单, a setting's word, went out
as a name placeholder 821 times — the local model took it for a name
once, and a value masked once is masked again wherever it stands
(known.go), so it came back in every request after, "之前见过".
The model's own gate for an ordinary word (zhWordNotName, asked in
modelSpans) is asked no more once the value is known: knownSpans
looked at the kind, the slider, the shape of the letters and the
packages, never at the words.

knownSpans now asks zhWordNotName at the place a PERSON value stands,
the same gate modelSpans asks, as it asks packageAt (v0.1.1965): a
word the reader reads as one there goes as written, whatever found it
before, and a name it vouches for (no word of the reader's lists
begins with 欧阳) is masked again still. And 白名 enters zhWords, with
单 in zhNounEnds: the first two characters of 白名单, so the model's
find goes as written to begin with and never becomes known at all.
连续 was already left as written (zhWords), Allow already let an
allowed value go, and nothing masks node_modules at this tree (probed
as a home folder, a User: line, user@host and paths). Not covered:
时按 and 时隐藏, the model's finds of two words it cut as one — the
reader has no word for them, and only the guard model can stop
finding them.

Broken by hand at this tree: the zhWordNotName gate gone in
knownSpans and 白名 out of zhWords, TestKnownWordTakenForANameGoesAs
Written red on 开启{{PERSON_…}}之后 both as found and as known, and
TestModelMisreadsNotMasked red on 白名单; the gate back: all green.

Run: go test -tags nogui -count=1 ./internal/redact/...: ok. gofmt
clean, go vet clean, go build ./... ok.

Fixes #4087
Generated-by: GLM-5.3-Flash (ZCode)
---
 internal/redact/known.go             |  9 ++++++
 internal/redact/modelfits_test.go    |  6 ++++
 internal/redact/zhname.go            | 11 +++++---
 internal/redact/zhword_known_test.go | 41 ++++++++++++++++++++++++++++
 4 files changed, 63 insertions(+), 4 deletions(-)
 create mode 100644 internal/redact/zhword_known_test.go

diff --git a/internal/redact/known.go b/internal/redact/known.go
index ec7c5c870..bf1604eb6 100644
--- a/internal/redact/known.go
+++ b/internal/redact/known.go
@@ -218,6 +218,15 @@ func knownSpans(s string, o Options) []span {
 				// secret (dniray, v0.1.1965)
 				continue
 			}
+			if k.kind == "PERSON" && zhWordNotName(s, i, i+len(k.v)) {
+				// a word the reader reads as one where it stands goes as
+				// written, as modelSpans leaves it: the model took 白名单
+				// for a name once, and it went as its placeholder in every
+				// request after (tianyk, #4087). Where a role before it or
+				// a title after it says a person is meant, it is masked
+				// again still.
+				continue
+			}
 			best = &known[s[i:i+minKnown]][j]
 		}
 		if best != nil {
diff --git a/internal/redact/modelfits_test.go b/internal/redact/modelfits_test.go
index 5ee960e0b..d52c06982 100644
--- a/internal/redact/modelfits_test.go
+++ b/internal/redact/modelfits_test.go
@@ -72,6 +72,10 @@ func TestModelMisreadsNotMasked(t *testing.T) {
 		// the method a call is made on: gctx.GetInt64 went as a made-up key
 		// in the reporter's redaction shot (#4444)
 		{`rows, err := gctx.GetInt64("user_id")`, "gctx.GetInt64", "secret"},
+		// a setting's word the local model took for a name, wherever it
+		// stood: 白名单, 821 replacements in the reporter's three days
+		// (tianyk, #4087)
+		{"开启白名单之后，把要放行的域名填进去。", "白名单", "private_person"},
 	} {
 		f := &fakeModel{values: map[string]string{c.value: c.label}}
 		if out, n := Mask(c.text, Options{Secrets: true, Personal: true, Model: f.find}); n != 0 {
@@ -108,6 +112,8 @@ func TestModelFindsStillMasked(t *testing.T) {
 		{"the token is 9f2c4e1a7b3d5c8e9f2c", "9f2c4e1a7b3d5c8e9f2c", "secret"},
 		{"ask McDonald, he knows", "McDonald", "private_person"},
 		{"write to Rina at rina.lee@kowalczyk.pl", "Rina", "private_person"},
+		// a Chinese name where the words around it say one is meant
+		{"找王芳确认一下档期", "王芳", "private_person"},
 		{"ring +1 415.555.0132 after six", "+1 415.555.0132", "private_phone"},
 		{"we live at 3/12 Smith Street, Sydney", "3/12 Smith Street, Sydney", "private_address"},
 	} {
diff --git a/internal/redact/zhname.go b/internal/redact/zhname.go
index 067d685a1..79d0825ee 100644
--- a/internal/redact/zhname.go
+++ b/internal/redact/zhname.go
@@ -34,7 +34,9 @@ const zhNotGiven = "的了在是和与跟同说他她它我你您们这那个不
 // candidate's first two are looked up (zhWord). 毛利 is a gross margin
 // (毛利低 went as a name, _kaichen on X, 10-28) and a Japanese surname
 // too (毛利兰): the rules leave both, and the model, which reads the
-// sentence, finds the name.
+// sentence, finds the name. 白名 is the first two characters of 白名单,
+// a setting's word the model took for a name wherever it stood (tianyk,
+// #4087).
 var zhWords = runes2(
 	"张量", "张开", "张贴", "高度", "高效", "高级", "高速", "高亮", "高手", "高兴", "王国", "王者",
 	"黄河", "黄色", "方法", "方向", "方式", "方案", "方便", "方面", "程序", "程度", "温度", "白色",
@@ -54,7 +56,7 @@ var zhWords = runes2(
 	"范例", "游戏", "游客", "商品", "商店", "商业", "左边", "左侧", "焦点", "毕竟", "尚未",
 	"陆续", "连续", "连线", "林间", "林区", "谢谢", "顾客", "顾问", "房间", "房子", "高端", "高层",
 	"古代", "古典", "农业", "司法", "施工", "卫生", "荣誉", "宗旨", "齐全", "凌晨", "冷却", "蒙版",
-	"曲线", "黄金", "白天", "白板", "金钱", "石油", "夏天", "夏季", "唐朝", "宋朝", "秦朝", "申请",
+	"曲线", "黄金", "白天", "白板", "白名", "金钱", "石油", "夏天", "夏季", "唐朝", "宋朝", "秦朝", "申请",
 	"符号", "景色", "费用", "舒服", "辛苦", "纪律", "席位", "车间", "管道", "何时", "何况", "于是",
 	"余下", "杜绝", "罗列", "程式", "叶片", "涂层", "沙发", "池子", "巩固", "迟到", "仲裁", "钟点",
 	"钟表", "向导", "史诗", "易懂", "马路", "马虎", "汤汁", "朱红", "阳光", "任职", "董事",
@@ -86,8 +88,9 @@ var zhDict = func() map[string]bool {
 const zhColours = "红橙黄绿蓝紫黑白灰褐棕粉赤"
 
 // zhNounEnds are what makes a word a longer one (关键 → 关键词, 边界 →
-// 边界线, 毛利 → 毛利率), and no given name ends with (毛利兰 does not).
-const zhNounEnds = "词字性率值码型键框栏库器类表量度点线层期区图版式页数论员价计费件名夹帧戳"
+// 边界线, 白名 → 白名单, 毛利 → 毛利率), and no given name ends with
+// (毛利兰 does not).
+const zhNounEnds = "词单字性率值码型键框栏库器类表量度点线层期区图版式页数论员价计费件名夹帧戳"
 
 // zhWordShaped says v, a Chinese name the model or the cues took, is an
 // ordinary word: a colour (黄绿色, hh05928822 on X), a word that starts
diff --git a/internal/redact/zhword_known_test.go b/internal/redact/zhword_known_test.go
new file mode 100644
index 000000000..d5ad9484f
--- /dev/null
+++ b/internal/redact/zhword_known_test.go
@@ -0,0 +1,41 @@
+package redact
+
+import (
+	"strings"
+	"testing"
+)
+
+// tianyk, #4087: 白名单, a common word, was taken for a name by the local
+// model once, and from then on went as its placeholder everywhere, request
+// after request (821 replacements in three days, "之前见过"): a value
+// masked once is masked again wherever it stands (known.go), and the
+// model's gate for an ordinary word (zhWordNotName, modelSpans) is asked
+// no more. A value the reader reads as an ordinary word where it stands
+// goes as written there, whatever first found it; a name the reader
+// vouches for is masked again still.
+func TestKnownWordTakenForANameGoesAsWritten(t *testing.T) {
+	f := &fakeModel{values: map[string]string{"白名单": "private_person"}}
+	o := Options{Personal: true, Model: f.find}
+	if out, n := Mask("开启白名单之后，把要放行的域名填进去。", o); n != 0 {
+		t.Fatalf("not left as written to begin with: %q", out)
+	}
+	// the next request, with the model finding nothing in it
+	if out, n := Mask("白名单在设置里，加一行就行。", Options{Personal: true}); n != 0 {
+		t.Errorf("as known: %q", out)
+	}
+	if out, n := Mask("设置里的白名单要加一行。", o); n != 0 {
+		t.Errorf("as found again: %q", out)
+	}
+
+	// a name of its own, once masked, is masked again where no word stands
+	// in its place: 欧阳娜娜 the reader takes for one (欧阳 a surname's
+	// two characters, no word begins with them)
+	fr := &fakeModel{values: map[string]string{"欧阳娜娜": "private_person"}}
+	or := Options{Personal: true, Model: fr.find}
+	if out, _ := Mask("客户欧阳娜娜来电话", or); strings.Contains(out, "欧阳娜娜") {
+		t.Fatalf("not masked to begin with: %q", out)
+	}
+	if out, n := Mask("欧阳娜娜今天到了", Options{Personal: true}); n == 0 {
+		t.Errorf("a known name left as written: %q", out)
+	}
+}
-- 
2.50.1 (Apple Git-155)
```
</details>

Branch with the commit: fix/4087-redact-node-modules (head b9b79150c2d728062a185db5b49b070b5a1fb81a)
