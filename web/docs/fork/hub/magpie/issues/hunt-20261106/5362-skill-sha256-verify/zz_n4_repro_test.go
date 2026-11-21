package library

// N4 车道独立验证探针（非交付物，跑完即删）：复现 #5362 的两个行为。
// 1. TestN4ReproSha256Install:   SHA-256 仓 fetchGit 安装成功并读到内容。
// 2. TestN4ReproSha256UpdateCheck: 更新检查接受完整 64 位 pinned commit。

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// reproGitRepo 建一个指定对象格式的 fixture 仓，返回其 file:// 地址。
func reproGitRepo(t *testing.T, format string) (string, string) {
	t.Helper()
	git := realGit
	if git == "" {
		t.Skip("git isn't installed")
	}
	root := t.TempDir()
	bare, work := filepath.Join(root, "skills.git"), filepath.Join(root, "work")
	run := func(dir string, args ...string) string {
		t.Helper()
		cmd := exec.Command(git, append([]string{"-c", "user.name=t", "-c", "user.email=t@example.com",
			"-c", "init.defaultBranch=main", "-c", "commit.gpgsign=false"}, args...)...)
		cmd.Dir = dir
		cmd.Env = append(os.Environ(),
			"GIT_CONFIG_NOSYSTEM=1",
			"GIT_CONFIG_GLOBAL="+filepath.Join(root, "gitconfig"),
			"GIT_DEFAULT_HASH="+format)
		out, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
		return strings.TrimSpace(string(out))
	}
	run(root, "init", "-q", "--bare", bare)
	run(root, "init", "-q", work)
	run(work, "remote", "add", "origin", bare)
	if err := os.WriteFile(filepath.Join(work, "SKILL.md"), []byte("---\nname: repro\ndescription: repro\n---\nsha256 fixture\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	run(work, "add", "-A")
	run(work, "commit", "-q", "-m", "fixture")
	run(work, "push", "-q", "origin", "main")
	absp, err := filepath.Abs(bare)
	if err != nil {
		t.Fatal(err)
	}
	p2 := filepath.ToSlash(absp)
	if !strings.HasPrefix(p2, "/") {
		p2 = "/" + p2
	}
	return "file://" + p2, strings.TrimSpace(run(work, "rev-parse", "HEAD"))
}

func reproIsolate(t *testing.T) func() {
	t.Helper()
	t.Setenv("GIT_CONFIG_NOSYSTEM", "1")
	t.Setenv("GIT_CONFIG_GLOBAL", filepath.Join(t.TempDir(), "gitconfig"))
	old := gitPath
	gitPath = func() string { return realGit }
	return func() { gitPath = old }
}

// TestN4ReproSha256Install: #5362 — 安装 SHA-256 git 仓的 skill 必须成功。
func TestN4ReproSha256Install(t *testing.T) {
	if realGit == "" {
		t.Skip("git isn't installed")
	}
	restore := reproIsolate(t)
	defer restore()
	addr, _ := reproGitRepo(t, "sha256")
	dir, err := fetchGit(Source{Kind: "git", Repo: addr, Ref: ""})
	if err != nil {
		t.Fatalf("fetchGit from a SHA-256 repository failed: %v", err)
	}
	defer os.RemoveAll(dir)
	b, rerr := os.ReadFile(filepath.Join(dir, "SKILL.md"))
	if rerr != nil || !strings.Contains(string(b), "sha256 fixture") {
		t.Fatalf("installed contents: %q, %v", b, rerr)
	}
}

// TestN4ReproSha256UpdateCheck: #5362 — 更新检查接受 64 位 pinned commit。
func TestN4ReproSha256UpdateCheck(t *testing.T) {
	if realGit == "" {
		t.Skip("git isn't installed")
	}
	restore := reproIsolate(t)
	defer restore()
	addr, head := reproGitRepo(t, "sha256")
	got, err := gitRemoteHead(Source{Kind: "git", Repo: addr, Ref: strings.ToUpper(head)})
	if err != nil {
		t.Fatalf("gitRemoteHead with a 64-digit pinned commit failed: %v", err)
	}
	if got != head {
		t.Fatalf("head = %q, want %q", got, head)
	}
}
