# #5958 验证记录（lane 8 / n6，2026-11-11）

- worktree: /tmp/mg-1110-85-1（分支 fix-5958-headless-auth，base d2a80b31731 = upstream/main tip，开工后 fetch 复核未再动）
- head: d97311932a64c84ef06bcb6544879e19a6b22113（author/committer ggbdpq <ggbdpq@gmail.com>）
- patch: 0001-proc-a-browser-isn-t-started-where-there-is-no-displ.patch（--zero-commit），sha256[:16]=2dc4030ad379b1df
- am 即进：干净检出 d2a80b31731 上 git am 零冲突 → 50ae1a0969423615

## 修前红（TDD compile-red）
GOCACHE=/tmp/mg-verify-85-gocache go test -tags nogui -run 'TestBrowser' ./internal/proc/
→ undefined: openBrowserOn / osrelease，[build failed]（fixture 引用护栏 seam，双分支钉住）

## 修后绿
- go test -tags nogui -run 'TestBrowser|TestInWSL' ./internal/proc/ → ok
- proc 包全量（-tags nogui, 10m）→ ok 5.884s
- -race 实名 → ok 2.016s
- go vet -tags nogui ./internal/proc/ → 净
- go build -tags nogui ./... → OK
- gui 登录开页面面实名：TestPluginSignInPageOpensOnce / TestSignInLinkOnlyOpensNothing /
  TestMCPSignInSaysTheBrowserDidntOpen / TestOpenSaysTheBrowserDidntOpen /
  TestSignInAlertOpensItsProvider / TestSignInText / TestBrowserNamesRundll32ByItsPath → ok

## 消融回红（语义分叉行变异，保持编译）
变异：openBrowserOn 护栏条件 `why != ""` → `false && why != ""`（第一次直接摘 if 块触发 errors unused build-failed 假红，已弃用并改形）
- git diff --stat 复证：browser.go 52 行差异生效
- go test -run 'TestBrowser|TestInWSL' → FAIL TestBrowserWithoutDisplayStartsNoneAndSaysWhy
  browser_test.go:59: no display: err <nil>, started 2（行为红=修前形状）
- 还原 → 复绿 ok

## 兄弟面 rg 全查（11 点，改/不改理由入帖）
proc.OpenBrowser 直调：gui/app.go:194（Wails 后备，无头不可达，不改）、accounts_cli.go:810（受益）
openInBrowser 调用：accounts_cli.go:509、plugins_cli.go:669、web_cli.go:61/72/100、main.go:672（全部经共享 chokepoint 受益，链接旁打印原因）
非同族不动：folder_linux.go（文件夹打开自有候选链）、agent/lody.go+applink_other.go（scheme handler）、gateway/browser.go（浏览器扩展通道同名不同族）
WSL 豁免佐证：#2043 出自 WSL、wslrun/mcp_wsl 包、web.go 头注列 WSL

## NOT-RUNNABLE
Linux 无头真机（本机 darwin 无）：fixture 代显式环境变量与内核名；报告者 VPS 观察按其自述引用（其自认不能定根因）
