# CSS Peeper 架构文档

> **版本**: v1.2.2 | **平台**: Chrome Extension Manifest V3 | **构建工具**: Plasmo + Parcel
>
> **作者**: Sparkglare Sp. z o.o. | **分析日期**: 2026-07-05

---

## 一、项目概述

CSS Peeper 是一款 Chrome 浏览器扩展，用于快速检查网页元素的 CSS 样式、颜色调色板和排版信息。用户通过 Chrome Side Panel 面板直观查看任意网页元素的样式属性，支持颜色对比度分析、字体识别、渐变色提取等高级功能。

## 二、技术栈

| 层面 | 技术 | 说明 |
|------|------|------|
| 框架 | **Plasmo** | Chrome 扩展开发框架，处理 MV3 样板代码 |
| 打包器 | **Parcel** | Plasmo 默认打包器，所有 JS 均带内容哈希 |
| UI 框架 | **React** (sidepanel) | Side Panel 的 UI 层 |
| CSS 方案 | **Tailwind CSS** | 完整的 Utility-first CSS，含自定义 `peeper-*` 设计 token |
| 字体 | Google Fonts | Inter (主要)、Roboto、Roboto Mono |
| 运行时 | Chrome Extension MV3 | Service Worker + Side Panel + Content Scripts |

## 三、Plasmo 框架特征

从以下证据确认使用了 **Plasmo** 框架：

1. **图标文件命名**: `icon16.plasmo.6c567d50.png` — 文件名中包含 `plasmo` 标识，这是 Plasmo 打包的默认行为
2. **HTML 入口**: `sidepanel.html` 中包含 `<div id="__plasmo">` 根节点，这是 Plasmo React 挂载点
3. **文件哈希**: 所有构建产物带内容哈希 (`sidepanel.b7741352.js`)，符合 Plasmo 的构建配置
4. **Parcel 打包**: 代码中存在 `parcelRequire` 模块加载器，确认使用 Parcel 打包
5. **MV3 结构**: `manifest.json` 结构完全符合 Plasmo 对 MV3 的输出格式

## 四、扩展架构（组件关系图）

```
┌──────────────────────────────────────────────────────────────┐
│                     Chrome Extension                         │
│                                                              │
│  ┌─────────────────────────────────────────────────────┐     │
│  │           Service Worker (Background)               │     │
│  │         static/background/index.js                  │     │
│  │                                                     │     │
│  │  - 扩展生命周期管理                                  │     │
│  │  - 消息路由 (content ↔ sidepanel)                   │     │
│  │  - chrome.tabs / chrome.storage / chrome.alarms     │     │
│  │  - webRequest 监听                                   │     │
│  └──────────┬────────────────────────────────┬─────────┘     │
│             │                                │               │
│    chrome.runtime.sendMessage()   chrome.runtime.sendMessage()│
│             │                                │               │
│  ┌──────────▼──────────┐         ┌──────────▼──────────┐     │
│  │   Side Panel        │         │  Content Scripts ×3 │     │
│  │   sidepanel.html    │         │                      │     │
│  │   + sidepanel.*.js  │         │  1. sidebar-element- │     │
│  │   + sidepanel.*.css │         │     locator.*.js     │     │
│  │                     │         │     (元素定位覆盖层)  │     │
│  │  - React UI         │         │                      │     │
│  │  - Tab 切换         │◄───────►│  2. csspeeper-       │     │
│  │  - 调色板展示       │  消息    │     inspector-tools  │     │
│  │  - 排版分析         │  通信    │     .*.js            │     │
│  │  - 属性列表         │         │     (检查工具核心)   │     │
│  │  - 导出功能         │         │                      │     │
│  │                     │         │  3. inspector.*.js   │     │
│  │                     │         │     (主检查器)       │     │
│  └─────────────────────┘         └──────────┬──────────┘     │
│                                             │                │
│                                  注入到目标网页 DOM           │
└──────────────────────────────────────────────────────────────┘
```

## 五、文件清单与用途

### 5.1 入口和配置

| 文件 | 大小估计 | 用途 |
|------|----------|------|
| `manifest.json` | 2.3 KB | MV3 扩展清单，权限/入口定义 |
| `sidepanel.html` | 250 B | Side Panel HTML 入口 |

### 5.2 Service Worker

| 文件 | 大小估计 | 用途 |
|------|----------|------|
| `static/background/index.js` | ~170 KB | Service Worker，核心后台逻辑 |

### 5.3 Content Scripts（3 个）

| 文件 | 大小估计 | 用途 |
|------|----------|------|
| `sidebar-element-locator.*.js` | ~8 KB | 元素定位器，创建高亮覆盖层，处理 LOCATE_ELEMENT 消息 |
| `csspeeper-inspector-tools.*.js` | ~180 KB | 检查工具集，提取样式、调色板、排版信息 |
| `inspector.*.js` | ~1.4 MB | 主检查器，最大模块，检查模式核心逻辑 |

### 5.4 Side Panel UI

| 文件 | 大小估计 | 用途 |
|------|----------|------|
| `sidepanel.b7741352.js` | ~1.3 MB | Side Panel React 应用，所有 UI 逻辑 |
| `sidepanel.7c54f4bc.css` | ~48 KB | Tailwind CSS + 自定义 peeper 设计 token |

