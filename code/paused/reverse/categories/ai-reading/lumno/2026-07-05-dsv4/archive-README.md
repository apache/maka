# Lumno - 聚焦搜索新标签页 (存档)

## 基本信息

- **名称**: Lumno - 聚焦搜索新标签页
- **版本**: 0.9.14
- **清单版本**: Manifest V3
- **作者**: Kubai087
- **默认语言**: zh_CN
- **源文件数**: 140
- **存档日期**: 2026-07-05
- **存档位置**: `dist/`

## 文件清单

```
dist/
├── manifest.json                                    # 扩展清单
├── _locales/
│   ├── en/messages.json                             # 英文翻译
│   ├── ja/messages.json                             # 日文翻译
│   ├── zh_CN/messages.json                          # 简体中文翻译
│   └── zh_TW/messages.json                          # 繁体中文翻译
├── _metadata/verified_contents.json                 # Chrome Web Store 签名数据
├── assets/
│   ├── data/
│   │   ├── shortcut-rules.json                      # 浏览器快捷方式规则 (26 条)
│   │   └── site-search.json                         # 站点搜索配置 (23 个站点)
│   ├── fonts/open-sans/                             # Open Sans 可变字体
│   ├── images/                                      # 图标、Logo、引导图
│   ├── remixicon/                                   # Remix Icon 图标库 v4.6
│   ├── vendor/
│   │   └── pinyin-pro.js                            # 拼音转换库 (内联)
│   └── wallpapers/                                  # 20 张壁纸 (webp, 含缩略图)
└── src/
    ├── background/
    │   ├── background.js                            # Service Worker 主入口 (~7200 行)
    │   ├── ai-provider-submit.js                    # AI 站点交互提交
    │   ├── command-target-policy.js                 # 命令目标策略
    │   ├── extension-pages.js                       # 扩展页面管理
    │   ├── message-router.js                        # 消息路由
    │   ├── newtab-fallback.js                       # 新标签页回退
    │   ├── pip-main-world.js                        # PiP MAIN world 注入
    │   ├── pip-ownership.js                         # PiP 所有权管理
    │   ├── recent-tab-switcher.js                   # 最近标签跟踪器
    │   └── shortcut-rules.js                        # 快捷方式规则
    ├── content/
    │   ├── hotkey-listener.js                       # 全局热键监听 (所有页面)
    │   ├── auto-pip-blacklist.js                    # PiP 黑名单
    │   ├── site-auto-pip.js                         # 站点自动 PiP
    │   ├── youtube-auto-pip.js                      # YouTube 自动 PiP
    │   ├── youtube-auto-pip-page.js                 # YouTube PiP 页面脚本
    │   └── document-pip-picker.js                   # 文档 PiP 元素选择器
    ├── newtab/
    │   ├── newtab.html                              # 新标签页 HTML+CSS (~4500 行)
    │   ├── newtab.js                                # 新标签页主逻辑
    │   ├── bookmark-cascade-menu.js                 # 书签级联菜单
    │   ├── bookmark-cascade-position.js             # 级联菜单位置
    │   ├── bookmarks-store.js                       # 书签数据管理
    │   ├── bookmarks-view.js                        # 书签 UI
    │   ├── favicon-theme.js                         # 网站图标主题色
    │   ├── favicon-view.js                          # 网站图标渲染
    │   ├── layout.js                                # 页面布局
    │   ├── page-notice.js                           # 页面通知
    │   ├── recent-sites-store.js                    # 常用网站数据
    │   ├── recent-sites-view.js                     # 常用网站 UI
    │   ├── suggestions-view.js                      # 搜索建议面板
    │   ├── toast.js                                 # 轻提示
    │   ├── wallpaper.js                             # 壁纸系统
    │   ├── wallpaper-adaptive-tone.js               # 自适应色调
    │   ├── wallpaper-effects.js                     # 壁纸特效
    │   ├── wallpaper-local-store.js                 # 壁纸本地存储
    │   └── wallpaper-preload.js                     # 壁纸预加载
    ├── onboarding/
    │   ├── onboarding.html                          # 引导页
    │   ├── onboarding.js                            # 引导页逻辑
    │   └── onboarding-content.js                    # 引导内容
    ├── options/
    │   ├── options.html                             # 设置页
    │   └── options.js                               # 设置逻辑
    ├── overlay/
    │   ├── runtime.js                               # 覆盖层运行时
    │   ├── shell.js                                 # 覆盖层 DOM 创建 (Shadow DOM)
    │   ├── lifecycle.js                             # 覆盖层生命周期
    │   ├── search-panel.js                          # 搜索面板
    │   ├── tab-switcher.js                          # 标签切换器面板
    │   ├── tab-switcher-page-bridge.js              # 扩展页面标签切换桥接
    │   ├── page-theme.js                            # 页面主题适配
    │   ├── site-fixes.js                            # 站点兼容修复
    │   ├── input-ui.js                              # 输入框 UI
    │   ├── favicon-view.js                          # 覆盖层图标渲染
    │   └── suggestions-view.css                     # 建议面板样式
    └── shared/
        ├── blacklist-utils.js                       # 黑名单工具
        ├── checkbox.css + .js                       # 复选框组件
        ├── cursor-tooltip.css + .js                 # 光标提示
        ├── custom-select.css + .js                  # 自定义选择器
        ├── extension-routes.js                      # 扩展路由
        ├── favicon-cache.js                         # favicon 缓存
        ├── favicon-utils.js                         # favicon 工具
        ├── favicon-view-core.js                     # favicon 渲染核心
        ├── feature-hints.css + .js                  # 功能提示
        ├── ime-key-guard.js                         # IME 按键守卫
        ├── menu-surface.css + .js                   # 菜单面板
        ├── search-input-mode.js                     # 搜索模式
        ├── search-input-ui.js                       # 搜索输入组件
        ├── search-input.css                         # 搜索输入样式
        ├── search-utils.js                          # 搜索核心算法 (~2600 行)
        ├── settings.js                              # 设置标准化
        ├── shortcut-reference.js                    # 快捷键引用
        ├── site-search-store.js                     # 站点搜索存储
        ├── suggestion-action-model.js               # 建议动作模型
        ├── suggestion-navigation.js                 # 建议导航
        ├── tooltip.css + .js                        # 提示组件
        ├── update-notice.js                         # 更新通知
        └── url-guards.js                            # URL 安全守卫
```

