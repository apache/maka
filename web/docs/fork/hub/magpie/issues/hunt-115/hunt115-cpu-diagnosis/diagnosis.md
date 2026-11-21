# hunt115 CPU 占用诊断（Discord 01huadalang_05077「PID 37060: 41% CPU」）

- 日期：2026-11-02（诊断执行）/ 基线 fetch：2026-11-01 深夜
- 报告信息量：仅一张截图（"Magpie PID 37060: 41% CPU"）。**无版本、无平台、无场景（前台/最小化）、无 profile、无持续/峰值区分**。
- 方法论：先复现/测量，后假设。本机隔离实测 + 已知 issue 家族比对 + 读码枚举。**不开 issue**（无可复现缺陷，Q2 闸不过）。

## 0. 基线与实测环境

| 项 | 值 |
|---|---|
| upstream/main | `59fdab0af`（2026-11-01 23:47 +0800） |
| 本机 | macOS darwin 24.6.0 arm64（M 系列），go 1.25.5 |
| 构建 | `git archive 59fdab0af` 导出 /tmp → `go build -tags production`，版本串 `59fdab0af-diag` |
| 隔离 | 可执行旁 `.portable` 标记 + `data/`（magpie 自身文件全部落 `bin/data/`，含 plugin-host、bun 缓存） |
| 隔离实例 | 主进程 PID 15893 + bun 宿主 PID 16552（自动迁移 grok/zcode 到插件，2 个插件账号，无任何真实供应商请求） |
| 采样 | `ps -o pcpu` 每 2s × 180s/轮（macOS pcpu=内核衰减平均，近似瞬时值） |

## 1. 实测数据

### 1.1 四路对照（每轮 180s，~90 样本）

| 场景 | 进程 | 平均 CPU | 峰值 | 非零样本 |
|---|---|---|---|---|
| 隔离实例·前台窗口 | magpie 主进程 | ≈0.1-0.5%（剔除下述单次突发） | 0.5% | 少量 |
| 隔离实例·前台窗口 | bun 宿主 | 0.00% | 0.0% | 1 次 0.1% tick |
| 隔离实例·隐藏窗口 | magpie 主进程 | **0.08%** | 2.8% | 10/89 |
| 隔离实例·隐藏窗口 | bun 宿主 | **0.00%** | 0.1% | 1/89 |
| 真实实例旁观（v0.1.2630，真实数据：usage.jsonl 1.6M + routing 1.3M） | magpie 主进程 | **0.35%** | 26.9%（启动尾段） | 6/89 |
| 同上 | bun 宿主 | **0.50%** | 3.6% | 67/89（持续低水平） |

结论①：**空闲基线接近 0%**——主进程与 bun 宿主都不是天然吃 CPU 的；41% 不是 magpie 的常态。
结论②：真实实例（有数据、有插件账号）也仅 0.35%/0.50% 均值，bun 宿主有持续低水平活动（插件 relist/查账链）但离 41% 差两个数量级。
结论③：本机前台 vs 隐藏无可见差异（与 #4742 的 Windows 形态不同——该单是 Windows WebView2 可见性驱动）。

### 1.2 意外捕获：一次 6s×72-95% 的突发 = #4735 首扫实测

- 隔离实例启动于 23:54:12；23:56:14 起连续 3 个样本 72.0→94.6→51.7%（约 6s）。
- 与 `codexPortAfter = 2 * time.Minute`（`internal/agent/codex_portable.go:23`）**精确吻合**（启动+2min=23:56:12）。
- 该扫描走真实 `~/.codex`（agent 配置不随 portable 隔离，1.4G）。**只读核实**：无新 `.zst`、无 120min 内被改写的 json——纯扫描，未改用户数据。
- 形态与 #4735 报告者一致（其 30.19s profile 采到 42.48 CPU-s ≈ 140% 单核，采时 pass 仍在跑）。**这是 #4735 的本机实测形态**：扫大 `~/.codex` 的 pass 期间半核到整核，每 10min 一轮（`codexPortEvery`），且**不受窗口可见性影响**（最小化照跑）。

### 1.3 副作用披露（隔离实验对真实环境的触碰）

- magpie 按设计把 agent 登录态/配置当"非 magpie 自有文件"，隔离实例仍读写了真实 `~/.dsh/profiles/*/cordis.patch.yml`（每 30s 重写一次，`KeepDshWired`）。内容与真实 magpie 会写的一致（同上游代码），幂等、无破坏；真实 magpie 在跑，文件归属其管理。
- `~/.codex` 只被读取（见 1.2），未改动。
- 其余全部落在 `bin/data/` 隔离区。临时进程与 /tmp 目录用后即清。

## 2. 常驻周期任务全表（59fdab0af 枚举，`NewTicker/After` 全量）

