Reproduced both refusals of this report on a fake upstream and fixed the gateway's side of them. The screenshot Claude Desktop's browser tool takes is `image/webp`, and GLM can't read one: its 400 [1210] is its "image input format/parse error", and its Anthropic-style endpoint says of the same picture 400 [1214] "messages[0].content[0].file must pass at least one of file_id, file_url, file_data" — it has taken the picture for a file of its own. The picture rides in the conversation's history, so every later turn carried it again, every turn was refused the same way, and no other model or provider of the same conversation could answer either — the session was stuck for good. magpie already writes a HEIC again as a JPEG for exactly this reason; a webp went as it came, most vendors taking it.

## What changed

- A webp of a request whose provider refused one is written again as a JPEG (as a PNG when it has transparency), the way a HEIC is, and the provider is remembered: from the refusal on, every request to it has its webps written before they leave (`internal/gateway/webp.go`, the walk and the cache of `internal/gateway/heic.go`; the serve loop in `internal/gateway/gateway.go`). The first turn pays one refusal, the session's later turns pay none.
- GLM's two wordings for the unreadable picture (its [1210] and its [1214], read decoded, as a relay may pass them on escaped) join the shape refusals (`shapeRefused`, `retryable` in `internal/gateway/fallback.go`): a request with no webp that can be written again (one gone as an URL, say) moves to the next member, which may take the picture as it is, and this one doesn't rest. The bare code alone is none of it — Z.ai's other "1210", its word for a model that always thinks, stays where it was (a test pins that).
- Most vendors take webp, so nothing is written again for them until their own first refusal says otherwise.

## Red before the fix

