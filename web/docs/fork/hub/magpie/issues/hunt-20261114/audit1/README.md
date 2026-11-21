# 档1 审查轮（2026-11-14 · 26 单六要素全链复验）

- 口径（用户令）：档1 全部有 patch 单（在途 22 + 当日新增 4）在**当前 main** 重跑六要素全链，证据落 issue 可核查，缺一不算完成。编制=M（8）+R-A（gateway 族 9）+R-B（provider/背书族 9）。
- **终账 26/26 全部 REVERIFY-POSTED**：每单复验帖=六要素表（rebase 当前 tip/range-diff 漂移、am 即进树一致、包全量+定向+race+gofmt/vet+GOOS×3、消融红复证、兄弟面重扫、实证或如实 Not verified）+新 head16+patch sha256-16+分支链接+Attribution。零 SUPERSEDED/零 DEFER-REVIEW（本批 rebase 全部 `=` 零漂移）。
- 预存红全部 base detached 对照归因在案（TestMothX/TestResolveVia/TestHostToldTheGatewayAddress/cli healthcheck 三测/gui ProxyCheck+SessionReadsRoutes 互踩对）。
- 抽查：M 车道亲做；R-A 抽 3197/5252/6288（分支对账+5252 提取 sha16 MATCH+残留探针文件确认剔除）；R-B 专项核验 #5197 重做链（独占 worktree+唯一日志+双 tip 披露）+6336/4666 分支对账。
- 事故与纠正：①R-B #5197 双后台任务共用 worktree+日志互踩→证据链作废重做（独占 worktree+唯一日志）→**用户令落永久约束 handbook/10 #25 + handbook/05 §8 模板**；②R-B 误删 docs 23 tracked 文件→git checkout 全数恢复（git status 核净）；③M 车道 #5411 帖 Siblings 行误用整上游增量当触达面→PATCH 编辑勘误（真实触达=gateway.go 一文件）。
- tip 高频移动（当日 9+ 次）：每单证据钉在各自 POST 前 tip 并帖内明示；rebase 每次 `=` 零漂移已证明可零成本追平。
- **B3 投递前复验（2026-11-14 晚，批3 五单追平 tip 3dbbb173e，用户令六要素缺一不算完成）**：3 车道（M=#5782 series、R-A=#5198+#5252、R-B=#6320+#4666，五树独占 worktree+唯一日志）六要素全链重跑：五单 range-diff 全 `=`、am 即进树逐字节一致、矩阵全绿（唯一红 TestMothX/TestHostToldTheGatewayAddress/linux wails `undefined: pointer` 全部 base 归因预存）、消融全回红、兄弟面零新面、实证按原帖形态（live 缺口如实 Not verified）；五帖全发布+GET 回读，远端分支 ls-remote 全核对；patch 产物落 B3-5198/B3-5252/B3-5782/B3-6320/B3-4666（#5782/#4666 patch 逐字节同旧=窗口内零上游变更；#5198/#5252/#6320 sha 变=gateway 面上下文行变、语义零漂移）。新判例三条：①复验前 worktree 检出本地 ref 落后 origin 正本（显式 SHA 推送不动本地分支）——开工先 `reset --hard origin/<branch>` 对齐；②`--force-with-lease=<ref>=<sha>`（= 分隔）lease 不生效按普通 push 拒——冒号语法 `<ref>:<oldsha>`（三车道同踩）；③shell 环境吞 refspec 字符（`:refs`→`efs`）——关键参数加引号。推文批3 待用户发。
- **B4 投递前复验（2026-11-15，批4 五单追平 tip 705d67efc，同用户令）**：3 车道（M=#5273 series、R-A=#5260+#6131、R-B=#5411+#5465，五树 mg-b4*+唯一日志）六要素全链：五单 range-diff 全 `=`、am 树一致、矩阵全绿（预存红全 base/tip 对照归因：TestMothX、TestResolveVia、cli 3 红、race 抖动族；TestProxyCheckSaysAProxyPassedBy 升级为单跑也红=上游窗口内环境型，base 同红）、消融全回红（#5273 浏览器 0/20+budget 门牙实锤）、兄弟面零未处置新面、#6131 真二进制沙盒复现超原帖；五帖全发布回读（6887930982/6888383719/6887749400/6888123967/6888379284），远端 ls-remote 全核对；patch 产物 B4-*/。#5273 判例：0002 与上游同 budget 常量行冲突→语义合并（上游 1_270_431+我方 278）；上游 lazy-chunk 瘦身使上调成余量（非必要），如实披露由维护者定。推文批4 等批3+#6601/#6602 验收门槛（用户定版）。
- **B5 投递前复验（2026-11-15，批5 六单追平 tip 5bd41301b，同用户令「批5 也这样做」）**：3 车道（M=#6336 11 提交系列+#3197、R-A=#5908+#5923、R-B=#5914+#5969，六树 mg-b5*+唯一日志）六要素全链：am 树全一致、矩阵全绿（预存红全 tip/base 对照归因；#5923 cli 4 红含 5bd41301b 自带 TestEveryRouteHasACommandOrIsNamed 新预存）、消融全回红、六帖全发布回读（6889296873/6889428908/6889124971/6889268600/6888940429/6889129458），远端 ls-remote 全核对；patch 产物 B4-5908/B4-5923/B4-5914/B4-5969/B4-6336/B4-3197（沿 B4- 前缀目录）。升级两例：#6336 浏览器 24/24 真跑消掉原帖 Not verified、#3197 新 event: 写侧站点同族缝排查。非 `=` 两例全披露：#6336 第 2 提交 fromSameSource 语义融合（well-known kind-strict 前置拦 sameGitRepo 漂移）、#5914 四处上游强制吸收。上游新预存红入册：TestEveryRouteHasACommandOrIsNamed（5bd41301b 自带）；上游真 bug 披露：clone() 缺 Resolve map（#5914 帖，未扩改）。推文批4/批5 同等批3+#6601/#6602 验收门槛。

