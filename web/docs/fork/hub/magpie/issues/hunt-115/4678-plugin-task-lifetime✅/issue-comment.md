The task-lifetime reading is confirmed, and this patch closes it: an ordinary RPC whose caller leaves now tells the host, the host answers the aborted RPC at once instead of waiting out the plugin's I/O, and the plugin hooks that do the vendor reading are handed a signal — a `usage` hook through its own options, a models hook through the same controller its `listWait` deadline aborts. Renewal and its token persistence run before the hooks and are untouched.

**What changed**

- `internal/plugin/host.go`: `call` marked only `gatewayRequest` cancellable, so a caller whose context ended released its call without a word to the host. Every ordinary RPC is now cancellable the way a fetch already was (the existing `callAborting` control write); `init` is the exception, since a start that overruns is stopped whole.
- `internal/plugin/host.js`: the dispatcher registers each ordinary RPC's `AbortController`, answers an aborted RPC at once (`Aborted`) and drops it from `pending`, so the host can leave once nothing real is pending; the handler is handed the signal, `usage` passes it to the plugin's `auth.usage` hook as a third `{ signal }` argument, and a model list's hook options carry a signal that either the caller's giving up or the `listWait` deadline aborts — `inTime` now aborts the controller when its timer fires, so the I/O a deadline gives up on stops too.
- Siblings checked and left alone: fetch (`inflight`) and `gatewayRequest` (`gatewayInflight`) already own cancellation; `init` as above; the other ordinary methods (authorize, callback, load, prompt, ...) get the same early reply and signal argument, which changes nothing for handlers that ignore it — a handler still finishes whatever it saves, only its reply is no longer waited on.

**Run** (macOS arm64, Go 1.26, Bun via testenv; tests in a sandbox home, off the network)

