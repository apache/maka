# L17 车道笔记（2026-11-14 批量 rebase 到 upstream/main a8fa771a63）

TIP = a8fa771a63d1b337d52c5376544c4ea11236da76（开工 fetch 实测，全部单 rebase 到同一 TIP）。
9 单 old sha 均 ls-remote 实测与任务书一致。

## #4899 hunt-20261111-r1-4899-rework@6e4e0ae42 → RESOLVED-PUSHED 15fbdfffb43c8c9c

- 结论：双保留，push。
- 上游侧：05cadcafd（sync: a provider can stay only on this device）在 Provider struct 加 ThisDevice 字段、GUI 保存保留逻辑加 `in.ThisDevice = old.ThisDevice`；与我方 CarryCid 字段（translated 路透传 X-Cid header）语义独立、相邻插入。
- 解法：provider.go 字段区与 gui/providers.go 保留区两侧新增都保留（ThisDevice 在前，CarryCid 在后），gofmt 对齐；全部触点（cli 5、gateway 4、测试文件、gui 1、provider 2）核对在位。
- new sha：15fbdfffb43c8c9c00cafa781694f2a15eb9c749；go build 绿。

## #5692 fix/5692-provider-failwords@d175626fd → RESOLVED-PUSHED 59aacd713fb4559c3

- 结论：normalize 相邻新增双保留 + 修复 auto-merge 丢失的 regexp import，push。
- 上游侧：a95a7a1cd（each API key can bill at a price rate of its own）在 normalize() 加 `p.KeyPriceRates = normalKeyPriceRates(...)`，与我方 `p.FailWords = normalFailWords(...)` 相邻。
- 解法：normalize 两行都保留；build 红发现 fallback.go import 块的 `"regexp"` 在 3-way 合并中被上游 import 区改动挤掉（我方 `spent *regexp.Regexp` 字段还在），补回并 amend。
- new sha：59aacd713fb4559c3a1c6e7a9681f360b90a3208；build 绿 + TestFailWords 定向绿。

## #5914 hunt-20261111-rf-5914@02d76378f → RESOLVED-PUSHED a41c0243ea0fcab4

- 结论：三文件语义重建（import 双保留 / 双函数共享插入点 / editFound 重构保留并搬入上游 KeyPriceRates）+ 修一处混入的旧返回签名，push。
- 上游侧：account_caps.go 冲突点=上游 d0fb3c008（Claude extra usage）新增 extraCapped() 与我方新增 Room() 同插入点（共享尾部闭括号）；keys.go ReplaceKey=上游仍是 Find+Save 直写、新增 moveKeyed(p.KeyPriceRates)（a95a7a1cd），我方 patch 把整函数改成 editFound（并发写保护）；key_spend.go=import 块上游加 dayzone/settings、我方加 maps；provider.go 无文本冲突但 auto-merge 把上游 97bc02df0 的 Resolve 检查（旧 `error` 单返回形态）混进我方改的三值返回校验函数（`(Provider, bool, error)`）。
- 解法：key_spend import 按上游混排字典序融合；account_caps 双函数都保留（extraCapped 闭括号 + 空行 + Room 体，共享尾括号）；keys.go 保 editFound 结构、闭包 moveKeyed 列表补 `moveKeyed(q.KeyPriceRates, keyRef, now)`（上游 a95a7a1cd 语义：换 key 时每 key 价格倍率跟走）、尾部保 `return keyRef, now, nil`（editFound 内部保存）；provider.go 两处旧式 return 补成三值。KeyPriceRates 确认为我方基线后上游才加（基线 rg 0 命中）。
- new sha：a41c0243ea0fcab47de88ade58ff71e160a871fd；build 绿 + provider/tui 包测试绿。

## #5935 fix/5935-unreadable-providers-file@99c5704db → RESOLVED-PUSHED 863bbd57deae3ba0

