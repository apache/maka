# 34 支六要素验证总表（2026-11-06 收官）

> 基线：upstream/main `326e72f4c`（全链重验锁定）；收口批测对 `60fe6645a` 33 支 CLEAN 零新冲突。
> 六要素=实际 rebase 到当前 main / git am 即进 / 分支+sha256 / 测试实名绿 / 消融回红 / 兄弟面全查；PATCH 原帖三处换+GET 回读零残留。
> 证据源：L1/L3/L5/RL2/RL4/RL6 六车道报告 + 合并保障轮 R3/R4/R5。

## 批 1（18 支，可发）

| 单 | rebase | 测试（实名绿） | 消融红→绿 | 兄弟面 | head | sha256-16 | PATCH 回读 | 例外 |
|---|---|---|---|---|---|---|---|---|
| #4069 催点 | 干净 | TestGeminiToolImageLastTurnGetsAUserTurn+族5 | ✅ | 无漏网 | b00493c93 | 3c16af42082032b3 | OK 6620004624 | — |
| #4169 催点 | 干净 | TestFailedSystemProxyReadsBackOff+全包 | ✅ | fork 唯一 | 4c9616c35 | 359a829d7acdb273 | OK 6620042590 | — |
| #4978 催点 | 干净 | TestClaudeTUISafeguardsOverOneEnvEntryRefused+3 | ✅ | 无新漏网 | 7d7a0c4bf | 82226441dafaabc2 | OK 6613921262 | — |
| #4987 催点 | 干净 | TestSharedSkillReachesZCode+全包 library | ✅ | 同列表闭合 | eea905b0f | d28394ad16850356 | OK 6613698200 | — |
| #5030 催点 | 干净 | TestDeepSeekRelayChatGetsMaxTokens+族8 | ✅ | 双通道无窄门 | 9ab0fcbec | 979a60d883d96e44 | OK 6619148639 | — |
| #5087 催点 | 干净 | TestReadMistralBudget 等5+全包 provider | ✅✅ 双消融 | 无漏网 | a4763140e | 289367974bcb5dcd | OK 6636583817 | — |
| #3510 清账 | 326e72f4c@918906a6a | TestRemoveProjectWhoseFolderIsGone | ✅（main红/叠patch绿） | projects_test 20 邻绿 | 918906a6a | — | OK 6660563344 | 全量套件/-race/GUI 未跑（原口径声明） |
| #4678 清账 | bce9dd085 | plugin 3测 | ✅ 三红点名 | 全 diff 逐段核 | bce9dd085 | c8fa0ae5c9a7ee56 | OK 6660960859 | TestHostToldTheGatewayAddress 预存红（父同红） |
| #5085 清账 | 80e239bf2 | TestUsageReadDeferredIsNotAFailedRead+KeepsItsReadTime | ✅ 双红精确 | — | 80e239bf2 | — | OK 6661176764 | — |
| #4030 | no-op（前身已 rebase） | gateway 15 测+cli+provider 字段 | ✅ 三点红 | orderBy 单点闭合 | d28368d54 | 8c5e04887250f115 | OK | — |
| #4995 | no-op | TestParseClaudeUsageCountsSayRequests | ✅ 逐字红 | 四读者无涉 | 9e7333814 | d1c9dd67ea0e3602 | OK | — |
| #4980 | no-op | TestRescanAsksLatestAgain+LooksAgain | ✅ 逐字红 | 三键族全覆盖 | 561b9437 | 28540b22d4602ff0 | OK | — |
| #4335 | no-op | TestRestartReplaced+TestUpdateRestartsTheService | ✅ build break 红 | 单点三调用 | a731ec402 | 9f19b3fb6f9ce359 | OK | — |
| #2935 亲单 | no-op | agent-expand-steady 4/4（webkit+chromium）+邻12 | ✅ 探针复现 746 逐字 | 2 同型已披露不动 | 5119cf5c5 | bb22fda4233ea2aa | OK 6644074551 | — |
| #2950 亲单 | no-op | sidebar 18/18+邻68 | ✅ 三连消融 | 1 同型原帖已披露 | bc48ee0e8 | 30ce6c060f415078 | OK 6644147609 | — |
| #2965 亲单 | no-op | TestRequestBuildsProvidersOnce$ count=5+-race count=4 | ✅ 三连消融 | delta 计数无同型 | a2a64142a | 31eeafe08c83c229 | OK 6644273220 | — |
| #2982 亲单 | no-op | TestDsh 族（4.5s） | ✅ 摘除绿/恢复绿 | 7 调用点=原帖七测 | d605bb498 | 9d0adc9365656b42 | OK 6644094979 | **Windows 消融红 NOT-RUNNABLE**（darwin 不可复现，原帖同限声明） |
| #3078 亲单 | no-op | lightweight 8/8 ×2 | ✅ 4/8 红坐标逐字 | 63 文件同型原帖口径不动 | 326fe9dee | eb3285b2ec43e801 | OK 6643797602 | 帖内 f24829636 残留 1 处=新 patch 内文历史记录（合理保留） |