Base `647323409`, tests in `internal/gateway/webp_test.go` (fake upstream answering with the report's refusals, a real 2x1 webp in an Anthropic request):

- `TestWebPRefusalHealed`: before, the first turn ended in the 400 (media types sent: `["image/webp"]` only); after, the same member is asked again with the picture as `image/jpeg` and answers, and the next turn goes out as `image/jpeg` from the start.
- `TestZhipuImageRefusalFailsOver`: before, the 400 reached the client and the fallback member was never asked; after, it answers.
- `TestZhipuImageRefusalWords` / `TestWebPAsJPEG`: the wordings' table membership and the rewrite itself, as table tests.

Ablation (product halves reverted one at a time, tests kept): reverting the shape-table half turns the failover test and the wording test red again, the heal test stays green; reverting the rewrite half turns the heal test and the rewrite test red again, the failover test stays green; both reverted, all four are red. Neither half covers for the other.

## Verification

| Check | Result |
| --- | --- |
| `go test -tags nogui -count=1 -run 'TestWebPRefusalHealed|TestZhipuImageRefusalFailsOver|TestZhipuImageRefusalWords|TestWebPAsJPEG' ./internal/gateway/` | ok |
| `go test -tags nogui -count=1 ./internal/gateway/` (full package, on the rebased head) | ok, ~526s |
| `gofmt -l internal/gateway/` | empty |
| `go vet -tags nogui ./internal/gateway/` darwin / linux / windows | clean |
| `go build -tags nogui` darwin/arm64, linux/amd64, windows/amd64 | ok |

## Siblings

The rewrite reuses the HEIC machinery's walk, cache and writer (`heicConverted` gained an encode parameter; `encodeHEIC`'s tail is now `pictureWritten`, shared with the webp's) — the HEIC tests pass unchanged. The Codex image tool, image generation and magpie's own image MCP tool are different pipelines and are untouched. The wording join is beside the other word lists a 400 is read by; the quota, credit and model-refusal lists still outrank it where they also match.

## Not verified

- No real GLM account here: the refusals are answered by a fake upstream, in the exact bodies the report pastes, and the rewritten picture is a real webp decoded and encoded through the shipping path — but the two endpoints of the report (`open.bigmodel.cn/api/anthropic` and the zcode relay) were not asked.
- Whether GLM takes the rewritten JPEG of a screenshot that also has transparency (it would go as a PNG there) is read off the HEIC path's experience, not tried against GLM.

Branch with the commit: [hunt115-c-4732](https://github.com/ggbdpq/magpie/tree/hunt115-c-4732) (head `70cf626c54bf37110c4389518cff7f5b1f52250e`).

**Attribution**: AI-written; I've read the whole diff and the tests pass. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`.

<details><summary>patch: gateway: a webp a vendor can't read is written again as a JPEG, and GLM's word for one fails over (#4732) — git am applies it as is; SHA-256 first 16: d517193f585e9dde</summary>

```patch
From 70cf626c54bf37110c4389518cff7f5b1f52250e Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Sun, 1 Nov 2026 17:21:05 +0800
Subject: [PATCH] gateway: a webp a vendor can't read is written again as a
 JPEG, and GLM's word for one fails over (#4732)
MIME-Version: 1.0
Content-Type: text/plain; charset=UTF-8
Content-Transfer-Encoding: 8bit

Claude Desktop's browser tool answers a screenshot as image/webp, and
GLM can't read one: its 400 [1210] "图片输入格式/解析错误" turns the
picture away, and its Anthropic-style endpoint says of the same picture
400 [1214] "messages[0].content[0].file必须传入file_id、file_url、
file_data至少之一", having taken it for a file of its own — the two
alternating (zhangqingwen204's report). The picture rides in the
conversation's history, so every later turn was refused the same way,
and the session was stuck; another model or provider of the same
conversation fared no better.

Now the request is asked again with the picture written again as a JPEG
(as PNG when it has transparency), the way a HEIC is (heic.go), and the
provider is remembered (unfit, webpRefused) to have every webp of its
requests written again before they leave — the session's later turns
pay the refusal no more. The words themselves join the shape refusals
(shapeRefused, retryable): a request no webp of whose can be written
again (one gone as an URL, say) moves to the next member, which may
take the picture as it is, and this one doesn't rest. Z.ai's bare
"1210", its word for a model that always thinks, is none of this: the
family is the double-bracket "[1210][" and "[1214][" forms and the two
wordings, read decoded (#1669).

Most vendors take webp, so nothing is written again for them until
their first refusal says otherwise.

Run: go test -tags nogui ./internal/gateway/

Generated-by: GLM-5.3-Flash (ZCode)
---
 internal/gateway/fallback.go  |  10 +--
 internal/gateway/gateway.go   |  21 ++++++
 internal/gateway/heic.go      |  19 ++++-
 internal/gateway/webp.go      | 116 ++++++++++++++++++++++++++++++
 internal/gateway/webp_test.go | 131 ++++++++++++++++++++++++++++++++++
 5 files changed, 291 insertions(+), 6 deletions(-)
 create mode 100644 internal/gateway/webp.go
 create mode 100644 internal/gateway/webp_test.go

diff --git a/internal/gateway/fallback.go b/internal/gateway/fallback.go
index 9c6583ab2..25af25ab4 100644
--- a/internal/gateway/fallback.go
+++ b/internal/gateway/fallback.go
@@ -1516,12 +1516,14 @@ var unsaidWords = regexp.MustCompile(`(?i)(^|"|\\"|: )invalid request error trac
 // member has tried every API it has a URL for (forwardTranslated), and
 // another member, on another API or another vendor, may serve it (#2670:
 // a relay with a Chat URL alone, refusing tools with reasoning there).
-// One that also says the account is out of quota or credit (quotaWords,
-// creditWords: "请充值") is that, and rests it (#4095).
+// GLM's word for a picture it can't read (zhipuImageRefusal, #4732) is
+// one: another vendor takes the webp as it is. One that also says the
+// account is out of quota or credit (quotaWords, creditWords: "请充值")
+// is that, and rests it (#4095).
 func shapeRefused(status int, body []byte) bool {
 	// the words are matched decoded, too (#1669)
 	body = wordsOf(body)
-	return (status == 400 || status == 422) && (shapeWords.Match(body) || unsaidWords.Match(body) || customToolRefusal.Match(body) || wrongEndpoint(status, body)) &&
+	return (status == 400 || status == 422) && (shapeWords.Match(body) || unsaidWords.Match(body) || customToolRefusal.Match(body) || zhipuImageRefusal.Match(body) || wrongEndpoint(status, body)) &&
 		!quotaWords.Match(body) && !creditWords.Match(body) && !unservedWords.Match(body) && !refusedWords.Match(body)
 }
 
@@ -1642,7 +1644,7 @@ func retryable(status int, body []byte) bool {
 		// mycf_711)
 		return true
 	case status == 400, status == 422:
-		return quotaWords.Match(body) || unservedWords.Match(body) || refusedWords.Match(body) || shapeWords.Match(body) || unsaidWords.Match(body) || regionWords.Match(body) || wrongEndpoint(status, body)
+		return quotaWords.Match(body) || unservedWords.Match(body) || refusedWords.Match(body) || shapeWords.Match(body) || unsaidWords.Match(body) || regionWords.Match(body) || zhipuImageRefusal.Match(body) || wrongEndpoint(status, body)
 	}
 	return false
 }
diff --git a/internal/gateway/gateway.go b/internal/gateway/gateway.go
index b19da3873..9ad907d94 100644
--- a/internal/gateway/gateway.go
+++ b/internal/gateway/gateway.go
@@ -3005,6 +3005,13 @@ func (s *Server) serve(w http.ResponseWriter, r *http.Request, from provider.Pro
 		}
 		// a middleware's onProvider changes what this provider is sent
 		attemptBody = triedOn(r.Context(), c.p, c.model, attemptBody)
+		if !s.fits(c.p.ID, webpRefused, from) {
+			// a provider that took a webp picture for one it can't read
+			// (webp.go) has every one of its requests' webps written again
+			// before they leave, its later turns not paying the refusal
+			// again (#4732)
+			attemptBody = webpAsJPEG(from, attemptBody)
+		}
 		// a value masking swapped for a placeholder: the model is told to
 		// use it as written (treeMan on Discord). A conversation's values
 		// are masked again on every turn, so once one is, every later
@@ -3733,6 +3740,20 @@ func (s *Server) serve(w http.ResponseWriter, r *http.Request, from provider.Pro
 				continue
 			}
 		}
+		if !hw.passing && badRequest(hw.code()) && hw.mayAskAgain() && zhipuImageRefusal.Match(wordsOf(hw.errBody())) {
+			if b := webpAsJPEG(from, attemptBody); !bytes.Equal(b, attemptBody) {
+				// GLM can't read a webp picture (Claude Desktop's browser
+				// screenshot, #4732), and the session's history carries it,
+				// so every turn was refused again: written here as a JPEG,
+				// which it takes, and this member asked once more — from
+				// then on written before the request leaves (webpRefused).
+				// A picture gone as an URL is none's to write: the member
+				// falls through, and the next is asked (shapeRefused)
+				s.markUnfit(c.p.ID, webpRefused, from)
+				i--
+				continue
+			}
+		}
 		if !last && hw.failed() && shapeRefused(hw.code(), hw.errBody()) {
 			// a request this vendor's API can't read (xAI's 422 over an
 			// input item it doesn't know, #350) another's may: the next is
diff --git a/internal/gateway/heic.go b/internal/gateway/heic.go
index d52a4fc39..885517a12 100644
--- a/internal/gateway/heic.go
+++ b/internal/gateway/heic.go
@@ -5,6 +5,7 @@ import (
 	"crypto/sha256"
 	"encoding/base64"
 	"encoding/json"
+	"image"
 	"image/jpeg"
 	"image/png"
 	"runtime/debug"
@@ -166,6 +167,12 @@ var heicSlots = make(chan struct{}, 1)
 // heicConverted is the HEIC raw written again, from the cache when it was
 // before: an agent sends its conversation's images on every turn.
 func heicConverted(raw []byte) (string, []byte) {
+	return converted(raw, heicEncode)
+}
+
+// converted is heicConverted for an encode: the raw written again by enc,
+// from the cache when it was before.
+func converted(raw []byte, enc func([]byte) (string, []byte)) (string, []byte) {
 	k := sha256.Sum256(raw)
 	heicCache.Lock()
 	r, ok := heicCache.m[k]
@@ -184,7 +191,7 @@ func heicConverted(raw []byte) (string, []byte) {
 					r = heicResult{} // the decoder's fault on a bad file
 				}
 			}()
-			r.mime, r.data = heicEncode(raw)
+			r.mime, r.data = enc(raw)
 		}()
 		heicKeep(k, r)
 		done <- r
@@ -231,7 +238,15 @@ func encodeHEIC(raw []byte) (string, []byte) {
 	if err != nil {
 		return "", nil
 	}
-	if cfg.Width*cfg.Height > heicFreeAbove {
+	return pictureWritten(img, cfg.Width*cfg.Height)
+}
+
+// pictureWritten is img written as JPEG, or as PNG when it has
+// transparency, its longest side heicMaxSide at most; "", nil when it
+// can't. pixels is the count of what the decode held, a big one's home
+// going back to the system once it is written.
+func pictureWritten(img image.Image, pixels int) (string, []byte) {
+	if pixels > heicFreeAbove {
 		// a 48 MP photo held about a gigabyte while it was written
 		// again (1.6s on an M5 Pro); what it held goes back to the system
 		// now, not minutes later
diff --git a/internal/gateway/webp.go b/internal/gateway/webp.go
new file mode 100644
index 000000000..6c97217f0
--- /dev/null
+++ b/internal/gateway/webp.go
@@ -0,0 +1,116 @@
+package gateway
+
+import (
+	"bytes"
+	"encoding/base64"
+	"encoding/json"
+	"regexp"
+	"strings"
+
+	"github.com/yetone/magpie/internal/provider"
+	"golang.org/x/image/webp"
+)
+
+// Claude Desktop's browser tool answers a screenshot as image/webp, and
+// GLM can't read one: its 400 [1210] "图片输入格式/解析错误" turns the
+// picture away, and its Anthropic-style endpoint says of the same picture
+// 400 [1214] "messages[0].content[0].file必须传入file_id、file_url、
+// file_data至少之一", having taken it for a file of its own — the two
+// alternating (zhangqingwen204's report, #4732). The picture rides in the
+// conversation's history, so every later turn was refused the same way,
+// and the session was stuck. Most vendors do take webp, so it is not
+// written again for them all the way a HEIC is (heic.go): a provider that
+// refused one (webpRefused) has every webp of its requests written again
+// as JPEG — as PNG when it has transparency — before anything reads the
+// body, the first turn paying one refusal to learn it.
+
+// webpRefused is how unfit remembers a provider that turned a webp away.
+const webpRefused = "image/webp"
+
+// zhipuImageRefusal is how GLM's says it can't read the picture: its
+// [1210] word for a format it doesn't parse, its [1214] word for one it
+// took for a file and found none of its file fields in, and the pair of
+// codes in the double brackets it puts before them. Read of the words
+// wordsOf gives, as a relay may pass them on \u-escaped (#1669).
+var zhipuImageRefusal = regexp.MustCompile(`必须传入file_id、file_url、file_data至少之一|图片输入格式|\[(?:1210|1214)\]\[`)
+
+// mayHoldWebP is whether the body may hold a webp: an image/webp type, or
+// the base64 of a RIFF file's head, wherever its base64 starts (a webp
+// sent under another type is one too, as a HEIC sent as image/jpeg is).
+func mayHoldWebP(body []byte) bool {
+	return bytes.Contains(body, []byte("image/webp")) || bytes.Contains(body, []byte(`image\/webp`)) ||
+		bytes.Contains(body, []byte("UklG"))
+}
+
+// webpAsJPEG is the body with each webp in it written again as JPEG (PNG
+// with transparency); the body as it came when there is none.
+func webpAsJPEG(proto provider.Protocol, body []byte) []byte {
+	if !mayHoldWebP(body) {
+		return body
+	}
+	out, err := walkImages(proto, body, func(im imageAt) (json.RawMessage, error) {
+		raw := webpOf(im.Src)
+		if raw == nil {
+			return nil, nil
+		}
+		mime, data := webpConverted(raw)
+		if data == nil {
+			return nil, nil
+		}
+		return withImageData(proto, im.Block, mime, base64.StdEncoding.EncodeToString(data)), nil
+	})
+	if err != nil {
+		return body
+	}
+	return out
+}
+
+// webpOf is the bytes of a data: URL's image when they are a webp's.
+func webpOf(src string) []byte {
+	rest, ok := strings.CutPrefix(src, "data:")
+	if !ok {
+		return nil
+	}
+	head, b64, ok := strings.Cut(rest, ",")
+	if !ok || !strings.HasSuffix(head, ";base64") || len(b64) < 16 || len(b64) > heicMaxBase64 {
+		return nil
+	}
+	sniff, err := base64.StdEncoding.DecodeString(b64[:16])
+	if err != nil || !isWebP(sniff) {
+		return nil
+	}
+	raw, err := base64.RawStdEncoding.DecodeString(strings.TrimRight(b64, "="))
+	if err != nil {
+		return nil
+	}
+	return raw
+}
+
+// isWebP is whether b starts as a webp's file does.
+func isWebP(b []byte) bool {
+	return len(b) >= 12 && string(b[0:4]) == "RIFF" && string(b[8:12]) == "WEBP"
+}
+
+// webpConverted is the webp raw written again, from the cache when it was
+// before (converted, heic.go): an agent sends its conversation's images on
+// every turn.
+func webpConverted(raw []byte) (string, []byte) {
+	return converted(raw, webpEncode)
+}
+
+// webpEncode writes a webp again; a var for tests.
+var webpEncode = encodeWebP
+
+// encodeWebP decodes a webp and writes it as pictureWritten does; "", nil
+// when it can't.
+func encodeWebP(raw []byte) (string, []byte) {
+	cfg, err := webp.DecodeConfig(bytes.NewReader(raw))
+	if err != nil || cfg.Width <= 0 || cfg.Height <= 0 || int64(cfg.Width)*int64(cfg.Height) > heicMaxPixels {
+		return "", nil
+	}
+	img, err := webp.Decode(bytes.NewReader(raw))
+	if err != nil {
+		return "", nil
+	}
+	return pictureWritten(img, cfg.Width*cfg.Height)
+}
diff --git a/internal/gateway/webp_test.go b/internal/gateway/webp_test.go
new file mode 100644
index 000000000..b8b076129
--- /dev/null
+++ b/internal/gateway/webp_test.go
@@ -0,0 +1,131 @@
+package gateway
+
+import (
+	"bytes"
+	"encoding/base64"
+	"strings"
+	"testing"
+
+	"github.com/tidwall/gjson"
+
+	"github.com/yetone/magpie/internal/provider"
+)
+
+// webpShot is a 2x1 lossless webp, as Claude Desktop's browser tool
+// answers a screenshot (#4732).
+var webpShot = "UklGRh4AAABXRUJQVlA4TBEAAAAvAQAAAA+w//Mf8x8VMqL/AQA="
+
+// zhipuFileRefusal is GLM's 400 [1214], its word for a content block it
+// took for a file of its own and found no file_id, file_url or file_data
+// in — what its Anthropic-style endpoint says of a webp picture (#4732).
+const zhipuFileRefusal = `{"type":"error","error":{"type":"invalid_request_error","message":"[1214][messages[0].content[0].file必须传入file_id、file_url、file_data至少之一]"}}`
+
+// zhipuFormatRefusal is GLM's 400 [1210] for an image it doesn't parse,
+// the other of the reporter's two, the pair alternating (#4732).
+const zhipuFormatRefusal = `{"error":{"code":"1210","message":"[1210][图片输入格式/解析错误]"}}`
+
+// #4732: Claude Desktop's browser screenshot is a webp, GLM can't read
+// one, and its 400 left the session stuck: the picture rides in the
+// conversation's history, so every later turn was refused the same way.
+// Asked again with the picture written as a JPEG, which it takes, and
+// from then on written before it leaves, the session goes on.
+func TestWebPRefusalHealed(t *testing.T) {
+	var mts []string
+	f := &fake{t: t, reply: anthropicHi}
+	f.refuse = func(b []byte) (int, string) {
+		mt := gjson.GetBytes(b, "messages.0.content.0.source.media_type").String()
+		mts = append(mts, mt)
+		if mt == "image/webp" {
+			return 400, zhipuFileRefusal
+		}
+		return 0, ""
+	}
+	setup(t, provider.Anthropic, f)
+	srv := New()
+	ask := `{"model":"m1","max_tokens":32,"messages":[{"role":"user","content":[` +
+		`{"type":"image","source":{"type":"base64","media_type":"image/webp","data":"` + webpShot + `"}},` +
+		`{"type":"text","text":"这是什么"}]}]}`
+	for turn, want := range [][]string{{"image/webp", "image/jpeg"}, {"image/jpeg"}} {
+		mts = nil
+		code, body := postTo(t, srv, "/v1/messages", ask)
+		if code != 200 || len(mts) != len(want) {
+			t.Fatalf("turn %d: %d %s, media types sent %q, want %q", turn+1, code, body, mts, want)
+		}
+		for i, mt := range want {
+			if mts[i] != mt {
+				t.Fatalf("turn %d: media type sent %d is %q, want %q (all %q)", turn+1, i, mts[i], mt, mts)
+			}
+		}
+	}
+}
+
+// The same refusal with no webp of the request's to write again: the next
+// provider is asked, as for a shape it can't read, and this one doesn't
+// rest — nothing is wrong with it.
+func TestZhipuImageRefusalFailsOver(t *testing.T) {
+	plan := &fake{t: t, ctype: "application/json", code: 400, reply: zhipuFileRefusal}
+	spare := &fake{t: t, ctype: "application/json", reply: `{"id":"from-spare","choices":[]}`}
+	twoProviders(t, plan, spare)
+	code, body := post(t, "/v1/chat/completions", chatReq)
+	if code != 200 || !strings.Contains(body, "from-spare") || strings.Contains(body, "file_data") {
+		t.Fatalf("%d %s", code, body)
+	}
+	if plan.calls != 1 {
+		t.Fatalf("plan asked %d times, want 1", plan.calls)
+	}
+}
+
+func TestZhipuImageRefusalWords(t *testing.T) {
+	// the message \u-escaped, as a relay may pass it on (#1669)
+	escaped := `{"error":{"code":"1214","message":"[1214][messages[0].content[0].file\u5fc5\u987b\u4f20\u5165file_id\u3001file_url\u3001file_data\u81f3\u5c11\u4e4b\u4e00]"}}`
+	for b, want := range map[string]bool{
+		zhipuFileRefusal:   true,
+		zhipuFormatRefusal: true,
+		escaped:            true,
+		`{"error":{"message":"messages: field required"}}`:                 false,
+		`{"error":{"message":"messages[1210].content: must have a role"}}`: false,
+		`{"error":{"message":"Invalid API key"}}`:                          false,
+		// Z.ai's other 1210, its word for a model that always thinks
+		// (TestAnthropicPassthroughModelThatAlwaysThinks): the bare code,
+		// without the double brackets or the picture's words, is none of
+		// this family
+		`{"type":"error","error":{"type":"1210","message":"GLM-5.3 always engages in thinking; use low, high, or max"}}`: false,
+	} {
+		if got := zhipuImageRefusal.Match(wordsOf([]byte(b))); got != want {
+			t.Errorf("zhipuImageRefusal(%s) = %v, want %v", b, got, want)
+		}
+		if got := shapeRefused(400, []byte(b)); got != want {
+			t.Errorf("shapeRefused(400, %s) = %v, want %v", b, got, want)
+		}
+		if got := retryable(400, []byte(b)); got != want {
+			t.Errorf("retryable(400, %s) = %v, want %v", b, got, want)
+		}
+	}
+}
+
+func TestWebPAsJPEG(t *testing.T) {
+	ask := []byte(`{"model":"m1","max_tokens":32,"messages":[{"role":"user","content":[` +
+		`{"type":"image","source":{"type":"base64","media_type":"image/webp","data":"` + webpShot + `"}},` +
+		`{"type":"text","text":"这是什么"}]}]}`)
+	got := webpAsJPEG(provider.Anthropic, ask)
+	mt := gjson.GetBytes(got, "messages.0.content.0.source.media_type").String()
+	data, err := base64.StdEncoding.DecodeString(gjson.GetBytes(got, "messages.0.content.0.source.data").String())
+	if err != nil {
+		t.Fatalf("data: %v", err)
+	}
+	if mt != "image/jpeg" && mt != "image/png" {
+		t.Fatalf("media type %q, want a written-again picture", mt)
+	}
+	if len(data) > 4 && !bytes.HasPrefix(data, []byte{0xff, 0xd8}) && !bytes.HasPrefix(data, []byte("\x89PNG")) {
+		t.Fatalf("data is neither a JPEG nor a PNG: %x", data[:8])
+	}
+	if bytes.Contains(got, []byte(webpShot)) {
+		t.Fatalf("the webp is still there: %s", got)
+	}
+	if same := webpAsJPEG(provider.Anthropic, []byte(chatReq)); !bytes.Equal(same, []byte(chatReq)) {
+		t.Fatalf("a request with no webp was changed: %s", same)
+	}
+	if mayHoldWebP([]byte(chatReq)) {
+		t.Fatal("mayHoldWebP saw a webp in a plain text request")
+	}
+}
-- 
2.50.1 (Apple Git-155)

```

</details>
