# R-A 车道 档1 审查轮 终笔记（2026-11-14）

审查基线：lane 冻结 tip = **eb1b83000**（开工实 fetch = f53c4a1a1，开工后上游 2 提交且其一触碰 gateway.go，遂冻结重做；轮末上游又进 8 提交至 8ce32d700，见"终鲜度门"）。产物目录 `audit1/RA-<单号>/`（reverify-post.md + patch + readback.md）。

## 逐单六要素结论（9/9 REVERIFY-POSTED）

| 单 | verdict | 新 head | patch sha256-16 | 六要素一句话 |
|---|---|---|---|---|
| 3197 | REVERIFY-POSTED [6869315954](https://github.com/yetone/magpie/issues/3197#issuecomment-6869315954) | `53f761c184554ecc` | `876c9fc95e77f8d6` | rebase 两次均净+`=`/am tree 同/全量 gateway 1077s 绿+定向+race+3GOOS/消融两测试红 verbatim/兄弟面=写侧 pending 唯一/not verified=live Codex SDK 承接 |
| 5198 | REVERIFY-POSTED [6869319047](https://github.com/yetone/magpie/issues/5198#issuecomment-6869319047) | `4744f5491029a893` | `930ea4297e87ace1`（与末帖同=内容稳定） | 全链同上型；全量 1094s；消融两个 SealedTask 测试红；hasSealedAgentMessage 各点未被动 |
| 5252 | REVERIFY-POSTED [6869319562](https://github.com/yetone/magpie/issues/5252#issuecomment-6869319562) | `a7d3ff5d3e54ab3f` | `09728f4d60077221` | **探针清洗**（见下）；全量 1052s；消融 MidReplyCutRestsNobody 红；transportWords/restAfterMarked 结论成立 |
| 5452 | REVERIFY-POSTED [6869319562→6869678685 PATCH 修复空围栏](https://github.com/yetone/magpie/issues/5452#issuecomment-6869678685) | `6d29c05880a96f63` | `23ac5613840d94a8` | 全量 1299s；消融 4 个 file 测试红；TIP 的 nested-only case 即本单所修面；发帖时 patch 文件被误删致围栏空，当日 PATCH 补齐并回读复核（教训见下） |
| 5908 | REVERIFY-POSTED [6869824328](https://github.com/yetone/magpie/issues/5908#issuecomment-6869824328) | `066628648`+`80d943a47`（双提交） | `46bf961e1789f2cf`+`c1dbfcd4ecfa1627` | 双 patch am tree 同/agent 全量仅 TestMothX 红（base 对照归因）/gateway 全量 1396s（含 wire fixtures）/两刀消融各 5 测试红/wireProtocol 单写点结论成立 |
| 5923 | REVERIFY-POSTED [6869319957](https://github.com/yetone/magpie/issues/5923#issuecomment-6869319957) | `31cf813f07e51f5b` | `9cfc79685bcc88e4`（与末帖字节同） | applog+cli 全量（cli 3 红=base 预存对照归因）/消融 2 测试红/Quiet 双调用点兄弟结论成立/3GOOS 绿 |
| 6131 | REVERIFY-POSTED [6869409449](https://github.com/yetone/magpie/issues/6131#issuecomment-6869409449) | `1c7b8aabe1555e12` | `be6e4815a19d2e31` | provider+cli 全量（TestResolveVia+cli3=base 预存归因）/新测试+race 绿/消融红/IsPattern 全站结论成立（access 不涉 #account） |
| 6288 | REVERIFY-POSTED [6869895126](https://github.com/yetone/magpie/issues/6288#issuecomment-6869895126)（+附言：tip 再动后廉价复验） | 终 push `bf85d3e5a7be2663`（8ce32d700 基） | 帖内 `27fbdcf6cf9d2ec6`（eb1b83000 基）；附言 `0d861beae76ef4c1`（8ce32d700 基） | 全量 1477s/两刀行为消融 3 测试红 verbatim（normal stop 形）/MALFORMED 系兄弟结论成立/8ce32d700 上 rebase `=`+am tree 同+定向绿 |
| 6320 | REVERIFY-POSTED [6869753300](https://github.com/yetone/magpie/issues/6320#issuecomment-6869753300) | `7e51b1361a8ae06f` | `2915734be3070f7c` | 全量 1221s（与上游 prev share 同存）/消融 ClientWholeReplay 红（Azure 400 verbatim）/prevElsewhere 两调用点结论成立 |

全部 9 分支终态远端对账一致（ls-remote 2026-11-14 实测）。

## 审查发现（重要）

1. **5252 交付污染（已清洗）**：原提交携带 `internal/agent/zz_t1l1_6142_probe_test.go`（#6142 探针，110 行，他单残留；提交信息、issue 末帖正文均无解释，但末帖嵌入 patch 里带着）。amend 删除（作者/日期保留），复验帖明示"stray file dropped"。探针本身在冻结 tip 可编译可通过，若 #6142 后续要接单应重开专支。
2. **5452 发帖事故（当日修复）**：发帖脚本 `cat` 的 patch 源文件被更早的 `rm /tmp/mg-RA-am2/000*.patch` 误删，帖子带空围栏发出（POST 成功≠内容正确）。当日重出 patch（sha 同）、`gh api PATCH` 改写评论、回读围栏 sha 复核通过。教训：**发帖前对 body 文件做 fence 内容完整性自检（sha 对表）**，`&&` 门控应覆盖"帖子内容"而非仅"POST 退出码"。
3. **tip 三连动**：f53c4a1a1（开工）→ eb1b83000（审查中途，触碰 gateway.go → 冻结重做 3197）→ 8ce32d700（轮末，8 提交；仅 codeassist.go 触 6288 同文件不同区域——cloak 区 vs decoder 区）。终门处置：6288 廉价复验（rebase `=`+am tree 同+linux nogui build+定向绿）+push 新 head+帖内附言披露；其余 8 单增量未触碰其改动面与同族函数，如实记录于本笔记，未重跑。
4. **预存红对照归因（全部 base 单跑实证）**：TestMothX（agent，5908 单）、TestResolveVia（provider，6131 单）、cli 3 连红 TestHealthcheckFindsTheRunningGatewayWithoutMagpieAddr / TestUpdateRestartsTheGatewayItFindsWithoutMagpieAddr / TestUpdateFindsAMagpieThatWroteNoRecord（5923、6131 两单复现）。均干净 TIP 同红，不追不修，帖内如实标注。
5. **5908 双提交形态**：分支=旧 keep 提交（a3f4e464f 内容，rebase 后 066628648）+新 genai 默认提交（80d943a47）叠放；am 检查按 2-patch 系列做；帖内双围栏分别给 sha16，回读以拼接 sha 复核（98ad03d31fd08b38 一致）。

## 本车道不自信的点

1. **6288 附言的复验深度**：8ce32d700 上只做了 rebase/am/build/定向（未重跑全量 25m 套件）；帖内主证据链仍在 eb1b83000。若上游继续动 codeassist.go decoder 区域，6288 需要再走全链。
2. **8ce32d700 的其余 8 提交对 9 单的影响只做了文件面比对**（diff --stat 过滤到各单触达文件），未逐提交语义审读；`4e770f733 library: subagents imported from a repository` 这类提交未来可能与 #5198 的 sealed 面产生语义交互（subagent 导入路径），本轮未验证。
3. **3197 第一次 push（9d455cdb0，f53c4a1a1 基）后发现 tip 动**，重做后终版 53f761c18；期间 9d455cdb0 在远端存在过约 30 分钟——若有他人拉取过该 head，无影响（同内容，force-with-lease 覆盖）。
4. **消融红的覆盖面**：5198/5252/5923/6131/6320 用"退产品文件保新测试"单刀；6288 因耦合用两刀行为切（未覆盖 gemini_deferred "in place 加载"面的独立消融——该面只有全量绿+测试绿佐证，无独立回红）。
5. **域外证据未重做**：各单 NOT-RUNNABLE 项（live Codex SDK、真实 Antigravity 应用、真实 Azure 中继、真实 WorkBuddy、Windows 运行时等）本轮原样承接声明，未尝试复活——与原帖口径一致。

## 未跑项清单

- 8ce32d700 上除 6288 外 8 单的重新 rebase（增量未触碰其文件面；上游若再动同面文件需重跑）。
- 6288 在 8ce32d700 上的 gateway 全量套件（只有定向族+build）。
- 5908 在 8ce32d700 上的 agent/gateway 套件（migrate_antigravity.go 2 行改动与其 antigravity.go 面无文件交集，但同属 antigravity 域，语义级未审）。
- Windows 真机运行时（全部单沿用"build only"口径）。

## 耗时与口径

- 开工 ≈08:35，收口 ≈10:05（darwin/arm64 12 核；gateway 全量单跑 1050-1500s，最多 5 套件并发）。
- 口径：改动包全量（gateway/cli 包 -timeout 25m）+定向+-race（新测试族）+gofmt+vet+GOOS linux/darwin/windows nogui build；每单 POST 前 fetch 鲜度门。
