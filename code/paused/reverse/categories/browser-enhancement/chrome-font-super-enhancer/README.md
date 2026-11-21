# Chrome Font Super Enhancer

**原始名称**: Chrome Font Super Enhancer | **商店版本**: 2.25 | **Manifest**: V3

## 功能概述

Chrome Font Super Enhancer 通过 text-shadow 技术增强 Chrome 浏览器中的字体渲染效果，改善中文字体在 Windows 系统下的锯齿问题。

核心功能：
- 全局字体抗锯齿增强（text-shadow 硬边阴影 blur=0）
- 动态不透明度计算（基于 ITU-R BT.709 亮度公式 `0.2126R + 0.7152G + 0.0722B`）
- Shadow DOM 递归穿透
- DOM 变化自动重处理（MutationObserver + 100ms 防抖）
- 内存安全（WeakMap + WeakSet 避免 DOM 属性污染）

## 技术架构

- **框架**: 纯原生 JS
- **注入**: content.js 在 document_end 注入所有页面和 iframe
- **存储**: chrome.storage.sync（跨设备同步偏好）
- **解锁码**: `"Apz4m1-s"`（经 `reduceRight` 字符提取混淆）

## 安全

无网络通信、无数据收集、最小权限集，安全风险评级为低。

## 权限

`storage`, `activeTab`

## 分析版本

| 版本 | 日期 | 模型 | 文档 |
|------|------|------|------|
| 2.25 | 2026-07-05 | DeepSeek V4 Pro | [2026-07-05-dsv4/](2026-07-05-dsv4/) |
