# Runtime managed mutation settlement proof v1

## 1. 主要不变量

在一次存活的 Runtime execution 内，managed Write/Edit 的 provider result 与 durable response 由 Runtime 从同一个 strict-JSON snapshot 构造，并且只构造一个 response event。Host 可以选择并提交 workspace terminal，但不能替换或重新解释 provider 结果。

本切片不承诺跨进程的 transform invocation exactly-once。T2 前进程退出后，后续 recovery owner 可以基于同一个 durable operation、accepted base 与冻结参数重新计算无外部副作用的 deterministic transform；安全属性是“最多接受一个精确 successor”，不是“纯函数只调用一次”。

```text
Runtime-owned strict JSON result
  -> immutable RuntimeEvent outcome proof
  -> Host-owned Git/SQLite terminal commit
  -> Runtime exact adoption
```

## 2. Owner 与权限

- Runtime 拥有原始 tool args、pure transform、provider result 和 response envelope。
- Runtime 向 settlement owner 暴露只读 `RuntimeManagedMutationOperationProof`；其中的 `durableOutcome` 是冻结的精确事件。
- no-change 或明确业务失败时，Runtime 额外签发与 T1 identity 绑定的 `terminalOutcome`。
- Host 不能返回 execution args，也不能要求 Runtime 采用另一个 success result。
- Storage 只通过 owner-bound execution-stores capability 暴露 head/version/reservation 读取和 successor/terminal 原子写入；裸 SQLite writer 不进入 Host API。

## 3. 原子性边界

- T1：function call、dispatch 和 durable reservation 在一个 SQLite transaction 中提交。
- T2：tool response 与 successor/head，或 tool response 与 no-effect terminal/reservation release，在一个 SQLite transaction 中提交。
- Git candidate receipt 与 SQLite 不是一个事务；候选 ref/receipt 只能作为派生证明，不能自行推进 accepted head。

## 4. 失败状态与回滚

- T1 前失败：不产生 reservation，可直接返回拒绝。
- T1 后 proof 缺失、被修改或 owner 抛错：`unsettled`，禁止 generic T2 fallback。
- no-change / failed-no-effect：使用 Runtime-issued terminal event 原子释放 reservation。
- candidate 已产生但 SQLite 未接受：保持未接受派生物；如何 reopen、重新计算或 park 由后续 managed-recovery owner 明确定义。
- SQLite 已接受但 Git accepted ref 尚未投影：由后续 accepted-ref projection slice 直接采用 durable candidate evidence 幂等推进，不依赖当前 transform 实现。

## 5. 平台承诺

本切片只改变 Runtime/SQLite capability seam，不执行平台文件 mutation：

- Linux、macOS、Windows：同一 strict RuntimeEvent 与 SQLite transaction 合同。
- Git ref promotion、filesystem projection 和 crash reconciliation 由后续切片分别提供平台证据。
