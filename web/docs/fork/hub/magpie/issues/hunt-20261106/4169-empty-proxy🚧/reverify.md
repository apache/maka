# #4169 rework 现场命中验证（rework per @yetone's review）

分支 fix/4169-empty-proxy（基线 upstream/main 18a9a2d88）。维护者驳回原因：上一 patch（failed 读退避，4c9616c35）「修的不是报告者的现场」——报告者 MisonL 实测其机器 `scutil --proxy` **成功返回空代理**，`failed` 恒 0，退避永不触发（她实测：分支 7da88d97 上 59 reads vs main 58 reads，同一窗口）。

## 报告者实测数据（原帖，MisonL）

```
$ scutil --proxy; echo "exit=$?"
<dictionary> {
  FTPPassive : 1
  HTTPEnable : 0
  HTTPSEnable : 0
  ProxyAutoConfigEnable : 1
  ProxyAutoConfigURLString : http://wpad/wpad.dat
  ProxyAutoDiscoveryEnable : 1
  SOCKSEnable : 0
}
exit=0
```

- `parseScutil` 只看 HTTP/HTTPS/SOCKS 的 `*Enable`（PAC 不解析）→ 返回 `Proxy{}` → `readTool` 返回 `(Proxy{}, true)`——**读成功、空代理**（她端到端实测 ok=true, p={URL:""}；no-proxy 最小字典与 PAC-only 字典解析相同）。
- 她的探测（noneKeep 缩 5ms，300ms 循环 ask(t) 计 readSystem 调用）：上一 patch 分支 59 reads，main 58 reads——退避在她的数据流里完全不成立。

## 本修法逐步过报告者数据流（每步在她机器上成立）

修法面：`sysCache.quiet int` = 连续未找到代理的读次数（失败/空读都计入）；`quietKeep(n)` = noneKeep×2^(n-1) 封顶 failKeep(1m)；读到代理（ok && URL!=""）quiet 清零；`failed bool` 原样保留只管 #3421 fail-open。

| 步 | 她机器上发生什么 | 修法行为 |
| --- | --- | --- |
| 1 | 请求 → `For()`/`EnvWith()` → `System()`；缓存过期 → fork `scutil --proxy` | fork 1 次（唯一 per-request fork） |
| 2 | scutil exit 0、无 `*Enable=1` → `parseScutil`→`Proxy{}` → `readSystem()` 返回 `(Proxy{}, true)` | `ok=true && p.URL==""` → **走空读分支 `quiet++`**（关键差异：上一 patch 此处只看 failed，恒不触发） |
| 3 | 下一个请求 `System()`：quiet=1 | keep=`quietKeep(1)`=noneKeep=2s——首档不变，短暂空窗行为与 main 相同 |
| 4 | 请求持续流入，读依次回来仍空 | quiet=2→4s，3→8s，4→16s，5→32s，6→封顶 60s |
| 5 | 稳态 | **每 60s fork 1 次（main 是每 2s 一次，30x 降）**——上一 patch 广告的 30x 这次落在她的路径上 |
| 6 | 她哪天设了系统代理 | 下一个到点读返回非空 → `quiet=0`、keep=systemKeep=15s；代理消失后从 2s 重新爬梯（维护者要求的 reset 语义） |
| 7 | #1518 语义：magpie 启动后代理 app 才起 | 进程启动 quiet=0，前几读 2s/4s 档 → 代理很快被读到；`TestSystemProxySetAfterStartIsTakenSoon`（noneKeep=50ms，1 次空读后设代理 200ms 内取到）实测绿 |
| 8 | 失败路径（scutil 坏/被删） | `ok=false` → 同一 `quiet++` 爬梯 + `failed=true` 保持请求不等读（#3421 fail-open 原样）——上一 patch 的失败退避面被同一阶梯完整保留（维护者末评 "empty reads **too**"） |

关键差异一句话：上一 patch 退避挂在 `failed>0`，她现场 failed 恒 0；本修法退避挂在 `quiet`（成功空读也计数），她现场第 2 步即命中。

## RED/GREEN/消融实测

| 阶段 | TestEmptySystemProxyReadsBackOff | TestFailedSystemProxyReadsBackOff |
| --- | --- | --- |
| main 基线 18a9a2d88（RED，pre-fix） | FAIL：50 reads/250ms（noneKeep=5ms） | FAIL：50 reads/250ms |
| 修复后 | PASS（阶梯 ~6 reads/250ms + 中途设代理被取到 + 重置后 30ms 内 ≥3 reads 回到 none 档） | PASS |
| 消融（摘 System keep 计算 + refreshSystem quiet 更新两个逻辑 hunk，struct/测试保留） | FAIL：50 reads/250ms 回红 | FAIL：50 reads/250ms 回红 |
| 恢复后全包 | ok 5.4s（全绿） | 同 |

50 reads/250ms 即她 58-59 reads/300ms 的同形状（空读与失败读在 main 上节奏完全相同）。
