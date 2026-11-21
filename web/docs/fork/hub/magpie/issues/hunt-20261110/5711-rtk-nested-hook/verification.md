#5711 刷新+完善（REFINE）2026-11-10
head d4a45281c45b（rebase 7e5cebb86 v0.1.3435，零冲突）
patch sha256[:16]=9c8df54ac202e5cd，干净树 am 即进
新增：嵌套 [hooks.PreToolUse.hooks] 形态（laweit-lxy 报告）+TOMLWithout projects 剥离（#2278 跟进）
新测 TestRTKCodexTomlNestedHook 修前红修后绿；TestRTKCodexTomlHooks/GainWritable 绿；library 全包 82s ok；GUI 6/6
消融三处新基点回红（嵌套读取/has 单源/writable_roots 写点）全还原复绿
兄弟面 codexTomlHookIn 唯一读者；fc8e98ba4 已并
帖 6745834319 回读 ggbdpq 2587B