| Check | Result |
|---|---|
| `TestOrdinaryCallCancelTellsTheHost` (new; cancelled usage call → host is written an `abort`, call and slot released) | PASS (fails on the parent commit: "the host was told of the cancellation didn't happen") |
| `TestCancelledUsageReachesThePlugin` (new; stuck plugin's usage hook traces the signal it is handed and the abort arriving) | PASS (fails on the parent: no signal handed) |
| `TestModelListDeadlineTellsTheHook` (new; a models hook whose `listWait` runs out is aborted, not merely raced past) | PASS (fails on the parent: "the deadline aborted the models hook didn't happen") |
| `go test -tags nogui ./internal/plugin/` (full package) | PASS except `TestHostToldTheGatewayAddress`, which fails the same way on the unmodified parent commit (pre-existing on this machine, untouched paths) |
| `go test -race -tags nogui` on the new tests plus the existing cancellation tests (`TestHostCancelAfterHeadStopsTheFetch`, `TestRefreshInvalidationCancelsStaleCall`, `TestRefreshSingleFlight`) | PASS (one data race found and fixed in my own test's call-count read before it was clean) |
| `gofmt -l`, `go vet`, `GOOS=linux go vet -tags nogui`, `GOOS=windows go vet`, `go build` on darwin/linux/windows | all clean |

**Not verified**: no reproduction of the reporter's exact host-script SHA-256 fixture; the verification here is the three tests above against the real host script and a fake plugin, which cover the abort write, the early reply, and the signal reaching both hooks. The pending count a plugin task holds beyond its reply is released only if the plugin honors the signal — one that ignores it still runs to completion, but no longer holds the RPC's `pending` or its caller.

**Attribution**: AI-written; I've read the whole diff and the tests pass. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`.

<details><summary>patch: fix(plugin): end ordinary RPCs' plugin work when their caller leaves (#4678) — git am applies it as is; SHA-256 first 16: be2d11fa6d04dadc</summary>

```
From b2c162d2e07ee7176130b883527beb6cfd45dd00 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Sun, 1 Nov 2026 20:13:42 +0800
Subject: [PATCH] fix(plugin): end ordinary RPCs' plugin work when their caller
 leaves (#4678)

A plugin model list's deadline and an ordinary RPC's cancellation released
only the caller. inTime raced the hook without stopping it, and host.go
marked only gatewayRequest cancellable, so a cancelled usage or providers
call never told the host: the plugin's task kept running, the host's
pending count kept it, and repeated reads left task after task alive past
their callers. Reported with an offline host-script reproduction that
shows abort reaching none of three pending usage tasks and five model
tasks outliving their deadlines.

The cancellation path a fetch and a gateway request already take now
carries ordinary RPCs too:

- host.go marks every call but init cancellable, so a caller whose
  context ends has the host told (the existing callAborting write), the
  way it already tells it of a stopped fetch. init is left alone: a start
  that overruns is stopped whole.
- host.js registers each ordinary RPC's AbortController, answers an
  aborted RPC at once instead of waiting out the handler, and drops it
  from pending, so the host can leave once nothing real is pending.
- the handler is handed the signal: usage passes it to the plugin's
  auth.usage hook as its own options, and a model list's hook options
  carry it, with the listWait deadline aborting the same controller, so
  vendor I/O that supports stopping stops at the deadline or when the
  caller leaves, whichever comes first.

Sign-in renewal and its persistence are untouched: fresh() runs before
the hooks, and an aborted RPC's handler still finishes what it saves.

Fixes #4678

Generated-by: GLM-5.3-Flash (ZCode)
---
 internal/plugin/host.go                   |   8 +-
 internal/plugin/host.js                   |  86 ++++++++++-----
 internal/plugin/plugin_rpc_cancel_test.go | 127 ++++++++++++++++++++++
 internal/plugin/testdata/stuck/index.js   |  29 ++++-
 4 files changed, 220 insertions(+), 30 deletions(-)
 create mode 100644 internal/plugin/plugin_rpc_cancel_test.go

diff --git a/internal/plugin/host.go b/internal/plugin/host.go
index 6aec43968..7007c50de 100644
--- a/internal/plugin/host.go
+++ b/internal/plugin/host.go
@@ -97,7 +97,7 @@ type call struct {
 	// the body's reader takes them: the host's reader queues them without
 	// ever waiting on one request's consumer (see push).
 	stream      bool
-	cancellable bool // a gateway request owns asynchronous I/O, without a stream slot
+	cancellable bool // asynchronous I/O of its own, without a stream slot: an aborted call is told to the host
 	mu          sync.Mutex
 	queue       []message
 	queued      int           // the queued chunks' decoded bytes
@@ -1558,7 +1558,11 @@ func (h *host) call(ctx context.Context, method string, params, out any) error {
 		return err
 	}
 	c.mu.Lock()
-	c.cancellable = method == "gatewayRequest"
+	// An ordinary RPC is cancellable too: a caller whose context ends has
+	// the host told, so its plugin work is not left running unseen (#4678).
+	// init is the exception: a start that overruns is stopped whole, and
+	// aborting it would only interrupt its own load.
+	c.cancellable = method != "init"
 	c.mu.Unlock()
 	if err := h.enqueueCall(ctx, map[string]any{"id": id, "method": method, "params": params}, nil, c); err != nil {
 		c.settle(err)
diff --git a/internal/plugin/host.js b/internal/plugin/host.js
index 8085a2612..f8b6c3a9c 100644
--- a/internal/plugin/host.js
+++ b/internal/plugin/host.js
@@ -355,12 +355,17 @@ let listWait = 20 * 1000
 
 // late is what a step that took longer than ms gives instead of its own
 // result: an error saying so. The step goes on by itself; what it gives
-// later is dropped.
+// later is dropped. A step handed a signal of its own (a model hook's) has
+// its controller aborted here, so the I/O a deadline gives up on stops too
+// rather than waiting for a caller that has moved on (#4678).
 class Late extends Error {}
-function inTime(step, ms, what) {
+function inTime(step, ms, what, ctl) {
   let timer
   const late = new Promise((_, no) => {
-    timer = setTimeout(() => no(Object.assign(new Late(`${what} didn't finish in ${Math.round(ms / 1000)}s`), { plain: true })), ms)
+    timer = setTimeout(() => {
+      ctl?.abort()
+      no(Object.assign(new Late(`${what} didn't finish in ${Math.round(ms / 1000)}s`), { plain: true }))
+    }, ms)
   })
   return Promise.race([Promise.resolve().then(step), late]).finally(() => clearTimeout(timer))
 }
