# CLAUDE.md — Chrome 扩展逆向工程

## 项目定位

本仓库对 Chrome Web Store 上的热门扩展进行系统化逆向工程，产出可运行的还原项目及完整分析文档。

## 核心入口

- **根 README.md** — 目录总索引（SSOT），新内容放哪看它的决策表
- **docs/Chrome扩展逆向工程指南.md** — 完整方法论与工作流程
- **categories/** — 所有逆向产出（按用途分 5 类）
- **crx-archive/** — 原始 CRX 文件存档（按日期分目录）

## 关键约定

1. 所有逆向产出放在 `categories/{分类}/{插件名}/{YYYY-MM-DD}-{模型}/` 下
2. 每个版本子目录必须包含：`dist/` + `src/types/index.ts` + `src/docs/ARCHITECTURE.md` + `src/docs/DATA_FLOW.md` + `src/docs/SECURITY_AUDIT.md`
3. 插件根 README.md 是通用介绍（不绑定版本），版本特定说明放版本子目录
4. 原始 CRX 文件统一放在 `crx-archive/{日期}/` 下
5. 新批次使用并行 agent 策略（每个插件一个 subagent）

## 记忆系统

旧工作路径（guahub/scripts/reverse-engineer）时代的 `.claude/projects/e--guahub-scripts-reverse-engineer/` 记忆目录已随 2026-11-16 目录收编退役，本机已无对应目录；如需新记忆，在当前路径重开 CLI 后自动生成。