## 命令快捷键

| 命令 | 快捷键 | 功能 |
|------|--------|------|
| `show-search` | `Ctrl+Shift+K` | 打开覆盖层搜索 |
| `show-search-prefill` | `Ctrl+Shift+L` | 打开覆盖层搜索（预填当前页面 URL） |
| `show-search-prefill-v` | `Ctrl+Shift+C` | 打开覆盖层搜索（预填 URL 变体） |
| `show-tab-switcher` | `Alt+Q` | 打开标签页切换器 |

## 内容脚本匹配范围

| 脚本 | 匹配 |
|------|------|
| `hotkey-listener.js` | `<all_urls>` (所有页面) |
| `auto-pip-blacklist.js` + `site-auto-pip.js` | 21 个视频站点 (iqiyi, netflix, youtube*, bilibili, tiktok, douyin 等) |
| `youtube-auto-pip.js` | `*.youtube.com` |

## 存储键前缀

所有存储键使用 `_x_extension_*_YYYY_unique_` 命名模式，包含年份标记用于版本迁移。

## 逆向分析文档

本存档附带的逆向分析文档位于 `src/docs/`:

- `ARCHITECTURE.md` — 架构分析
- `DATA_FLOW.md` — 数据流分析 (含 Mermaid 图)
- `SECURITY_AUDIT.md` — 安全审计

TypeScript 类型定义位于 `src/types/index.ts`。