@@ -1760,8 +1765,10 @@ function fromModelsDev(p, m) {
 // provider.models hook.
 // info is what OpenCode knows of provider id, its models as the plugin
 // lists them for account key (the first when none); strict fails where the
-// plugin's list does, rather than keeping the list it was given.
-async function info(id, key, strict, limit) {
+// plugin's list does, rather than keeping the list it was given. The
+// listing's caller may give up (signal), which a hook is told through its
+// own options' signal too (#4678).
+async function info(id, key, strict, limit, signal) {
   const md = mdev()[id]
   const cfg = config.provider?.[id]
   const out = {
@@ -1828,11 +1835,16 @@ async function info(id, key, strict, limit) {
     const began = Date.now()
     await fresh(id, k)
     const all = readAuth()
+    // the hook's own signal: its listWait deadline aborts it, and so does
+    // the listing's caller going away, whichever comes first (#4678)
+    const ctl = new AbortController()
+    if (signal?.aborted) ctl.abort()
+    else signal?.addEventListener("abort", () => ctl.abort(), { once: true })
     try {
       const given = JSON.parse(JSON.stringify(out))
       const l = { tried: false, lastOk: false }
-      const ask = () => listing.run(l, () => inScope(id, k, () => ph.models(given, { auth: authCopy(k) })))
-      const next = limit > 0 ? await inTime(ask, Math.max(limit - (Date.now() - began), 0), "the plugin's model list") : await ask()
+      const ask = () => listing.run(l, () => inScope(id, k, () => ph.models(given, { auth: authCopy(k), signal: ctl.signal })))
+      const next = limit > 0 ? await inTime(ask, Math.max(limit - (Date.now() - began), 0), "the plugin's model list", ctl) : await ask()
       // a hook that asked its vendor, got no list and gave back the one it
       // was given fell back: magpie keeps the list it had, as a built-in
       // whose fetch failed keeps the one it fetched last; so does one that
@@ -1861,7 +1873,9 @@ async function info(id, key, strict, limit) {
       // magpie keeps the one it had, as for one that gave its defaults back
       out.fellBack = true
       out.listError = e?.message ?? String(e)
-      send({ event: "log", level: "error", message: `${h.spec}: provider.models: ${e?.message ?? e}` })
+      // a listing the caller gave up on says its abort itself, not as if
+      // the vendor had failed
+      if (!ctl.signal.aborted) send({ event: "log", level: "error", message: `${h.spec}: provider.models: ${e?.message ?? e}` })
     }
   }
   for (const [k, m] of Object.entries(cfg?.models ?? {})) if (m?.disabled) delete out.models[k]
@@ -2066,8 +2080,11 @@ function tiersOf(v) {
 
 // providers lists each provider and its accounts' models, each asked
 // through its proxy (proxies[provider][key], "" the provider's own), as a
-// built-in fetches each account's list through the account's.
-async function providers({ proxies } = {}) {
+// built-in fetches each account's list through the account's. A caller
+// that gave up (signal) has every hook it would still have asked told, so
+// a timed-out listing stops its vendor reads instead of multiplying them
+// (#4678).
+async function providers({ proxies } = {}, signal) {
   const stored = readAuth()
   // every provider is listed side by side, each models hook given
   // listWait: one whose vendor is stuck holds up no other's row
@@ -2080,12 +2097,12 @@ async function providers({ proxies } = {}) {
     // listWaits back to back took one provider past refreshDeadline twice
     // over (#4065)
     const [p, own] = await Promise.all([
-      via.run(through(), () => info(id, undefined, false, listWait)).then((q) => (keepInfo(keys[0] ?? id, q, gen), q)),
+      via.run(through(), () => info(id, undefined, false, listWait, signal)).then((q) => (keepInfo(keys[0] ?? id, q, gen), q)),
       // each account's own models, as the built-ins read each account's: a
       // plan may serve fewer, or others, than the first account's. One that
       // can't be read is taken to have them all, or the ones it was last
       // told to have, as a built-in account whose fetch failed keeps its own.
-      Promise.all(keys.slice(1).map((k) => via.run(through(k), () => info(id, k, true, listWait)).then((q) => (keepInfo(k, q, gen), q)).catch((e) => ({ failed: true, listError: e?.message ?? String(e) })))),
+      Promise.all(keys.slice(1).map((k) => via.run(through(k), () => info(id, k, true, listWait, signal)).then((q) => (keepInfo(k, q, gen), q)).catch((e) => ({ failed: true, listError: e?.message ?? String(e) })))),
     ])
     const models = { ...p.models }
     for (const q of own) for (const [k, m] of Object.entries(q?.models ?? {})) models[k] ??= m
@@ -2531,18 +2548,20 @@ async function load({ provider, account, proxy }) {
 //       a clean read clears it)
 //   }
 // Run in the account's scope, a token it renews is saved to that account.
-async function usage({ provider, account, proxy }) {
-  return via.run(proxy ?? "", () => usageOf(provider, account))
+// A caller that gave up (signal) is what the hook is handed as its own
+// options, so a vendor read that supports stopping stops (#4678).
+async function usage({ provider, account, proxy }, signal) {
+  return via.run(proxy ?? "", () => usageOf(provider, account, signal))
 }
 
-async function usageOf(provider, account) {
+async function usageOf(provider, account, signal) {
   const a = auths().get(provider)?.auth
   if (typeof a?.usage !== "function") throw new Error(`${provider}'s plugin doesn't tell its usage`)
   const key = accountKey(provider, account)
   if (!readAuth()[key]) throw new Error("not signed in")
   await fresh(provider, key)
   const p = await infoOf(provider, key)
-  const u = (await inScope(provider, key, () => a.usage(async () => authCopy(key), JSON.parse(JSON.stringify(p))))) ?? {}
+  const u = (await inScope(provider, key, () => a.usage(async () => authCopy(key), JSON.parse(JSON.stringify(p)), signal === undefined ? undefined : { signal }))) ?? {}
   const when = (v) => {
     if (v === undefined || v === null || v === "") return ""
     const d = new Date(typeof v === "number" && v < 1e11 ? v * 1000 : v)
@@ -2783,7 +2802,7 @@ const handlers = {
     await loadPlugins(p.plugins ?? [])
     return { plugins: loaded.map(withProviders) }
   },
-  providers: (p) => providers(p ?? {}),
+  providers: (p, signal) => providers(p ?? {}, signal),
   prompt: async (p) => ({ prompt: await nextPrompt(p.provider, p.method, p.inputs ?? {}) }),
   validate: (p) => ({ error: validate(p.provider, p.method, p.key, p.value) }),
   authorize,
@@ -2808,13 +2827,13 @@ const handlers = {
   // vendor turned the sign-in away. A models hook may fall back to a list
   // it keeps when the vendor can't be reached, so a check that reached
   // none of the places it asked proves nothing, and fails.
-  async check(p) {
+  async check(p, signal) {
     const key = accountKey(p.provider, p.account)
     const r = { reached: false, failed: null, refused: null }
     return via.run(p.proxy ?? "", () => reach.run(r, async () => {
       await load({ provider: p.provider, account: key })
-      const pi = await info(p.provider, key, true)
-      const u = typeof auths().get(p.provider)?.auth?.usage === "function" ? await usageOf(p.provider, key) : null
+      const pi = await info(p.provider, key, true, undefined, signal)
+      const u = typeof auths().get(p.provider)?.auth?.usage === "function" ? await usageOf(p.provider, key, signal) : null
       if (r.failed && !r.reached) throw new Error(`couldn't reach ${pi.name}: ${r.failed?.message ?? r.failed}`)
       return { models: Object.keys(pi.models), usage: u, refused: r.refused ?? "" }
     }))
@@ -2908,6 +2927,7 @@ const done = () => {
 }
 
 const gatewayInflight = new Map() // RPC id -> AbortController
+const rpcInflight = new Map() // an ordinary RPC's id -> its AbortController (#4678)
 const rl = readline.createInterface({ input: process.stdin, terminal: false })
 rl.on("line", (line) => {
   if (!line.trim()) return
@@ -2922,6 +2942,7 @@ rl.on("line", (line) => {
     const record = inflight.get(id)
     if (record) transitionFetch(record, "cancelled")
     gatewayInflight.get(id)?.abort()
+    rpcInflight.get(id)?.abort()
     return
   }
   if (msg.method === "credit") {
@@ -2992,13 +3013,28 @@ rl.on("line", (line) => {
     done()
     return
   }
-  wait
-    .then(() => fn(msg.params ?? {}))
+  // An ordinary RPC owns its cancellation now, as a fetch and a gateway
+  // request do: magpie's abort reaches it here, the answer it gives up on
+  // is sent at once rather than waited out of the plugin's I/O, and the
+  // host may leave once nothing real is pending (#4678). The handler is
+  // handed the signal, so the work that supports stopping stops.
+  const ctl = new AbortController()
+  rpcInflight.set(msg.id, ctl)
+  const answered = wait
+    .then(() => fn(msg.params ?? {}, ctl.signal))
     .then(
-      (result) => send({ id: msg.id, result: result ?? null }),
-      (e) => send({ id: msg.id, error: { message: String(e?.message ?? e) } }),
+      (result) => ({ id: msg.id, result: result ?? null }),
+      (e) => ({ id: msg.id, error: { message: String(e?.message ?? e) } }),
     )
-    .finally(done)
+  const cancelled = new Promise((resolve) =>
+    ctl.signal.addEventListener("abort", () => resolve({ id: msg.id, error: { message: "Aborted" } }), { once: true }),
+  )
+  Promise.race([answered, cancelled])
+    .then((m) => send(m))
+    .finally(() => {
+      rpcInflight.delete(msg.id)
+      done()
+    })
 })
 rl.on("close", () => {
   closed = true
diff --git a/internal/plugin/plugin_rpc_cancel_test.go b/internal/plugin/plugin_rpc_cancel_test.go
new file mode 100644
index 000000000..5de7a7a95
--- /dev/null
+++ b/internal/plugin/plugin_rpc_cancel_test.go
@@ -0,0 +1,127 @@
+package plugin
+
+import (
+	"context"
+	"errors"
+	"os"
+	"path/filepath"
+	"strings"
+	"testing"
+	"time"
+)
+
+// TestOrdinaryCallCancelTellsTheHost: a caller whose context ends while an
+// ordinary RPC is under way has the host told of it, as a fetch's or a
+// gateway request's caller is. Before, only those two kinds were
+// cancellable: the plugin's usage or model work went on unseen, and repeated
+// reads left task after task alive past their callers (#4678).
+func TestOrdinaryCallCancelTellsTheHost(t *testing.T) {
+	f := newFakeHost(t)
+	// the call count is read beside a caller goroutine still admitting, so
+	// it is read under the host's lock
+	liveCalls := func() int {
+		f.mu.Lock()
+		defer f.mu.Unlock()
+		return len(f.host.calls)
+	}
+	ctx, cancel := context.WithCancel(context.Background())
+	waited := make(chan error, 1)
+	go func() {
+		waited <- f.host.call(ctx, "usage", map[string]any{"provider": "fakeco"}, nil)
+	}()
+	waitFor(t, "the usage call reached the host", func() bool { return liveCalls() == 1 })
+	cancel()
+	if err := <-waited; !errors.Is(err, context.Canceled) {
+		t.Fatalf("usage = %v, want canceled", err)
+	}
+	waitFor(t, "the host was told of the cancellation", func() bool {
+		for _, m := range f.methods() {
+			if m == "abort" {
+				return true
+			}
+		}
+		return false
+	})
+	waitFor(t, "the aborted call left the host", func() bool { return liveCalls() == 0 })
+	waitFor(t, "the call's slot came free", func() bool { return f.slotsFree() == cap(f.host.slots) })
+}
+
+// TestCancelledUsageReachesThePlugin: a usage read whose caller gave up has
+// the plugin's own usage hook told as well, through the signal the host
+// hands it, so a vendor read that supports stopping stops instead of waiting
+// out its caller's successor (#4678). The hook traces what it was handed
+// and whether the abort arrived, to a file the test reads.
+func TestCancelledUsageReachesThePlugin(t *testing.T) {
+	sandbox(t)
+	trace := filepath.Join(t.TempDir(), "trace.jsonl")
+	t.Setenv("STUCK_USAGE", "1")
+	t.Setenv("STUCK_TRACE", trace)
+	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
+	defer cancel()
+	abs, err := filepath.Abs("testdata/stuck/index.js")
+	if err != nil {
+		t.Fatal(err)
+	}
+	if _, err := Add(ctx, abs); err != nil {
+		t.Fatal(err)
+	}
+	if _, err := APIKey(ctx, "stuckco", 0, nil, "k-stuckco", NewAccount); err != nil {
+		t.Fatal(err)
+	}
+	uctx, ucancel := context.WithTimeout(context.Background(), time.Second)
+	defer ucancel()
+	if _, err := AccountUsage(uctx, "stuckco", ""); !errors.Is(err, context.DeadlineExceeded) {
+		t.Fatalf("usage = %v, want deadline exceeded", err)
+	}
+	waitFor(t, "the plugin's usage hook was handed a signal", func() bool {
+		b, err := os.ReadFile(trace)
+		return err == nil && strings.Contains(string(b), `"signal":"live"`)
+	})
+	waitFor(t, "the plugin's usage hook saw the abort", func() bool {
+		b, err := os.ReadFile(trace)
+		return err == nil && strings.Contains(string(b), `"aborted":true`)
+	})
+}
+
+// TestModelListDeadlineTellsTheHook: a models hook whose listWait runs out
+// is aborted, not merely raced past — what its vendor read still supports
+// stopping stops, instead of one task waiting behind every timed-out read
+// (#4678). The hook traces the signal it was handed to a file the test
+// reads.
+func TestModelListDeadlineTellsTheHook(t *testing.T) {
+	sandbox(t)
+	stuckWaits(t)
+	trace := filepath.Join(t.TempDir(), "trace.jsonl")
+	t.Setenv("STUCK_MODELS", "1")
+	t.Setenv("STUCK_MODELS_TRACE", "1")
+	t.Setenv("STUCK_TRACE", trace)
+	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
+	defer cancel()
+	abs, err := filepath.Abs("testdata/stuck/index.js")
+	if err != nil {
+		t.Fatal(err)
+	}
+	if _, err := Add(ctx, abs); err != nil {
+		t.Fatal(err)
+	}
+	if _, err := APIKey(ctx, "stuckco", 0, nil, "k-stuckco", NewAccount); err != nil {
+		t.Fatal(err)
+	}
+	lctx, lcancel := context.WithTimeout(context.Background(), 20*time.Second)
+	defer lcancel()
+	ps, err := Providers(lctx)
+	if err != nil || len(ps) != 1 || ps[0].ID != "stuckco" {
+		t.Fatalf("Providers = %+v, %v", ps, err)
+	}
+	if !ps[0].FellBack {
+		t.Fatalf("stuckco listed fellBack=false, want the deadline's fallback")
+	}
+	waitFor(t, "the models hook was handed a signal", func() bool {
+		b, err := os.ReadFile(trace)
+		return err == nil && strings.Contains(string(b), `"signal":"live"`)
+	})
+	waitFor(t, "the deadline aborted the models hook", func() bool {
+		b, err := os.ReadFile(trace)
+		return err == nil && strings.Contains(string(b), `"aborted":true`)
+	})
+}
diff --git a/internal/plugin/testdata/stuck/index.js b/internal/plugin/testdata/stuck/index.js
index 32a043a42..4c72b5254 100644
--- a/internal/plugin/testdata/stuck/index.js
+++ b/internal/plugin/testdata/stuck/index.js
@@ -1,9 +1,24 @@
 // A plugin whose vendor never lets it through, as one whose sign-in is
 // answered 401 and tried again for ever: with $STUCK_LOAD set its plugin
-// function never returns, and with $STUCK_MODELS set its models hook
-// never does.
+// function never returns, with $STUCK_MODELS set its models hook never
+// does, and with $STUCK_USAGE set its usage hook doesn't either — but not
+// before saying what its caller handed it, and whether an abort reaches it,
+// to the file $STUCK_TRACE names (#4678).
 const never = () => new Promise(() => {})
 
+import fs from "node:fs"
+
+// traceUsage says what the host handed the hook: a signal it can listen to,
+// and, later, that the abort arrived, one JSON line each.
+function traceUsage(options) {
+  const signal = options?.signal
+  const live = signal && typeof signal.addEventListener === "function"
+  fs.appendFileSync(process.env.STUCK_TRACE, JSON.stringify({ signal: live ? (signal.aborted ? "aborted" : "live") : "none" }) + "\n")
+  if (live && !signal.aborted) {
+    signal.addEventListener("abort", () => fs.appendFileSync(process.env.STUCK_TRACE, JSON.stringify({ aborted: true }) + "\n"), { once: true })
+  }
+}
+
 export const StuckPlugin = async () => {
   if (process.env.STUCK_LOAD) await never()
   return {
@@ -18,7 +33,8 @@ export const StuckPlugin = async () => {
     },
     provider: {
       id: "stuckco",
-      async models(provider) {
+      async models(provider, options) {
+        if (process.env.STUCK_MODELS_TRACE) traceUsage(options)
         if (process.env.STUCK_MODELS) await never()
         return provider.models
       },
@@ -27,6 +43,13 @@ export const StuckPlugin = async () => {
       provider: "stuckco",
       methods: [{ type: "api", label: "API key" }],
       loader: async () => ({ baseURL: "https://stuck.invalid/v1" }),
+      usage: async (_getAuth, _provider, options) => {
+        if (process.env.STUCK_USAGE) {
+          traceUsage(options)
+          await never()
+        }
+        return { windows: [] }
+      },
     },
   }
 }
-- 
2.50.1 (Apple Git-155)

```

</details>

Branch with the commit: [fix/4678-plugin-task-lifetime](https://github.com/ggbdpq/magpie/tree/fix/4678-plugin-task-lifetime) (head `b2c162d2e07ee7176130b883527beb6cfd45dd00`).
