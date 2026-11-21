# 主车道（M）解冲突笔记 · Cluster C 7 单（2026-11-14，tip=a8fa771a6）

| 单号 | verdict | 解法摘要 |
| --- | --- | --- |
| #4034 | RESOLVED-PUSHED `4c5b6d1c8` | docs 冲突=上游追加两表行（select-none 句扩展）vs 我方仅改服务层级行内 Ultrafast 插入句；解法=取上游整文件+重放我方该行（程序断言上游该行除我方插入外零改动）；**build 抓到异行语义漂移**：上游把 Entry.Provider 改指针，我方 hunk `UltraOn(e.Provider,…)`→`UltraOn(*e.Provider,…)` amend 修入 |
| #5273 | RESOLVED-PUSHED `997ff7a5b` | 预算常数冲突：上游 1_268_961（其自增累计）vs 我方 1_264_700（基 1_264_422+278）；合并=上游数+我方 delta=1_269_239，注释=上游全注+我方 +278 条目；**TestCoreScriptBudget 实测绿** |
| #5440 | RESOLVED-PUSHED `608c5258b` | 机制级三块：保作者 apple-ouyang 的 dirty 集机制（阈值按 distinct dirty 文件计），顺上游 a532b646e 的 on-去字段化设计（save(b.on) 带参、不复活 idx.on 字段）；usage 包 disk 测试族全绿 361s（含作者核心测试 TestRequestDiskOneGrowingSessionWritesOnce）；toDisk 实证 tip 仍整文件重写=未被超替 |
| #5463 | RESOLVED-PUSHED `50ca5ab49` | middleware 行=上游新 Kind 字段+我方 who/Key/KeyName；docs 字段列表=两侧插入并集（key/keyName+kind） |
| #5627 | RESOLVED-PUSHED `1f3c5fdce` | 注释冲突取上游新版（session/prev 句）；**两轮修正**：①误提交带标记文件→marker-search 重解+amend（流程失误自纠）②原提交 sessions.go +16 用旧 time.Time API、上游已改 modTime 类型（异行编译断）→modOf/.Time() 适配 amend；TestCoreScriptBudget 真红（超 365B）→按常数自身惯例 raise 1_268_961+365=1_269_326 带名加注（feature 代码已最紧、剩余为用户可见字符串不可压；落地时维护者再对行=判例预期） |
| #5418 | RESOLVED-PUSHED `9217c40bb` | 四块联合合并：gateway.go listKinds=上游 cherryStudio 段+我方 serves 维度（签名 5 返回、!ok 分支 return true,media,media,nil,nil）；providers.go 块1=MediaKinds（上游 chip 特性）与 Speech/Embed 四字段（我方）并集、块2=MediaKinds 填充循环+我方 speech/embeds 循环串联（括号配平手拼）；app.js=上游新行+插入 hiddenSpeech/hiddenEmbeddings 两字段；stray-brace 一次 build 抓回；gateway Kind 族+provider Kind/Speech/Embed 族测试绿 |
| #3208 | RESOLVED-PUSHED `6b084eddb` | go.mod=tip 行为基+x/net→0.60.0+go 1.26.10（x/sys 保 tip 更新的 0.49.0）；go.sum=上游侧后 GOTOOLCHAIN=auto go mod tidy 全量重建；build 绿（仅预存 ld warning） |

## 不自信的点（必填）
1. #5440：保机制+顺管道的适配未跑上游 noteBuilt 全语义对拍（dirty 触发与 savedRows 二档共存语义靠读码对齐）；dirty map 无容量上限，极长会话理论上限=会话文件数（作者原设计如此，未擅改）。
2. #5627：+365 预算 raise 是对原交付形态的偏离（原交付靠注释压缩抵扣——后实测证明注释不计入预算，原交付绿靠的是基线余量）；已按常数惯例带名加注，维护者落地时再对行。
3. #5418：listKinds 的 cherryStudio !ok 分支 serves 返 nil（Cherry 无法用 speech/embed）是我的判断非作者原文；"all" kind 不含 serves 同理（原 patch 代码如此）。
4. 全车道均未跑包全量套件（门禁=build+gofmt+定向测试，如实记录）。