- 结论：Resolve 冲突保我方 FileError 门槛、返回形态随上游指针化，push。
- 上游侧：Entry.Provider 由值 `Provider` 变 `*Provider`（"shared, read only"），groupEntries 命中分支返回改 `*e.Provider`；我方 patch 在该分支前加 auto- 组 + FileError 门槛（#5935 核心：providers.json 读不了时不从内置订阅猜）。FileError 本身是基线已有上游函数（非我方引入）。
- 解法：冲突分支=我方检查块 + 上游 `*e.Provider` 返回；patch 其余 4 个防御点（gateway 503、GroupFor、resolveIn、ownRouteIn）auto-merge 核对在位。
- new sha：863bbd57deae3ba01debadb02fac50cfbca918c7；build 绿；gateway 定向（TestUnreadableProvidersFile|OwnFirst|OwnRoute|BareName|GroupFor）绿；provider 全包唯一红 TestResolveVia 经干净 TIP 对照同红（gw.invalid EOF，本机代理环境预存红，与本单解冲突无关）。

## #4144 hunt-20261112-t1-4144@eb23419a0 → RESOLVED-PUSHED 367ce6f8a4056445

- 结论：两级版本表逐条合并，push。（第一提交 1ad0bc29f 干净落地，冲突在第二提交）
- 上游侧：call_cache.go callParseVersions 与 sessions.go parseVersions 两条 map 被上游扩展（agy 1 / pi 1 / raft 1 / cindy 2 等新条目）；我方 patch（author=vincent，第三方单）加 dsh 1（call）与 dsh 4（parse）——坏帧不再跳过的读取行为变化只影响 dsh，按 873b4987e 两级方案不升全局 cacheVersion/callCacheVersion（注释 v16 行已在自动合并区）。
- 解法：两 map 都取上游最新全集 + 我方 dsh 条目与注释（cindy 取上游的 2；callParseVersions {agy:1, antigravity:1, cindy:2, codex:3, dsh:1, pi:1, raft:1, zcode:3}；parseVersions 同集且 dsh:4），calls-v15/29 主版本不动。
- new sha：367ce6f8a405644573957876adbba931250f6a9b；build 绿 + sessions 全包绿。

## #5710 verify/5710-antigravity-step-speed@a6dee3b9f → RESOLVED-PUSHED 31b53746a3da4cc4

- 结论：callParseVersions 合并=上游最新全集 + antigravity 升 2，push。
- 上游侧：同区上游扩展（zcode 3 / agy 1 / pi-raft-cindy 2）；我方 patch 把 antigravity 1→2（call keeps its step's time and first token (Millis, TTFT)）。
- 解法：上游全集 + antigravity: 2，我方注释行接在 antigravity 1 注释后；其余触点（calls.go、antigravity_app.go、ledger.go、docs、page.js、两测试文件）auto-merge 核对在位。
- new sha：31b53746a3da4cc4779428592b3caee87c0eff16；build 绿 + sessions/usage 全包绿。

## #5064 fix/5064-opencode-v2-providers@5241d3dba → SUPERSEDED（分支原样 5241d3dba，abort）

- 结论：冲突区上游已实现同一修复，不硬解不硬推。
- 证据：上游 03a800ac6「agent: OpenCode 2's config in its own words (kaising00 on X)」（2026-11-10，#5064 交付 11-04 之后）新增 internal/agent/opencode_v2.go 的 ocFile：按「哪个 OpenCode 读文件」（openCodeTwo 版本探测）统一决策——OpenCode 2 只写 providers 拼写、v1 provider.magpie 不写（two 分支），已有的 v1 块被 moveProvider 搬到 providers 并删除；OpenChamber 同一决策（提交消息明言 + openchamber.go file() 同构）。上游测试 TestOpenCode2WritesItsOwnWords、TestOpenCode2MovesAnOpenCode1File（断言 provider.magpie 不留）、TestOpenChamberAndOpenCode2AgreeOnWords 直接覆盖 #5064「每次启动回填 v1、用户删除不持久」的诉求。
- 我方 patch 的实现前提（agents.go/openchamber.go Sync 用 edit.GetJSON+SetJSON+syncJSONInOrder 直写 v1 key）已被该重构整体推翻，openCodeNativeOn「文件形状」判据与维护者「版本探测」判据是方向选择，残余差异（探测失败时的文件形状兜底）属设计分歧，按 DEFER/SUPERSEDED 出口停发报告。