## 批 2（15 支，可发——#4972 出列后）

| 单 | rebase | 测试（实名绿） | 消融红→绿 | 兄弟面 | head | sha256-16 | PATCH 回读 | 例外 |
|---|---|---|---|---|---|---|---|---|
| #3866 | **真 rebase** b538b096a | agent 三测+uninstall 全包 | ✅ tests not build 红 | TakeLeftovers 单点闭合 | b538b096a | f2ef5ad4714d78ab | OK | **语义融合**：上游 TestKeepData 不含 leftovers 步，按 TestRunOrder 融合 amend |
| #3936 | 干净 | TestImagesAPISizeReachesTheGeminiAPI+CodeAssist | ✅ | 两处原帖声明保留 | 17f51b28b8 | 8013d53f471733c2 | OK | — |
| #3937 | 干净 | TestGeminiGenConfigReachesTheGeminiAPI+DrawModel | ✅ | Vertex 同走已核 | ab6faa9f64 | 9ec735fd8236fda4 | OK | — |
| #4040 | 干净 | TestEveryVendorsOverflow+ByteCap 族 | ✅ | tooLongRe 单 funnel | 50f1d85e84 | f11a0d0473bdc4aa | OK | 首轮回读抓措辞偏差已二次修正 |
| #4087 | 干净 | 三测+redact 全包+pii/guard/coreml/masking 邻包 | ✅ | 消费方闭合 | 1d307368ec | 238034bfc86aa3c2 | OK | — |
| #4175 | 干净 | ProbeRefusal 两测+四族 | ✅ | 其余调用方全传被查 model | 646f148dd9 | 4c058d980e93e430 | OK | — |
| #4972 | ~~f80aeddac no-op~~ | ✅ 7 测 | ✅ 逐字 | ✅ | f80aeddac | — | OK 6611597963 | **⛔ 出列：上游 125fd93ec(v0.1.3060)+1100ed649(v0.1.3067) 已修同根因（主题带 #4972+Landed 帖×2），三文件全冲突，patch 退场转判定帖** |
| #5002 | no-op | TestTimestampIsNoSecret+HeadAndMore | ✅ 12 行全 masked 逐字 | 三入口随包生效 | 2380436c4 | 409320903e1397c4 | OK 双帖 | — |
| #4819 | no-op | go vet 双模式（帖内口径） | ✅ 恰 3 处警告逐字 | 全仓 3 调用点全 cast | fdb162c15 | fda99bf31a365820 | OK 6626153240 | gui 全包预存红已定性未重跑 |
| #5101 | no-op | 5 新测实名 | ✅ checkout HEAD~1 恰 2 红 | 应用点唯一 | 5bbad1af5 | 43d1785c14a9ae57 | OK 6631816968 | — |
| #5111 | **真 rebase** 4ce1a16aa | 3 测实名 | ✅ | quotaWords 自带覆盖 | 4ce1a16aa | 24edb2c67e4b202c | OK 6610713532 | 帖内中文=Go 词表正则源码原样 |
| #5024 | 干净 | TestCodexListedLevelsSayDescription | ✅ 4 项缺失 FAIL | /v1/models 消费者无校验 | c000849bdd | 97f074d633123367 | OK | — |
| #5082 | 干净 | TestSilentlyIgnoredFormatToldInWords | ✅ | refusal 分支互补 | d046d7428a | 4e9464e8fc3cef8d | OK | — |
| #4993 | 干净 | TestDAV123panConditionalRead+Sync | ✅ 精细消融 | 三处设计面一致 | a0e57a499 | ce42fc1c22985cad | OK | 短 SHA 一并换新 |
| #5006 | 干净 | TestRateLimitIsNotQuota | ✅ credit/rate 红 | 402 排除项无涉 | 1aee4ce1b5 | c5cf1f759835c4d1 | OK | 帖内中文=vendor 文案引用零新增 |

## 出局/在途外
- #4972：出列转判定帖（上游已修，见上）
- sha256 口径：zero-commit format-patch raw（帖内已注明口径；GitHub .patch URL 为第三种哈希已在 RL2 披露）
