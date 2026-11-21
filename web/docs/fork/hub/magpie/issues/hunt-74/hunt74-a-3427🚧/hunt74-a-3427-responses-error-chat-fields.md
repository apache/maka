# hunt74-a — issue #3427: Responses-to-Chat translation drops `code` and `param` from standard SSE error events

## Summary

A Responses stream's `error` event carries its `code` and `param` on itself (the documented shape has no nested `error` object), and `responsesDecoder` only fed Said from `requestRefused`/`filterRefused`, which both read an `error` object or a safety refusal — so a Chat client got the translated error with `type: "api_error"` and the message, and nothing else, while a Responses client had the fields, its stream relayed as it came.

## What changed

- `internal/gateway/responses.go`, `case "error"` of `responsesDecoder.decode`: when neither `requestRefused` (400 `invalid_request_error`) nor `filterRefused` (safety refusal) classified the event, the event's own top-level `code` and `param` (string, non-empty) now go as the `Event`'s `Said` via the new `flatErrorSaid` helper. The Chat, Anthropic and Responses encoders already write what Said carries on the error they produce (`saidError`), so the translated Chat envelope gains exactly the fields the vendor said: `{"error":{"message":…,"type":"api_error","code":"invalid_prompt","param":"input"}}`. Fields the event does not name are left out, not invented (missing `code`/`param` produce no empty strings).
- `internal/gateway/responses_flat_error_test.go`: regression test with a synthetic upstream emitting the documented flat error event; the `/v1/responses` controls (relayed, fields preserved) and the translated `/v1/chat/completions` cases (fields were dropped) share one table.

