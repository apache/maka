# t1-L3-5260（2026-11-12）

处置：✅ PATCH（真修复，无第三方竞争；key_env 在场时 api_key 写成 ${key_env 值} 引用而非字面量回环 token）
- take: 6825191793；patch 帖: 6825220542（GET 回读一致）
- 分支: hunt-20261112-t1-5260 @ 6ba7ffbc0e306f06（基 e2afa3931）
- patch sha256[:16]=8c8cf7f3e7bc127f；am 回放 e2afa3931 树一致 c5f8bda06d0d2a85；author=ggbdpq+Generated-by 尾注
- 六要素：RED 断言级（TestHermesWithAKeyEnvStaysAReference "api_key written as magpie"）→GREEN→消融（退 hermes.go 至父 ea3a00adc 保测试→逐字同形红→复绿）→兄弟面（goose/vibe/reasonix 保留用户 env 选择=不改；jcode wire 写内联 key=外部语义不可证，帖内留 follow-up）→实证（macOS 宿主，Docker 401 面取报告者 curl A/B+identifyCaller 读码，Not verified 如实）
- 验证矩阵：hermes 族+race 双绿；agent 全包 297s 唯一红 TestMothX=预存红（父 7199afbb6 detached 同红）；vet darwin+windows 净；gofmt 净；GOOS windows/linux build 过
- 事故自纠：首次提交误落 4785 分支 → reset --hard 恢复 d349bc957a（与 origin 一致）→ cherry-pick 到新分支 hunt-20261112-t1-5260
- 语义设计：api_key 引用 > key_env > magpie key（用户显式引用最优先）；坏状态自愈（字面量 token+key_env 并存→下次写回引用）；.env 变量不动（keyHolds 早退）
- 失败读取语义：key_env 空/读不到 → helper 返回 "" → 行为同今天
- 不自信点：Hermes 双字段并存（api_key 引用+key_env）的展开优先级未真机验证（引用展开同变量→发送 key 不变的论证依赖报告者 A/B 的字面量优先实测）；jcode 形状存疑但无法本地核证
