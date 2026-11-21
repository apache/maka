package budget

// Judgment evidence for #4586: can a torn (partially written) ledger line
// make a key over its token cap read as no use? The standard
// (docs/code-standards.md) says a key limit fails closed when its file
// can't be read; this test pins the observable behavior on clean main.

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/yetone/magpie/internal/access"
	"github.com/yetone/magpie/internal/catalog"
	"github.com/yetone/magpie/internal/usage"
)

func TestReserveRefusesWhenLedgerLineIsTorn(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	t.Setenv("XDG_CONFIG_HOME", filepath.Join(home, ".config"))
	t.Setenv("XDG_CACHE_HOME", filepath.Join(home, ".cache"))
	catalog.Reset()
	t.Cleanup(catalog.Reset)

	if _, err := access.Update("add-key", access.Change{Name: "Cap"}); err != nil {
		t.Fatal(err)
	}
	ks, err := access.List()
	if err != nil {
		t.Fatal(err)
	}
	k := ks[0]
	if _, err := access.Update("limit-key", access.Change{Key: k.ID, Limit: &access.Limit{Period: "day", Tokens: 500}}); err != nil {
		t.Fatal(err)
	}
	ks, err = access.List()
	if err != nil {
		t.Fatal(err)
	}
	k = ks[0]
	who := access.Identity{KeyID: k.ID, KeyName: k.Name, Limit: k.Limit, More: k.More}
	now := time.Now()

	Append(usage.Record{Time: now, Input: 800, Status: 200, CallerKeyID: k.ID})
	if _, refused := Reserve(who, -1, "", now); refused == nil {
		t.Fatal("sanity: 800 tokens of a 500 cap is let in even with an intact ledger")
	}

	// a torn write: half of the record's line survives, the parser cannot
	// decode it, and the call it recorded is gone
	p := usage.Path()
	b, err := os.ReadFile(p)
	if err != nil {
		t.Fatal(err)
	}
	s := string(b)
	last := strings.LastIndexByte(s, '\n')
	if last <= 0 {
		t.Fatalf("no complete line in %s", p)
	}
	prev := strings.LastIndexByte(s[:last], '\n')
	line := s[prev+1 : last]
	if err := os.WriteFile(p, []byte(s[:prev+1]+line[:len(line)/2]), 0o644); err != nil {
		t.Fatal(err)
	}

	Forget() // a restart would forget too; the next read reparses the file
	_, refused := Reserve(who, -1, "", now)
	if refused == nil {
		t.Fatal("a torn ledger line reads as no use: a key over its cap is let in")
	}
}