### 5.5 静态资源

| 文件 | 用途 |
|------|------|
| `icon*.plasmo.*.png` (5个) | 扩展图标 (16/32/48/64/128px) |
| `sideBar.*.png` | Side Panel 侧栏背景图 |
| `colors.*.png` | 颜色分析功能截图/图标 |
| `contrast-pro.*.png` | 对比度分析 Pro 功能示意 |
| `contrast-free.*.png` | 对比度分析 Free 功能示意 |
| `semantic-colors.*.png` | 语义化颜色示意 |
| `typography.*.png` | 排版分析功能示意 |
| `advanced-typography.*.png` | 高级排版 Pro 功能示意 |
| `ob-step-*.png` (4个) | Onboarding 引导步骤图 |
| `inspector-current-div.*.svg` | DIV 元素当前选中指示图标 |
| `inspector-current-text.*.svg` | 文本元素当前选中指示图标 |

## 六、Content Scripts 详细架构

### 6.1 sidebar-element-locator.js

**模块结构** (通过 Parcel 打包可见):

```
parcelRequire("7wRm3")           ← 主入口: LOCATE_ELEMENT 消息处理
  ├── ~app/helpers/createCurrentOverlay  ← 覆盖层创建
  ├── ~app/helpers/getExtensionContainer ← 扩展容器管理
  └── 工具函数:
      - elementDeduplicator()     去重逻辑
      - elementFinder()           元素匹配查找
      - overlayUpdater()          覆盖层位置更新
```

**核心职责**:

1. 监听 `chrome.runtime.onMessage` 中的 `LOCATE_ELEMENT` 消息
2. 在页面上创建固定定位的高亮覆盖层 (`z-index: 2147483646`)
3. 根据 tag / class / text 内容匹配元素
4. 平滑滚动到匹配元素并高亮
5. 创建隔离的扩展 DOM 容器 (`#csspeeper-extension-container`)

### 6.2 csspeeper-inspector-tools.js

**核心职责**:

1. 页面样式提取 (计算样式、内联样式)
2. 颜色提取与分析 (背景色、文本色、边框色)
3. 字体/排版信息提取
4. 对比度计算 (WCAG AA/AAA)
5. 语义化颜色匹配 (对照 Tailwind 设计 token)
6. 与 Side Panel 通信，传递检查结果

### 6.3 inspector.js

**核心职责**:

1. 检查模式管理 (激活/停用)
2. 鼠标悬停/点击事件处理
3. 元素选择 UI (选择框、高亮)
4. 检查结果序列化与传输

## 七、Side Panel UI 架构

Side Panel 使用 **React** 构建，通过 Tailwind CSS 实现完整的 UI。主要 Tab 页：

| Tab | 功能 |
|-----|------|
| **Colors** | 颜色调色板展示、对比度分析、语义色匹配 |
| **Typography** | 字体族显示、字重大小、行高、Google Font 链接 |
| **Properties** | 完整 CSS 属性列表、分组折叠 |
| **Styles** | 详细样式展示 (Pro 功能) |
| **Export** | 导出检查结果 |

### 设计 Token

CSS Peeper 使用自定义颜色系统：

| Token | 色值 | 用途 |
|-------|------|------|
| `peeper-purple` | `#5D2DE6` | 主色调 (品牌紫) |
| `peeper-purple-hover` | `#4A24B8` | 主色悬停 |
| `peeper-pink-accent` | `#FFEBF6` | 粉色强调背景 |
| `peeper-pink` | `#C92E82` | 粉色文字 |
| `peeper-green` | `#05381A` | 绿色 (对比度合格) |
| `peeper-light-green` | `#D3F8E1` | 浅绿背景 |
| `peeper-dark-gray` | `#262626` | 深灰 |
| `peeper-gray` | `#666666` | 中灰 |
| `peeper-white-hover` | `#F5F5F5` | 悬停白 |
| `peeper-light-pink` | `#9E81F0` | 浅紫 |
| `peeper-white-secondary` | `#C7C7C7` | 次要亮色 |
| `primary` | `#0E0E0E` | 主要文字色 |
| `secondary` | `#262626` | 次要文字色 |
| `surface-gray` | `#F5F5F5` | 页面底色 |

## 八、数据持久化

使用 `chrome.storage` API (local 存储):

- 主题偏好 (`light` / `dark`)
- Onboarding 完成状态
- 许可证信息 (`free` / `pro` tier)
- 通过 `unlimitedStorage` 权限实现无限制存储

## 九、外部依赖

| 依赖 | 说明 |
|------|------|
| **Google Fonts** | 运行时加载 Inter、Roboto、Roboto Mono 字体 |
| **googletagmanager.com** | externally_connectable 允许，用于 Google Analytics/GTM |
| **csspeeper.com** | externally_connectable 允许，用于许可证验证/后端通信 |

## 十、构建与打包

1. **Plasmo** 作为扩展框架，生成 `manifest.json` 和所有入口文件
2. **Parcel** 打包所有 JS 模块，输出带哈希的文件名 (如 `sidepanel.b7741352.js`)
3. 无 source map — 所有产物为生产构建，无调试映射
4. `file-manifest.json` 仅包含一个映射条目 (`inspector → inspector.b9415ea5.js`)，可能是留存的构建中间产物
