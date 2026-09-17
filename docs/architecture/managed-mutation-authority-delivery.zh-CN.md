# Managed mutation authority：交付合同

## 状态与范围

本分支从 `upstream/main@cd93f13da78d3f8aa7f480f509bf80b8bd024cec` 提取；
实现来源为 `codex/managed-files-mainline-rebuild@87a9c7765`。
这是四个交付中的第一项，不是完整 Desktop Resume。
没有增加 schema 版本、Host 协议、Gitoxide helper、Desktop 入口或自动恢复。

## 主要不变量

显式 managed mutation 在 T1 后，只能把 Runtime 计算出的结果交给已选择的
workspace authority 结算；不可调用 checkout Write/Edit 实现，不可回退 generic T2。
所有 workspace authority 调用受同一个 execution stores group 的生命周期约束。

## Owner 与权限

- Runtime 拥有原始工具参数、纯 Write/Edit 转换、provider result 和规范 response envelope。
- Host 后续负责提供经过验证的 accepted base 与 proof verifier；本交付不实现该 Git 验证。
- Storage group 选择一次 proof verifier，固定函数快照，禁止换 owner。
- authority facade 不暴露 SQLite handle；每次调用都进入现有 group runner。
  close 停止新调用并 drain 已进入调用。伪造 group、已关闭 group、Memory provider 均拒绝。
- `readVersion` 不属于 PR1；PR2 的 accepted-ref predecessor 校验及后续 continuation
  需要历史证据读取，分别随真实消费者加入和验证。
- `PreparedManagedMutation.commitOutcome` 是受信 composition 接口，不是来自工具参数的权限。
  Runtime 深比较返回的完整 durable event；Storage 独立约束 writer 与事务。
  本切片不宣称该接口能够鉴别恶意的进程内 Host 实现。

## 原子边界与失败状态

| 阶段 | 原子边界 | 失败行为 |
| --- | --- | --- |
| 采用已有普通历史 | 同一 SQLite write transaction 扫描 canonical workspace facts、核对投影、绑定 root | 有 workspace residue 或 root 不同则拒绝，不清库、不改历史 |
| T1 | 使用 main 已有的 call/dispatch/reservation 事务 | T1 失败不运行转换、不发布结果 |
| managed 执行 | 纯函数：accepted content + 已验证参数 → 内容和冻结结果 | 确定性 Edit 匹配失败进入 no-effect error；其他异常 fail-stop |
| T2 | 使用 main 已有 successor/no-effect atomic writer | owner throw、缺失 event、修改 event 均禁止 generic fallback 或发布伪造结果 |
| close | group runner 停止 admission、等待已进入调用结束 | retained facade 失效，不改选 backend |

取消若已发生在 T1 前，不进入 durable dispatch。
T1 已成功后完成有界纯转换与 owner settlement；这不是取消后继续操作用户 checkout。
未知失败保留 durable reservation，后续恢复属于第四个交付，不在这里自动释放或重试。

## 回滚

没有数据库 schema migration。撤回未接入的 composition hook 不影响普通工具路径。
已提交的 T1/T2/root binding 不通过降级、清库或删除事实回滚：
T1 未结算保持 fail-closed，已接受 T2 仍由 main 的 ledger 读取。
撤回本代码不代表可以重新运行未确定的 mutation。

## 测试与平台

携带纯转换、Runtime durable-boundary、execution-provider conformance、
workspace-version authority persistence 测试。后者包含在 root binding 前/后真实子进程退出，
然后由父进程 reopen 校验；不是用异常代替所有 crash 证据。
现有 main 的 reservation/terminal 事务约束继续复用。

| 平台 | 本切片目标 | 本轮证据 |
| --- | --- | --- |
| Windows | group revocation、SQLite adoption process-exit/reopen、纯转换与严格 T2 | Node 24.18.1；新分支 Core/Storage/Runtime build 通过，五文件 187/187，0 skip |
| Linux | 同一平台无关 Runtime/SQLite 合同 | 本轮未执行，需 CI |
| macOS | 同一平台无关 Runtime/SQLite 合同 | 本轮未执行，需 CI |

不承诺本切片已验证断电、Git materialization、完整 Host kill/restart 或 Desktop Resume。

定向验证命令（先按依赖顺序构建 Core、Storage、Runtime）：

```sh
node --test packages/runtime/dist/__tests__/managed-mutation-transform.test.js packages/runtime/dist/__tests__/edit-replace.test.js packages/runtime/dist/__tests__/tool-runtime-durable-boundary.test.js packages/storage/dist/__tests__/execution-provider-conformance.test.js packages/storage/dist/__tests__/workspace-version-authority-persistence.test.js
```

本轮未运行全量 CI、Linux 或 macOS；不能把上述定向结果描述为跨平台全绿。

## 后续交付

1. 本项：managed mutation authority。
2. Gitoxide managed file execution：verified import/read/candidate/accept/ref。
3. Desktop managed files tasks：prepared creation、Host capability 与显式 UI 入口。
4. Crash recovery and manual continuation：existing-candidate verification、source-bound
   continuation、真实 Host/Electron crash proof。

后三项尚未从此基线提取。不得把来源分支中的完整能力当成本 PR 的已交付能力。
