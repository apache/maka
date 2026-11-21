# ADR-0007：数据面保持零运行时依赖；zod 只在 contracts 与控制台

- 状态：草案（Proposed）
- 相关：01 §2 依赖方向；WP0、WP7、WP8

## 背景

现有网关零运行时依赖，这是它的长板：安装快、供应链面小、`node --test` 直接跑 TS。新增管理面和控制台后，有人会想在网关里用 zod 校验 admin 请求、用 express/hono 做路由、用 better-sqlite3 存用量。

## 决定

1. `apps/gateway/package.json` 的 `dependencies` 保持为空。CI 检查。
2. 网关内的校验手写（参考骨架 `parseRouteGroups`）。错误信息要带路径（`members[1].model`）。
3. `packages/contracts` 用 zod 定义 admin API 与路由事件的 schema，**只被** `apps/console`、`apps/playground`、测试引用。网关不 import 它（architectureCheck 强制）。
4. 两边一致性靠**契约测试**保证：网关 e2e 产出的真实响应 / 事件，用 contracts 的 zod schema parse，必须全部通过（骨架 live 模式已验证 0 条非法）。
5. 存储用 `node:fs`（JSON 原子写）和 `node:sqlite`。不可用时降级为 JSONL。
6. HTTP 继续用 `node:http`，不引入框架。

## 后果

- 正面：数据面供应链面不变；SEA 打包简单。
- 负面：同一个 schema 写两遍（手写校验 + zod）。用契约测试兜住漂移。
- 备选（已否决）：网关引入 zod —— 约 60 KB，换来少写约 200 行校验，不值得破坏"零依赖"这个对外承诺。
