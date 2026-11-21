# src 目录说明

## 定位

`src` 是 CLI 自动化工具的生产源码目录。当前保持原有相对导入和文件位置，避免在没有 Git 回滚保障的情况下做大范围搬迁。

## 当前目录职责

| 目录 | 职责 | 归属层 |
| --- | --- | --- |
| `index.ts` | CLI 入口，注册命令 | app |
| `cli/` | 命令实现、启动确认、doctor | app |
| `config/` | Zod schema、配置加载、选择器归一化、常量 | config |
| `flows/` | 注册和 OAuth 编排、自愈策略、身份生成 | domain |
| `state/` | 页面快照、状态机、页面事件识别 | domain |
| `oauth/` | PKCE、授权 URL、code 换 token、JWT 读取 | domain |
| `browser/` | BrowserAdapter、Playwright、PuppeteerReal、DOM 工具 | infrastructure |
| `providers/` | sms、mail Provider 抽象和实现 | infrastructure |
| `persistence/` | SQLite 连接、迁移和 Repository | infrastructure |
| `infra/` | HTTP、代理、限速和重试工具 | infrastructure |
| `logging/` | pino 日志和运行报告 | infrastructure |
| `compliance/` | 合规提示和速率护栏 | cross-cutting |
| `types/` | 品牌类型和 Result 类型 | shared |

## 推荐阅读顺序

1. `index.ts`
2. `cli/commands.ts`
3. `config/loader.ts`
4. `state/pageDetector.ts`
5. `state/SignupFlow.ts`
6. `state/OAuthFlow.ts`
7. `flows/SignupOrchestrator.ts`
8. `flows/OAuthOrchestrator.ts`
9. `oauth/OAuthClient.ts`
10. `browser/BrowserAdapter.ts`
11. `providers/mail/createMailProvider.ts`
12. `providers/sms/createSmsProvider.ts`
13. `persistence/migrations/0001_init.sql`

## 下一阶段迁移目标

等获得明确批准后，可以把当前目录迁移成：

```text
src/
├── index.ts
├── app/
├── domain/
├── infrastructure/
├── config/
├── compliance/
└── shared/
```

迁移条件：

1. 明确允许批量移动源码和测试导入。
2. 当前工作区有可回滚快照或 Git 提交。
3. 迁移后必须通过 `pnpm typecheck` 和 Vitest 子集。