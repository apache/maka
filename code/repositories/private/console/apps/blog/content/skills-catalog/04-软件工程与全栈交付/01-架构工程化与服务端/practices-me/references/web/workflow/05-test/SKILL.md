---
name: test-me
description: 测试用例与轻量验证实践。Use when designing acceptance cases, contract tests, pure function tests, UI smoke checks, visual regression notes, or when deciding what to verify without running full build/lint/format commands.
---

# 测试与验收实践

## 使用定位

用于把需求、组件和接口改动转成可执行验收点。它关注“验证什么”和“用什么最小方式验证”，质量门禁执行细节继续看 `quality-me`。

## 默认顺序

1. 先验证用户当轮明确要求。
2. 再验证本轮 touched files 的路径、导入、类型引用和关键分支。
3. 纯函数优先写最小输入输出用例。
4. 接口字段优先写 mapper/contract 测试。
5. UI 还原优先记录 URL、截图、设备、人工验收点。
6. 用户明确要求跳过构建、Prettier、ESLint、Stylelint 时，改用 UTF-8、冲突标记、行尾空白、路径引用、`git diff --check` 等轻量检查。

## 输出要求

- 明确已验证项。
- 明确未跑项和原因。
- 不把静态检查说成真实浏览器验收。
- 不把截图相似说成接口联调完成。