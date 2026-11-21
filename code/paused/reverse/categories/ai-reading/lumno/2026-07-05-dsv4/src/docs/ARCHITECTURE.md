# Lumno - 聚焦搜索新标签页 架构文档

> 版本: 0.9.14 | Manifest V3 | 作者: Kubai087 | 默认语言: zh_CN

## 一、概述

Lumno 是一个 Chrome 浏览器扩展，提供三个核心体验：

1. **新标签页** (`chrome_url_overrides.newtab`) — 替换浏览器默认新标签页
2. **覆盖层搜索** (Overlay Search) — 在任意网页上弹出搜索面板
3. **标签页切换器** (Tab Switcher) — 类似 IDE 的最近标签快速切换

辅助功能包括：自动画中画 (Auto PiP)、书签管理、壁纸系统、AI 站点搜索集成。

## 二、整体架构

```
┌──────────────────────────────────────────────────────────────┐
│                      Chrome Extension                        │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐   │
│  │             Service Worker (Background)               │   │
│  │              src/background/background.js             │   │
│  │                                                      │   │
│  │  ┌──────────┐ ┌──────────┐ ┌───────────────────┐   │   │
│  │  │ message  │ │ shortcut │ │ pip-ownership     │   │   │
│  │  │ router   │ │ rules    │ │ pip-main-world    │   │   │
│  │  └──────────┘ └──────────┘ └───────────────────┘   │   │
│  │  ┌──────────┐ ┌──────────┐ ┌───────────────────┐   │   │
│  │  │ newtab   │ │ recent   │ │ ai-provider       │   │   │
│  │  │ fallback │ │ tab-swit │ │ submit            │   │   │
│  │  └──────────┘ └──────────┘ └───────────────────┘   │   │
│  │  ┌──────────┐ ┌──────────┐                         │   │
│  │  │ extension│ │ command  │                         │   │
│  │  │ pages    │ │ target   │                         │   │
│  │  └──────────┘ └──────────┘                         │   │
│  └──────────────────────────────────────────────────────┘   │
│                                                              │
│  ┌──────────────────────┐  ┌──────────────────────────┐    │
│  │   New Tab Page        │  │   Options Page            │    │
│  │   src/newtab/          │  │   src/options/            │    │
│  │                        │  │                            │    │
│  │  ┌──────────────────┐ │  │  ┌──────────────────────┐ │    │
│  │  │ newtab.html+js   │ │  │  │ options.html+js      │ │    │
│  │  │ wallpaper system │ │  │  │ settings UI          │ │    │
│  │  │ bookmark grid    │ │  │  └──────────────────────┘ │    │
│  │  │ recent sites     │ │  │                            │    │
│  │  │ suggestion panel │ │  └──────────────────────────┘    │
│  │  │ favicon views    │ │                                  │
│  │  └──────────────────┘ │  ┌──────────────────────────┐    │
│  └──────────────────────┘  │   Onboarding Page          │    │
│                            │   src/onboarding/          │    │
│  ┌──────────────────────┐  └──────────────────────────┘    │
│  │   Overlay System      │                                  │
│  │   src/overlay/         │  ┌──────────────────────────┐    │
│  │                        │  │   Shared Libraries        │    │
│  │  ┌──────────────────┐ │  │   src/shared/              │    │
│  │  │ runtime.js       │ │  │                            │    │
│  │  │ shell.js (DOM)   │ │  │  ┌──────────────────────┐ │    │
│  │  │ lifecycle.js     │ │  │  │ settings.js          │ │    │
│  │  │ search-panel.js  │ │  │  │ search-utils.js      │ │    │
│  │  │ tab-switcher.js  │ │  │  │ favicon-utils.js     │ │    │
│  │  │ page-theme.js    │ │  │  │ search-input-ui.js   │ │    │
│  │  │ site-fixes.js    │ │  │  │ site-search-store.js │ │    │
│  │  │ input-ui.js      │ │  │  │ url-guards.js        │ │    │
│  │  │ favicon-view.js  │ │  │  │ extension-routes.js  │ │    │
│  │  └──────────────────┘ │  │  └──────────────────────┘ │    │
│  └──────────────────────┘  └──────────────────────────┘    │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐   │
│  │                Content Scripts                        │   │
│  │                src/content/                           │   │
│  │                                                      │   │
│  │  ┌──────────────────┐ ┌────────────────────────────┐ │   │
│  │  │ hotkey-listener  │ │ auto-pip-blacklist         │ │   │
│  │  │ (<all_urls>)     │ │ + site-auto-pip            │ │   │
│  │  └──────────────────┘ │ (多站点匹配)                │ │   │
│  │                       └────────────────────────────┘ │   │
│  │  ┌──────────────────┐ ┌────────────────────────────┐ │   │
│  │  │ youtube-auto-pip │ │ document-pip-picker        │ │   │
│  │  │ (youtube.com)    │ │ (文档 PiP)                  │ │   │
│  │  └──────────────────┘ └────────────────────────────┘ │   │
│  └──────────────────────────────────────────────────────┘   │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐   │
│  │                 Assets & Data                         │   │
│  │                                                      │   │
│  │  ┌─────────────┐ ┌──────────────┐ ┌─────────────┐   │   │
│  │  │ wallpapers/ │ │ remixicon/   │ │ fonts/       │   │   │
│  │  │ (20 个壁纸)  │ │ (图标库)     │ │ (Open Sans)  │   │   │
│  │  └─────────────┘ └──────────────┘ └─────────────┘   │   │
│  │  ┌─────────────┐ ┌──────────────┐ ┌─────────────┐   │   │
│  │  │ site-search │ │ shortcut     │ │ vendor/      │   │   │
│  │  │ .json       │ │ -rules.json  │ │ pinyin-pro   │   │   │
│  │  └─────────────┘ └──────────────┘ └─────────────┘   │   │
│  └──────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────┘
```

