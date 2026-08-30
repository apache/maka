# Runtime managed mutation pure transform v1

## 1. 不变量

managed Write/Edit 不读写 live checkout。Runtime 使用自己的原始工具参数和 Host 提供的 immutable accepted-tree base content，计算唯一 result content 与 provider result。

该转换允许 recovery 在 T2 前根据完全相同的 durable input 重新计算；它不拥有 filesystem、network 或 process 副作用。跨进程安全性来自 deterministic input/output 与后续 at-most-one acceptance，而不是 invocation count。

```text
Runtime-owned args + T1 expectedPath + accepted base content
  -> pure Write/Edit transform
  -> immutable mutation result proof
```

Host 不能返回完整 `executionArgs`，也不能替换 `content`、`old_string` 或 `new_string`。它只能提供 accepted-tree base content；路径来自已经与 durable function call 严格匹配的 T1 `expectedPath`。

## 2. Owner

- Runtime：参数、transform、provider result、strict JSON snapshot；
- Host admission：accepted-tree base content 与 terminal proof；
- Gitoxide candidate owner：后续消费 mutation result proof；
- SQLite：后续决定 terminal/accepted truth。

## 3. 失败状态

- Write 参数无效；
- Edit 目标缺失；
- Edit 匹配缺失或不唯一；
- immutable base envelope 畸形。

前三类是“operation completed with no workspace effect”，由 Runtime 转成 error proof，后续 owner 在确认没有 candidate 后提交 `operation_failed_no_effect`。Host envelope 畸形在 T1 前拒绝。

## 4. 非目标

- 不发布 candidate receipt；
- 不推进 accepted head；
- 不物化 projection；
- 不接 Desktop/CLI；
- 不允许 filesystem worker 获得 managed worktree 写权限。
