# @ggbdpq/blog

个人博客微服务（端口 3100）。技术栈宪法、架构边界与九项目迁移对照见 [AGENTS.md](./AGENTS.md)；任务裁决入口为 `../../.ggbdpq/actions/blog/prd.json`。

```bash
pnpm dev:blog   # 开发（workspace 根执行）
pnpm build && pnpm start
pnpm test && pnpm typecheck
```

栏目：朋友圈（首页）/ 文章 / 算法 / 成长 / 约会攻略 / 动漫 / 技能 / 关于 / RSS。
