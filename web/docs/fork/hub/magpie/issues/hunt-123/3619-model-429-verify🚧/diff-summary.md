# #3619 验证车道：diff 摘要与判定

日期：2026-11-04。基线 tip = upstream/main e17b6cefc。验证对象 = 竞速者 skygunner 分支，本车道不交自己的 patch。

## 对象

- 分支：`skygunner/magpie fix/3619-model-scoped-rate-limit`
- 评论引用的提交：`0c5a9d458ba086e19bfd9caa359719f12fea5e46`（10-28，两期 issue 评论均只引用此 SHA）
- **分支实际 HEAD**：`e9307596c07d3a513764d878199f13c3a08b83b8`（10-28 15:27 +1000，比前者晚 37 分钟，评论未提及；测试清理 + 收紧正则 + 加 OpenRouter 排除分支）
- 修复基点：`20b35df55`（父提交），距验证 tip 1517 commits，仅 internal/gateway +82k 行

## 提交 1（0c5a9d458）改动面：2 文件 +88 行，无越界

1. `internal/gateway/routing.go`：
   - 新词表 `modelRateWords = (?i)(model.{0,40}(limit|quota|tpm|rpm|rate|throttl)|(limit|quota|tpm|rpm|rate|throttl).{0,40}model)`（"model" 与限流词任一方向 40 字符窗口）
   - `restAfterMarked` 注入：`if why == failRate && modelRateWords.Match(wordsOf(body)) { id = c.restID() }`（`r.Key = id` 之前）
   - `rateRest` else-if 分支：同条件 → `id = c.restID()`
2. `internal/gateway/model_limit_rest_test.go`（新，70 行）：`TestModelRateLimitRestsTheModelAlone`（issue JSON 逐字 + 反措辞 + 同 key 第二模型）+ `TestKeyRateLimitRestsTheKey`（plain 429 仍 rest 整 key）

## 提交 2（e9307596c，分支头）相对提交 1

- 反向分支收紧：`(?:limit|...)[^.\n]{0,24}(?:for|on) (?:the )?model`
- 新词表 `freeModelsPerMin = (?i)free[ -]?models?[ -]?per[ -]?(min|minute|hour)`
- `restAfterMarked` 排除分支（在 modelRateWords 注入之前）：`if why == failRate && c.p.Preset == "openrouter" && freeModelsPerMin.Match(...) { id = provider.KeyAllowanceID(c.p) }`
- 测试文件清理（去掉 modelRateWords 诊断引用等），**丢了文件尾换行**（gofmt -l 在其分支上即红）
- 未动 `rateRest`

## 机理对照（自述 vs diff）——SophNet 场景成立

- 识别："Model tpm limit exceeded" 命中 modelRateWords（消融输出 `modelRate=true` 佐证）✅
- rest 落 restID 而非 restKey ✅；key 其余模型不受累 ✅（测试断言 `restOf(restKey())` 为空）
- plain "Too Many Requests" 仍 rest 整 key ✅（TestKeyRateLimitRestsTheKey）
- RED→GREEN：基点+测试+词表声明（无代码注入）→ 主测试红 `Key="sophnet" restKey=sophnet restID=sophnet/DeepSeek-V4.1-Flash-1017 why=rate modelRate=true`；落修复后绿；tip 消融（只摘注入保词表）复跑同签名红 ✅

## 3way 到 tip（如实记录）

- 单提交 patch：**冲突一处**——routing.go 正则声明区：tip 在同位置加了 `modelCooling`（#3039，2c5d9101b），patch 加 `modelRateWords`；非重叠语义，手工保两词表解决后落树 fcfe03416。测试文件干净即进。
- tip 上 #4317 修复（c37b8b659）把相邻行改成 `id, r.there = c.restID(), true`、#3039 给 rateRest 条件加 `|| modelCooledDown(failRate, body)`——两处上下文漂移未再成冲突（3way 自动并入）。
- 双提交 patch：同一处冲突，同法解决，两提交均落（fafe99666 + c53e8bac9）。

## 兄弟面（识别口形状一致性）

