# Material Icons for GitHub (dsv4 逆向工程)

对 Chrome 扩展 **Material Icons for GitHub** v1.16.2 的逆向工程分析项目。

## 项目背景

**Material Icons for GitHub** 是一款在 Git 托管平台文件浏览器中注入 Material Design 风格 SVG 图标的 Chrome 扩展。它支持 10 个主流 Git 托管平台，拥有约 **1251 个 Material Design SVG 图标**。

本项目 (dsv4) 对该扩展进行系统性逆向工程，产出类型定义、架构文档、数据流文档和安全审计报告。

## 项目结构

```
material-icons-for-github-dsv4/
├── dist/                        # 原始扩展源码副本 (1265 files)
│   ├── main.js                  # 核心逻辑 (~52K tokens, 打包后单文件)
│   ├── manifest.json            # MV3 清单
│   ├── options.html/js/css      # 选项页面
│   ├── settings-popup.html/js/css # 弹出窗口
│   ├── injected-styles.css      # 注入样式
│   ├── icon-*.png               # 扩展图标
│   └── *.svg                    # ~1251 Material Design SVG 图标
├── src/
│   ├── types/
│   │   └── index.ts             # TypeScript 类型定义
│   └── docs/
│       ├── ARCHITECTURE.md      # 架构文档 (中文)
│       ├── DATA_FLOW.md         # 数据流文档 + Mermaid 图 (中文)
│       └── SECURITY_AUDIT.md    # 安全审计报告 (中文)
├── package.json
└── README.md                    # 本文件
```

## 技术要点

- **类型**: 纯 Content Script 扩展（无 Service Worker）
- **Manifest**: MV3
- **语言**: JavaScript (打包后), SVG
- **图标数量**: ~1251 个 Material Design SVG 文件
- **支持站点**: GitHub, Bitbucket, Azure DevOps, Gitea, GitLab, Gitee, SourceForge, Codeberg (Forgejo), Tangled
- **图标包**: Angular, Nest, NgRx, React, Redux, Roblox, Qwik, Vue, Vuex, Bashly (10 个)
- **存储**: chrome.storage.sync (per-host 设置)
- **Polyfill**: webextension-polyfill (内联)

## 核心架构发现

1. **无后台脚本**: 所有逻辑在 content script 中运行，`document_start` 注入时机确保在页面渲染前就绪
2. **Adapter 模式**: 每个 Git 托管平台有独立的 SiteConfig 适配器，封装 DOM 选择器和行为差异
3. **三级图标匹配**: 精确文件名 > 文件扩展名 > 默认图标
4. **图标注入**: 通过 `chrome.runtime.getURL()` 加载扩展内置的 SVG 图标，创建 `<img>` 元素替换原始图标
5. **设置系统**: Per-host 键覆盖 default 键，通过 `chrome.storage.onChanged` 实现实时更新
6. **自定义站点**: 用户可通过设置提供自定义选择器，扩展基于已知模板构建 SiteConfig

## 使用方式

```bash
# 安装依赖
npm install

# 类型检查
npm run check

# 构建
npm run build
```

## 许可证

本项目仅用于逆向工程学习分析。原始扩展的许可证和版权归原作者所有。