## 三、模块职责

### 3.1 Service Worker (background.js)

`src/background/background.js` (~7200 行) 是整个扩展的中枢。通过 `importScripts` 加载约 20 个模块，挂载到 `globalThis` 命名空间。

**核心职责：**

| 模块 | 文件 | 职责 |
|------|------|------|
| 消息路由 | `message-router.js` | 基于 action 字符串的请求分发 |
| 快捷方式规则 | `shortcut-rules.js` | 浏览器内部页面快捷方式匹配 |
| PiP 所有权 | `pip-ownership.js` | 管理全局 PiP 所有权令牌 |
| PiP 主世界 | `pip-main-world.js` | 注入 MAIN world 脚本执行 PiP |
| 新标签页回退 | `newtab-fallback.js` | 文件协议、内部页面的回退处理 |
| 最近标签切换 | `recent-tab-switcher.js` | 维护最近标签列表 + 缩略图缓存 |
| AI 提交 | `ai-provider-submit.js` | 调用 AI 站点的交互式搜索提交 |
| 扩展页面 | `extension-pages.js` | 打开/管理扩展自有页面 |
| 命令策略 | `command-target-policy.js` | 命令触发时的目标选择策略 |

**关键功能：**

- **标签页切换器缩略图捕获** — 使用 `chrome.tabs.captureVisibleTab` 获取标签缩略图 (JPEG quality 42, 320x200)
- **标签切换频率排序** — 基于指数衰减 + 频次统计的评分算法，用于叠加层标签排序
- **固定标签页恢复** — 定期快照固定标签列表，浏览器重启后恢复
- **存储迁移** — sync -> local 自动迁移，清理废弃 AI 存储键
- **热键去重** — 180ms 热键重复守卫，防止键盘快捷键重复触发

### 3.2 新标签页 (New Tab)

通过 `chrome_url_overrides.newtab` 替换浏览器默认新标签页。

**文件结构：**

