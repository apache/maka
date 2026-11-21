package gateway

import (
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/yetone/magpie/internal/access"
	"github.com/yetone/magpie/internal/budget"
	"github.com/yetone/magpie/internal/provider"
	"github.com/yetone/magpie/internal/usage"
)

// Lane B's independent check of #5912 (verification only, no fix here):
// a routing group's classifier is asked with no caller on its context, so
// its ask is neither held to the turn's gateway key's limit nor recorded
// under that key.

// keyedPost posts body to path on s with the gateway key secret.
func keyedPost(s *Server, secret, path, body string) (int, string) {
	rec := httptest.NewRecorder()
	req := httptest.NewRequest("POST", path, strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+secret)
	s.Handler().ServeHTTP(rec, req)
	return rec.Code, rec.Body.String()
}

// The turn's classifier ask should be recorded under the turn's key, so a
// key's usage shows what the group spent deciding where the turn goes.
func TestLaneBClassifierAskRecordedUnderTheTurnsKey(t *testing.T) {
	fresh(t)
	s, _, _, c := intented(t, provider.Rule{Use: "b/big", Intent: "writing or fixing tests"})
	c.set("1", 0)
	keys, secrets := newCaller(t, "Work")
	if code, out := keyedPost(s, secrets[0], "/v1/chat/completions", chat("add a unit test for the parser", nil, 0, "")); code != 200 {
		t.Fatalf("the turn: %d %s", code, out)
	}
	var under []usage.Record
	for _, r := range usage.Load(time.Now().Add(-time.Hour)) {
		if r.Provider == "c" {
			under = append(under, r)
		}
	}
	if len(under) != 1 {
		t.Fatalf("classifier rows: %d (%+v)", len(under), under)
	}
	if under[0].CallerKeyID != keys[0].ID {
		t.Fatalf("the classifier's ask is recorded under caller key %q, want the turn's key %q", under[0].CallerKeyID, keys[0].ID)
	}
}

// A key with nothing left should not have the classifier asked for its
// turn, as keyLimited holds the turn itself.
func TestLaneBKeyLimitHoldsTheClassifiersAsk(t *testing.T) {
	fresh(t)
	s, _, _, c := intented(t, provider.Rule{Use: "b/big", Intent: "writing or fixing tests"})
	c.set("1", 0)
	keys, secrets := newCaller(t, "Capped")
	budget.Forget()
	at := pinLimitClock(t)
	setLimit(t, keys[0].ID, &access.Limit{Period: "day", Tokens: 1000})
	budget.Append(usage.Record{Time: at.Add(-time.Minute), Provider: "a", Model: "small", Input: 999, Status: 200, CallerKeyID: keys[0].ID})
	body := chat("add a unit test for the parser", nil, 0, "")
	code, out := keyedPost(s, secrets[0], "/v1/chat/completions", body)
	if code != 200 {
		t.Fatalf("the capped key's turn: %d %s", code, out)
	}
	if n := c.n(); n != 0 {
		t.Fatalf("the classifier was asked %d times for a key with nothing left: %s", n, out)
	}
}
