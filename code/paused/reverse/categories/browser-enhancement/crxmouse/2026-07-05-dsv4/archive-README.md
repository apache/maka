# crxMouse Chrome Gestures v7.0.5 — 存档说明

> 逆向工程批次 | 2026-07-06

---

## 来源

此目录包含对 **crxMouse Chrome Gestures** Chrome 扩展 v7.0.5 的逆向工程分析结果。

- **原始扩展名称**: crxMouse Chrome Gestures (crxMouse Top Gestures)
- **原始版本**: 7.0.5
- **Manifest 版本**: 3
- **文件名**: `crxmouse-chrome™-手势-source-code`
- **总文件数**: 403

---

## 分析步骤

1. manifest.json 权限分析 — 确认 12 个权限 + 2 个 host_permissions + 5 个 content script 注入点
2. 5 个 content script 职责分离分析 — 按 `run_at`、`match_about_blank`、帧范围分类
3. Service Worker 模块结构分析 — 识别 ~20 个内联模块
4. MpiUO 模块系统逆向 — 分析自定义依赖注入框架
5. 数据流追踪 — `mouse-gestures-feedback` 事件 -> 缓冲队列 -> 规则引擎 -> 服务端
6. 安全影响评估 — webRequest, clipboard, bookmarks, all_urls 组合风险分析
7. TypeScript 类型生成 — 根据运行时行为推断数据结构

---

## 归档内容

- `dist/` — 原始扩展完整副本
- `src/types/` — TypeScript 类型定义
- `src/docs/` — 架构文档、数据流图、安全审计
- `package.json` / `tsconfig.json` — 项目配置