| 文件 | 职责 |
|------|------|
| `newtab.html` | 4,572 行 — 完整 HTML+CSS+UI 模板结构，包含超椭圆形状、毛玻璃效果、暗色主题 |
| `newtab.js` | ~N 行 — 主逻辑，初始化搜索面板、书签、最近站点 |
| `wallpaper.js` | 壁纸加载、切换、过渡动画 |
| `wallpaper-preload.js` | 壁纸预加载（页面渲染前） |
| `wallpaper-effects.js` | 壁纸特效渲染（半色调、ASCII） |
| `wallpaper-adaptive-tone.js` | 自适应色调计算 |
| `wallpaper-local-store.js` | 壁纸本地存储管理 |
| `bookmarks-store.js` | 书签数据获取与缓存 |
| `bookmarks-view.js` | 书签网格 UI 渲染 |
| `bookmark-cascade-menu.js` | 书签级联菜单（安全三角形导航） |
| `bookmark-cascade-position.js` | 级联菜单位置计算 |
| `recent-sites-store.js` | 常用网站数据 |
| `recent-sites-view.js` | 常用网站卡片 UI |
| `suggestions-view.js` | 搜索建议下拉面板渲染 |
| `favicon-view.js` | 网站图标渲染 |
| `favicon-theme.js` | 网站图标主题色提取 |
| `layout.js` | 页面布局管理 |
| `page-notice.js` | 页面通知横幅 |
| `toast.js` | 轻提示组件 |

**设计特点：**

- **两层壁纸系统** — CSS 背景层 + `<canvas>` 特效层，支持半色调和 ASCII 特效
- **超椭圆形状** — 使用 `corner-shape: superellipse(1.25)` (CSS Houdini)
- **毛玻璃效果** — `backdrop-filter: blur() saturate()` 实现面板玻璃质感
- **底部停靠布局** — 支持传统的上方内容和底部停靠两种布局模式
- **暗色主题完整适配** — 通过 CSS 自定义属性 `data-theme="dark"` 切换
- **壁纸过渡层** — 透明叠加层 + opacity 过渡实现壁纸平滑切换

### 3.3 覆盖层系统 (Overlay)

覆盖层是注入到**任意网页**上的搜索面板，由 Service Worker 触发。

**文件结构：**

| 文件 | 职责 |
|------|------|
| `runtime.js` | 运行时配置获取（存储键定义、locale 加载） |
| `shell.js` | DOM 创建 — 生成覆盖层 Shadow DOM 容器（z-index: 2147483647） |
| `lifecycle.js` | 覆盖层生命周期 — 打开/关闭/过渡动画 |
| `search-panel.js` | 搜索面板核心 — 搜索执行、结果渲染、导航 |
| `tab-switcher.js` | 标签页切换器面板 — 最近标签展示与切换 |
| `tab-switcher-page-bridge.js` | 扩展页面内标签切换器的桥接适配 |
| `page-theme.js` | 页面主题适配 — 根据宿主页面主题调整覆盖层颜色 |
| `site-fixes.js` | 站点兼容修复 — 处理特定网站的样式/行为问题 |
| `input-ui.js` | 搜索输入框 UI 组件 |
| `favicon-view.js` | 覆盖层内网站图标渲染 |

**覆盖层打开流程：**

1. 用户按 `Ctrl+Shift+K`（或其它热键）
2. `hotkey-listener.js` 捕获按键 → 向 background 发消息
3. Background 检查当前活动标签页 URL 是否允许
4. 若允许 → 通过 `chrome.scripting.executeScript` 注入覆盖层脚本
5. 覆盖层创建 Shadow DOM 容器 → 渲染搜索面板
6. 用户输入时 → 搜索历史/书签/常用网站 → 显示建议

### 3.4 内容脚本 (Content Scripts)