共享识别表（restAfterMarked 的 id 覆盖块 + rateRest 条件链）现有：otherModels（#1669）、clineModelLimited（#1398）、zcodeTrialRefused（#3661）、modelCooledDown（#3039）、PaidBesideFree、remoteModelRest（#1849/#2077）、OpenRouter free sharedPool（#153）。本修复形状与同族一致（同块内谓词分支）。**但**：modelRateWords 的 40 字符桥接窗口比同族谓词宽（其它都是整句/紧邻措辞），与 #153 的账号级分类正面相撞——见下。

## 回归（FAIL 主据）：#153 OpenRouter 账号级 free 限流被翻成 model 级

`TestOpenRouterFreeAccountRateLimitKeepsProviderRest`（9e37a6929，2026-09-28 入仓，**在其修复基点内**）钉死：OpenRouter 账号级 "Rate limit exceeded: free-models-per-min" 必须 rest provider（Key=="orf"）。

| 树 | 结果 |
| --- | --- |
| 干净 tip e17b6cefc | PASS |
| 干净基点 20b35df55 | PASS |
| 基点 + 分支头 e9307596c | **FAIL**，探针：最终 `Rest.Key="orf/x/a:free"` |
| tip + 提交1（3way） | **FAIL**；全量 gateway（602s）**恰好此一红** |
| tip + 分支头（3way） | **FAIL**（其两条自测 PASS） |

机理（分支头，埋点实测）：
1. 排除分支 B7 先开：`id = KeyAllowanceID(c.p)` → **空串**（测试 provider 的 `readsKeyWindows` 为 false）——即便后续不开也已是坏 Key。
2. modelRateWords 注入 B8 仍开：测试桩回的是**带 JSON 信封的完整 OpenRouter 错误**（`"code":null,...,"type":"rate_limit_error"`），收紧后的**正向**分支 `model.{0,40}限流词` 横跨信封字段命中——"model"（free-models 尾部）→ 34 字符（`s-per-min","param":null,"type":"`）→ "rate"（rate_limit_error）。
3. 最终 id=restID，账号级限流被翻成 model 级 → #153 断言红。

race 子集（Rest|Rate）：同测试红，无 DATA RACE（措辞匹配问题，非并发）。gofmt：routing.go 净；分支头测试文件缺尾换行（其分支上即如此）。vet：净。build -tags nogui：净（dockflap/trayimage cgo warning 为预存清单项）。

## 鲜度

upstream/main 无引用 3619 的提交（`--grep=3619` 仅命中 skygunner 自有 ref）；issue 仍 open、无维护者收编；open PR 扫描无他人占坑。

## 判定：FAIL

SophNet 机理正确且其测试锁得住（修前红/修后绿/消融同签名），但分支头确定性回归 #153 的账号级 429 分类（在仓测试、在其自身基点即红），另有空串 rest key 与测试文件缺尾换行两处次要问题。交证据转判定，不背书。

## 证据日志索引（本目录）

- targeted-green.log：tip+修复 两条定向测试 PASS
- base-red-runtime.log：基点+测试+声明 RED（修前红）
- ablation-red-runtime.log：tip 消融 RED（同签名）
- skytree-openrouter.log / tip-clean-openrouter.log：分支上 #153 测试红 / 干净 tip 绿
- skyhead-targeted.log：分支头三条测试（1 红 2 绿）
- skyhead-restkey-probe.log：实际 Rest.Key="orf/x/a:free" 探针
- skyhead-branchprobe.log：B7(空串)→B8(restID) 埋点序列
- skyhead-bodyprobe.log：B8 实际 words（JSON 信封全貌）
- regex-probe.log：极简 body 下收紧正则=false（对照）
- tiphead-targeted.log / tiphead-gofmt-vet.log：tip+分支头 三测试 + gofmt/vet
- full-gateway.log：tip+提交1 全量 602s 恰一红
- race-rest-rate-full.log：race 子集失败清单（同测试，无 DATA RACE）
- 3619.patch / 3619-both.patch：format-patch 原件
