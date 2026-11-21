# ADR-0009：控制台由网关同源托管；桌面壳延后；只接三个 Agent

- 状态：草案（Proposed）
- 相关：01 §1；02 §3.1、§6；WP7、WP8、WP9、WP11

## 决定

1. **托管**：`apps/console` 构建产物随 npm 包发布，网关在 `/ui` 同源托管。不单独起前端服务，不需要 CORS。dev 模式才通过 `QPA_DEV_CORS_ORIGIN` 开 CORS（原型验证时踩过预检失败的坑）。
2. **事件流**：正式版用 fetch 流读取 `/admin/events`，带 `Authorization` 头；`EventSource` + `?token=` 只做 dev 兜底。
3. **技术栈**：React 19 + TypeScript 7 + Vite 8 + React Router + Zustand 5 + Zod 4 + Tailwind 4 + shadcn CLI v4。界面信息结构参照 magpie（Agent / 供应商 / 路由 / 用量 / 设置），视觉和文案自己做，不复制图标和名字。
4. **桌面壳延后**：先 `npx` 与 Node SEA 单文件。菜单栏 / 托盘 / 开机自启等放 WP11 评估（Tauri 优先，体积小）。不为桌面壳改架构：壳只是启动网关进程 + 打开 `/ui` 的 WebView。
5. **Agent 范围**：只接 **Claude Code、Codex、OpenCode**。它们覆盖了三种下游协议（Anthropic Messages、OpenAI Responses、OpenAI Chat），能把网关的三条入口都验证到。其他 Agent 在界面上列为"暂不支持"，不写文件。新增 Agent 需要：真实 CLI 验证字段 + I7 三种场景测试。

## 后果

- 正面：一个进程一个端口；安全边界简单（回环 + token + Host/Origin）。
- 负面：没有原生菜单栏体验，状态要打开浏览器看；后续可用桌面壳补。