| 循环 | 周期 | 触发条件 | CPU 形态 | 关联用户状态 |
|---|---|---|---|---|
| KeepCodexRolloutsPortable（#4735） | 启动+2min 首扫，后每 10min | 常驻 | **整段高 CPU**（扫描+可能的 zst 解压重压缩） | `~/.codex` 大小、Codex 会话是否活跃；**与窗口可见性无关** |
| FetchNewSoon→plugin.Providers（#4742） | /api/state 触发（15s 节流）+ 失败账号 60s 重试 | 页面可见/聚焦（visibilitychange/focus） | 8-11s × 100-200% 单核/约86s 周期（**Windows 实测**） | 有插件账号 + vendor 列表拉取失败/卡顿；最小化即停 |
| KeepPluginsListed / KeepListsFresh | 1min | 常驻 | 低 | 插件账号数 |
| KeepAccountsListed | 1h | 常驻 | 低 | 账号数 |
| KeepDshWired | 30s | 常驻 | 磁盘写，CPU 可忽略 | 用 dsh 的用户 |
| KeepCodexDaemonCurrent | 15s | 常驻 | 低 | Codex 用户 |
| KeepCodexAppOnItsProvider | 3s | Codex app server 活动期 | 低 | Codex app 用户 |
| 托盘 usage 卡片（#4366 修后） | ~30s-1min 重绘；总和 memo 1min | 托盘开启 | 随日志体积的全量 QueryPage 配对 | usage/routing 日志大小 |
| gateway fallback watch | 1s/流 | 请求期 | 低 | 请求并发 |
| hub_mcp prune | 5s | MCP hub 使用期 | 低 | MCP 用户 |
| KeepClaudeScience / KeepLinked / pageRest / lightEvery | 1min / 30s / 30s / 30s | 常驻 | 低 | — |
| conversations 归档 / issue_keys | 1h / 10min | 常驻 | 低 | — |
| 登录保活 KeepLoginsAlive | 8天 | 常驻 | 极低 | — |

**全表无接近 41% 持续占用的定时器**；能顶到半核以上的只有：rollout port pass（#4735）、usage 全量配对（日志大时）、masking 扫描（请求期）。

## 3. 嫌疑排序（针对「持续 41% ≈ 半个核持续满载」）

> #4742 的 86s 周期（均值 8.2%）形态不符；重试风暴类：gateway 请求内 try 循环有 rest/退避（`retryPause=1s` 且指数位移续传，`continuation.go`），`newFetchRetry=60s` 平坦重试只影响列表拉取（见 #4742），均非持续半核形态。以下按嫌疑降序。

### 嫌疑 1（最高）：usage/会话日志扫描族（#4366/4367/4368/4369/4370/4371）

