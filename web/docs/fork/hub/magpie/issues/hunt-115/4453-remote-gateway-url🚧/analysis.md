# #4453 策略降级分析（hunt-115-c13，2026-11-02）

**判定：策略设计（写地址选择策略拍板权在维护者）→ 英文分析帖。无 core patch、无分支；已 take 占坑（6560824118）。**

- issue：https://github.com/yetone/magpie/issues/4453（RedpoQ 报，2026-10-30，接单时 0 评论）
- 开工 SHA：upstream/main `14e3513780d3f6b32f97f20760b92a65808fb8eb`（主 clone 只读，未建 worktree——降级无代码交付）
- 帖：https://github.com/yetone/magpie/issues/4453#issuecomment-6560843573（ggbdpq，2026-11-02 00:42 +0800，body 4318 字符，GET 回读核对）
- 产物：`comment.body.md`（发帖稿）

## 根因链（全部核实，行号基于 14e351378）

1. `desktopOn`（internal/agent/claudedesktop.go:605-618）在每次连接（Field.Set provider=magpie，经 Rewire/setAgain→Reapply 亦然）无条件写 `inferenceGatewayBaseUrl = gateway.URL()`。
2. `gateway.URL()`（internal/gateway/gateway.go:288-296）把未指定监听地址（`lan:true` 时 listenAddr=0.0.0.0）归一为 `127.0.0.1`——注释明说 "a gateway listening on every interface is reached here on loopback"，同机 agent 走 loopback 是设计。
3. `settings.Load().LAN`（"Share on local network"）不影响该写入：只加宽监听面（lan.go listenAddr:36-41）并把 loopback 之外的来源改成必须 key（lanGuard/remoteKeyed）。
4. Claude Desktop 侧（reporter 对其 index.pre.js 的解读，未本机验证）：SSH 远程会话以 `new URL(baseUrl).origin` 探测 provider，loopback 即拒（`provider_loopback`，因 SSH 连接 `ClearAllForwardings=yes`，远端永远够不到本机 loopback）。两侧矛盾成立。

## 策略未收敛的硬证据（为何降级）

1. **reporter 自己的建议分裂**："offer (or default to) http://<lan-ip>:<port> ... or let the host be configured"，caveat 明说 "this probably wants an explicit switch rather than a new default"。
2. **默认翻成 LAN URL 的破坏面真实**：
   - DHCP/IP 漂移无人监听重写 Desktop profile（全仓无 IP-change watcher；Relisten 只管监听面）→ 漂移后 Desktop 全部会话（不止 SSH）挂到下次 Reconnect；
   - 防火墙 profile 差异（a1c1b7053 自身教训：WSL 适配器在 Public profile，Private-only 放行规则照样拦）；
   - `MAGPIE_PUBLIC_URL` 隧道用户会被写入隧道地址（LANURLs 首选 publicURL），hairpin NAT 下本地会话可能不通。
3. **代码内部对"什么算 magpie 的地址"判定不一致**（设计问题未收敛的直接证据）：
   - drift 路径 `wiringOff`→`reachesMagpie`（applied.go:1039-1048 + reach.go:88-125）：**探测式**，凡 magpie 还在该地址应答就不算漂移（#1985 中继机制，proxyBase 接受 onAnotherMachine 的 base）；
   - 导入路径 `desktopIsOurGateway`（claudedesktop.go:988-999）：**静态**，只认 loopback/localhost 形态，导入带 LAN 地址的 profile 被判 "another gateway configuration"。
4. **发帖前六问第①问命中**：写地址的默认选择是未经维护者声明过的决策空间。

## 既有 seam 盘点（修法五问）

