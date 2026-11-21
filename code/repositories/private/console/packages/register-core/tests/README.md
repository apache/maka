# tests 目录说明

## 定位

`tests` 保存 CLI 自动化工具的验证入口。当前测试以纯函数、状态机、配置、Provider 和 Mock 浏览器流程为主。

## 目录职责

| 目录 | 职责 | 是否依赖 native SQLite |
| --- | --- | --- |
| `unit/` | 纯函数、配置、状态机、Provider、基础设施测试 | 大多不依赖 |
| `integration/flowIntegration.test.ts` | Mock 浏览器跑通注册编排主干 | 不依赖 |
| `integration/persistenceIntegration.test.ts` | 真实 SQLite Repository 集成测试 | 依赖 `better-sqlite3` |
| `manual/` | IMAP、CDK 等外部通道手动验证脚本 | 依赖真实配置 |

## 推荐命令

当前环境如果仍是 Node 24，可以临时执行：

```powershell
.\node_modules\.bin\tsc.cmd --noEmit
.\node_modules\.bin\vitest.cmd run tests/unit tests/integration/flowIntegration.test.ts
```

等切到 Node 20 后再执行完整验证：

```powershell
pnpm install
pnpm test
pnpm doctor
```

## 脚本分层

| 命令 | 覆盖范围 |
| --- | --- |
| `pnpm test:fast` | Node 20 下运行 `tests/unit` 和 `tests/integration/flowIntegration.test.ts` |
| `pnpm test:sqlite` | `tests/integration/persistenceIntegration.test.ts` |
| `pnpm test` | 全量 Vitest |