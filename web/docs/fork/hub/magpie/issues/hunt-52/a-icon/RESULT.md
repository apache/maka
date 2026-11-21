# hunt52 / a-icon：图标路径的 fake-IP × 回环代理一致性（#2593）

**结论：无缺口（consistent）。** 图标路径经回环代理时把**名字**（NAME）发给代理——这正是 h4rk8s 在 #2593 里指出的"工作"行为；hunt51 式补丁（fake-IP 名字不 pin）在这里**无事可修**，因为 icon 的守卫结构下通过代理时根本不存在 pin。交付物为保护性测试 + 一致性说明，外加 9 行测试 seam。

## (a) 回环代理 + fake-IP 解析下，图标抓取发给代理的是名字，不是 pin 地址

**stdlib 事实（go1.26.8，本仓构建用的 toolchain）**：

- `connectMethod.addr()`（transport.go:2079）：设了代理时首跳只 dial `canonicalAddr(cm.proxyURL)`，即代理自身地址；只有无代理才 dial `cm.targetAddr`。
- https 走代理时 CONNECT 请求由 `cm.targetAddr` 构造（transport.go:1877–1884），而 `cm.targetAddr = canonicalAddr(treq.URL)` 在 `t.Proxy(req)` **之前**算定（transport.go:986–990）——Go 设代理时从不在本地解析目标名，结构上无从 pin。

**icon 路径组合（`internal/provider/icon.go`）**：

1. `guardClient`（icon.go:95）包了默认 transport 的 `Proxy` 与 `DialContext`。`Proxy` wrapper 对站点名先做一次 `publicHost` 判定（icon.go:106）；fake-IP 答案（198.18.0.0/15）过 `publicIP` 的 #252 豁免（icon.go:221–248），随后把代理自身 host:port 记入 `proxies`（icon.go:109）。
2. transport dial 代理（如 127.0.0.1:7890）；该地址在 `proxies` 里，跳过 `publicDial`，回环代理按原样 dial（icon.go:113–118）。
3. CONNECT 行携带名字。该路径上没有任何本地解析/ pin——gateway 旧的 pin 手法（RoundTrip 前重写 URL host，image_fetch_guard.go:276–277）在 icon 客户端里不存在。

**测试锁定**：`TestGuardClientFakeIPThroughLoopbackProxyKeepsName`（icon_test.go:302）。经 9 行 seam `lookupIPAddr`（icon.go:126，仿 gateway 已有的 `lookupIP`，image_fetch_guard.go:142–145）把解析 stub 成"所有名字都答 198.18.7.11"，回环测试代理记录到 `CONNECT icon.example:443`。**改动前即绿（protective）**；mutation 检查：加一层 RoundTrip 前 pin（gateway 旧形态）后测试红——`the proxy was not asked for the name: "198.18.7.11:443"`，已撤销。

**附带发现**：在 `t.Proxy` 回调里改 `req.URL.Host` 对 CONNECT 目标**无效**（targetAddr 先取，transport.go:986）——第一次 mutation 由此未红，改用 RoundTrip-pin 形态才对。这本身再次佐证 (a)：icon 走代理时"发名字"是该 transport 结构下唯一可能的行为。

## (b) 字面量 `https://198.18.x.x/icon.png`：icon 放行、gateway 拒绝——差异符合信任级，不是缺口

机械事实：`iconURL`（importurl.go:198）只拒非 https 与 `local()`（loopback/RFC1918，198.18.0.5 两者都不是）→ 放行；`publicIP` 放行（#252 豁免）；gateway 的 `publicAddr` 因 `specialNets` 含 198.18.0.0/15（image_fetch_guard.go:156）拒绝同一字面量。

但**图标 URL 的供给方不是模型输出**（gateway 一刀切拒绝所针对的正是后者，见 image_fetch_guard.go 头注 "an image or video a vendor answers with (its URL may come from what the model was steered to say)"）：

- `FetchIcon`（import 链接 `icon=`、插件图标 plugin_icon.go:46、伙伴图标 partners.go:367）**根本不 dial 图标主机**：URL 被改写为 usemagpie.ai 的图标代理（internal/iconproxy），magpie 守卫只见 usemagpie.ai；字面量只是查询参数，由 Cloudflare 网络去取，不经用户机器。
- `FaviconFor`（favicon.go:40）是唯一 magpie 亲自 dial 非自选 URL 的路径，其候选来自**用户自己的 provider base URL** 与该站自己页面——用户配置级信任，与 gateway 对 fetchPrivate / vendor 自有主机的豁免同级。
- 可达性：无 TUN 时 198.18.0.0/15（RFC 2544）公网不可路由，无应答；开 TUN 时字面量是**未映射** fake-IP（Clash 没为它登记过名字），TUN 无名可回连，丢弃。已映射 fake-IP 也不增益：能写出 `198.18.x.y`（Clash 给 `d` 发过的映射）的人直接写 `d` 即可，守卫同样放行——与 gateway hunt51 后"fake-IP 名字保名"接受的属性相同。

所以差异是"字面量严格度"差异，由 URL 供给方信任级不同解释，不构成能力缺口。

## 改动与提交

- 分支 `hunt52-a-icon-fakeip`（基 upstream/main dee5c9d7），单提交 `9e52c7bd`（作者 ggbdpq，`Generated-by: GLM-5.3-Flash (ZCode)`）：
  - icon.go：+9 行 `lookupIPAddr` seam（publicHost/publicDial 两处调用点替换，行为零变化）；
  - icon_test.go：+`TestGuardClientFakeIPThroughLoopbackProxyKeepsName`（protective，改动前即绿，测试注释如实标注）。
- 未 push、未发评论。

## 验证矩阵（全绿）

| 项 | 结果 |
|---|---|
| icon 守卫测试（TestGuardClient*/TestPublicDial*/TestPublicIP/TestIconIPs/TestFetchIcon/TestStoreIcon） | ok |
| provider 包全量 `-count=1` | ok（66.4s） |
| gofmt -l internal/provider | 干净 |
| go vet ./internal/provider ×3 | 3/3 ok |
| go build（根 main）×3 | 3/3 ok（仅 macOS 链接器预存警告） |
| go build ./internal/cli ./internal/gui/... ./internal/gateway ./internal/provider | ok |
| mutation（RoundTrip-pin） | 测试红（预期）→ 撤销后绿 |

消融：唯一新增复杂度是 seam；移除则测试无法确定性模拟 fake-IP（`net.DefaultResolver` 不可按测试替换），且与 gateway 先例同构，保留。

## 不确定性

1. **未映射 fake-IP 字面量被 TUN 丢弃**：基于对 mihomo fakeip 池反向查找行为的推断，本机未跑 Clash 实测；即便行为不同（直连黑洞），结论不变——该范围无可读的 HTTP 应答方。
2. **代理来源差异（预先存在，未动）**：icon 用 `http.DefaultTransport` 的 Proxy（环境变量）；gateway 用 `netproxy.Func`（magpie 设置，image_fetch_guard.go:231）。用户只在 magpie 设置里配代理而环境变量为空时，icon 走直连——fake-IP 直连路径两边都工作（#252），非本单缺口。
3. `proxyAddr`（icon.go:173）与 Go `canonicalAddr` 的无端口默认端口表（https→443、socks5/socks5h→1080、其余→80）未逐项核对 Go 侧全表；显式端口（127.0.0.1:7890 常态）必然一致。
4. usemagpie.ai worker 对字面量 URL 的处理未验证（不影响 magpie 侧守卫结论）。
5. mutation 只验证 RoundTrip-pin 形态；Proxy 回调 pin 形态被证明结构性无效（见上）。
