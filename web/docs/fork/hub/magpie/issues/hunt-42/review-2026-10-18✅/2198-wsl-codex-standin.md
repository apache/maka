# #2198 复查（C 路 provider/agent，2026-10-18）

审计基线：worktree `/private/tmp/magpie-rev-c-prov`，HEAD = upstream/main = `d783df46`。fork 分支 `hunt19-c-wsl-codex-standin` 现指向 `e98d7063`（基 `ebf3f48f` 2026-10-17）——比 10-16 评论所说的 `cba7d56c`（基 `8b84dc90`）又新一次 rebase；两个 commit 的 patch 内容**逐字节一致**（`diff /tmp/cba.patch /tmp/e98.patch` 仅 index 行不同），作者日期同为 2026-10-14 20:14:38 +0800。

## verdict：PUSH

三单中证据最强：Edward4226 第三方独立验证 + 今日在 `d783df46` 上五测绿/消融红/mutation 红全部复现。唯一机械遗留：`gateway-routing.md` 的 doc hunk 因上游新增 3 行表格整体错位（Model resolution 行本身逐字节未变），建议用户先花几分钟把分支 rebase 到 `d783df46` 再发 ping。

## ① 现状复核

- 缺陷仍在：`d783df46` 上 `internal/agent/claude.go:2442` codex 分支仍只读本机 `~/.codex/config.toml`；`rg -n 'wslCodexStandIn' internal/` → **空**（补丁符号不存在）；claude 分支（line 2448）有 `wslClaudeStandIn` 兜底（#254），codex 是唯一缺 WSL 兜底的分支。
- StandIn 区域未被维护者再动：claude.go 在基线 `ebf3f48f`→`d783df46` 间漂移 41+/12-，但全部 hunk 位于 line 1766 之前（@@ 头逐一核对：13/301/332/1491/1737/1788），`StandIn`（~2431-2448）不在其中。
- 同题无 PR：`gh pr list --search 2198` → `[]`；`git log --grep '#2198' upstream/main` → 空。

## ② 落 main 检查（含 doc hunk 漂移定性）

- 代码三块（`claude.go`、`wsl.go`、新测试 `wsl_codex_stand_test.go`）：`git apply --check --include='internal/*' /tmp/cwsl.patch` → **APPLIES CLEAN**。
- doc hunk（`docs/subsystems/gateway-routing.md`）：整 patch apply 失败于 `patch failed: docs/subsystems/gateway-routing.md:29`。定性：**纯错位，非内容漂移**——上游 `bd30b068`（retired built-ins 文档）等在表格上方新增 3 行，把 Model resolution 行从 line 29 挤到 line 32；该行本身与 patch 旧上下文**逐字节一致**（`diff /tmp/doc_old.txt /tmp/doc_main.txt` → 空）。
- 手工 rebase 验证：在该行 `when magpie is its provider` 后插入「— in a WSL distro, the distro's own, of the ones running now —」，结果行与 patch 的 + 行**逐字节一致**（`diff /tmp/doc_new_now.txt /tmp/doc_new_patch.txt` → 空，输出 `DOC ROW MATCHES PATCH INTENT BYTE-FOR-BYTE`）。

## ③ GREEN / 消融 / mutation（沙盒 HOME + 缓存钉死，-count=1）

| 步骤 | 命令（`GOTOOLCHAIN=auto go test -tags nogui`，HOME=/tmp/revc-home） | 结果 | exit |
| --- | --- | --- | --- |
| GREEN（d783df46 + 代码 hunk + rebase 后 doc） | `-run 'TestWSLCodexStandIn\|TestWSLCodexStandInSkipsStopped\|TestWSLClaudeStandIn\|TestCodexStandIn\|TestClaudeStandIn' ./internal/agent/` | `ok ... 1.204s` 五测全过 | 0 |
| ABLATION RED（还原 claude.go+wsl.go，保留新测试，加零行为桥接 `func wslCodexStandIn() string { return "" }`） | `-run 'TestWSLCodexStandIn\|TestWSLCodexStandInSkipsStopped'` | `wsl_codex_stand_test.go:41: stand-in: ""` `FAIL`——与 Edward4226 10-16 独立验证逐字一致 | 1 |
| MUTATION（`wslReady` 的 `wsl.running[n]` 过滤移除） | `-run TestWSLCodexStandInSkipsStopped` | `wsl_codex_stand_test.go:78: stand-in from a stopped distro: "stopped/model"` `FAIL`——与 Edward 的 mutation 2 逐字一致 | 1 |
| 终态复 GREEN（checkout 后重放 hunk） | 五测同跑 | `ok ... 1.153s` | 0 |
| gofmt / vet | `gofmt -l internal/agent internal/provider`；`go vet -tags nogui ./internal/agent/ ./internal/provider/` | 无输出 / 无输出 | 0 / 0 |

