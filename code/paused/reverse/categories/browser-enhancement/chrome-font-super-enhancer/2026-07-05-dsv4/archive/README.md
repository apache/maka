# Chrome Font Super Enhancer — 逆向工程归档

## 归档信息

| 字段 | 值 |
|------|-----|
| 项目名称 | Chrome Font Super Enhancer (逆向工程) |
| 原始扩展版本 | 2.25 |
| 原始作者 | "ME" |
| 清单版本 | Manifest V3 |
| 逆向工程日期 | 2026-07-05 |
| 归档编号 | dsv4 |
| 文件数 | 18 (原始) + 6 (逆向产物) |

## 归档内容

### 原始文件 (dist/)
- manifest.json — 扩展清单
- service-worker.js — Service Worker 后台脚本
- content.js — 核心字体增强内容脚本
- popup.html / popup.js / popup.css — 弹出窗口
- options.html / options.js / options.css — 选项页面
- manage.html / manage.js — 排除域名管理
- images/ — 图标集 (16/32/48/128)
- paypal.png / options.png — 素材图片
- _metadata/ — Chrome Web Store 验证签名

### 逆向产物 (src/)
- types/index.ts — TypeScript 类型定义（接口、常量、算法）
- docs/ARCHITECTURE.md — 架构文档（中文）
- docs/DATA_FLOW.md — 数据流文档含 Mermaid 图（中文）
- docs/SECURITY_AUDIT.md — 安全审计报告（中文）

### 工程文件
- package.json — TypeScript 项目配置
- README.md — 项目总览

## 关键技术发现

1. **字体增强原理**: text-shadow 硬边阴影（blur=0）+ RGBA 不透明度按亮度公式计算
2. **亮度公式**: ITU-R BT.709 系数 (0.2126·R + 0.7152·G + 0.0722·B)
3. **解锁码**: 混淆字符串 "Contexts binary-o..." → reduceRight 字符提取 → "Apz4m1-s"
4. **内存管理**: WeakMap(lastColor) + WeakSet(spaced) 避免 DOM 污染和内存泄漏
5. **增量处理**: MutationObserver + 100ms 防抖批处理
6. **Shadow DOM**: 递归穿透 open shadowRoot
7. **无网络通信**: 所有操作完全离线，不收集用户数据

## 安全评估摘要

- 安全评级: 🟢 低风险
- 高危漏洞: 0
- 中危漏洞: 0
- 低危漏洞: 0
- 关注点: 解锁码为客户端混淆，静态分析可还原
- 隐私: 无数据收集、无网络请求、无追踪

## 使用限制

本归档仅用于学习和研究目的。原始扩展代码版权归原作者所有，不得用于商业用途或重新发布。
