package pii

import (
	"archive/zip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// seed copies a pre-fetched artifact from cache to where magpie looks
// for it.
func seed(t *testing.T, name, to, cache string) {
	t.Helper()
	src, err := os.Open(filepath.Join(cache, name))
	if err != nil {
		t.Fatalf("pre-fetched %s: %v", name, err)
	}
	defer src.Close()
	if err := os.MkdirAll(filepath.Dir(to), 0o755); err != nil {
		t.Fatal(err)
	}
	dst, err := os.Create(to)
	if err != nil {
		t.Fatal(err)
	}
	defer dst.Close()
	if _, err := io.Copy(dst, src); err != nil {
		t.Fatal(err)
	}
}

// realCache is where the pre-fetched artifacts live. It is resolved at
// package init, before testenv's TestMain isolates HOME into a temporary
// folder the test's own folder is inside.
var realCache = func() string {
	if p := os.Getenv("PII_REAL_CACHE"); p != "" {
		return p
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return ".cache/magpie-real-accept"
	}
	return filepath.Join(home, ".cache", "magpie-real-accept")
}()

// TestRealModelColdStartAndSlowCPU is the real-resource acceptance run for
// #3682's follow-up (handbook rule 15: a real model, a cold start, and
// concurrent requests). Skipped unless PII_REAL=1: it runs the real model
// for minutes on the CPU. pf-serve and the model come from realCache,
// fetched once by hand — the release downloads are slow on some networks
// — and are checked against the same pins install checks.
func TestRealModelColdStartAndSlowCPU(t *testing.T) {
	if os.Getenv("PII_REAL") == "" {
		t.Skip("real-resource acceptance: set PII_REAL=1 to run the real model")
	}
	cache := realCache

	// phase 0: seed magpie's folder from the pre-fetched artifacts, each
	// checked against the pin install checks them by.
	check := func(name, path, want string) {
		t.Helper()
		f, err := os.Open(path)
		if err != nil {
			t.Fatalf("pre-fetched %s: %v", name, err)
		}
		defer f.Close()
		h := sha256.New()
		io.Copy(h, f)
		if got := hex.EncodeToString(h.Sum(nil)); got != want {
			t.Fatalf("pre-fetched %s is %s, want %s", name, got, want)
		}
	}
	model := filepath.Join(dir(), "privacy-filter-q8-"+modelSHA[:12]+".gguf")
	zipPath := filepath.Join(dir(), serveTag+"-"+target()+".zip")
	check("the model", filepath.Join(cache, "privacy-filter-q8.gguf"), modelSHA)
	check("pf-serve's zip", filepath.Join(cache, "pf-serve-darwin-arm64.zip"), serveSHA[target()])
	seed(t, "privacy-filter-q8.gguf", model, cache)
	seed(t, "pf-serve-darwin-arm64.zip", zipPath, cache)
	zr, err := zip.OpenReader(zipPath)
	if err != nil {
		t.Fatal(err)
	}
	defer zr.Close()
	os.MkdirAll(serveDir(), 0o755)
	for _, f := range zr.File {
		if f.FileInfo().IsDir() {
			continue
		}
		out, err := os.OpenFile(filepath.Join(serveDir(), filepath.Base(f.Name)), os.O_CREATE|os.O_TRUNC|os.O_WRONLY, f.Mode())
		if err != nil {
			t.Fatal(err)
		}
		src, err := f.Open()
		if err != nil {
			t.Fatal(err)
		}
		io.Copy(out, src)
		src.Close()
		out.Close()
	}
	if _, err := os.Stat(exe("pf-serve")); err != nil {
		t.Fatalf("pf-serve is not where ensureServe looks for it: %v", err)
	}
	// the product's own pass over what is on disk: the model is the size
	// its pin says, pf-serve is where ensureServe left it, so nothing is
	// fetched and the bookkeeping is exercised as in production.
	dl := make(chan error, 1)
	if err := Download(func() { dl <- nil }); err != nil {
		t.Fatalf("download: %v", err)
	}
	select {
	case err := <-dl:
		if err != nil {
			t.Fatalf("download: %v", err)
		}
	case <-time.After(5 * time.Minute):
		t.Fatal("the seeded install took over 5 minutes")
	}
	if !Installed() {
		t.Fatal("pf-serve is not on disk")
	}
	t.Log("pf-serve and the model are on disk")

	// a history past the ~65 KB a CPU can't read in one call: 30 turns of
	// 8 KB, 240 KB together
	texts := make([]string, 30)
	for i := range texts {
		texts[i] = fmt.Sprintf("turn %02d: Alice met Bob to discuss the plans; they wrote about budgets, schedules, and the rest of it. ", i) +
			strings.Repeat("More of the conversation went back and forth about the same. ", 145)
	}

	// phase 1: a cold start with requests already knocking — the
	// incident's shape. Every request must come back, none lost.
	var wg sync.WaitGroup
	answers := make(chan error, 3)
	started := time.Now()
	wg.Add(3)
	go func() { defer wg.Done(); _, err := FindContext(context.Background(), texts); answers <- err }()
	time.Sleep(300 * time.Millisecond) // the load and the queue are under way
	st := Now()
	t.Logf("status during the load: running=%v loading=%v device=%q waiting=%d", st.Running, st.Loading, st.Device, st.Waiting)
	go func() { defer wg.Done(); _, err := FindContext(context.Background(), texts[:10]); answers <- err }()
	go func() { defer wg.Done(); _, err := FindContext(context.Background(), texts[10:]); answers <- err }()
	wg.Wait()
	for i := 0; i < 3; i++ {
		if err := <-answers; err != nil {
			t.Fatalf("request %d failed in the cold start: %v", i, err)
		}
	}
	t.Logf("phase 1, cold start + 3 requests over the same 240 KB: %s", time.Since(started).Round(time.Millisecond))

	// phase 2: a true restart, then the CPU's real reading speed
	// (1.4 KB a second, per cebd0d4c's run) on the same 240 KB. With
	// PF_DEVICE=cpu in the test's env, the Metal candidate reports CPU
	// and outlasts its 40s budget, so the real CPU candidate serves —
	// the production GPU-hung-then-CPU flow. Before the fix the whole
	// history went in one call (budget 30s+240/4=88.6s, the read taking
	// ~171s) and was ended with nothing kept; a chunk at a time each
	// chunk's budget (33s) outruns its 8.6s read, and every chunk is
	// kept as it is answered.
	restart(t)
	t.Setenv("PF_DEVICE", "cpu")
	t0 := time.Now()
	done := make(chan error, 1)
	go func() { _, err := FindContext(context.Background(), texts); done <- err }()
	last := -1
	tick := time.NewTicker(20 * time.Second)
	defer tick.Stop()
	for {
		select {
		case err := <-done:
			if err != nil {
				t.Fatalf("the CPU's read of the whole history failed: %v", err)
			}
			t.Logf("phase 2, the CPU read 240 KB through: %s", time.Since(t0).Round(time.Second))
			goto kept
		case <-tick.C:
			_, miss := cached(texts)
			if len(miss) != last {
				t.Logf("at %s: %d/%d kept", time.Since(t0).Round(time.Second), len(texts)-len(miss), len(texts))
				last = len(miss)
			}
		}
	}
kept:
	if _, miss := cached(texts); len(miss) != 0 {
		t.Fatalf("%d texts are missing from the cache", len(miss))
	}
	// the same texts again: everything is in the cache, nothing is read
	t1 := time.Now()
	if _, err := Find(texts); err != nil {
		t.Fatal(err)
	}
	if time.Since(t1) > 2*time.Second {
		t.Fatalf("a cache-only read took %s", time.Since(t1).Round(time.Millisecond))
	}
	t.Logf("the cache-only read took %s", time.Since(t1).Round(time.Millisecond))
}