## #5100 fix/5100-drift-own-claude@c6eded857 → RESOLVED-PUSHED 42ab9a87ddc39551

- 结论：lastJSONLTime 变参签名与上游 inMagpieWork skip 融合，push。
- 上游侧：上游在同区加了 inMagpieWork skip（ifccod7391564 on X：magpie 桥在 magpie 工作目录给的 prompt 也进 history.jsonl），lastJSONLTime 仍是单 skip 参数；我方 patch 把签名改变参并加 own-session skip（usage.IsOwnSession(sessionId)，#5100）。
- 解法：变参签名保留（我方核心），循环补 `s != nil` 防御（兄弟面 codex.go:2331、codex_profile.go:193 现传 nil，上游原代码本有 nil 检查）；claude.go LastUsed 传两个 skip（inMagpieWork + own-session 闭包），注释融合两来源（#5100 + ifccod7391564）。
- new sha：42ab9a87ddc39551c3bb6c97a679eda799578de3；build 绿 + agent/gateway 定向绿。

## #5476 fix/5476-appserver-switch-resume@aa5d8fd4d → RESOLVED-PUSHED 21ee5bee1ac358aa

- 结论：provider 注释块「either」措辞重锚进上游 crashSpent/unasked 新段；docs 按惯例上游新文本保留、我方增补重锚，push。
- 上游侧：961427f12（crashSpent——used-up 账户 switch 后不经 RestartApp 直接 reopen，RealZeroP27）与 15acba534（unasked 保护，Michael25651150）扩展了 codex_app_crash.go 顶部注释与 agent-wiring.md 同一条超长 bullet 的中段（identity 侧边栏项目段）；我方 patch 在该 bullet 尾段加 resume-failed 形态描述与 codexCrashLines 措辞。两处改动在同一行的不同区段。
- 解法：provider 侧注释=上游新段落（crashSpent/RestartApp unasked）全保留 + 首句改「a line of either」；docs 用 python 锚点替换（上游 bullet 为底、两处措辞重锚：「; sometimes the same identity error…(websocket_reconnect_thread_resume_failed…; ZeroP27, #5476)」与「for a whole line of either stamped after the end (`codexCrashLines`; …). When one shows…」），上游新增 bullets（deskList、.codex-global-state.json）原样保留。
- new sha：21ee5bee1ac358aaac3397b26ef2363c57f397c9；build 绿；TestCodexApp* 绿；provider 全包唯一红 TestResolveVia=预存环境红（同上对照）。

## 本车道汇总

- RESOLVED-PUSHED 8：#4899 #5692 #5914 #5935 #4144 #5710 #5100 #5476；SUPERSEDED 1：#5064。
- go build 全绿：8/8（每次 rebase 后实测 exit=0）。
- 预存红记录：TestResolveVia（internal/provider，gw.invalid EOF，干净 TIP 同红，本机代理环境）——两单（#5935/#5476）provider 全包验证时如实区分。
- 不自信点见各段；总体：#5914 keys.go 的 KeyPriceRates 搬入位置（KeyOwnBalances 后）为语义等价选择、map 顺序无关但与上游原序不同；#5100 变参化对上游两处 nil 调用方的兼容靠 nil 防御，属最小改动但签名形态（变参 vs slice 参数）是维护者口味问题；#5064 残余 edge（openCodeTwo 探测失败时的文件形状兜底）未交给维护者裁决，若主线程认为值得跟进需另议。