## 逐单台账（M=主线程 R-A/R-B=子智能体）

| 单号 | 帖 id | head16 | patch sha16 | tip 基 |
| --- | --- | --- | --- | --- |
| #3197 | 6869315954 | 53f761c184554ecc | 876c9fc95e77f8d6 | f53c4a1a1→eb1b83000 | → **B5 复验追平 5bd41301b：head 3fbd5e0213792a71 / sha b780e66f45fc630d（上下文行变）/ 帖 6889129458（gateway 全量 958.8s 零红，消融双红逐字同原帖；新 event: 写侧站点全部本地成对写=无同族缝）**
| #3254 | 6868654954 | d6f72ab0900d5e98 | b14aeb1bb6b32591 | f53c4a1a1 | → **已收编 v0.1.4130（284b22172，author 保留，patch-id 实证）**
| #3356 | 6868713111 | e94c150839784940 | 301fbfd2f9e8108e | eb1b83000 | → **已收编 v0.1.4130（4082f6d00，author 保留，patch-id 实证）**
| #4144 | 6868883652 | 48d18e31d3528b6a | 419d74d389c68d4a | eb1b83000 | → **未合入（维护者审完给 spec 在各自 issue：#6288 拆两分/#4144 需跳帧真修法）**；**用户令 2026-11-15 暂不上线（不 rework 不投递）** |
| #4258 | 6868799703 | 57ef507fd47213d8 | c9663118cd5ad6ac | eb1b83000 | → **已收编 v0.1.4130（1dbd3bb07，author 保留，patch-id 实证）**
| #4666 | 6868968760 | f7ecd0bd9fbbdc0b | e04902cbd80e38d3 | eb1b83000 | → **B3 复验追平 3dbbb173e：head c1a906ad771b96c1 / sha e04902cbd80e38d3（逐字节同旧）/ 帖 6878746525**；**已收编进 main（5aa365349，纯改动行逐字节一致=patch-id 差异仅上下文行号漂移，author 保留；版本号已回填 v0.1.4220）** |
| #4785 | 6869105729 | 38a7e7e3f992eec4 | 719447a6508d0554 | eb1b83000 | → **已收编 v0.1.4130（f12a1f79d(Dopetaiga)+6cc70b2b3(维护者另补 deskCatalog)，author 保留，patch-id 实证）**
| #5197 | 6870531265 | 13b5b423e87edbd8 | 36f572bcc038ba02 | 925bc7188b/8ed2ae030c | → **已收编 v0.1.4174（131037e2b(NightGlowww)）**
| #5198 | 6869319047 | 4744f5491029a893 | 930ea4297e87ace1 | eb1b83000 | → **B3 复验追平 3dbbb173e：head 502ba6017f066bfd / sha da7a7ccb0a01e238（上下文行变）/ 帖 6878357362**；**已收编进 main（c747ecfa6，patch-id d4ccf0da385b9d79 相等，author 保留；版本号已回填 v0.1.4220）** |
| #5205 | 6869277681 | ff919f08cb6264cd | ef76ec315fb6ff55 | 92e760f3d | → **已收编 v0.1.4174（a49f3745e(SkyJiashu)）**
| #5252 | 6869319562 | a7d3ff5d3e54ab3f | 09728f4d60077221 | eb1b83000 | → **B3 复验追平 3dbbb173e：head dddd43d768cade59 / sha 480f23e84f0645e4（上下文行变）/ 帖 6879163916**
| #5260 | 6870387012 | 91e05dd4f7f7f503 | 90aa470aa5f62232 | 925bc7188b | → **B4 复验追平 705d67efc：head 08d144bf7e4aeb1c / sha 90aa470aa5f62232（逐字节同旧）/ 帖 6887930982**
| #5273 | 6869183293 | 08d58f1d8627078 | 2d0a4ab7+d4c2864b（series） | eb1b83000 | → **B4 复验追平 705d67efc：head 73b82dc3e4759c88 / sha 02897415+7bb2fd5e（0002 语义合并：上游同常量行冲突，coreScriptBudget=1_270_431+278=1_270_709；上游窗口内 core scripts 瘦身使上调成余量，旧门 1_268_961 红实锤 1270179 over）/ 帖 6887749400**
| #5411 | 6869639391（已勘误） | 776803650d5bea85 | 16bbe81e4a61eb9c | 92e760f3d | → **B4 复验追平 705d67efc：head b2ad2612f7b37b8a / sha 1e403c33309860ea / 帖 6888123967（gateway 全量+race 零红）**
| #5452 | 6869678685 | 6d29c05880a96f63 | 23ac5613840d94a8 | eb1b83000 | → **已收编 v0.1.4174（fee33668d(ggbdpq)+7a9c40413(维护者审查:只放行 PDF)）**
| #5465 | 6869838250 | fb0475ff5ed491a2 | 6d4f372e6e46e96b | 6c88d61f0 | → **B4 复验追平 705d67efc：head 348f5877136b25a0 / sha d542e4d0b7f72115 / 帖 6888379284（race 4 红 tip 对照 5 红零新增）**
| #5782 | 6870002358 | c035ec5ce3ca4ccb | efb5a47c+fdaa96d7（series） | 8ce32d700 | → **B3 复验追平 3dbbb173e：head 358ad7cf1d79cd18 / sha efb5a47c+fdaa96d7（逐字节同旧）/ 帖 6877670772**
| #5908 | 6869824328 | 066628648+80d943a47 | 46bf961e+c1dbfcd4（series） | eb1b83000 | → **B5 复验追平 5bd41301b：head 23947aa52e288243 / sha 46bf961e+c1dbfcd4（逐字节同旧）/ 帖 6889296873（gateway 全量 900s+race 1722s 零红，消融双刀五 FAIL）**
| #5914 | 6870389076 | efedb81bb1b55179 | 86f06740e90836d5 | 925bc7188b/27e43ed26 | → **B5 复验追平 5bd41301b：head 4e2cfb489d7306f3 / sha a25b8a0653464dfd / 帖 6889124971（range-diff `!`：4 处上游强制吸收帖内披露，修法本体零漂移；修正上轮 3 族未锁写入面说法；暴露上游 clone() 缺 Resolve map 真 bug=TestProviderSetResolve 稳定红，帖内披露未扩改）**
| #5923 | 6869319957 | 31cf813f07e51f5b | 9cfc79685bcc88e4 | eb1b83000 | → **B5 复验追平 5bd41301b：head 3ace44c343bcfc68 / sha 9cfc79685bcc88e4（逐字节同旧）/ 帖 6889428908（cli 4 红 tip 基线同红含 5bd41301b 自带 TestEveryRouteHasACommandOrIsNamed）**
| #5969 | 6870391324 | ef20ebb347bc755e | f1c5678f85317575 | 925bc7188b | → **B5 复验追平 5bd41301b：head 78ea9e259cd29556 / sha 659a49e43ba85555 / 帖 6889268600（零冲突零漂移，消融双红）**
| #6131 | 6869409449 | 1c7b8aabe1555e12 | be6e4815a19d2e31 | eb1b83000 | → **B4 复验追平 705d67efc：head 13b6912e917e7282 / sha be6e4815a19d2e31（逐字节同旧）/ 帖 6888383719（本轮新增真二进制沙盒复现）**
| #6288 | 6869895126+附言 | bf85d3e5a7be2663 | 27fbdcf6+0d861bea（series） | 8ce32d700（全量证据 eb1b83000 帖内披露） | → **未合入（维护者审完给 spec 在各自 issue：#6288 拆两分/#4144 需跳帧真修法）**；11-15 对账：报告者 HKTPlay 自交付补丁 1（帖 6880506157，含真机 run+消融红），我方 rework 待办撤销；**用户令 2026-11-15 暂不上线（不 rework 不投递）** |
| #6320 | 6869753300 | 7e51b1361a8ae06f | 2915734be3070f7c | eb1b83000 | → **B3 复验追平 3dbbb173e：head 33b25b49448ce921 / sha 7b8bf972aab0fc0b（上下文行变）/ 帖 6878452788**；**已收编进 main（dac251b5f，patch-id 1c54896aac14245d 相等，author 保留；版本号已回填 v0.1.4220）** |
| #6336 | 6870393492 | 97dbb07071a7a69e | 9b3adb02a19f9c48（11 提交系列） | eb1b83000 | → **B5 复验追平 5bd41301b：head d46749c01190ad3a / sha f40f3ccdc96e206e（聚合，文件级 cat 口径与台账 9b3adb02 同配方验证）/ 帖 6888940429（range-diff 10/11 `=`，第 2 提交 fromSameSource 与上游 subagent-import 语义融合=well-known kind-strict 分支前置；浏览器 24/24 真跑消掉原帖 Not verified；消融 8/10 红逐一致；found-skill-pick-remove 9 fail/bili-settings 3 fail=base 同红预存）**
| #6391 | 6868832041 | cb4ff36a655edbfe | 853983c6d927ffa1 | eb1b83000 | → **已收编 v0.1.4130（8cd8cf31b，author 保留，patch-id 实证）**