- 兄弟面：`StandIn` 只有 claude/codex 两个分支，codex 是最后一个缺 WSL 兜底的；patch 顺带把 `wslReady(kind)` 抽成两兄弟共用（下一个 WSL agent 直接复用）。
- 未验证声明口径：FakeWSL ≠ 实机，真机 Windows/WSL 双方均缺环境（`HCS_E_HYPERV_NOT_INSTALLED`），issue 与 Edward 评论均已如实写明——口径清晰合格。

## ④ 验证过程事故记录（透明）

mutation 后的恢复第一次出了岔子：sed 只删掉了 `// MUTATION` 注释、没还原被删的 `wsl.running[n] &&` 条件，紧随的复绿 FAIL（`SkipsStopped` 仍红）。定位后 `git checkout -- internal/agent/wsl.go` 重放 hunk，五测终态绿（exit=0）。上表终态行以还原正确后的运行为准；消融红与 mutation 红的证据不受影响。

## ⑤ 不自信清单

- 真机 Windows/WSL 未实测（双方环境同缺，#254 本体当年也止于 fake distros 并明示 `Not tried on real Windows/WSL`）——若维护者坚持实机面，此单会挂起等待。
- 分支被再 rebase 过一次（`e98d7063` ≠ 评论里的 `cba7d56c`）：patch 内容已核对一致，但 issue 评论区未提这次强推，ping 时若维护者看 commit 图注意到日期差，属已知非问题。
- `gateway-routing.md` 的 doc 行 rebase 由本机手工完成并逐字节核对，未以 commit 形式落在 fork 分支上（硬纪律禁 push）；分支持续停在 `ebf3f48f` 基，`git am` 官方 patch 文本时 doc hunk 会撞同一个错位。
- Edward 机器上 gateway 包的既有环境失败（`TestClaudeAsRootEnv` 等）未在本机复跑定性，沿用其"与本次改动无关"的基线对照结论。

## ⑥ 下一步最小动作（用户执行）

1. 在任意 clone：`git fetch https://github.com/ggbdpq/magpie.git hunt19-c-wsl-codex-standin && git checkout -b tmp-rebase FETCH_HEAD && git rebase --onto upstream/main ebf3f48f`（doc hunk 冲突时按上文验证过的单行插入解决）。
2. `GOTOOLCHAIN=auto go test -tags nogui -count=1 -run 'TestWSLCodexStandIn|TestWSLCodexStandInSkipsStopped|TestWSLClaudeStandIn|TestCodexStandIn|TestClaudeStandIn' ./internal/agent/` 复绿后强推分支。
3. 发下方英文 ping。

## ⑦ 英文 ping 稿（可直接发）

> Gentle nudge on this one — it's the one issue in my batch with independent third-party verification. @Edward4226 reproduced the whole matrix on `a15e5765` (bridge-red `stand-in: ""`, both mutations red, five tests green, honest not-tried list), and I've re-run the same on today's tip (`d783df46`): the three code hunks apply clean, the five tests pass, the new test goes red on a zero-behavior bridge and the stopped-distro guard goes red with the running filter removed. Only drift since is one docs row that moved down three lines in gateway-routing.md with its text unchanged — I've re-based the branch.
>
> The gap is small and mirrors the accepted #254 shape: `StandIn("codex", …)` reads only this machine's config.toml, so a Codex wired inside a WSL distro (`model_provider = "magpie"`, the only shape under NAT since #2145) that names an unserved model gets a 404 where this machine's Codex falls back to its config's model and a Claude Code in the same distro gets its stand-in. The patch mirrors claude's branch exactly (`wslReady` shared, `wslCodexStandIn` reads the first running distro whose config.toml names magpie, stopped distros never opened), and off Windows nothing changes.
>
> Real-Windows/WSL remains untried by all of us (no distro installable on either machine — `HCS_E_HYPERV_NOT_INSTALLED`), as stated in the issue. Branch: [hunt19-c-wsl-codex-standin](https://github.com/ggbdpq/magpie/tree/hunt19-c-wsl-codex-standin), `git am`-able. Is there anything you'd need before this can go in?
