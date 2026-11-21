# magpie 逐单台账 · 索引（唯一入口）

接单前先到这里：**查这单做过没有、做过同构的没有、有什么坑**。本索引按子系统与模式家族组织；逐单全过程按时间线记在[编年全录](编年全录.md)（只追加，永不回写），本索引随事实更新，两者冲突以全录更晚轮次为准。

快速上手三步：

1. 在[总索引](#总索引按子系统)查 issue 号或子系统，看同类单的根因、修法与结局；
2. 在[模式家族](#模式家族避坑核心)对照本单是否落在已知家族，家族规则就是修法和避坑的起点；
3. 过一遍[避坑清单](#避坑清单)，交付时用[新单模板](#新单模板)。

狩猎方法论与验证手法在[05-缺陷狩猎经验](../handbook/05-缺陷狩猎经验.md)；哨兵巡检任务书在[07-哨兵任务书](../handbook/07-哨兵任务书.md)。

## 状态口径

| 标记 | 含义 |
| --- | --- |
| ✅ 署名合入 | patch 被 `git am`/cherry-pick 合入，author 或 Co-authored-by 保留 |
| ✅ 采纳自实现 | 维护者致谢 patch 后按其改良实现（多数保留署名） |
| ✅ 方向吸收 | 分析评论的边界/方向被维护者实现 |
| ↺ 同构取代 | 我方交付前后，维护者/竞品独立修了同一根因；登记保留，分支作废 |
| ↺ 让位 | 占坑复查发现报告者/并行会话已在做，不重复触达 |
| ✗ 被拒 | 维护者明示不采纳（附理由，是流程教训的来源） |
| ⏳ 等确认 | 已合入/已发版，等报告者或版本发布后确认关单 |
| 🗂 分析在案 | 分析/考证评论交付，无 patch，后续看维护者回合 |

## 总索引（按子系统）

全局号为记录时点的预算号；**Windows 本机轮与 hunt 轮曾并行记号，157–162 各有两单**（历史口径保留，查单以 issue 号为准）。

### gateway（协议翻译、流、模型发布）

| 全局号 | Issue | 一句话 | 形态 | 结局 | 检索键 |
| --- | --- | --- | --- | --- | --- |
| 99 | [#1341](https://github.com/yetone/magpie/issues/1341) | Responses 直通孤工具调用被上游 400 | patch | ✅ 采纳自实现 `b3330ea8`·v0.1.1125（合成结果放串尾） | MG-3·10-09 |
| 121 | [#1438](https://github.com/yetone/magpie/issues/1438) | /v1/models 的 output 超上下文窗口 | patch | ✅ 确认吸收 `7f62dbf3`·v0.1.1144（扩到全部发布路径） | MG-7·10-09 |
| 125 | [#1454](https://github.com/yetone/magpie/issues/1454) | Sonnet 5.5 拒 thinking disabled | patch | ↺ 同构取代（维护者三连修规则表） | MG-9·10-10 |
| 129 | [#1485](https://github.com/yetone/magpie/issues/1485) | 新 Claude 默认无 thinking 摘要 | patch | ✅ `6934853b`+`bfd5c82d`·v0.1.1159 | MG-17·10-10 |
| 131 | [#1558](https://github.com/yetone/magpie/issues/1558) | Messages 上游工具交换残缺直达 400 | patch | ✅ v0.1.1183 批 | hunt4 A1·10-11 |
| 132 | [#1559](https://github.com/yetone/magpie/issues/1559) | 翻译路径采样拒绝无自适应重试 | patch | ✅ v0.1.1183 批 | hunt4 A2·10-11 |
| 136 | [#1560](https://github.com/yetone/magpie/issues/1560) | Gemini 构造器缺打断调用的合成回应 | patch | ✅ `fa5ef88d6`·v0.1.1183 | hunt5 A·10-11 |
| 141 | [#1562](https://github.com/yetone/magpie/issues/1562) | Responses 流截断被当完整回复 | patch | ✅ `e435fe00f`·v0.1.1183 | hunt6 A1·10-11 |
| 165 | [#2074](https://github.com/yetone/magpie/issues/2074) | TokenHub 拒收透传的 web_search_20250305 | 分析 | 🗂 分析在案：透传系 #2027（`77f90fd8`）声明设计、1219/1230 对固定配置无代码差异（两版测试同绿），征询报告者配置+维护者边缘（声明 searches 遇部分路由不认的上游不回退） | hunt19 A·10-14 |
| 142 | [#1563](https://github.com/yetone/magpie/issues/1563) | 非流式翻译截断静默 200 | patch | ✅ `05cf7814e`·v0.1.1183（改 502 可 failover） | hunt6 A2·10-11 |
| 152 | [#1643](https://github.com/yetone/magpie/issues/1643) | Gemini 翻译路径流被掐断 | patch | ✅ `17c56ed2`·v0.1.1196 | hunt9·10-11 |
| 153 | [#1644](https://github.com/yetone/magpie/issues/1644) | Gemini 中继路径流被掐断 | patch | ✅ `e4e22b23`·v0.1.1196 | hunt9·10-11 |
| 163 | [#1916](https://github.com/yetone/magpie/issues/1916) | tool_search 历史条目被上游相位拒收 | patch | ✅ 根因采纳、实现被替代：无条件转 function `9492e5db8`·v0.1.1229；测试级+隔离网关端到端双复验通过，**10-14 确认关闭** | hunt17 A·10-13 |
| 164 | [#1917](https://github.com/yetone/magpie/issues/1917) | 历史图片重读，按轮次标注 | patch | ✗ 被拒：提示词层证据门槛=真实会话，纯文本断言不算 | hunt17 B·10-13 |
| 157 | [#1678](https://github.com/yetone/magpie/issues/1678) | wordsOf 转义解码漏改三处判读者 | patch | ✅ ping 后维护者关闭 | hunt11 A·10-12 |
| 158 | [#1679](https://github.com/yetone/magpie/issues/1679) | Grok 裸数字窗口 id 无价原样发出 | patch | ✅ ping 后维护者关闭 | hunt11 B·10-12 |
| 165 | [#2017](https://github.com/yetone/magpie/issues/2017) | codex-autoreset.json 读不了被当零花费 | patch | ✅ `e297a8ab2`·v0.1.1229（补丁之上改根因：读不了算未知，从 resets-used 重建）；测试级复验通过（实例级触发需周窗口用尽，未做已注明），**10-14 确认关闭** | hunt18 B·10-13 |
| 166 | [#2021](https://github.com/yetone/magpie/issues/2021) | omo 自更新用系统 npm 报 EACCES | patch | ✅ 维护者自实现 `27956002c`·v0.1.1230（署名 ggbdpq）：装着 OmO 的 node/bun 的 bin 置 PATH 最前；**10-14 真机 fnm 双场景对照确认关闭**（系统 NodeJS 前置→npm 走 Roaming\npm；omo 所在 node bin 前置→走回 fnm prefix） | 本机踩坑·10-13 |
| 170 | [#2167](https://github.com/yetone/magpie/issues/2167) | 远程 magpie 单模型 429 沉整个 remote | patch | ⏳ 已发待采纳——对抗式审核 0 阻断、5 条 P3 可选修订（见编年 10-14 晚） | hunt14 L4·10-14 |
| 173 | [#2187](https://github.com/yetone/magpie/issues/2187) | desktopTurn 对 Remote 嵌套条目失明，后台请求回落 Opus | patch | ⏳ 等维护者 git am（fork `fix/issue-2187`） | take20 A2·10-14 |
| 184 | [#2405](https://github.com/yetone/magpie/issues/2405) | OpenCode 导入漏 15 个同址 preset 被假话跳过 | patch | ⏳ 已发待采纳（fork `hunt24-a-opencode-presets`） | hunt24 A·10-15 |
| 183 | [#2259](https://github.com/yetone/magpie/issues/2259) | 嵌套组 Affinity 从未被读（#2246/#2255 同族第三字段） | patch 评论 | ⏳ 已交付等采纳（维护者自立单，fork `hunt24-b-nested-group-affinity`） | hunt24 B·10-15 |
| 181 | [#2255](https://github.com/yetone/magpie/issues/2255) | 嵌套组的 Sink 完全不生效（递归只消费外层） | patch | ✅ 采纳自实现 `7a3fed6bb`（Co-authored-by，插入点与注释同源、实现重写），我方确认后已关单 | hunt22 X2·10-15 |
| 182 | [#2256](https://github.com/yetone/magpie/issues/2256) | `*.localhost` 子域免网关 key 花订阅（WebKit 解析洞，#2242 同族） | patch | ⏳ 已发待采纳（fork `hunt22-x2-localhost-origin-key`） | hunt22 X2·10-15 |
| — | [#2247](https://github.com/yetone/magpie/issues/2247) | effort=auto 主现象证伪；真缺陷=none 被归一成 low 白咨询分类器 | patch | ⏳ 已交付等采纳（fork `fix/issue-2247`） | take22 X4·10-15 |
| — | [#2246](https://github.com/yetone/magpie/issues/2246) | 嵌套组忽略内层 firstToken | patch | ⏳ 已交付等采纳（fork `fix/issue-2246`） | take22 X4·10-15 |
| 183 | [#2259](https://github.com/yetone/magpie/issues/2259) | 嵌套组的 Affinity 从未被读（#2246/#2255 同族第三字段） | patch 评论 | ⏳ 已交付等采纳（维护者自立单，fork `hunt24-b-nested-group-affinity`，[评论](https://github.com/yetone/magpie/issues/2259#issuecomment-6192487741)） | hunt24 B·10-15 |
| 187 | [#2414](https://github.com/yetone/magpie/issues/2414) | 内置 Qoder 读不出的 `<tool_call>` 块被当 200+stop 回答发出（插件侧已修、内置兄弟面未跟） | patch | ✅ 合入 `06a4e71e`（10-15T16:44 直推 main，author ggbdpq 保留） | hunt25 A·10-15 |
| 185 | [#2410](https://github.com/yetone/magpie/issues/2410) | 嵌套组的内层 Patience 经外层组请求从不被读（#2246/#2255/#2259 同族第四字段） | 分析+红测试 | ⏳ 已发待采纳；ump45nose 补完整方案+patch `61b1c17c`，我方五点核对背书+三缺口（InnerOff 红跑 13 vs 手算 10 留实测、soonest 按 list 算、基线需 rebase） | hunt25 C·10-15 |
| — | [#2407](https://github.com/yetone/magpie/issues/2407) | 规则点名的组中组把内层 rotate 的轮换顺序抹平，每请求钉死首成员 | patch 评论 | ✅ 署名合入 `43fef069`（维护者按 #2361 扩展：仅组自己 plan 的模型保持组序） | hunt25 C 遗产接力·10-15 |
| 195 | [#2446](https://github.com/yetone/magpie/issues/2446) | 直通流被半行掐断时补发的 error 事件拼进半行，SDK 解析不出错误 | patch | ✅ 原样采纳 `7e4336e71`（Co-authored-by，维护者留言致谢；v0.1.1262/1263 已含） | hunt27 B 遗产接力·10-16 |
| 198 | [#2455](https://github.com/yetone/magpie/issues/2455) | 不支持 SSE 的上游被问 15 次——确定性 did-not-stream 被同者重试与组 Patience 双双当瞬态 | patch | ⏳ 已发待采纳（fork `hunt29-gw-streamless-retry`） | hunt29 B·10-16 |
| 199 | [#2481](https://github.com/yetone/magpie/issues/2481) | Codex 转发被拒钥/空体失败时 Routing 页「Request and response」404（af601541 兄弟面：两失败出口漏 call.Route） | patch | ⏳ 已发待采纳（fork `hunt30-gw-relay-route`） | hunt30 B·10-16 |
| 200 | [#2579](https://github.com/yetone/magpie/issues/2579) | 被 accounts 持有的网关 key 在 image/video 列表仍泄漏不 serve 的媒体模型（8b84dc90 兄弟面） | patch | ⏳ 已发待采纳；ump45nose 提独立分支 `fix/2579-image-video-account-serves`@`592cc4db`（同 gate 逐字+t.Cleanup 更干净），[碰撞协调评论](https://github.com/yetone/magpie/issues/2579#issuecomment-6226189994)建议维护者择一合入 | hunt31 C·10-16 |
| — | [#2492](https://github.com/yetone/magpie/issues/2492) | 插件模型 temperature:false 未被读取（Factory 400 的 magpie 侧根因） | patch 评论 | ⏳ 已交付等采纳（fork `hunt31-c2-prov-plugin-temp`；hunt31 B 路等效修复 `7aa5682b` 主动弃发转技术跟进两缺口，备份分支 `hunt31-b-gw-plugin-temp`） | hunt31 B/C 双路·10-16 |
| — | [#2607](https://github.com/yetone/magpie/issues/2607) | Chat member body 里 withReasoningOnToolTurns 追加 reasoning_content 不清客户端自带 reasoning 键，严格上游 400 | patch 评论 | ⏳ 已交付等采纳（fork `hunt32-b-gw-2607-reasoning-dup`） | hunt32 Mac B·10-16 |
| — | [#2599](https://github.com/yetone/magpie/issues/2599) | 中断残留的空 assistant 轮发给 Chat 上游致 DeepSeek/Kimi 400（翻译+直通两路径，轮丢弃+前后 user 合并） | patch 评论 | ✅ **维护者以我方 cb438ebb 与假上游为基础重写合入 `ed0335f75`（Co-authored-by 署名 ggbdpq）**；review 修正我方五处缺口（tool 后空轮/relay 误丢 function_call·refusal·prefill/空白 text parts 漏盖/join 仅字符串/JSON 重编码 HTML 转义/Resume 索引错位），维护者评论逐条在案 | hunt32 Mac B 遗产接力·10-16 |
| — | [#2471](https://github.com/yetone/magpie/issues/2471) | finish_reason:"error" 被当成功 try，组内不 failover（链尾永不尝试） | patch 评论 | ⏳ 已交付等采纳（fork `hunt30-gw-finish-error`，黑名单单值+复用 failOther 两偏离已说明） | hunt30 B·10-16 |
| — | [#2473](https://github.com/yetone/magpie/issues/2473) | Desktop 1-token 探测被误判标题请求，换上已关供应商旧 pick → 404 | patch 评论 | ⏳ 已交付等采纳（fork `hunt30-desktop-title`） | hunt30 A·10-16 |
| — | [#2580](https://github.com/yetone/magpie/issues/2580) | 上游流中途重置，半截 SSE 行原样转发致 pi 解析死、补发错误永远读不到（#2446 只管补发行独立成行，半行本身没管） | patch 评论 | ⏳ 已交付等采纳（分支 `hunt/2580-midstream-reset` @`2acffddf` 基 a751f528：write 行缓冲+dropHalf，[交付帖](https://github.com/yetone/magpie/issues/2580#issuecomment-6217486240)） | hunt32 B·10-16 |
| — | [#2547](https://github.com/yetone/magpie/issues/2547) | 我方 #2316 守护测试 silent 子测试负载红（pings=0） | 分析评论 | 🗂 定性=负载墙钟脆弱非产品缺陷（首个 KAlive 调度延迟超 300ms 测试 idle 窗；同族先例 `3f4287e6`，修法方向已给），单跑×3 绿本机复核 | hunt32 主·10-16 |
| — | [#2526](https://github.com/yetone/magpie/issues/2526) | 本机 capped 429 的 Retry-After 原样下发无上限，Codex 睡 89 分钟（「缓存不同步」未定性，已用排除法+未断言处理） | patch 评论 | ⏳ 已交付等采纳（分支 `hunt/2526-retry-after-sync` @`df41c438`：cappedRecheck=30s 截短+近重置点保持真实值，[交付帖](https://github.com/yetone/magpie/issues/2526#issuecomment-6218111199)；#2517 确认只改文案不覆盖） | hunt33 B·10-16 |
| — | [#2622](https://github.com/yetone/magpie/issues/2622) | MCP 原生 tools（无 type:function）经 Chat→Chat 未归一化，SenseNova 强校验整批 400 | 分析+本地实现 | ↺ 同构取代：claim 后 1 分钟维护者自修 `72d6103e2`（shapeChatTools）——**同窗自修极限纪录（#2183 差 3 分钟→1 分钟）**；我方零 commit 零 push 正确撤单（[撤单帖](https://github.com/yetone/magpie/issues/2622#issuecomment-6223860985)，透传面核实无 bug：APIError 如实提取） | hunt35 B·10-17 |
| — | [#2576](https://github.com/yetone/magpie/issues/2576) | 推理组缺省 effort 走非思考 + /v1/models 元数据未对齐 Catwalk 惯例——两半分开判 | patch+分析 | 半①=🗂 声明设计（缺省不注入 effort 键是上游默认；auto 分类器双注释+#2247 同门，改缺省=产品变更交维护者）；半②=⏳ 已发待采纳（分支 `hunt/2576-models-metadata` @`74dde581`：modelObject 补 `reasoning_levels` 扁平数组对齐 Catwalk，`default_reasoning_effort` 无数据源不编造，[交付帖](https://github.com/yetone/magpie/issues/2576#issuecomment-6223960355)） | hunt35 C·10-17 |
| — | [#2532](https://github.com/yetone/magpie/issues/2532) | Responses→Claude mid-turn system/developer 降级为 system-reminder 用户回合 | 分析评论 | 🗂 定性=声明设计（responses.go 注释引 #502 缓存保持+守护测试钉死；边界比正文窄：首回复前 developer 项保住 system 权重；与 #1378 维护者表态同构），[评论](https://github.com/yetone/magpie/issues/2532#issuecomment-6217808072)含向报告者索要线级抓包 | hunt33 C·10-16 |
| — | [#2426](https://github.com/yetone/magpie/issues/2426) | 旧版 Desktop 构建无 mythos 词，effort 别名模型整行静默丢 | patch 评论 | ✅ 合入 `39bebbbd`（扩 Code tab 与无版本构建两面） | hunt27 A·10-15 |
| — | [#2578](https://github.com/yetone/magpie/issues/2578) | 双供应商同 Claude 模型在 Desktop 菜单只见「目录名+别名哈希括号」，display_name 已对仍不可辨供应商（#1746 已知限制的实例化） | 分析评论 | 🗂 定性=Desktop 端限制非 magpie 可修（菜单是 Desktop 启动自拉 /v1/models；`magpie-<n>.anthropic.<model>` 形态被 effort HFt 表锁死，目录折叠行 Desktop 用目录名覆盖 display_name——#1746 关单帖已声明「网关这边改不了」；mythos 别名替换=thinking 强制常开+丢 per-model 档位+Code tab 不认；供应商名进 id 撞 desktopDenied 厂商词雷区；description/labelOverride 两杠杆对目录折叠行未验证，帖中交维护者拍板），缓解=哈希稳定可认一次+Desktop 行单勾一家，[评论](https://github.com/yetone/magpie/issues/2578#issuecomment-6218481428) | hunt34 A·10-16 |
| — | [#2578 增量](https://github.com/yetone/magpie/issues/2578) | 报告者追问落地：供应商页模型 chip 显示与 Desktop 括号一致的编号（`aliasNumber` FNV64a 10 位） | patch 评论 | ⏳ 已发待采纳（分支 `hunt/2578b-alias-display` @`dcb00beb`：导出 `DesktopNumber` 零第二套哈希+badge 零新增 CSS+i18n 四语言，Playwright 4/4 红→绿，[交付帖](https://github.com/yetone/magpie/issues/2578#issuecomment-6224132617)；Desktop 端限制定性仍成立，本 patch 是编号对照缓解面） | hunt35 A·10-17 |
| — | [#2593](https://github.com/yetone/magpie/issues/2593) | Clash TUN Fake-IP/Surge 增强下 web_fetch 全报私有地址（guard specialNets 含 198.18.0.0/15，假 IP 必落段必拒；#2592 为其重复单） | patch 评论 | ⏳ 已发待采纳（分支 `hunt/2593-webfetch-fakeip` @`279c436f`：specialNets 移除该段，与 icon.go #252 先例对齐；不按 hostname 判保 DNS rebinding 防线、字面量变体留维护者裁量，[交付帖](https://github.com/yetone/magpie/issues/2593#issuecomment-6218576615)；真实 TUN 端到端未跑帖中明标） | hunt34 B·10-16 |

### provider · usage · catalog（账号、额度、计价、模型识别）

| 全局号 | Issue | 一句话 | 形态 | 结局 | 检索键 |
| --- | --- | --- | --- | --- | --- |
| 109 | [#1357](https://github.com/yetone/magpie/issues/1357) | 日志指纹 3 轮全文件重哈希 43× | 分析 | ✅ 方向吸收 `439cfc4a`·v0.1.1129（解析即指纹，省 1/3） | MG-5·10-09 |
| 126 | [#1458](https://github.com/yetone/magpie/issues/1458) | Desktop Code 显示 200K 窗口 | 分析 | ✗ 定性修正：实为 settings.json 注入面可修 `43cb6fe3`——宣告"无解"前穷尽配置注入面 | MG-10·10-10 |
| 127 | [#1455](https://github.com/yetone/magpie/issues/1455) | grok-4.7-build 被判换模型 | 分析 | ✅ 方向采纳（not a swap 豁免）`18d87fc5`·v0.1.1159 | MG-11·10-10 |
| 133 | [#1484](https://github.com/yetone/magpie/issues/1484) | Bedrock global./us-gov. 前缀误判 swap | patch | ✅ `012be0fc`·v0.1.1159（尾注署名） | MG-16·10-10 |
| 134 | [#1505](https://github.com/yetone/magpie/issues/1505) | 强杀后 auth 文件全零（fsync 家族本体） | patch | ✅ 本体 `89271cd4` 已含主体；pi flush 补充在案；issue 已关 | MG-20·10-10 |
| 137 | [#1561](https://github.com/yetone/magpie/issues/1561) | 同名 key 的卡片互相覆盖 | patch | ✅ `cf8a16cf5`·v0.1.1183 | hunt5 B·10-11 |
| 138 | [#1530](https://github.com/yetone/magpie/issues/1530) | magpieModels 漏 OwnTier，/fast 不可用 | 红测试就绪 | ↺ 让位（ump45nose patch → `708515245`）；竞速车道对本仓节奏不可行的判例 | hunt5 C·10-11 |
| 139 | [#1522](https://github.com/yetone/magpie/issues/1522) | netproxy 空 choice 不遮蔽会话直连 | patch | ↺ 维护者同日自修 `2305ab1f`（更广） | hunt5 D·10-11 |
| 143 | [#1564](https://github.com/yetone/magpie/issues/1564) | renamed() 不认 canonical-only id | patch | ✅ `43b6959fc`·v0.1.1183 | hunt6 B1·10-11 |
| 144 | [#1565](https://github.com/yetone/magpie/issues/1565) | canonical-only 模型无能力票 | patch | ✅ `d1ddb7def`·v0.1.1183 | hunt6 B2·10-11 |
| 42 | [#1754](https://github.com/yetone/magpie/issues/1754) | 同 tick 旧额度覆盖 reset 后额度 | patch | ✅ 已合入 `509328ccb`·v0.1.1230；10-14 Windows 真机 TestResetAllowanceKnownAtOnce/StaleMidRead ×20 绿，**确认关闭** | Win 轮·10-12 |
| 163 | [#2071](https://github.com/yetone/magpie/issues/2071) | relay 的 Nano Banana 漏进对话模型列表 | patch | 交付：`DrawsID` 词表加 `banana` + `TestFetchRelayDrawerNames` 红绿，patch 附 [`hunt19-b2`](https://github.com/ggbdpq/magpie/tree/hunt19-b2) @`304fcd26`（主线程独立消融复红）；视频侧按 #1399 走标注不猜词 | hunt19 B·10-14 |
| 166 | [#2069](https://github.com/yetone/magpie/issues/2069) | antigravity 23 个模型只显示 17 个 | 分析 | 🗂 分析在案：toast 按 id、列表按 #150 折叠后家族数，同数据两口径无丢失；TestAntigravity 13/13 | hunt19 A·10-14 |
| 164 | [#2065](https://github.com/yetone/magpie/issues/2065) | Qoder CN 请求显示为 undici | 分析 | 🗂 分析在案：Qoder UA 即裸 undici（`cae88f03` 声明），报告者自建 key "default" 进来；给三条出口（Agents 接线/#1958 映射/建 key）+征询请求头样本 | hunt19 B·10-14 |
| 40 | [#1228](https://github.com/yetone/magpie/issues/1228) | Claude ask 与旧读取同 tick 缓存顺序 | patch | ⏳ 补丁交付在案（`c56eccab`，generation 排序），未见闭环记录 | Win 轮·10-12 |
| 178 | [#2250](https://github.com/yetone/magpie/issues/2250) | WorkBuddy/CodeBuddy/MiniMax 链接根目录列不出会话（#2233 兄弟函数） | patch | ⏳ 已发待采纳（fork `hunt22-x3-linked-session-folders`） | hunt22 X3·10-15 |
| 175 | [#2197](https://github.com/yetone/magpie/issues/2197) | Antigravity 池周窗口因 aside 收不到重置提醒（#523 兄弟面） | patch | ⏳ 已发待采纳（fork `hunt19-b-pool-reminder`） | hunt19 B·10-14 |
| 177 | [#2199](https://github.com/yetone/magpie/issues/2199) | Bedrock 新四厂商按本名回答被 usage 误标 swapped（vendorDot 漂移，#1484 同类） | patch | ⏳ 已发待采纳（fork `take-b2-bedrock-vendor-dot`） | hunt19 B2·10-14 |
| 179 | [#2251](https://github.com/yetone/magpie/issues/2251) | import 链接不认 `gemini=`，Gemini 兼容中转没法用链接分享（#2201 兄弟面） | patch | ⏳ 已发待采纳（fork `hunt22-x1-import-gemini`） | hunt22 X1·10-15 |
| 186 | [#2413](https://github.com/yetone/magpie/issues/2413) | CC Switch/Alma 的 Gemini 中转条目被过时理由跳过（#2201/#2251 第三兄弟面） | patch | ⏳ 已发待采纳（fork `hunt25-prov-gemini-relay-import`） | hunt25 D·10-15 |
| 189 | [#2416](https://github.com/yetone/magpie/issues/2416) | import 链接 name= 超 80 字节裸截断，多字节名字尾部读成坏字符 | patch | ✅ 合入 `e3ea77f82`·v0.1.1258（Co-authored-by 署名） | hunt25 D·10-15 |
| 188 | [#2415](https://github.com/yetone/magpie/issues/2415) | 拒绝过的 Keychain 读取 10 秒就重弹——Cursor/Claude 没有 Copilot 的拒绝退避（#2408 同族） | patch | ✅ 署名合入 `d830d460f`·v0.1.1258 | hunt25 B·10-15 |
| — | [#2408](https://github.com/yetone/magpie/issues/2408) | Copilot CLI Keychain 拒绝后每 10 分钟循环重弹（security 错误被整丢） | patch 评论 | ✅ 合入 `d830d460f`·v0.1.1258（"from @ggbdpq's patch"，等报告者确认） | hunt25 E·10-15 |
| 191 | [#2427](https://github.com/yetone/magpie/issues/2427) | Gemini 中转同一把 key 添加两次不判重，落成 gemini-relay-2 劈开用量（#1346 同期漂移） | patch | ✅ 合入 `319b86fe`（10-15T16:43 直推 main，author ggbdpq 保留） | hunt26 C·10-15 |
| 197 | [#2454](https://github.com/yetone/magpie/issues/2454) | Command Code Credits 月池窗不显示重置时间（#2451 meter 缺 resets 行，周期端点在手没接进窗口） | patch | ⏳ 已发待采纳；维护者已回：插件侧 0.1.13 已 ship（real key 核对 resetsAt=until），**内置侧缺口由本帖 patch 补**，mover min 待提 | hunt29 C·10-16 |
| — | [#2583](https://github.com/yetone/magpie/issues/2583) | OpenCode GO 额度卡缺 plan 级到期标注（zhipu 有） | 分析评论 | 🗂 定性=上游数据不可得：`/zen/go/v1/usage` 仅 `usage.{rolling,weekly,monthly}.{status,percent,resetsAt}` 无订阅周期字段（sst/opencode 代理层端点表佐证）；monthly resetsAt 是回满点，硬凑到期位会每月错标，[评论](https://github.com/yetone/magpie/issues/2583#issuecomment-6223759449) | hunt35 D·10-17 |
| — | [#2605](https://github.com/yetone/magpie/issues/2605) | OpenCode Zen 付费 key 无额度卡 | 分析评论 | 🗂 定性=无数据源：`/zen/v1/usage`、`/balance` 实测 404；余额 `billing/status` 网页会话专属（Bearer 401）；唯一可达的 Budgets API 要 `oc_sk_` 服务账号 All 权限（文档原话 Inference-only keys cannot access budget data）——pay-as-you-go 不建卡是既有规则（#387），[评论](https://github.com/yetone/magpie/issues/2605#issuecomment-6226175910)三条出路归维护者 | hunt36 C·10-17 |
| — | [#2605](https://github.com/yetone/magpie/issues/2605) | OpenCode Zen 付费 key（oc_ 按量）额度/余额完全不建卡 | 分析评论 | 🗂 定性=推理 key 无数据源：zen/v1 无 usage（实测 404）、`billing/status` 网页会话专属（Bearer 401，闭源）、Console 官方 API 推理 key 只开 config；唯一花费读端点=Budgets API（实测存在）但要求 `oc_sk_` 服务账号 All key + 用户自设预算，报告者场景接了也无卡；pay-as-you-go 不建卡=#387 既有规则；出路三条帖中给齐，[评论](https://github.com/yetone/magpie/issues/2605#issuecomment-6226175910) | hunt36 C·10-16 |
| — | [#2602](https://github.com/yetone/magpie/issues/2602) | ZCode Global Build 额度读不到：api-key 账号无 jwt 读不到 gift；修复面在插件仓（已插件化+每小时强迁） | 分析评论 | 🗂 分析在案：两仓取证链 + OAuth 重添加可操作路径 + 插件修复建议已附 | hunt32 Mac C·10-16 |
| 192 | [#2429](https://github.com/yetone/magpie/issues/2429) | 接管中打开导入，stash 换回只恢复 3 键、丢 claude.env.* 的 tier 模型键 | patch | ✅ 合入 `3960dd2d`（10-15T16:43 直推 main，author ggbdpq 保留） | hunt26 C·10-15 |
| — | [#2530](https://github.com/yetone/magpie/issues/2530) | Usage only 后 Codex 桌面端仍见 ChatGPT 原生 7 模型（CodexNativePicked 把「没选模型」当「不收窄」，兄弟路径不一致家族） | patch 评论 | ⏳ 已交付等采纳（分支 `hunt/2530-usage-only-models` @`46b6c628`：NoModels/ServesNone 收窄 codexModels，hide 条目按 #1460 保留，[交付帖](https://github.com/yetone/magpie/issues/2530#issuecomment-6218071968)；ETag 时效与 codexOwnOnly 豁免两取舍帖中明说；与 #2554 正交） | hunt33 D·10-16 |

| — | [#2591](https://github.com/yetone/magpie/issues/2591) | 用量总 token 不计 cache read——口径已被 #2378 裁决（Overview 默认不含+切换器 `d6b045a7`），Sessions 页（page.js:2340 硬加法）是未接开关的残留 | 分析评论 | ⏳ 已发定性分析（[评论](https://github.com/yetone/magpie/issues/2591#issuecomment-6218456072)）：字段已记（usage.go:63-69）成本已含（378）、Sessions/CLI/TUI/托盘/heatmap 口径地图给齐，裁量点（Sessions 接 usageWithCache 需改 usageTokensPick 写死的 renderUsage 回调；默认值不动）帖中明说；与 #2297/#2488 不同文件不同视图 | hunt34 C·10-16 |
| — | [#2587](https://github.com/yetone/magpie/issues/2587) | 余额不足 rest 30min + quotaHeld 免问直答，充值后读数照常读回「钱回来了」却永不解除拦截（renewed 只抬 quota/window，credit 显式排除的不对称） | patch | ⏳ 已发待采纳（分支 `hunt/2587-balance-refresh` @`6ab5c8d3`：`OnCreditBack` 钩子，卡片/窗口成功读数只抬该 key 的 failCredit rest，[交付帖](https://github.com/yetone/magpie/issues/2587#issuecomment-6218832171)；被拒代价上界=每读周期一次帖中明说；"update"按钮指向未考证已征询） | hunt34 D·10-16 |

### agent · plugin · library（agent 接线、插件、备份、proc）

| 全局号 | Issue | 一句话 | 形态 | 结局 | 检索键 |
| --- | --- | --- | --- | --- | --- |
| 97 | [#1332](https://github.com/yetone/magpie/issues/1332) | dsh key store 持本网关 key 被误判 drift | PR #1339 | ✅ 署名合入 `172f45a5`·v0.1.1123（magpie 首合） | MG-2·10-08 |
| 96 | [#1320](https://github.com/yetone/magpie/issues/1320) | sessions List(1) 被空会话吃掉 | PR #1335 | ↺ 被更早同题 #1324 取代（质量获维护者全链认证）；排雷教训立此存照 | MG-1·10-08 |
| 108 | [#1358](https://github.com/yetone/magpie/issues/1358) | 历史写持读无测试+缓存批重复读 | patch | ✅ 署名合入 `e9ed2943`·v0.1.1129 | MG-4·10-09 |
| 110 | [#1306](https://github.com/yetone/magpie/issues/1306) | 冷 PATH bun 吃光测试 ctx | patch | ✅ patch1 `65dcc573`·v0.1.1151；patch2 定性排除（慢≠挂） | MG-5·10-09 |
| 115 | [#1375](https://github.com/yetone/magpie/issues/1375) | 测试墙钟 bound 负载下击穿 | patch | ↺ 同构取代 `2c36d3f2`（顺序断言思路被印证） | MG-7·10-09 |
| 120 | [#1424](https://github.com/yetone/magpie/issues/1424) | Codex 双 Team seat 名错位 | patch | ↺ 同构取代 `c3e673b0` | MG-8·10-09 |
| 128 | [#1461](https://github.com/yetone/magpie/issues/1461) | daemon helper 误计 stale copy | patch | ✅ 署名合入 `74c48ac0`·v0.1.1156 | MG-12·10-10 |
| 145 | [#1566](https://github.com/yetone/magpie/issues/1566) | edit delItem 吃掉同行注释 | patch | ✅ `c40969380`·v0.1.1181 | hunt6 C1·10-11 |
| 146 | [#1567](https://github.com/yetone/magpie/issues/1567) | backup 拒收带 BOM 的合法备份 | patch | ✅ `671e2b44e`·v0.1.1181 | hunt6 C2·10-11 |
| 147 | [#1568](https://github.com/yetone/magpie/issues/1568) | proc kill 重试与 cleanup 竞态 | patch | ✅ `1c746a7e8`·v0.1.1181 | hunt6 D1·10-11 |
| 148 | [#1569](https://github.com/yetone/magpie/issues/1569) | access caller-keys 接 lastgood 回读 | patch | ✗ 被拒：#1505 本体声明的有意豁免（fail-closed）——**发帖前六问由此立** | hunt6 D2·10-11 |
| 149 | [#1570](https://github.com/yetone/magpie/issues/1570) | 机器代理变量固化进测试进程 | patch | ✅ v0.1.1181（TestOffline 同带转绿） | hunt6 D3·10-11 |
| 155 | [#1646](https://github.com/yetone/magpie/issues/1646) | TestOmo 读宿主 PATH | patch | ✅ `df49305e`·v0.1.1197 | hunt9·10-11 |
| 156 | [#1647](https://github.com/yetone/magpie/issues/1647) | 三 agent 接线漏改 LAN key | patch | ✅ `bc320e24`·v0.1.1197 | hunt9·10-11 |
| 162 | [#1842](https://github.com/yetone/magpie/issues/1842) | Keychain 清空后凭据读取序不对 | patch | ✅ 署名合入 `31956b92f`·v0.1.1215 | hunt15 C·10-12 |
| 159 | [#1766](https://github.com/yetone/magpie/issues/1766) | 自带 MCP 超限 body 被截成合法前缀执行 | patch | ✅ 维护者 `c59b808c`·v0.1.1214（改 413） | Win 轮·10-12 |
| 161 | [#1919](https://github.com/yetone/magpie/issues/1919) | StepCode enabledModels 留旧 magpie id | patch | ✅ 原样合入 `90ac1f03`·v0.1.1225（Co-authored-by） | Win 轮·10-13 |
| 162 | [#1913](https://github.com/yetone/magpie/issues/1913) | Kimi Code sessions 不列出 | 分析+测试套 | ✅ 维护者按评论重实现 `4921e5e`·v0.1.1225（Co-authored-by）——patch 未附获取通道被重写，教训=**patch 必须推 fork 附链接** | hunt18 C·10-13 |
| 176 | [#2198](https://github.com/yetone/magpie/issues/2198) | WSL 发行版的 Codex 无 stand-in 兜底（#254 兄弟面） | patch | ⏳ 已发待采纳；Edward4226 独立验证（桥接红/双 mutation），文档行按其措辞 rebase 至 8b84dc90 重放为 `cba7d56c` 五测绿，分支已强推 | hunt19 C·10-14 |
| 174 | [#2183](https://github.com/yetone/magpie/issues/2183) | bunTargetFor 拒 windows/arm64，插件装不上 | patch | ↺ claim 后 3 分钟被维护者自修（致谢 checksum；fork `fix/issue-2183` 存档） | take20 C2·10-14 |
| 180 | [#2254](https://github.com/yetone/magpie/issues/2254) | library Targets() 未套 CLIMissing 门，卸载 agent 仍列为写入目标（#2177 修复自注的未覆盖面） | patch | ⏳ 已发待采纳（fork `hunt22-x5-library-targets-gone`） | hunt22 X5·10-15 |
| 190 | [#2418](https://github.com/yetone/magpie/issues/2418) | 不可解析的 magpie-models.json 被整体覆盖/删除不留副本（#2263 清扫漏网，文件含用户手填键） | patch | ✅ 署名合入 `a786c51cb`·v0.1.1258 | hunt25 B·10-15 |
| 193 | [#2428](https://github.com/yetone/magpie/issues/2428) | TUI agents 页无窗口预算，高亮滚出屏幕（#2220 同病兄弟面） | patch | ✅ 维护者 `fed24aa1d`·v0.1.1262 同思路实现，我方已确认 | hunt27 C·10-15 |
| 196 | [#2452](https://github.com/yetone/magpie/issues/2452) | TUI 路由组内页把选中行滚出屏幕（#2428 同族最后一块） | patch | ✅ 署名合入 `1d227a7eb`（采用我方选窗思路），等确认后关 | hunt28 C·10-16 |
| — | [#2545](https://github.com/yetone/magpie/issues/2545) | Claude Code/Codex 手设的网关 caller key 被模型写入静默覆盖（#2510 漏面三处直写点） | patch 评论 | ⏳ 已交付等采纳（fork `hunt31-a-audit-caller-key`） | hunt31 A·10-16 |
| — | [#2380](https://github.com/yetone/magpie/issues/2380) | 导出给 Pi 的 models.json 判定与 gateway 口径不一致（Trae CN reasoning false；报告人补 image 面 502） | patch→分析 | ✅ 维护者按我方思路重写合入 `9f8fe81a`（author=yetone）；image「误标」经取证=声明设计（vision.go 注释+TestDescribedModelTakesImages 守护），[机理分析评论在案](https://github.com/yetone/magpie/issues/2380#issuecomment-6217101636)（真缺口=codex 账号列表混入不可服务模型，两条征询等回复） | hunt32 D·10-16 |
| — | [#2562](https://github.com/yetone/magpie/issues/2562) | macOS 系统 scutil 代理逃逸临时 HOME，TestProxyCheckSaysAProxyPassedBy 红（netproxy NO_PROXY 绕过回落机器态，#1570 同原则漏网） | patch 评论 | ⏳ 已交付等采纳（分支 `hunt/2562-proxycheck-home` @`74f704c5` 基 a751f528：testenv inert tools 加 scutil 替身一处收口，[交付帖](https://github.com/yetone/magpie/issues/2562#issuecomment-6217377195)；Windows 注册表源未盖帖中明示） | hunt32 C·10-16 |
| — | [#2589](https://github.com/yetone/magpie/issues/2589) | Windows 备份导入 macOS 后 WorkBuddy/Trae CN 多账号只剩一个——定性=订阅登录有意不进备份（#880 设计，四守护测试+GUI 两处文案钉死），账号不随备份走 | 征询评论 | 🗂 定性在案：端到端复现证实行 3/3 导入、凭据 0 进 bundle、SignIn 提示点名登录；征询报告者账号形状与导出密钥选项，[评论](https://github.com/yetone/magpie/issues/2589#issuecomment-6217871786) | hunt33 E·10-16 |
| — | [#2540](https://github.com/yetone/magpie/issues/2540) | Hermes 每 bot 一 profile 不读主 home，资源库 targets 只挂主文件（报告者自带行号+实跑输出） | patch 评论 | ⏳ 已发待采纳（分支 `hunt/2540-hermes-profile-targets` @`0104090b`：导出 `HermesProfiles(dir)` 同源枚举、MCP.Also 每 profile 挂载、also()/putEntry/del 放开 fmtHermes；skills 面按报告者建议留下版，[交付帖](https://github.com/yetone/magpie/issues/2540#issuecomment-6218588190)） | hunt34 E·10-16 |

### sessions · mcpauth · 同步 · 凭据

| 全局号 | Issue | 一句话 | 形态 | 结局 | 检索键 |
| --- | --- | --- | --- | --- | --- |
| 159 | [#1722](https://github.com/yetone/magpie/issues/1722) | gateway-sessions-hidden.json 读不了被覆写 | patch | ✅ 已合入 `94e3b3f52`·v0.1.1230（维护者改两处：列表反序列化判读+存副本失败不写入）；10-14 两测试 v0.1.1230 复验，**确认关闭** | hunt12 收编·10-12 |
| — | [#2494](https://github.com/yetone/magpie/issues/2494) | OpenCode 子会话占满追踪窗口挤掉父会话导出（公司机发单+交付，traceOpenCodeWindow 只留 main 会话） | patch | ✅ 合入 `ee2a7c7e`（10-16T16:39 直推 main，author ggbdpq 保留，尾注 Grok 4.7 (Cursor)；hunt36 A 巡查确认） | 公司机·10-16 |
| 161 | [#1737](https://github.com/yetone/magpie/issues/1737) | davsync 首加入用自己的键整体替换 | patch | ✅ 已合入 `eb22f6355`·v0.1.1230（"一侧没见过的值不是清空指令"）；10-14 join 两测试复验，**确认关闭** | hunt13·10-12 |
| 42 | [#1750](https://github.com/yetone/magpie/issues/1750) | MCP OAuth 取消后迟到回调仍发凭据 | patch | ✅ 已合入 `1a7aa76b4`·v0.1.1230（维护者按我方 `46440adc` 复核重写，原 patch 未直接合入）；10-14 复验，**确认关闭**；维护者顺藤开 #2054（provider signin 同族） | Win 轮·10-12 |

### 分析与巡检在案（无 patch，看维护者回合）

| Issue | 一句话 | 结局 | 检索键 |
| --- | --- | --- | --- |
| [#1365](https://github.com/yetone/magpie/issues/1365) | Claude 工具结果续跑丢失四源枚举 | 维护者根因更深（客户端中断→进程结束），参与性贡献不登记 | 10-09 |
| [#1382](https://github.com/yetone/magpie/issues/1382) | 客户端剥离历史图致续跑断缓存 | ✅ 容忍方向被采纳 `71ee5e35`·v0.1.1136 | 10-09 |
| [#1404](https://github.com/yetone/magpie/issues/1404) | 86 万 tokens 超限的 conv-id 拼接假说+双探针 | 探针在案等实测 | 10-09 |
| [#1418](https://github.com/yetone/magpie/issues/1418) | "at capacity" 不 failover 的条件枚举 | 被维护者正面引用；判别探针交报告者 | 10-09 |
| [#1450](https://github.com/yetone/magpie/issues/1450) | supports_reasoning_summaries 字段考证 | ✗ 结论修正：漏了用户手写配置持久化路径 | 10-10 |
| [#1702](https://github.com/yetone/magpie/issues/1702) | Responses 密钥三层语义考证 | 🗂 讨论收敛关单 | 10-12 |
| [#1758](https://github.com/yetone/magpie/issues/1758) | liftAdditionalTools 要的修法 | ↺ 指路评论（#350 声明决策+#1571 已认领） | 10-12 |
| [#2430](https://github.com/yetone/magpie/issues/2430) | release Latest 徽章残留 v0.1.1255 盖住 1256（LESSONS 自记之病活实例） | ✅ 维护者已移 Latest（现为 1258+），我方已确认，等关单 | hunt27 C·10-16 |

## 模式家族（避坑核心）

同构 bug 反复出现的家族。接单时对照：本单若落在某家族，修法和验证直接参考家族先例。

| 家族 | 成员（先例 → 后继） | 家族规则 |
| --- | --- | --- |
| **不可读状态文件保护（#1505 家族）** | [#1505](https://github.com/yetone/magpie/issues/1505) → [#1569](https://github.com/yetone/magpie/issues/1569)（✗ 有意豁免）→ [#1722](https://github.com/yetone/magpie/issues/1722) → [#2017](https://github.com/yetone/magpie/issues/2017) | 读不了 ≠ 空；写必 steady.WriteFile/fsync，坏文件先 `.bad-<ts>` 旁置；语义损失要有界（重建或停用）。**兄弟面收口前先读本体的提交说明**——兄弟缺口可能是有意豁免 |
| **工具交换/消息形状修补** | [#1341](https://github.com/yetone/magpie/issues/1341) → [#1558](https://github.com/yetone/magpie/issues/1558) → [#1560](https://github.com/yetone/magpie/issues/1560) → [#1916](https://github.com/yetone/magpie/issues/1916)（同族上游：#1171/#1755） | 严格上游对调用/结果配对和 item 类型零容忍；补形状别插进并行调用中间（串尾）；**无条件转换优于"被拒后补救并记住"**（#1916 维护者定版） |
| **同 tick 竞态与顺序** | [#1228](https://github.com/yetone/magpie/issues/1228) → [#1754](https://github.com/yetone/magpie/issues/1754) / [#1358](https://github.com/yetone/magpie/issues/1358) / [#1750](https://github.com/yetone/magpie/issues/1750)（同族 #2054） | 同刻时间戳排序失效，用 generation/锁序；"写不持读、取消后迟到完成必须复检"；Windows CI 只编译不跑测试，时序红只在本地露面 |
| **识别正则/家族名单漂移** | [#1470](https://github.com/yetone/magpie/issues/1470) → [#1471](https://github.com/yetone/magpie/issues/1471) → [#1454](https://github.com/yetone/magpie/issues/1454) → [#1484](https://github.com/yetone/magpie/issues/1484) → [#1645](https://github.com/yetone/magpie/issues/1645)/[#1679](https://github.com/yetone/magpie/issues/1679) | 同概念多套判定必须同步改；规则作用域过宽是惯犯形状；**版本一刀切在 Claude 家族不成立**（同代不同型号语义不同，按上游 400 自适应才是根治形） |
| **声明过的设计与有意豁免** | [#1569](https://github.com/yetone/magpie/issues/1569)（✗）→ [#1521](https://github.com/yetone/magpie/issues/1521) / [#1758](https://github.com/yetone/magpie/issues/1758) / [#1901](https://github.com/yetone/magpie/issues/1901) / [#1917](https://github.com/yetone/magpie/issues/1917)（✗） | 动手前 `git log --grep` 读相关提交说明全文；既有测试守护的行为=有意设计的最强信号；**提示词层变更的证据门槛=真实会话行为**，纯文本断言不构成影响面——这类发现以"观察+假设"评论交付 |
| **竞速与占坑** | [#1320](https://github.com/yetone/magpie/issues/1320)、"I'll open a PR"×4 应验、ump45nose 四连、维护者 20 分钟~1 天自修 | 开场六步 + 交付前最后一刻 fetch；c>0 必读评论内容（合入公告也占坑）；同构撞车零成本化：已发的 patch 留作独立佐证，不撤回不道歉 |
| **测试环境隔离** | [#1570](https://github.com/yetone/magpie/issues/1570) / [#1472](https://github.com/yetone/magpie/issues/1472) / [#1568](https://github.com/yetone/magpie/issues/1568) / TestOffline | 测试只读自己设的变量；验证一律干净 worktree（共享工作树不可信、不 stash/pop）；race 互踩先单跑定性 |
| **并行会话纪律** | #1306 ping 错标、#1418 双触达、全局号撞号 | 触达类动作（ping/评论）单会话执行或**先占坑后发射**；台账查重 grep 全文件最大号；发帖前回读 issue 原文核对交付物名称 |

## 交付形态与署名

- **禁 PR 政策**（upstream `b91569d3`）下的形态：patch 附 issue（主形态，`<details>` 折叠 format-patch 全文 + fork 分支链接）、分析评论、机理分析、背书、指路、让位。PR 通道仅在政策前用过 2 单（#1335/#1339）。
- **署名三通道**：author 保留（`git am`）/ `Co-authored-by: ggbdpq` / 提交消息尾注 `(#N, ggbdpq)`。更新日志不署名；维护者手工代提时请其保留作者或加 Co-authored-by（在案先例）。
- **发帖格式**：五段正文（现象/最小复现/根因/修法/验证）+ Verification 表格（**行间禁空行**，否则 GitHub 不渲染）+ 没跑什么 + AI 披露按当前 AI IDE 的工具名和所选模型写 `Generated-by: <模型> (<工具>)`，不写死。

## 避坑清单（接单前过一遍）

1. **开场六步**：fetch+ff → 在途 PR 新评论 → merge-tree → issue 增量 → upstream 自修 commit 扫 → **open PR 正文 `Fixes #N` 搜索**（#1320 血案），然后才准动手。
2. **发帖前六问**（#1569 被拒立）：①是否声明过的决策 ②既有测试守护什么 ③维护者近期表态 ④兄弟缺口是漏改还是有意豁免 ⑤影响面有证据不夸大 ⑥最后一刻 fetch+占坑复查。前四问存疑 → 降级疑点评论。
3. **patch 交付必须推 fork 附链接**（#1913 被重实现教训）；标题不带内部前缀；长 body 用 `--body-file`。
4. **ping 纪律**：24h 线；引用 patch 名先回读 issue 原文（#1306 错标）；ping 前查评论数防双重触达。
5. **宣告"无解"前穷尽配置注入面**（#1458 修正）——官方文档里的配置项就是可编程注入点。
6. **红实验**：marker 的 sleep 必须小于等待方 ctx 超时（#1375）；消融摘产品文件用 `--name-status` 列全，测试与产品分开摘（hunt17 定式）；测试引用新常量时加零行为桥接测试文件（2026-10-14 #2017 复验）。
7. **中文 Markdown 禁 perl/sed 批量替换**（2026-10-11 事故），用 Edit/Write 逐处改；破坏性操作前先确认回退源。
8. **限额与并行**：1308 限额错峰派单（整点后 40-60 分钟）+ 探针先行；死亡实例的已提交工作验证后收编；触达类动作先占坑后发射。

## 新单模板

```markdown
## YYYY-MM-DD <轮次名>：<一句话>

- **接单**：issue 号 + 报告者 + 四道闸（未被认领/范围小/本机可验/知识交集）+ 排雷结果。
- **根因**：文件 + 函数 + 关键判断；比报告者更深一层更好。
- **修法**：最小 diff；裁掉的方向和理由。
- **TDD**：红（修前会挂，报错与 issue 逐字对照）→ 绿；既有断言改动点名。
- **验证矩阵**：目标包 / -race / gofmt / vet / 三平台 / 全量（预存红注明）；**没跑什么如实列**。
- **交付**：commit SHA + fork 分支 + issue 评论链接。
- **结局**：（事后追加）合入 SHA / 版本 / 确认评论 / 关单。
```

## 维护

- 新单先在[编年全录](编年全录.md)按时间线追加轮次记录，再回本索引加行或更新结局列。
- 索引只改自己的行；编年全录的历史内容永不回写。