Classification is untouched by construction: `requestRefused` and `filterRefused` keep their precedence (an event whose code or message is the safety filter's is still intercepted by `filterRefused` first, and an `invalid_request_error` object still comes back 400 from `requestRefused` first, both carrying their own Said); `flatErrorSaid` only fills the gap where both returned nothing, and it sets no `Status` and no error `type`, so the hold, the rests and the encoders' default `api_error` type read exactly as before.

## Verification

| Check | Result |
| --- | --- |
| `go test -tags nogui -run '^TestResponsesFlatErrorDiagnostics$' -v ./internal/gateway/` (after the fix) | 4/4 pass |
| same command, product file reverted to dd1e8822 (test kept) | 2 chat cases red on the missing `code`/`param`, 2 responses controls green; file restored, 4/4 green again |
| `go test -race -tags nogui -run '^TestResponsesFlatErrorDiagnostics$' -count=3 ./internal/gateway/` | pass, 3 runs |
| `go test -tags nogui ./internal/gateway/` | ok 360.7s |
| `go vet ./...` | exit 0 (pre-existing cgo warning in `internal/gui` only, not from this change) |
| `GOOS=linux go vet -tags nogui ./...` | exit 0 |
| `GOOS=windows go vet ./...` | exit 0 |
| `go build -tags nogui` (darwin/arm64) | exit 0 |
| `GOOS=linux go build -tags nogui` | exit 0 |
| `GOOS=windows go build` | exit 0 |
| `gofmt -l` on the touched files | empty |

## Nothing else changed

Every other place a Chat-shaped error envelope is built was checked and left alone: `writeErrorSaid`/`writeVendorError` (whole replies) already carry the vendor's `code`/`param` when the caller hands them the vendor body, and the translated whole path now does exactly that, since the collector's `errSaid` is populated for flat errors too; `streamError` (magpie's own mid-stream errors) builds its Event without a Said and is untouched; the `requestRefused` and `filterRefused` envelopes are kept as they are, with precedence over the flat fields; the `response.failed` decoder branch is untouched (its diagnostics live in `response.error`, which the issue's fixtures do not exercise). No behavior of the hold, the rests or the continuation changes: the fix sets neither `Event.Code` nor `Event.Status`, so stream-continuation holding (`ev.Code == ""`) and failure classification (`failure`/`failureOf`/`lateRests`, `holdWriter.settle`, `streamEvent`) read the same words and statuses as before.

**Attribution**: AI-written; I've read the whole diff and the tests pass. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`.

<details><summary>patch: responses-error-chat-fields (#3427) — git am applies it as is; SHA-256 first 16: 70963d925dafd41f</summary>

```text
From c3362fe140f347678caf2ae7bcdb3ae3f3249c4f Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Sat, 24 Oct 2026 09:46:40 +0800
Subject: [PATCH] gateway: a Responses error event's own code and param survive
 a translation to Chat
MIME-Version: 1.0
Content-Type: text/plain; charset=UTF-8
Content-Transfer-Encoding: 8bit

What changed: a Responses stream's error event carries its code and param
on itself, as the documented one does, with no error object beside them.
The decoder's event reads only a nested error's message and the top-level
message, and Said comes from requestRefused and filterRefused alone, both
of which read an error object (or a safety refusal) — so the flat event's
code and param never reached the Event, and a client translated to Chat
got the message with "api_error" and nothing else, while a client of the
Responses API had them, its stream relayed as it came. When neither
classification names the event, the flat code and param now go as the
Event's Said, which the Chat, Anthropic and Responses encoders already
write on the error they produce; missing fields are left out, not
invented. An event whose code or message is the safety filter's is still
asked of filterRefused first, and a 400 invalid_request_error still comes
from requestRefused first, so what the hold and the rests read of an
error is as it was; only the envelope a client is told gains the fields
the vendor said.

Run:
  go test -tags nogui -run '^TestResponsesFlatErrorDiagnostics$' -v ./internal/gateway/  (4/4 pass; the two chat cases failed on the missing code and param before the fix, the two responses controls passed throughout)
  go test -race -tags nogui -run '^TestResponsesFlatErrorDiagnostics$' -count=3 ./internal/gateway/  (pass)
  go test -tags nogui ./internal/gateway/  (pass)
  go vet ./... && GOOS=linux go vet -tags nogui ./... && GOOS=windows go vet ./...  (pass)
  go build for darwin/arm64, linux (nogui) and windows  (pass)
  gofmt -l on the touched files  (empty)

Generated-by: GLM-5.3-Flash (ZCode)
---
 internal/gateway/responses.go                 | 25 +++++++
 internal/gateway/responses_flat_error_test.go | 66 +++++++++++++++++++
 2 files changed, 91 insertions(+)
 create mode 100644 internal/gateway/responses_flat_error_test.go

diff --git a/internal/gateway/responses.go b/internal/gateway/responses.go
index 64f58670..5b253965 100644
--- a/internal/gateway/responses.go
+++ b/internal/gateway/responses.go
@@ -1616,11 +1616,36 @@ func (d *responsesDecoder) decode(data string, emit func(Event)) error {
 		if status == 0 {
 			status, said = fs, fsaid
 		}
+		if said == nil {
+			said = flatErrorSaid(data)
+		}
 		emit(Event{Kind: KError, Text: cmp.Or(msg, streamErrorText(data)), Code: code, Status: status, Said: said})
 	}
 	return nil
 }
 
+// flatErrorSaid is a Responses stream's error event that carries its code
+// and param on itself, as the documented one does, where requestRefused
+// and filterRefused read no error object to carry them: the fields go as
+// an Event's Said, for a translation to keep them as they were said
+// (#3427). Nil when the event names neither, so none is invented.
+func flatErrorSaid(data string) json.RawMessage {
+	var said map[string]string
+	for _, k := range []string{"code", "param"} {
+		if v := gjson.Get(data, k); v.Type == gjson.String && v.String() != "" {
+			if said == nil {
+				said = map[string]string{}
+			}
+			said[k] = v.String()
+		}
+	}
+	if said == nil {
+		return nil
+	}
+	b, _ := json.Marshal(map[string]any{"error": said})
+	return b
+}
+
 // requestRefused is 400 and the vendor's error, as {"error":{…}}, when a
 // Responses stream's error event or failed response says the request
 // itself is at fault (type invalid_request_error): the ChatGPT backend
diff --git a/internal/gateway/responses_flat_error_test.go b/internal/gateway/responses_flat_error_test.go
new file mode 100644
index 00000000..b659de19
--- /dev/null
+++ b/internal/gateway/responses_flat_error_test.go
@@ -0,0 +1,66 @@
+package gateway
+
+import (
+	"encoding/json"
+	"net/http/httptest"
+	"strings"
+	"testing"
+
+	"github.com/tidwall/gjson"
+	"github.com/yetone/magpie/internal/provider"
+)
+
+// A Responses stream's error event carries its code and param on itself,
+// as the documented one does. A client of the Responses API has them as
+// the upstream said them; one of Chat, translated, has them beside the
+// message in its error, not the type alone (#3427).
+func TestResponsesFlatErrorDiagnostics(t *testing.T) {
+	for _, fixture := range []struct {
+		name, code, message string
+		param               any
+	}{
+		{"documented_example", "ERR_SOMETHING", "Something went wrong", nil},
+		{"parameter", "invalid_prompt", "The input is invalid.", "input"},
+	} {
+		for _, chat := range []bool{false, true} {
+			route := "responses"
+			if chat {
+				route = "chat"
+			}
+			t.Run(fixture.name+"/"+route, func(t *testing.T) {
+				data, _ := json.Marshal(map[string]any{
+					"type": "error", "sequence_number": 1,
+					"code": fixture.code, "message": fixture.message, "param": fixture.param,
+				})
+				setup(t, provider.Responses, &fake{t: t, reply: "event: error\ndata: " + string(data) + "\n\n"})
+				endpoint, body := "/v1/responses", `{"model":"fake/m1","stream":true,"input":"Hello."}`
+				if chat {
+					endpoint, body = "/v1/chat/completions", `{"model":"fake/m1","stream":true,"messages":[{"role":"user","content":"Hello."}]}`
+				}
+				rec := httptest.NewRecorder()
+				New().Handler().ServeHTTP(rec, httptest.NewRequest("POST", endpoint, strings.NewReader(body)))
+				var failure gjson.Result
+				if err := readSSE(strings.NewReader(rec.Body.String()), func(_, data string) error {
+					e := gjson.Parse(data)
+					if e.Get("error").IsObject() {
+						failure = e.Get("error")
+					} else if e.Get("type").String() == "error" {
+						failure = e
+					}
+					return nil
+				}); err != nil {
+					t.Fatal(err)
+				}
+				if failure.Get("message").String() != fixture.message {
+					t.Fatalf("error message missing: %s", rec.Body)
+				}
+				if failure.Get("code").String() != fixture.code {
+					t.Errorf("code lost: %s", failure.Raw)
+				}
+				if fixture.param != nil && failure.Get("param").String() != fixture.param {
+					t.Errorf("param lost: %s", failure.Raw)
+				}
+			})
+		}
+	}
+}
-- 
2.50.1 (Apple Git-155)

```

</details>

Branch with the commit: [hunt74-a-responses-error-chat-fields](https://github.com/ggbdpq/magpie/tree/hunt74-a-responses-error-chat-fields) (head `c3362fe140f347678caf2ae7bcdb3ae3f3249c4f`).
