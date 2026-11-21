# iTab 新标签页逆向工程归档

> 对 Chrome 扩展 "iTab 新标签页" v1.6.36 的完整逆向工程分析

## 目录结构

```
2026-02-24-iTab新标签页的逆向工程/
├── iTab新标签页.crx                      # 原始 CRX 文件
├── 安装教程.html                          # 安装说明
├── itab-source-code/                      # 提取的原始代码
│   ├── manifest.json
│   ├── background.js
│   ├── newtab.html
│   ├── popup.html
│   ├── chunks/                           # 411 个 Vite 打包的 chunk
│   ├── assets/                           # CSS 和静态资源
│   ├── _locales/                         # 国际化
│   ├── js/                               # 初始化脚本
│   ├── weather/                          # 天气资源
│   ├── icon/                             # 图标资源
│   └── ...
├── itab-by-ai/                           # 还原的项目（可运行）
│   ├── src/
│   │   ├── types/                        # TypeScript 类型定义
│   │   ├── api/                          # API 端点定义
│   │   ├── storage/                      # 存储层
│   │   ├── components/                   # Vue 组件
│   │   ├── composables/                  # Vue 组合式函数
│   │   ├── utils/                        # 工具函数
│   │   └── main.ts
│   ├── dist/                             # 可运行的扩展
│   ├── package.json
│   ├── tsconfig.json
│   ├── vite.config.ts
│   └── README.md
├── REVERSE_ENGINEERING_NOTES.md          # 逆向笔记
└── README.md                             # 本文件
```

## 项目概述

**iTab 新标签页** 是一个功能丰富的 Chrome 扩展，提供：

- 多源壁纸（内置、Unsplash、Wallhaven、视频）
- 天气显示（和风天气）
- 书签管理
- 自定义搜索引擎
- 网站图标网格
- 用户账户与配置同步

### 技术栈

| 技术 | 版本 |
|------|------|
| Vue 3 | 3.x |
| Vite | 最新 |
| Tailwind CSS | 3.x |
| Element Plus | 最新 |
| Chrome Extension | MV3 |

## 快速开始

### 安装原始扩展

1. 下载 `iTab新标签页.crx`
2. 解压 CRX 文件（重命名为 .zip）
3. 在 Chrome 中打开 `chrome://extensions/`
4. 开启"开发者模式"
5. 点击"加载已解压的扩展程序"，选择 `itab-source-code` 目录

### 运行还原项目

```bash
cd itab-by-ai
npm install
npm run dev
```

## 逆向工程文档

详细的逆向分析请查看 [REVERSE_ENGINEERING_NOTES.md](./REVERSE_ENGINEERING_NOTES.md)

### 文档内容

- API 端点清单
- 存储系统分析
- 核心模块分析
- 数据流分析
- 安全审计

## API 端点

| 类别 | 端点 |
|------|------|
| **壁纸** | `/wallpaper/category`, `/wallpaper/list`, `/wallpaper/random` |
| **用户** | `/user/login`, `/user/info`, `/user/update` |
| **配置** | `/itab/config`, `/itab/update` |
| **天气** | 通过代理访问和风天气 API |

基础 URL: `https://api.codelife.cc`

## 存储系统

| 存储 | 用途 |
|------|------|
| LocalForage | 本地数据缓存 |
| IndexedDB | 大数据存储（带 TTL） |
| Chrome Storage | 扩展配置同步 |

## 功能模块

- 壁纸系统 (wallpaper-*.js)
- 天气组件 (weather-*.js)
- 书签管理 (website-*.js)
- 搜索引擎 (search-*.js)
- 布局系统 (layout-*.js)
- 账户系统 (user-*.js, account-*.js)
- 备份功能 (backup-*.js)
- 主题系统 (theme-*.js)
- 待办事项 (todo-*.js)
- 日历组件 (calendar-*.js)

## 进度

| 阶段 | 状态 | 说明 |
|------|------|------|
| Phase 1: 提取与扫描 | ✅ | 完成 |
| Phase 2: 代码结构分析 | ✅ | 完成 |
| Phase 3: 类型定义重建 | 🔄 | 进行中 |
| Phase 4: 核心模块还原 | ⏳ | 待开始 |
| Phase 5: 数据流分析 | ⏳ | 待开始 |
| Phase 6: 安全审计 | ✅ | 完成 |
| Phase 7: 文档生成 | ✅ | 完成 |
| Phase 8: 项目打包 | ⏳ | 待开始 |

## 注意事项

1. 本项目仅供学习研究使用
2. 请勿用于商业用途
3. 遵守原项目的使用条款

## 许可

本归档项目仅供学习研究使用，原代码版权归 iTab 开发者所有。

---

**分析日期**: 2026-02-24
**原始版本**: 1.6.36
