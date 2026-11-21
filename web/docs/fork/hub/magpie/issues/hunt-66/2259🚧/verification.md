# hunt66 Lane A — #2259 验证证据

验证对象：skygunner `ec3c82b159cd1101971205bdaa1c719bc434fcce`（自称 adapted ours 7112fe69, preserving Co-authored-by）
我方原 patch：`7112fe69cf93589e02038396da5d1a19e3d7e95e`（hunt24-b-nested-group-affinity，base 37fec124）
本轮基线：upstream/main = `63be47717a9ca91fc89102078a1f1fff3e03e0ce`（开工复核 tip 未动）
worktree：magpie-hunt66-a（分支 hunt66/a，记录分支 hunt66/a-2259 = f75f172f）

## 1. attribution（只认提交）

```
$ git show --format=fuller ec3c82b1 | head
Author:     vincent <webmaster@palmit.com.au>
Commit:     vincent <webmaster@palmit.com.au>
消息尾部逐字：Co-authored-by: ggbdpq <ggbdpq@gmail.com>
```
PASS：trailer 在提交消息里逐字存在（本条 commit，非分支其它提交）。

## 2. 保真对比（逐函数/hunk；两 base 间 fallback.go 漂移 509 行，不能整文件 diff）

- `func innerAffinity`（无注释体）：`git show 7112fe69:... | sed -n '/^func innerAffinity/,/^}/p' | diff - <(git show ec3c82b1:...)` → **逐字节相同**；注释我方 3 行 → 其 1 行（"follows the same inner-first precedence as FirstToken"）。
- candidate 字段 `affinity string` + `planLevel` 内 `l[i].affinity = innerAffinity(m)`：两版同在（行号 436/452），注释缩短。
- `affine` 的回答者 mode 覆盖：保留（`if cs[at].affinity != "" { mode, a.Mode = cs[at].affinity, cs[at].affinity }`）；匹配循环提取为共享 `lastAnswerer`（who/model/effort 三级），`a.Last` 并入同一块——语义等价。
- `strictKeep`：**扩展**。我方门 = 「点名组 strict，或 capped/held 回答者的内层 affinity==strict」（who() 粗匹配）；其版 = 用 `lastAnswerer(left, st)`（model/effort 精确）从 capped/held 回答者取内层 mode 覆盖后再判 strict —— 内层 off/session/turn 在 cap/credit-hold 边界也压过外层 strict（我方在该边界只认 strict）。其 commit message 与帖内均明说 "consistent override behavior at caps"，与 affine 的优先级一致，属有意扩展，非缩水。
- 测试：`nestedKeys` helper 逐字节相同；`TestNestedGroupStrictAffinity` 断言全保留（仅删未用的 `other` 变量）；另有 4 个新测试（Modes 5 例 / AtCap 10 例 / UsesTheAnsweringModel / HeldAccountThroughGateway 4 例），267 行 vs 我方 89 行。
- docs Affinity 行：语义同 + 增补 cap 边界句，点名两个测试。

结论：**适配（保真 + 一致性扩展）**，无缩水。

## 3. 消融回红（cherry-pick ec3c82b1 → tip）

- cherry-pick 冲突（漂移证据）：docs/subsystems/gateway-routing.md、internal/gateway/fallback.go —— 其分支携带 tip 没有的 #2410 Patience 改动与 docs 行；affinity.go 干净。
- 解决 = 只取本 commit 自身改动（patience 上下文全部丢弃），结果 `f75f172f`（分支 hunt66/a-2259）。消融说明：本 commit 行为面全在 affinity.go（affine 覆盖块 + strictKeep 门 + lastAnswerer）；fallback.go 是纯管道（字段+函数+赋值），checkout 其父文件会注入 tip 没有的 patience 特性，故消融取「管道保留 + affinity.go 回 tip」。
- RED（`git checkout 63be4771 -- internal/gateway/affinity.go`，测试保留）：

```
$ HOME=<scratch> go test -tags nogui -count=1 -p 2 ./internal/gateway -run 'TestNested...' ; echo $?
--- FAIL: TestNestedGroupStrictAffinity (0.68s)
    nested_affinity_test.go:79: second turn, the inner group's strict: 200 {"id":"x","choices":[{"index":0,"message":{"role":"assistant","content":"from k2"},"finish_reason":"stop"}]} tried k1,k2
--- FAIL: TestNestedAffinityModes (1.89s)        （4/5 子测试红）
--- FAIL: TestNestedAffinityAtCap (0.03s)        （10/10 子测试红）
--- FAIL: TestNestedAffinityUsesTheAnsweringModel (0.00s)
--- FAIL: TestNestedAffinityHeldAccountThroughGateway (7.39s)  （4/4 子测试红）
FAIL
EXIT=1
```
核心红与 issue 症状同形（200 from k2, tried k1,k2）——报告在当前 main（63be4771）仍成立，修仍不在 main。

- GREEN（`git checkout HEAD -- internal/gateway/affinity.go` 恢复）：

```
ok  	github.com/yetone/magpie/internal/gateway	10.996s
EXIT=0
```

过程曲折记录：第一次批量解冲突脚本一次 sub 消费了全部三个冲突块，fallback.go 丢了 innerAffinity/planLevel 赋值（2/5 测试带修也红，假象）；发现后补齐 amend（c78d98f0→f75f172f），RED 用修正后的树重跑，上方 RED/GREEN 为修正后的成对记录。

## 4. 漂移与落地

- `git merge-base ec3c82b1 63be4771` = `63be4771`（tip 本身）：其分支正切在当前 tip 上，上游零漂移。
- 落地单 commit：plain apply 失败（docs/fallback.go 上下文带 patience），`git apply --3way --check --cached` 报同两文件 conflict、affinity.go 干净（见 landing.log）——即上游收录时需要我做过的同款三步解法（f75f172f 已验证可行）。

## 5. 兄弟面（rg 全查）

- mode 消费点仅两处：`gateway.go:1994 strictKeep(...)`、`gateway.go:2060 affine(...)`——**两处都改了**。
- mode 来源：`gateway.go:1922/1929`（provider 或点名组）——保持「点名组兜底」语义，未动，正确。
- `trace.go:191` `GroupRef.Affinity` 只进 trace 展示，非行为面，正确未动。
- `fallback.go:414` `m.Via[i].Affinity` 是新函数自身。无漏面。

## 6. 相称矩阵

| 检查 | 结果 |
| --- | --- |
| 新测试 5 条（-count=1 -tags nogui -p 2） | GREEN ok 10.996s（消融对：RED 11.225s exit 1 / GREEN exit 0） |
| 同域定向 StrictAffinity/Nested/AccountCap/WindowCaps/Sink/FirstToken | ok 30.557s exit 0 |
| `-race`（CGO_ENABLED=1） | **未跑成**：本机无 gcc（cgo: C compiler "gcc" not found），见 race.log |
| `gofmt -l`（3 个改动文件） | 干净 |
| `go vet -tags nogui ./internal/gateway` | exit 0 |
| gateway 包全量 / 其它包 / 三平台 build | 未跑（改动面 3 文件，定向+同域已盖；其帖自称在其 head 上 69 包全量过，本机不复验） |

## 7. 不确定项

- 其 strictKeep 扩展在「外层 strict + 内层 off + cap」组合的行为与我方原 patch 不同（其版不放回），这是语义取舍而非缺陷——两版各自自洽，其版内部一致性更强。
- f75f172f 是我做的落地解法，非其原样提交；其原 commit 在其分支树上的七条验收命令本机未复跑。
