Following the reporter's own root-cause analysis — the diagnosis is theirs, the patch is my implementation of it. @xixilys reports that with a symlink in $HOME whose name matches `*codex*` and points to a macOS TCC-protected USB Removable Volume (or any slow or hung mount), `provider.rememberLogins()` held the global `logins.json.lock` while the look for Codex's other folders walked $HOME; `os.ReadDir` blocked for good, and the lock being taken on the hot path of every gateway request (`provider.Accounts()`), every `/v1/messages`, `/v1/responses` and `/v1/models` request timed out with 504, `magpie ls` and `usage` hung, hundreds of goroutines piled up behind `filelock.(*Mutex).Lock`, and tccd burned a CPU. Observed on 0.1.4515, still present in 0.1.4525's code.

**Root cause**: `rememberLogins` took `loginsMu` (the `logins.json.lock` filelock) first and reached the walk only under it: the codex branch's `codexHomeLogins` → `codexOtherHomes` → `appdir.CodexHomesIn` reads the home folder and every folder named `*codex*` in it with `os.ReadDir`, and one of those can sit on an answer the system is never done giving. So the lock was held for good, with every gateway request standing behind it.

**The fix**: the look for Codex's other folders now runs apart from `loginsMu`, one at a time (`internal/provider/logins.go`): it reads the folders, then their sign-ins (`readCodexLogin` — so a folder that passes the walk's stat and then hangs its reads is read apart from the lock too), and keeps what it read for the looks that follow. The look that started it waits `filelock.Wait` for it, then goes on with what the last finished look read, as filelock goes on without the lock; a look that finds one running does not wait on it, so a look held for good holds no other look, no `logins.json.lock`, and no request behind it. What a held-for-good look leaves the looks after it is none known, not none there is: the accounts already saved stay in logins.json, and the merge under `loginsMu` only names and keeps what the look read.

**Source**: reported in #7190 by @xixilys (with goroutine stacks). The fix follows their suggested fix 1 — discovery and the candidate auth reads out of the lock — plus a bounded wait for it, so the pile-up doesn't move from the lock to the walk.

