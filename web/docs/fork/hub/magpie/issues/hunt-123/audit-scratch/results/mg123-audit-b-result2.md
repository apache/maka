# hunt-123 审计扩轮车道 b（r2）结果 — 2026-11-05

#2950 | patch(GUI cjs 稳化) | 1✓ls-remote=f7ee701492a240181d174fab68e8aa8c37048757 一致 2✓am-3 干净落 681a472ca(最新tip,帖基线dabb5722f) 3✓sha256前16=3e26b91102c977f4 4✓sidebar.test.cjs 双引擎 18/18 pass fail0(帖16/16,tip多2 subtest,如实记) 5✓消融navSubEnter bare return→fail4红"the list unrolls"与帖一致→恢复复绿 6✓兄弟面=provider-advanced-fold boxMoves 137/139/152 单采样如帖,其余getAnimations均为等待式 7✓Not verified(load~175)如实保留 8✓yeton credit+Attribution一次 | 实跑:NODE_PATH=pw162(1.62.0) node --test sidebar.test.cjs;消融同法 | PASS | 无

#2982 | patch(Go测试稳化) | 1✓ls-remote=3f6b58b26f517c653e29001bbe81456948bfc5a7 一致 2✓am-3 干净落 681a472ca 3✓sha256=a092245dc425d5a6 4✓TestDsh定向ok 4.1s+agent全量154.5s仅TestMothX红(预存红清单)+gofmt空+vet净 5✓消融=摘dshTempHome retry+time import→TestDsh绿(与帖一致:macOS不可能红,Windows如实Not verified)→恢复复绿 6✓DSH_HOME兄弟10+文件照旧未动,helper恰7调用+1定义 7✓Not verified Windows保留 8✓lokic7123-star credit+Attribution | 实跑:go test -tags nogui -run TestDsh ./internal/agent;全量-timeout 25m | PASS | 无

#2990 | 判定帖(分型2核帖门) | GET回读6639590334✓落readback.json ①机理可追溯✓(cline_pin.go/affinity.go deepseekCold=1h/opencode_session.go/upstream.go finalProvider均在tip核实) ②版本SHA✓(f24829636与fa22bc646 cat-file可解析;log -S clinePin仅引入commit 1b025b3fa;f24829636..tip 对cline_pin/affinity零改动,结论未被推翻;plainCompactMax=400_000属codex compaction非routing,不冲突) ③credit✓thesixgod6 ④AI use✓ | 无需跑测试(判定帖) | PASS | 无

#3042 | 判定帖(分型2核帖门) | GET回读6639325480✓落readback.json ①机理可追溯✓(zcode.go两个outputOr(m,zcodeOutput(maxTokens(m)))>0守卫L146/L522;zcodeMaxOutput=128000;replyLimit=Provider方法models.go:3388;TestZCodeOutputAndReasoning存在) ②SHA✓(f24829636af可解析;0ad9661b6为f24829636祖先;zcode.go自f24829636..tip零改动,结论未被推翻) ③credit✓huangchulan578527086-netizen ④AI use✓ | 无需跑测试(判定帖,零代码) | PASS | 无
