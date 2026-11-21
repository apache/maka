# sessions — AI 会话归档

按工具归档的 AI 会话记录与沉淀，完整索引入口是 [index.md](index.md)（按工具/项目/月份三张表）。

- `md/` — 机器逐会话抽取（frontmatter + 用户提问 + 助手结论 + 工具摘要），按 `md/<工具>/<项目路径>/<日期>_<短id>.md` 组织
- `curated/` — 人工治理层：cursor plans、项目级会话总结、AI 对话知识资产 v2（入口 [curated/README.md](curated/README.md)）
- `manifest.jsonl` — 全量清单（源/哈希/md 落位）
- `prompts/` `snippets/` `reports/` — 提示词库、精华片段、盘点报告
- `tools/` — 归档脚本（archive_phase2.py 与 Mac 适配版）
