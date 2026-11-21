# 附录 · 复现脚本

`repro-midturn.ts`：零依赖，直接调用 `runTurn` / `estimateTokens` / `createPermissionGate`，用假 provider 复现 C1、C3、C4。

```bash
cd impls/typescript
mkdir -p scripts && cp <本附录>/repro-midturn.ts scripts/
node scripts/repro-midturn.ts
```

## 基线输出（develop @ bbac303，已实测）

```text
A. 单轮内每次模型请求前的估算 token： 9 → 20026 → 40043 → 60060 → 80077 → 100094 → 120111 → 140128 → 160145
   超过 contextLimit(100000) 的请求次数： 4 （轮内无任何治理）
B. finish_reason=length 截断的 tool 参数 → 工具实际收到： {}
C. 对 write 选 always 后，bash 是否还询问： 不再询问（全局 yolo） 放行= true
```

## 合并后预期

| 项 | 预期 | 对应 |
|---|---|---|
| A | 需要把 `governanceMiddleware` 传给 `runTurn` 才能看到效果；每次请求 ≤ 上限 | WP1 + WP2 |
| B | 工具不再被调用，`got` 保持 `'unset'` | WP3 |
| C | **不变**（always 是锁定契约） | — |
| D | 取消脚本末尾注释后：选 scoped，bash 仍询问 | WP4 |

注意：脚本 A 项直接调用 `runTurn`，不经过 `turn.ts`，所以 WP2 合并后要在脚本里显式传 `middleware: [governanceMiddleware(...)]`。