- `LANURLs()`（lan.go:161-178）：现成的"其它机器够到我的地址"列表，优先级 MAGPIE_PUBLIC_URL > 非环回 pinned host > 本机私有 IPv4（RFC1918 在前，#1677 族沉淀：fake-ip 198.18/15 剔除、静态公网地址排序）。
- `reachesMagpie`：drift 侧已容忍任意可达地址 → **方案 (a)（lan:true 时默认写 LANURLs()[0]）的 Check 侧零成本**，决策只剩 desktopOn 写什么、何时重写。
- `Rekey`（rewire.go:60-69）：LAN 切换只重设 `a.Gateway != nil && onAnotherMachine(a.Gateway())` 的 agent；claude-desktop 的 Agent 从不设 Gateway（nil=gateway.URL）→ **被完全跳过**。翻默认需同时教 LAN 切换处理器重写 Desktop。
- WSL 先例（wsl.go，最近 a1c1b7053）：全仓唯一给 agent 配置写非环回地址的机制，配在位探测（reachFrom/wslReach，从 distro 内问）+ 专用 key（wsl-key）。门槛先例：真机复现后才落。
- 既有注入面（10 §9 穷尽）：`MAGPIE_ADDR=<lan-ip>:<port>` 能让 `gateway.URL()` 返回 LAN 地址（GatewayAddr→URL 保留指定 host），Desktop 即拿到非环回 URL——**能用的 workaround 但沉重**：监听面钉死单接口（loopback 不再服务）、全部调用方改 keyed、IP 漂移即全断；`MAGPIE_PUBLIC_URL` 不进 desktopOn 写入，无效果；手改 profile JSON 见下。

## Workaround 现状（帖内已给 reporter）

- 手改 magpie 自己 profile 的 `inferenceGatewayBaseUrl` 为 LAN 地址（分享开着）：Check 经 reachesMagpie 不报漂移（代码推断，未真机验证）、Desktop 本地标签页走本机接口地址仍通（RemoteAddr 非环回→keyed→Desktop 有 key）、SSH 远程过环回探测。**下次 Reconnect（provider 切换）或网关迁移（Rewire）被覆写回 loopback**；防火墙拦本机接口时本地会话受影响。
- 导入带 LAN 地址的 profile 不可行（desktopIsOurGateway 拒认）。

## 三选项与风险（帖内表格）

| 选项 | 效果 | 风险 |
| --- | --- | --- |
| lan:true 时默认写 LANURLs()[0] | 无新 UI，SSH 即通 | 全体分享用户的 Desktop 搬上 LAN 接口：防火墙 profile、DHCP 漂移、MAGPIE_PUBLIC_URL 隧道 hairpin；需同时改 LAN 切换处理器与（如翻转后）Rekey 过滤 |
| 显式开关（reporter 倾向） | 默认不动 | 新 Settings 面，维护者领地 |
| MAGPIE_PUBLIC_URL 进 desktopOn | opt-in 无 UI | 把分享/展示旋钮耦合进 agent 接线；本地未必可达（hairpin） |

## 兄弟面（rg 全查，不改理由）

`gateway.URL()` 消费方：codex.go（codexGatewayURL）、droid.go、omp.go、vscode.go（gatewayV1）、route.go、gatewaykey.go（hereKey/agentKey）、keptaway.go、applied.go（elsewhere）、wsl.go（兜底默认）——全部同机 agent，loopback 正确；跨边界消费方 WSL 有自己的可达地址机制。Desktop 是唯一消费方会替远端会话探测该 URL 的。drift 基准与写入同源（desktopCheck:276），改写入必同步改 Check 基准（或确认 reachesMagpie 已盖住，见上）。

## 排雷

- open PR：search "4453"/"gateway loopback" 零命中；timeline 无 cross-reference。
- 近期同域提交（claudedesktop.go/lan.go）：3ecc02b78（3p 模式判定）、5a56bc7d7（OIDC key）、173fb6ab0/581d64b7d（#1677 族 LAN 排序）——均非本因，无自修。
- c=0（接单时）；发帖前复查 timeline。

## 验证与未验证

- 已验证：全部代码断言（上述行号）基于 14e351378 本机 clone 静态核实；take/分析帖 GET 回读。
- 未验证：Claude Desktop 侧 provider_loopback 探测逻辑（reporter 对其打包 JS 的解读，未本机复现）；手改 profile 的 reachesMagpie 容忍未真机跑过（macOS 有 Desktop 环境但本单不做真机改写实验）；Windows/防火墙行为纯引用 a1c1b7053 先例。