| 脚本 | 匹配 | run_at | 职责 |
|------|------|--------|------|
| `hotkey-listener.js` | `<all_urls>` | `document_start` | 全局键盘监听 → 触发覆盖层 |
| `auto-pip-blacklist.js` | 多站点 | `document_idle` | PiP 黑名单管理 |
| `site-auto-pip.js` | 多站点 | `document_idle` | 自动检测并触发画中画 |
| `youtube-auto-pip.js` | `youtube.com` | `document_idle` | YouTube 专用自动 PiP |
| `youtube-auto-pip-page.js` | web_accessible | — | YouTube PiP 页面注入脚本 |
| `document-pip-picker.js` | web_accessible | — | 文档 PiP 元素选择器 |

### 3.5 共享模块 (Shared)

| 文件 | 职责 |
|------|------|
| `search-utils.js` | 搜索核心算法 — 意图分类、相关性评分、去重、排序 |
| `settings.js` | 设置标准化 — 主题、语言、宽度、覆盖层等设置值校验 |
| `search-input-ui.js` | 搜索输入框通用 UI 组件 |
| `search-input-mode.js` | 搜索模式管理 |
| `favicon-utils.js` | 网站图标工具函数 |
| `favicon-cache.js` | 网站图标本地缓存 |
| `favicon-view-core.js` | 网站图标渲染核心 |
| `site-search-store.js` | 站点搜索数据管理 |
| `extension-routes.js` | 扩展内部路由生成 |
| `url-guards.js` | URL 安全守卫 |
| `blacklist-utils.js` | 搜索黑名单工具 |
| `suggestion-action-model.js` | 建议项动作模型 |
| `suggestion-navigation.js` | 键盘导航建议列表 |
| `feature-hints.js/css` | 功能提示浮层 |
| `tooltip.js/css` | 通用提示组件 |
| `cursor-tooltip.js/css` | 光标跟随提示 |
| `menu-surface.js/css` | 菜单面板通用基类 |
| `custom-select.js/css` | 自定义选择器组件 |
| `checkbox.js/css` | 自定义复选框组件 |
| `ime-key-guard.js` | IME 输入法按键守卫 |
| `shortcut-reference.js` | 快捷键引用 |
| `update-notice.js` | 更新通知管理 |

## 四、数据存储

扩展使用 `chrome.storage.sync` 为主存储，`chrome.storage.local` 用于大体积数据：

| 存储域 | 用途 |
|--------|------|
| `sync` | 设置项（主题、语言、布局、壁纸、书签列数等） |
| `local` | 壁纸本地文件、网站图标缓存、标签切换统计、固定标签快照 |
| `session` | 标签页切换器状态（缩略图缓存，session 优先，回退 local） |

## 五、权限清单

| 权限 | 用途 |
|------|------|
| `scripting` | 注入覆盖层到任意网页 |
| `tabs` | 标签管理、查询、切换 |
| `history` | 搜索历史记录 |
| `topSites` | 获取常用网站 |
| `bookmarks` | 书签管理 |
| `storage` | 设置持久化 |
| `search` | 搜索引擎建议查询 |
| `favicon` | 获取网站 favicon |
| `host_permissions: <all_urls>` | 全局键盘监听 + 覆盖层注入 |

## 六、国际化

- `default_locale`: `zh_CN`
- 支持语言: `zh_CN`, `zh_TW`, `ja`, `en`
- Locale 文件: `_locales/{locale}/messages.json`
- 运行时动态加载 locale 消息到 storage，支持热切换

## 七、关键技术决策

1. **IIFE + globalThis 命名空间** — 不使用 ES Module，通过 `importScripts` + 全局命名空间实现模块化
2. **Shadow DOM 隔离** — 覆盖层使用 Shadow DOM 避免污染宿主页面样式
3. **z-index: 2147483647** — 覆盖层使用最大 z-index 确保位于所有页面元素之上
4. **指数衰减排序** — 标签切换器使用指数衰减函数计算标签新鲜度
5. **安全三角形导航** — 书签级联菜单使用 SVG 安全三角形实现无中断 hover
6. **pinyin-pro 拼音匹配** — 支持拼音搜索中文内容（vendor 内联）
