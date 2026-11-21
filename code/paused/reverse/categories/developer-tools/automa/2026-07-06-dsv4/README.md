# Automa v1.30.01 — 逆向工程版本

> 逆向日期: 2026-07-06 | 模型: dsv4 | 构建: Webpack 5 | 框架: Vue 3.4.38 | MV: 3

## 概述

本目录包含对 **Automa** Chrome 扩展 v1.30.01 的完整逆向工程产出。

Automa 是一款功能强大的浏览器自动化扩展，允许用户通过可视化工作流编辑器 (drawflow) 创建自动化任务，涵盖网页交互、数据提取、HTTP 请求、条件逻辑、定时调度等场景。

## 目录结构

```
2026-07-06-dsv4/
├── dist/                          # 可直接加载到 Chrome 的扩展文件
│   ├── manifest.json              # Manifest V3 清单
│   ├── background.bundle.js       # Service Worker (262KB)
│   ├── newtab.bundle.js           # Dashboard SPA (3.1MB)
│   ├── popup.bundle.js            # 弹出面板 (614KB)
│   ├── contentScript.bundle.js    # 内容脚本 (435KB)
│   ├── offscreen.bundle.js        # 屏幕外文档 (863KB)
│   ├── sandbox.bundle.js          # 沙箱页面 (108KB)
│   ├── elementSelector.bundle.js  # 元素选择器 (547KB)
│   ├── webService.bundle.js       # Web 服务集成 (37KB)
│   ├── execute.bundle.js          # 执行启动器 (21KB)
│   ├── params.bundle.js           # 参数编辑器 (393KB)
│   ├── recordWorkflow.bundle.js   # 录制器 (164KB)
│   ├── *.html                     # 各入口 HTML 页面
│   ├── *.css                      # 样式表
│   ├── locales/                   # 多语言文件 (en/es/fr/it/pt-BR/tr/uk/vi/zh/zh-TW)
│   └── *.svg/*.png/*.woff2        # 静态资源
├── src/
│   ├── types/
│   │   └── index.ts               # TypeScript 类型定义
│   └── docs/
│       ├── ARCHITECTURE.md        # 架构文档
│       ├── DATA_FLOW.md           # 数据流文档
│       └── SECURITY_AUDIT.md      # 安全审计报告
├── package.json                   # Node.js 包配置
└── README.md                      # 本文件
```

## 技术栈

| 类别 | 技术 |
|------|------|
| 构建工具 | Webpack 5 (代码分割 + CSS 提取) |
| UI 框架 | Vue 3.4.38 + Vue Router + Drawflow 画布 |
| 浏览器兼容 | webextension-polyfill |
| 工具库 | lodash, dayjs, dot-object |
| 后端集成 | Supabase (认证/团队共享) |
| IndexedDB | idb |
| 清单版本 | Manifest V3 |

## 权限清单

**必需 (11)**: `tabs`, `proxy`, `alarms`, `storage`, `debugger`, `activeTab`, `offscreen`, `webNavigation`, `unlimitedStorage`, `scripting`

**可选 (5)**: `cookies`, `downloads`, `contextMenus`, `clipboardRead`, `notifications`

**主机**: `<all_urls>`

## 核心架构

```
展示层:    Popup / Dashboard / Params / Recorder / ElementSelector
          (Vue 3 SPA + 独立 HTML 页面)
              │ runtime.sendMessage
业务逻辑:  Background Service Worker
          (消息中枢 / 工作流调度 / 触发器管理 / API 代理)
              │ runtime.sendMessage
执行引擎:  Offscreen Document (debugger/DOM) + Sandbox Page (unsafe-eval)
              │ tabs.sendMessage
注入层:    Content Script (all_urls + all_frames)
```

## 安装测试

1. 打开 Chrome → `chrome://extensions/`
2. 启用 "开发者模式"
3. 点击 "加载已解压的扩展程序"
4. 选择 `dist/` 目录
5. 扩展应正常加载并显示 Automa 图标

## 免责声明

本逆向工程产物**仅供安全研究与学习目的**。原始 Automa 扩展的版权归原作者所有。使用此逆向产物进行二次分发、商业用途或恶意用途可能违反软件许可协议和法律法规。

## 相关资源

- [Automa 官网](https://www.automa.site/)
- [Automa GitHub](https://github.com/AutomaApp/automa)
- [Chrome Web Store](https://chromewebstore.google.com/detail/automa/infppggnoaenmfagbfknfkancpbljcca)
