package gateway

// Local verification evidence for issue #3566 (typed $ref target holding an
// untyped object oneOf still reaches Kimi untyped and is refused 400
// "detected infinite recursion without termination condition"). These tests
// are written by the verification lane; they are not part of the racer's
// branch and are not meant for upstream. They pin the mechanism: the
// recursion into typed $ref targets, its boundaries (pure $refs, $ref-with-
// notes chains, anyOf parents, self-refs stay untouched), and that the
// caller's bytes are not modified.

import (
	"bytes"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/tidwall/gjson"
	"github.com/yetone/magpie/internal/provider"
)

// verify3566Kimi serves the schema to a fake kimi-code-cn upstream through
// the real gateway handler and returns tools.0.function.parameters as it
// was sent.
func verify3566Kimi(t *testing.T, schema string) gjson.Result {
	t.Helper()
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	t.Setenv("XDG_CACHE_HOME", t.TempDir())
	kimi, err := provider.FromPreset("kimi-code-cn")
	if err != nil {
		t.Fatal(err)
	}
	kimi.ID, kimi.Key, kimi.Models = "kimi", "k", []string{"m"}
	if err := provider.Save(kimi); err != nil {
		t.Fatal(err)
	}
	got := ""
	s := New()
	s.client = &http.Client{Transport: countTransport(func(r *http.Request) (*http.Response, error) {
		b, _ := io.ReadAll(r.Body)
		got = string(b)
		return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": {"application/json"}},
			Body: io.NopCloser(strings.NewReader(`{"id":"c","object":"chat.completion","model":"m","choices":[{"index":0,"message":{"role":"assistant","content":"ok"},"finish_reason":"stop"}]}`))}, nil
	})}
	body := `{"model":"kimi/m","messages":[{"role":"user","content":"hi"}],` +
		`"tools":[{"type":"function","function":{"name":"probe","description":"Diagnostic placeholder.","parameters":` + schema + `}}]}`
	rec := httptest.NewRecorder()
	s.Handler().ServeHTTP(rec, httptest.NewRequest("POST", "/v1/chat/completions", strings.NewReader(body)))
	if rec.Code != 200 {
		t.Fatalf("%d %s", rec.Code, rec.Body)
	}
	if got == "" {
		t.Fatal("nothing was sent to Kimi")
	}
	if !gjson.Valid(got) {
		t.Fatalf("invalid JSON sent:\n%s", got)
	}
	sent := gjson.Get(got, "tools.0.function.parameters")
	if !sent.Exists() {
		t.Fatalf("no parameters were sent:\n%s", got)
	}
	return sent
}

// The reporter's minimal repro: the $ref target X is typed, and inside it
// y is an untyped oneOf of two object branches. The fix writes
// "type":"object" into y; X and everything else go as they were. On the
// unfixed tree y goes out without a type, which is what Kimi refuses.
func TestVerify3566TypedRefTargetWithUntypedObjectOneOf(t *testing.T) {
	y := `{"oneOf":[{"type":"object","properties":{"mode":{"type":"string","const":"a"}}},{"type":"object","properties":{"mode":{"type":"string","const":"b"}}}]}`
	schema := `{"type":"object","properties":{"x":{"$ref":"#/$defs/X"}},` +
		`"$defs":{"X":{"type":"object","properties":{"y":` + y + `},"required":["y"]}}}`
	sent := verify3566Kimi(t, schema)
	gotY := sent.Get(`$defs.X.properties.y`)
	if !gotY.Exists() {
		t.Fatalf("y is gone:\n%s", sent)
	}
	want := `{"type":"object",` + strings.TrimPrefix(y, `{`)
	if gotY.Raw != want {
		t.Errorf("y was sent:\n%s\nwant:\n%s", gotY.Raw, want)
	}
	def := sent.Get(`$defs.X`)
	if !def.Exists() || !strings.HasPrefix(def.Raw, `{"type":"object","properties"`) {
		t.Errorf("X was rewritten:\n%s", sent)
	}
}

