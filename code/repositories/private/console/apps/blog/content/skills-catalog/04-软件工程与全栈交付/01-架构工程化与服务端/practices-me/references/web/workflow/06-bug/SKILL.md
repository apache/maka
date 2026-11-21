---
name: bug-me
description: 最小改动修复与轻量回归。Use when fixing a clear bug, startup failure, compatibility issue, local environment blocker, controlled console debugging, first-principles root-cause narrowing, adversarial fix review, or when the user asks to only change necessary files, avoid refactors, keep the diff small, or get the path running first.
---

# 最小改动修复

## 使用定位

只解决当前目标的直接阻断点。优化目标是最小可审阅 diff，改到阻断解除就停下。

如果目标是模块蓝图、目录规范、文档体系迁移或新 skill 提炼，切到对应 skill。

## 铁律

- Fail fast and loudly. Do not add fallback logic unless the user explicitly requires fallback behavior.
- Let exceptions and real errors surface early. Do not absorb business-layer errors just to make the UI look calmer.
- Write tests only when they first prove the current bug exists by failing. Do not expand scope with test infrastructure when the user's goal is immediate unblocking.

## 直接阻断链

动手前把候选改动分三类：

| 分类        | 判断                                 | 处理     |
| ----------- | ------------------------------------ | -------- |
| `required`  | 不做它，当前目标仍失败               | 本轮实现 |
| `optional`  | 更整洁、更完整，但当前不阻断         | 列为后续 |
| `off-scope` | 重构、文档、脚本、相邻问题、测试基建 | 本轮不做 |

## 第一性原理最小失败原语

定位 bug 时先把现象拆到最小失败原语，再决定改哪里。只回答四个问题：

| 问题                     | 用途                           | 输出                                       |
| ------------------------ | ------------------------------ | ------------------------------------------ |
| 真实失败是什么           | 避免把症状、猜测和根因混在一起 | 一个可复现的失败断言、日志、请求或页面行为 |
| 最短调用链是什么         | 把搜索范围压到直接路径         | 入口、直接调用方、一层被调方               |
| 必须保持不变的契约是什么 | 防止修复改变业务语义           | 字段、状态码、返回结构、UI 行为、命令输出  |
| 最小可验证切口是什么     | 避免新增测试基建               | 单测、契约测试、命令、人工检查点中的一个   |

这一步用于缩小修复，不用于写长方案。若拆解后发现目标其实是架构规划、能力蓝图或接口设计，切到对应 skill。

## 对抗性修复审查

动手前和收尾前各问一遍反方问题：

| 反方问题                   | 如果答案为是       | 处理                         |
| -------------------------- | ------------------ | ---------------------------- |
| 是否吞掉了真实错误         | 会让后续排查更难   | 删除 fallback 或改为显式报错 |
| 是否改变了原业务契约       | 会引入隐性回归     | 收回改动或补契约测试         |
| 是否扩大了文件和模块边界   | 会增加 review 面积 | 只保留 required 文件         |
| 是否把环境问题写成代码绕过 | 会掩盖前置条件     | 改为说明命令和依赖           |
| 是否为了“更优雅”抽象       | 会把修复变成重构   | 留为后续事项                 |

对抗性思辨在这里的目标是防止误修和过修，不是把小 bug 升级成路线图。

## 受控诊断打点

当用户只要求调试、排查、找原因、看为什么、debug 或加 console 时，先进入诊断模式：

1. 只在用户指定文件、直接调用方或一层被调方加最少 console。
2. 统一使用 `[DEBUG]` 前缀（可根据项目约定命名），必要时只补紧邻的 `eslint-disable-next-line no-console`。
3. 禁止在诊断模式下改业务分支、返回值、异常处理、请求参数、状态写入、依赖版本或目录结构。
4. 用户贴新日志时，只调整诊断点继续缩小范围，直到根因链路足够清楚。
5. 用户说已找到原因、OK、明白了、调试结束、删 console，或转入梳理机制时，先删除 `[DEBUG]` 及对应 eslint 注释，再继续下一步。

诊断输出只说明复现路径、应该看哪些 Console 或 Network 证据、下一轮需要贴回哪些日志。只有用户明确要求修复时，才从诊断模式切回最小改动修复。

## Test-first 流程

1. 抽取最小失败现象。
2. 找到可独立运行的函数、样式、配置、schema、route 或 contract。
3. 先写会失败的轻量测试，确认失败原因和 Bug 对齐。
4. 用第一性原理确认最小失败原语，用对抗性审查排除误修和过修。
5. 只改 `required` 文件。
6. 只运行相关测试，再按风险补人工验收。
7. 报告未改事项和原因。

## 常见判断

## 反模式

- 不顺手清理。
- 不为了小修复新增大型测试体系。
- 不把一个 Bug 修成通用框架。
- 不捕获异常后发明新 UI 状态解释它。
- 不改脚本名、依赖版本或目录结构来显得更整齐。
- 不把真实外部接口混进普通轻量测试，除非目标就是集成验收。

## 输出格式

1. 结论摘要
2. 根因链路
3. 修改文件清单
4. 必须改的原因
5. 测试命令和结果
6. 未改事项