- 路径：托盘/Usage 页全量 QueryPage 配对（`pairRowsMemo` 缓存要求时间窗+全部 chunk serial 相同，活跃会话一更新即全量重算）；`readLogSnapshot→recordHash` 重读历史日志前缀；Codex 子代理 `leadFirst` 失效后 `loggedAnswers` 逐请求 `usage.Visit(30d)`；`scanThin` 会话文件重扫。
- CPU 形态：**随日志体积线性/超线性增长，UI 刷新+逐请求触发，呈持续/半持续**。
- 关联用户状态：**与使用时长/历史量正相关**（usage.jsonl、routing/*.jsonl、session 文件越大越耗）。
- 判别特征：①`usage.jsonl`/`routing/` 文件大小；②关掉托盘 usage 卡片或不动 Usage 页后 CPU 是否回落；③pprof 里 `pairRows/readLogSnapshot/scanThin/Visit` 占比。
- 量级巧合：#4371 家族的 pprof 恰好测得 **12.35s/30.16s ≈ 0.41 核**——与报告者的"41%"同量级（当时含请求流量，不能直接划等号，仅作形态参照）。
- 修复门槛：#4371 longBody 哈希已落 **v0.1.2518**；#4353 masking 结果哈希缓存已落 **v0.1.2514**；pairRowsMemo/readLogSnapshot 结构仍在基线（未根修）。

### 嫌疑 2（高）：masking 全量重扫（#4766，版本 < v0.1.2622）

- 路径：Privacy masking 开启时，长会话 body 每个请求都全量重扫（修前 555KB body = 1m54s CPU）。
- CPU 形态：**请求期 100%+ 单核**，请求密集时接近"持续"；空闲即 0。
- 关联用户状态：masking 开 + 长会话/大 body + 请求频繁。
- 判别特征：①Privacy 是否开；②CPU 高峰与请求时段重合（发请求时才高）；③版本号 < 0.1.2622。
- 修复门槛：窗口有界化已落 **v0.1.2622**（修后 560KB → 0.2s）。**该修复落地仅一天，多数在线用户还在旧版**——若报告者版本旧且开着 masking，这是头号嫌疑之一。

### 嫌疑 3（高）：Codex rollout port 扫描/重压缩（#4735）

- 路径：`KeepCodexRolloutsPortable` 每 10min 扫 `~/.codex`；有未 port 的 `.zst` 时解压+逐行扫描+重压缩。
- CPU 形态：**pass 期间 100-140% 单核**（本机实测 6s×72-95%；报告者 30s profile 42.5 CPU-s），`~/.codex` 大或 backlog 多时 pass 可连续数分钟；**与窗口可见性无关**。
- 关联用户状态：Codex CLI 用户、`~/.codex` 体积、是否有活跃 Codex 会话持续产生新 rollout。
- 判别特征：①任务管理器曲线是否**每 ~10min 一阵**；②`~/.codex` 大小；③停用 Codex 会话/清 archived_sessions 后对照。

### 嫌疑 4（中）：插件宿主周期链（#4742，Windows 特征）

- 形态：86s 周期 8-11s×100-200%，均值 8.2%，**最小化即停**——是"周期突发"不是"持续"，与 41% 持续形态不符，但若报告者反复回前台或叠加多条链，均值会上抬。
- 判别特征：看 `magpie-bun.exe` 单独行分数；最小化 8 分钟对照。

### 嫌疑 5（低/放大器）：GC 标记（#4737）与 WebView 渲染

- GC 标记 12.08% 是分配来源的影子，不独立成 41%；本机 macOS 隐藏窗口主进程 0.08%，渲染器嫌疑在本机不成立（Windows WebView2 未测，待报告者平台信息）。

## 4. 向报告者要什么证据（一分钟自证清单）

按判别力排序，给 Discord 的版本见 reply-draft.md：

1. **版本号**：`magpie -v`（或设置→关于）。三道门槛：<0.1.2514 / <0.1.2518 / **<0.1.2622（masking，最关键）**。
2. **平台与 OS**：Windows/macOS/Linux（#4742 形态为 Windows 专属）。
3. **41% 的是哪个进程**：任务管理器"详细信息"页区分 `magpie.exe`（主进程）/ `magpie-bun.exe`（插件宿主）/ WebView2 渲染进程。截图 PID 37060 是哪个？
4. **曲线形状**（判形态，一张图定嫌疑）：持续平线 → 嫌疑 1/2；每 ~10min 一阵 → 嫌疑 3；每 ~86s 一阵 → 嫌疑 4；只在请求时高 → 嫌疑 2。
5. **最小化/隐藏窗口 1 分钟对照**：回落 → 嫌疑 4 或渲染器；不变 → 嫌疑 1/2/3。
6. **两个体积**（PowerShell 或终端）：
   - Windows：`"{0:N2} GB" -f ((Get-ChildItem $env:USERPROFILE\.codex -Recurse -File -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum/1GB)`；usage/routing 在 `%APPDATA%\magpie\`（`usage.jsonl` 与 `routing\` 文件夹大小）。
   - macOS/Linux：`du -sh ~/.codex ~/.config/magpie/usage.jsonl ~/.config/magpie/routing`。
7. **Privacy masking 是否开启**（设置→Privacy）。
8. **当时是否有 agent/Codex 会话在跑**（嫌疑 2/3 的触发条件）。
9. **升级到最新版（≥0.1.2622）对照**——一步排除嫌疑 2 与已知修复。
10. **终极证据（半分钟，一锤定音）**：仓库内置 CPU profile——`magpie cpu`（可选 `--seconds 60`），命令会向运行中的 magpie 要 30-120s Go CPU profile 并落一个文件，发回即可；pprof 火焰图能直接点名 `pairRows/scanThin/masking/portCodexRollouts/zstd` 中的哪一条（#4735/#4371 的 profile 都是这个入口采的）。

## 5. 诚实边界（不自信的点）

- **41% 的"持续 vs 峰值"未知**——整个排序建立在这四个字上，曲线形状（证据 4）可一票定案；本报告只能给条件化排序，不能定案。
- **平台未知**：本机全部实测是 macOS arm64；#4742 的周期链只在 Windows 复现过，Windows 的 WebView2 可见性/节能行为无法本机验证。
- **0.41 核的量级巧合**只是参照（那次 profile 含请求流量），不构成证据。
- 嫌疑 1 的家族（pairRowsMemo/readLogSnapshot）在基线仍属"结构性存在"，但没有大数据量日志的本机复现（本机仅 1.6M），无法给出"多大日志→多少 CPU"的实测换算。
- 隔离实例突发（23:56:14）与 `codexPortAfter=2min` 的时间吻合是推断（无内置日志直接标注该 pass），但时间差 2s 内、且无其它候选任务，置信度高。
- 未测项：真实 41% 复现（无报告者的数据/账号/插件）；Windows 任何场景。

## 6. 附：本诊断的可复现命令序列

```sh
git -C <magpie> fetch upstream main          # 基线 59fdab0af
git -C <magpie> archive 59fdab0af | tar -x -C /tmp/magpie-cpu-diag/src
cd /tmp/magpie-cpu-diag/src && go build -tags production -o ../bin/magpie .
touch /tmp/magpie-cpu-diag/bin/.portable     # portable 隔离
cd /tmp/magpie-cpu-diag/bin && nohup ./magpie gui > ../app.log 2>&1 &
# ps -o pid=,pcpu= 每 2s 采主进程+bun 宿主；osascript set visible false 模拟最小化
```