**Red without the fix** (base `f7173c79a`, with `internal/provider/logins.go`'s fix reverted — the one-line test seam kept — and the new test kept): `go test -tags nogui -run TestLoginsLookRunsApart ./internal/provider` fails:

```
--- FAIL: TestLoginsLookRunsApart (5.04s)
    logins_lock_test.go:279: logins.json.lock stands while the look for Codex's other folders runs
```

With the fix: `ok` (the test itself runs in 0.05s).

**Siblings**: `rg -n "rememberLogins|CodexHomesIn|logins.json.lock"` over the repo:

- `codexOtherHomes` / `codexHomeLogins` (`internal/provider/logins.go`): the only walkers under `loginsMu`; fixed here.
- The other takers of `loginsMu` (claude_auth, keepalive, signin, migrate, side_logins, …): each reads fixed paths only; none walks $HOME (`rg "CodexHomes|ClaudeHomes"` finds no call under the lock but the look above). Different by design.
- `liveLogin`'s reads of the agents' own folders (`~/.codex/auth.json`, Claude's credentials) stay under the lock: single fixed paths, not a walk, but a link on those would hold the lock the same way. Left: treating them alike means reading the live sign-ins apart from the lock too — a follow-up if one is ever hit.
- `internal/sessions` (`Dirs`, `listCodexFiles`, `access.go`, `tidyCodexCatalog`): the same walks on the Sessions paths, but no `loginsMu` there, and gateway mode reads none of them (`ownOff`); a hung folder stalls the Sessions page only. Left for a follow-up issue if one is reported.

**Verification** (go1.26.8, darwin/arm64):

| Check | Result |
| --- | --- |
| New test without the fix | FAIL in 5.04s: `logins.json.lock stands while the look for Codex's other folders runs` |
| New test with the fix | ok (test 0.05s) |
| Ablation (fix's logins.go reverted, test kept) | same FAIL line in 5.04s; ok again after restoring |
| `go test -tags nogui -timeout=45m -count=1 ./internal/provider` | FAIL in 122s — only `TestResolveVia`, which fails the same way on the commit's parent (this machine's own proxy reaches where the test points); all other tests ok |
| New test with `-race` | ok in 2.3s |
| `gofmt -l` on the touched files | no output |
| `git diff --check` | clean |
| `go vet ./...` | exit 0 |
| `GOOS=linux go vet -tags nogui ./...` | exit 0 |
| `GOOS=windows go vet ./...` | exit 0 |
| `go build ./...` (darwin) | exit 0 |
| `GOOS=windows go build ./...` | exit 0 |
| `GOOS=linux go build -tags nogui ./...` | exit 0 |

**Not verified**: a real TCC-protected USB volume or real hung mount on macOS — the test simulates the never-answering folder with an injectable walk, deterministically; Windows and Linux runtime behavior (built and vetted only); the gateway's 30s/504 path end to end under a hung mount.

**Attribution**: AI-written; I've read the whole diff and the tests pass. Please keep the author (ggbdpq) or add Co-authored-by: ggbdpq <ggbdpq@gmail.com>.

**Branch with the commit**: [fix/7190-logins-lock-scan](https://github.com/ggbdpq/magpie/tree/fix/7190-logins-lock-scan) (head `f9b3f2f271d3949d7cf0d76296e6ce005478de6f`), rebased onto current `upstream/main` (`f7173c79a318413eaf297fe758e1828f9c8af522`); on a fresh checkout `git am` applies clean.

<details><summary>patch: provider: the look for Codex's other folders runs apart from loginsMu (#7190) — git am applies it as is; SHA-256 first 16: 40d8234dd6300c16</summary>

```patch
From 0000000000000000000000000000000000000000 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Thu, 19 Nov 2026 23:56:34 +0800
Subject: [PATCH] provider: the look for Codex's other folders runs apart from
 loginsMu (#7190)
MIME-Version: 1.0
Content-Type: text/plain; charset=UTF-8
Content-Transfer-Encoding: 8bit

rememberLogins held logins.json.lock while the look for Codex's other
folders ran, and the look's walk (appdir.CodexHomesIn) reads every folder
named *codex* in the home folder. One of those can sit on an answer the
system is never done giving — a link in $HOME to a folder on a USB
Removable Volume macOS keeps magpie out of, or any slow or hung mount:
os.ReadDir blocked for good, and with logins.json.lock held for the look
on the hot path of every gateway request (provider.Accounts), every
/v1/messages, /v1/responses and /v1/models request timed out with 504,
magpie ls and usage hung, and hundreds of goroutines piled up behind
filelock.(*Mutex).Lock while tccd burned a CPU (xixilys, #7190).

The look now runs apart from loginsMu, one at a time: it reads the
folders, then their sign-ins, and keeps what it read for the looks that
follow. The look that started it waits filelock.Wait for it, then goes on
with what the last finished look read, as filelock goes on without the
lock; a look that finds one running does not wait on it, so a look held
for good holds no other look, no logins.json.lock and no request behind
it. What a held-for-good look leaves the looks after it is none known,
not none there is: the accounts already saved are kept as they are, and
the merge under loginsMu only names and keeps what the look read.

Run (mica, at this tree): without the fix, the new test fails —
TestLoginsLookRunsApart: logins.json.lock stands while the look for
Codex's other folders runs — and passes with it, in 0.01s; with the
fix's logins.go reverted and the test kept it fails the same line, and
passes again once restored. go test -tags nogui -timeout=45m -count=1
./internal/provider fails only TestResolveVia, which fails the same way
on this commit's parent (the machine's own proxy; the rest ok, 122s).
The new test under -race ok. gofmt -l on the touched files: nothing.
git diff --check: clean. go vet ./..., GOOS=linux go vet -tags nogui
./..., GOOS=windows go vet ./..., and go build ./... for darwin, windows
and linux (-tags nogui on linux): all exit 0.

Generated-by: GLM-5.3-Flash (ZCode)
---
 internal/provider/logins.go           | 124 ++++++++++++++++++++++----
 internal/provider/logins_lock_test.go |  75 ++++++++++++++++
 2 files changed, 183 insertions(+), 16 deletions(-)

diff --git a/internal/provider/logins.go b/internal/provider/logins.go
index 433930788..bd5a732d9 100644
--- a/internal/provider/logins.go
+++ b/internal/provider/logins.go
@@ -943,14 +943,22 @@ func CodexSignInListed() (ids []string, fetched time.Time, ok bool) {
 // the folder).
 func codexLoginIn(home string) (savedLogin, bool) {
 	b, _, err := readCodexLogin(home, false)
+	return codexLoginRead(b, err)
+}
+
+// codexLoginRead is the ChatGPT account the sign-in bytes auth hold, read
+// from its folder by the look for Codex's other folders, apart from
+// loginsMu with the rest of that look (#7190): err is what the read came
+// to, and what couldn't be read is no account.
+func codexLoginRead(auth []byte, err error) (savedLogin, bool) {
 	if err != nil {
 		return savedLogin{}, false
 	}
 	// read once for the bytes, as codexWho is: liveLogin is asked from
 	// four loops at rest, each a parse and a JWT decode of one auth.json
-	w := codexLogins.of(b, func() [2]string {
+	w := codexLogins.of(auth, func() [2]string {
 		var a codexAuth
-		if json.Unmarshal(b, &a) != nil || a.Tokens.AccessToken == "" || a.AuthMode == "apikey" {
+		if json.Unmarshal(auth, &a) != nil || a.Tokens.AccessToken == "" || a.AuthMode == "apikey" {
 			return [2]string{}
 		}
 		id := jwtClaims(a.Tokens.IDToken)
@@ -964,7 +972,7 @@ func codexLoginIn(home string) (savedLogin, bool) {
 	if user == "" {
 		return savedLogin{}, false
 	}
-	l := savedLogin{Agent: "codex", User: user, Plan: w[1], Auth: json.RawMessage(bytes.TrimSpace(b))}
+	l := savedLogin{Agent: "codex", User: user, Plan: w[1], Auth: json.RawMessage(bytes.TrimSpace(auth))}
 	l.User = codexLiveName(user, l.Auth)
 	return l, true
 }
@@ -973,28 +981,105 @@ var codexLogins authMemo[[2]string]
 
 // codexOtherHomes are the user's Codex folders but the one magpie and
 // Codex run with (appdir.CodexHomes): one ChatGPT account each, Codex run
-// in it with CODEX_HOME set.
-func codexOtherHomes() []string { return appdir.CodexHomes()[1:] }
+// in it with CODEX_HOME set. A var, so a test can hold the look, as a
+// folder the system answers slowly holds it (#7190).
+var codexOtherHomes = func() []string { return appdir.CodexHomes()[1:] }
+
+// otherHomesWait is how long the look of the logins that started the look
+// for Codex's other folders waits for it, as filelock waits for another
+// magpie: past that it goes on with what the last finished look read.
+const otherHomesWait = filelock.Wait
+
+// otherHomesLook is the one look at a time for the sign-ins in Codex's
+// other folders, run apart from loginsMu. Its walk (appdir.CodexHomesIn)
+// reads every folder named *codex* in the home folder, and one of those
+// can sit on an answer the system is never done giving — a link to a USB
+// volume macOS keeps magpie out of, a mount gone hung: the look ran for
+// good with logins.json.lock held for it, and every gateway request stood
+// behind it (#7190). Taken, a look that finds one running keeps what the
+// last finished one read, so a look held for good holds no other look,
+// no logins.json.lock, and no request behind it.
+var otherHomesLook struct {
+	sync.Mutex
+	read    []codexHomeRead // as the last finished look read them
+	running chan struct{}   // the look running now, closed when it is done; nil for none
+}
+
+// codexHomeRead is one other Codex folder and its sign-in as the look read
+// it. The read ran apart from loginsMu with the rest of the look (#7190),
+// so only the naming and the keeping of what it read are left to do under
+// the lock.
+type codexHomeRead struct {
+	home string
+	auth []byte
+	err  error
+}
+
+// codexHomesForLook are the sign-ins of Codex's other folders, as the last
+// finished look read them, for this look of the logins to keep. None
+// running, it starts the one look at a time and waits for it, as the look
+// ran under loginsMu before (#7190); one running, it does not wait on it —
+// what a folder the system never answers for holds for good is waited on
+// once, and the looks after it go on with what the last finished look
+// read at once. That is none known, not none there is: the accounts
+// already saved are kept as they are.
+func codexHomesForLook() []codexHomeRead {
+	otherHomesLook.Lock()
+	var started chan struct{}
+	if otherHomesLook.running == nil {
+		started = make(chan struct{})
+		otherHomesLook.running = started
+		go codexHomesLookRun(started)
+	}
+	otherHomesLook.Unlock()
+	if started != nil {
+		select {
+		case <-started:
+		case <-time.After(otherHomesWait):
+			log.Printf("logins: the look for Codex's other folders runs over %v; going on with the ones the last look read", otherHomesWait)
+		}
+	}
+	otherHomesLook.Lock()
+	defer otherHomesLook.Unlock()
+	return otherHomesLook.read
+}
+
+// codexHomesLookRun is the one look: the folders read, then their
+// sign-ins, then what was read kept for the looks that follow, however
+// long this one takes.
+func codexHomesLookRun(done chan struct{}) {
+	defer close(done)
+	var read []codexHomeRead
+	for _, home := range codexOtherHomes() {
+		auth, _, err := readCodexLogin(home, false)
+		read = append(read, codexHomeRead{home: home, auth: auth, err: err})
+	}
+	otherHomesLook.Lock()
+	otherHomesLook.read = read
+	otherHomesLook.running = nil
+	otherHomesLook.Unlock()
+}
 
 // codexHomeLogins are the accounts Codex is signed in to in the user's
-// other Codex folders, each with its folder as Home: one Codex keeps
-// signed in itself, as it does the one in ~/.codex. The one ~/.codex is
-// signed in to is that one's, wherever else it is too, and an account in
-// two other folders is the first's. A folder's sign-in the user removed
-// from magpie is passed over (codexSetAside); with that record unreadable,
-// which ones were removed is unknown, and none is read this time.
-func codexHomeLogins(live savedLogin, haveLive bool) []savedLogin {
+// other Codex folders, as the look read them (codexHomesForLook), each
+// with its folder as Home: one Codex keeps signed in itself, as it does
+// the one in ~/.codex. The one ~/.codex is signed in to is that one's,
+// wherever else it is too, and an account in two other folders is the
+// first's. A folder's sign-in the user removed from magpie is passed over
+// (codexSetAside); with that record unreadable, which ones were removed is
+// unknown, and none is read this time.
+func codexHomeLogins(live savedLogin, haveLive bool, read []codexHomeRead) []savedLogin {
 	aside, err := readCodexAside()
 	if err != nil {
 		return nil
 	}
 	var out []savedLogin
-	for _, home := range codexOtherHomes() {
-		l, ok := codexLoginIn(home)
+	for _, h := range read {
+		l, ok := codexLoginRead(h.auth, h.err)
 		if !ok || haveLive && sameLogin(live, l) || slices.ContainsFunc(out, func(o savedLogin) bool { return sameLogin(o, l) }) {
 			continue
 		}
-		l.Home = home
+		l.Home = h.home
 		if codexSetAside(l, aside) {
 			continue
 		}
@@ -1056,6 +1141,13 @@ func rememberLogins(force bool) {
 	if !force && !loginsLookDue() {
 		return
 	}
+	// the look for Codex's other folders runs apart from loginsMu, which
+	// a folder the walk reads holding its answer for good held for good,
+	// and every gateway request stood behind (#7190)
+	var read []codexHomeRead
+	if !accountRemoved("codex") {
+		read = codexHomesForLook()
+	}
 	loginsMu.Lock()
 	defer loginsMu.Unlock()
 	// another ask may have looked while this one waited for the lock
@@ -1075,7 +1167,7 @@ func rememberLogins(force bool) {
 		if agent == "codex" {
 			// Codex's other folders' accounts (phantom3792 on X: only the
 			// default profile's account read a quota)
-			for _, h := range codexHomeLogins(l, ok) {
+			for _, h := range codexHomeLogins(l, ok, read) {
 				h.Seen = now
 				ls = upsertLogin(ls, h)
 				changed = true
diff --git a/internal/provider/logins_lock_test.go b/internal/provider/logins_lock_test.go
index 2fc52f67e..5dcb9a719 100644
--- a/internal/provider/logins_lock_test.go
+++ b/internal/provider/logins_lock_test.go
@@ -221,6 +221,81 @@ func TestLoginsReadAfreshUnderLock(t *testing.T) {
 	}
 }
 
+// The look for Codex's other folders ran with logins.json.lock held for
+// it, and one folder of the many the walk reads can sit on an answer the
+// system is never done giving — a link to a USB volume macOS keeps magpie
+// out of: the look never came back, the lock never came off, and every
+// gateway request stood behind it (xixilys, #7190). The look runs apart
+// from the lock, a look while one is held for good does not stand behind
+// it, and the accounts already saved are kept as they are.
+func TestLoginsLookRunsApart(t *testing.T) {
+	home := signIn(t)
+	t.Setenv("CODEX_HOME", "")
+	codexSignIn(t, home, "me@example.com", "r-me")
+	work := filepath.Join(home, ".codex-work")
+	exp := float64(time.Now().Add(time.Hour).Unix())
+	writeFile(t, filepath.Join(work, "auth.json"), map[string]any{
+		"auth_mode": "chatgpt",
+		"tokens": map[string]any{
+			"id_token":      fakeJWT(map[string]any{"email": "pro@example.com", "https://api.openai.com/auth": map[string]any{"chatgpt_plan_type": "pro", "chatgpt_account_id": "acct-pro"}}),
+			"access_token":  fakeJWT(map[string]any{"exp": exp}),
+			"refresh_token": "r-pro", "account_id": "acct-pro",
+		},
+	})
+	rememberLogins(true)
+	if b, _ := os.ReadFile(loginsPath()); !bytes.Contains(b, []byte("pro@example.com")) {
+		t.Fatalf("the other folder's account isn't saved: %s", b)
+	}
+
+	// a folder of the walk the system never answers for: the look runs
+	// for good
+	scanning := make(chan struct{})
+	release := make(chan struct{})
+	realHomes := codexOtherHomes
+	codexOtherHomes = func() []string {
+		close(scanning)
+		<-release
+		return nil // what a look held for good has read: none known, not empty
+	}
+	t.Cleanup(func() {
+		codexOtherHomes = realHomes
+		select {
+		case <-release: // let go already
+		default:
+			close(release)
+		}
+	})
+
+	looked := make(chan struct{})
+	go func() { rememberLogins(true); close(looked) }()
+	<-scanning // the look is in the folders now
+
+	// logins.json.lock is not held for it: a gateway request takes it now
+	locked := make(chan struct{})
+	go func() { loginsMu.Lock(); loginsMu.Unlock(); close(locked) }()
+	select {
+	case <-locked:
+	case <-time.After(5 * time.Second):
+		t.Fatal("logins.json.lock stands while the look for Codex's other folders runs")
+	}
+
+	// and a look while that one is held for good does not stand behind it
+	rememberLogins(true)
+
+	// the accounts already saved are kept as they are
+	if b, _ := os.ReadFile(loginsPath()); !bytes.Contains(b, []byte("pro@example.com")) || !bytes.Contains(b, []byte("r-me")) {
+		t.Fatalf("a look held for good lost the accounts saved:\n%s", b)
+	}
+
+	// let the held-for-good look end; it has none known, and what is
+	// saved is still kept
+	close(release)
+	<-looked
+	if b, _ := os.ReadFile(loginsPath()); !bytes.Contains(b, []byte("pro@example.com")) || !bytes.Contains(b, []byte("r-me")) {
+		t.Fatalf("the held-for-good look's end lost the accounts saved:\n%s", b)
+	}
+}
+
 // Writing logins.json only to move when the accounts were last seen
 // builds no catalog anew: an idle magpie did each seenEvery, and dsh's
 // round alone built ~42 MB of models again for it. A change besides the
-- 
2.50.1 (Apple Git-155)
```

</details>