// The caller's bytes are not modified: a rebuilt body comes back, the
// argument is left as it was.
func TestVerify3566RefTypesLeavesItsInput(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	t.Setenv("XDG_CACHE_HOME", t.TempDir())
	p, err := provider.FromPreset("kimi-code-cn")
	if err != nil {
		t.Fatal(err)
	}
	schema := `{"type":"object","properties":{"x":{"$ref":"#/$defs/X"}},` +
		`"$defs":{"X":{"type":"object","properties":{"y":{"oneOf":[{"type":"object","properties":{"mode":{"type":"string","const":"a"}}},{"type":"object","properties":{"mode":{"type":"string","const":"b"}}}]}}}}`
	body := []byte(`{"model":"m","tools":[{"type":"function","function":{"name":"probe","parameters":` + schema + `}}]}`)
	before := bytes.Clone(body)
	out := kimiToolRefTypes(p, provider.Chat, body)
	if !gjson.Get(string(out), `tools.0.function.parameters.$defs.X.properties.y.type`).Exists() {
		t.Errorf("no type was written into y:\n%s", out)
	}
	if !bytes.Equal(body, before) {
		t.Errorf("the input body was modified:\n%s", body)
	}
}

// Boundaries of the recursion into a typed $ref target: pure $refs, a
// $ref beside notes (#3205's shape), an anyOf parent, a self-ref and
// typed branches stay untouched; an untyped object/string oneOf gets the
// type array; a oneOf whose branches are refs to typed objects resolves
// through them; and nothing anywhere goes out with a type beside a $ref.
func TestVerify3566BoundariesInsideTypedTarget(t *testing.T) {
	schema := `{"type":"object","properties":{"x":{"$ref":"#/$defs/X"}},` +
		`"$defs":{"X":{"type":"object","properties":{` +
		`"pure":{"$ref":"#/$defs/P"},` +
		`"noted":{"format":"uuid","description":"tt","$ref":"#/$defs/S"},` +
		`"u":{"anyOf":[{"type":"string"},{"$ref":"#/$defs/P"}]},` +
		`"mix":{"oneOf":[{"type":"object","properties":{"a":{"type":"string"}}},{"type":"string"}]},` +
		`"cyc":{"$ref":"#/$defs/X"},` +
		`"branchref":{"oneOf":[{"$ref":"#/$defs/P"},{"$ref":"#/$defs/Q"}]}` +
		`}},` +
		`"P":{"type":"object","properties":{"p":{"type":"string"}}},` +
		`"Q":{"type":"object","properties":{"q":{"type":"string"}}},` +
		`"S":{"type":"string"}}}`
	sent := verify3566Kimi(t, schema)
	if got := sent.Get(`$defs.X.properties.pure`).Raw; got != `{"$ref":"#/$defs/P"}` {
		t.Errorf("pure $ref was rewritten:\n%s", got)
	}
	if got := sent.Get(`$defs.X.properties.noted`).Raw; got != `{"format":"uuid","description":"tt","$ref":"#/$defs/S"}` {
		t.Errorf("$ref with notes was rewritten:\n%s", got)
	}
	if got := sent.Get(`$defs.X.properties.u`).Raw; !strings.HasPrefix(got, `{"anyOf":`) {
		t.Errorf("anyOf parent was rewritten:\n%s", got)
	}
	if got := sent.Get(`$defs.X.properties.mix`); got.Raw != `{"type":["object","string"],"oneOf":[{"type":"object","properties":{"a":{"type":"string"}}},{"type":"string"}]}` {
		t.Errorf("mixed oneOf was sent:\n%s", got.Raw)
	}
	if got := sent.Get(`$defs.X.properties.cyc`).Raw; got != `{"$ref":"#/$defs/X"}` {
		t.Errorf("self-ref was rewritten:\n%s", got)
	}
	if got := sent.Get(`$defs.X.properties.branchref`); got.Raw != `{"type":"object","oneOf":[{"$ref":"#/$defs/P"},{"$ref":"#/$defs/Q"}]}` {
		t.Errorf("ref-branch oneOf was sent:\n%s", got.Raw)
	}
	var besideRef []string
	walkSchema(sent, func(s gjson.Result) {
		if s.Get("type").Exists() && s.Get(`\$ref`).Type == gjson.String {
			besideRef = append(besideRef, s.Raw)
		}
	})
	if len(besideRef) > 0 {
		t.Errorf("a type went out beside a $ref, refused 400 \"when using $ref, type should be defined in the referenced schema instead of the parent schema\":\n%s",
			strings.Join(besideRef, "\n"))
	}
}
