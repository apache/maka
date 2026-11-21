---
name: summary-me
description: 项目总结、复盘、交接和组件说明沉淀。Use when writing components.md, README, handoff docs, project summaries, retrospectives, architecture notes, or when turning a delivery into reusable personal experience. Pair with writer-me for final wording polish.
---

# 总结沉淀实践

## 使用定位

用于把一次开发、重构、排查或交付沉淀成可复用文档。它负责结构，最终语气和去 AI 味可交给 `writer-me`。

## 推荐结构

1. 一句话结论。
2. 当前事实和文件范围。
3. 做了什么改动。
4. 为什么这样设计。
5. 哪些可以复用。
6. 哪些不能泛化。
7. 验证了什么。
8. 后续接入和风险。

## 组件说明文档重点

- 先写业务组件，而不是内部视觉碎片。
- 标清哪些组件适合跨模块复用。
- 标清数据边界：DTO、mapper、ViewModel、normalize、constants。
- 标清设计原则：业务红框、组合优先、少布尔 props、静态数据上移。