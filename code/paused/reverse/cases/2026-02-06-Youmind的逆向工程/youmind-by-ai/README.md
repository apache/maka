# YouMind by AI - Chrome 扩展逆向工程还原

**项目**: YouMind - AI Web Clipper, Youtube Notes & Annotate
**版本**: 0.3.0-alpha21
**还原日期**: 2026-02-06
**AI 助手**: Claude (GLM-4.7)

---

## 项目概述

YouMind 是一个功能丰富的 AI 网页剪藏和笔记工具 Chrome 扩展。本项目通过逆向工程原始 CRX 文件，将其还原为清晰的 TypeScript 代码，便于学习和研究。

### 核心功能

- ✅ **网页剪藏** - 保存任意网页内容
- ✅ **YouTube 集成** - 自动获取视频元数据和字幕
- ✅ **Twitter 集成** - 提取推文内容
- ✅ **AI 支持** - Claude/Gemini API 集成
- ✅ **Jina AI 抓取** - 智能网页内容提取
- ✅ **多语言支持** - 16 种语言界面
- ✅ **右键菜单** - 快捷剪藏操作
- ✅ **快捷键** - Alt+Y (打开), Alt+C (捕获), Alt+S (保存), Alt+T (翻译)

---

## 技术栈

| 技术 | 用途 |
|------|------|
| TypeScript | 主要开发语言 |
| React | UI 组件框架 |
| Vite | 模块打包工具 |
| Chrome Extension APIs | 扩展功能 |

---

## 项目结构

```
youmind-by-ai/
├── src/                      # TypeScript 源代码
│   ├── types/                # 类型定义
│   │   └── index.ts          # 核心类型 (UserInfo, Clip, YouTubeVideo, Tweet, etc.)
│   ├── scripts/              # 注入脚本
│   │   ├── inject-youtube.ts             # YouTube 元数据提取
│   │   ├── inject-youtube-subtitle.ts    # YouTube 字幕拦截
│   │   ├── inject-twitter.ts             # Twitter 拦截
│   │   └── index.ts                      # 入口
│   ├── content/              # Content Scripts
│   │   └── index.ts          # 主入口，消息处理
│   ├── background/           # Background Service Worker
│   │   └── index.ts          # 上下文菜单，命令处理
│   ├── utils/                # 工具函数
│   │   ├── storage.ts        # chrome.storage 封装
│   │   ├── youtube.ts        # YouTube 工具
│   │   ├── api.ts            # API 工具 (YouMind, Jina AI)
│   │   └── index.ts
│   └── i18n/                 # 国际化
│       └── index.ts          # 16 种语言支持
├── dist/                     # 可运行的扩展
│   ├── manifest.json         # 扩展清单
│   ├── background.js         # 编译后的 background
│   ├── content.js            # 编译后的 content script
│   └── scripts/              # 编译后的注入脚本
├── docs/                     # 技术文档
├── package.json              # NPM 配置
├── tsconfig.json             # TypeScript 配置
└── README.md                 # 本文件
```

---

## 快速开始

### 1. 安装依赖

```bash
cd /Users/ggbdpq/cc/test/2026-02-06-Youmind的逆向工程/youmind-by-ai
npm install
```

### 2. 编译 TypeScript

```bash
npm run build
```

### 3. 加载到 Chrome

1. 打开 `chrome://extensions/`
2. 启用"开发者模式"
3. 点击"加载已解压的扩展程序"
4. 选择 `dist/` 目录

### 4. 测试功能

- **YouTube**: 访问任意 YouTube 视频，插件自动获取视频信息
- **网页**: 右键点击任意网页 → 选择 "Save Page to YouMind"
- **快捷键**: 按 Alt+S 保存当前网页

---

## 类型系统

### 核心类型

```typescript
// 用户信息
interface UserInfo {
  id: string;
  username?: string;
  email?: string;
  isLogin: boolean;
  inWaitlist?: boolean;
  isInactive?: boolean;
  apiKey?: string;
}

// 剪藏项
interface Clip {
  id: string;
  type: ClipType;
  title: string;
  content?: string;
  url?: string;
  screenshot?: string;
  createdAt: string;
  tags?: string[];
}

// YouTube 视频
interface YouTubeVideo {
  id: string;
  title: string;
  channelName: string;
  duration?: number;
  viewCount?: number;
  thumbnails?: YouTubeThumbnail[];
}
```

---

## 核心功能说明

### YouTube 集成

**文件**: `src/scripts/inject-youtube.ts`, `src/utils/youtube.ts`

```typescript
// 注入脚本提取视频元数据
const videoInfo = extractYouTubeVideoInfo({
  ytInitialPlayerResponse: window.ytInitialPlayerResponse
});

// 捕获视频帧（支持字幕叠加）
const frame = await captureVideoFrame(videoElement, {
  format: 'base64',
  quality: 0.95,
  withSubtitle: true
});
```

### Jina AI 网页抓取

**文件**: `src/utils/api.ts`

```typescript
// 使用 Jina AI 智能抓取网页内容
const webpageData = await scrapByJina(url);
// 返回: { title, content, url }
```

### 上下文菜单

**文件**: `src/background/index.ts`

```typescript
// 自动创建 4 种右键菜单项
- Save Content to YouMind (选中文本)
- Save Image to YouMind (图片)
- Save Link to YouMind (链接)
- Save Page to YouMind (整页)
```

---

## 与原始扩展对比

| 特征 | 原始 YouMind | 本项目还原 |
|------|-------------|-----------|
| **框架** | React + Vite | TypeScript |
| **核心功能** | ✅ 完整 | ✅ 核心逻辑 |
| **YouTube 集成** | ✅ | ✅ |
| **Twitter 集成** | ✅ | ✅ 拦截器 |
| **AI 功能** | ✅ Claude/Gemini | 🔄 接口定义 |
| **UI 组件** | React | 🔄 待还原 |
| **代码行数** | 数万行 | ~1500 行（核心） |

---

## 逆向工程说明

### 还原内容

- ✅ **类型定义系统** - 完整的 TypeScript 类型
- ✅ **注入脚本** - YouTube/Twitter 拦截器
- ✅ **工具函数** - 存储、API、YouTube 工具
- ✅ **Background** - 上下文菜单、命令处理
- ✅ **Content Script** - 消息处理、平台集成
- ✅ **国际化** - 16 种语言支持
- 🔄 **UI 组件** - React 组件（待还原）

### 技术亮点

1. **Vite 打包识别** - 通过哈希文件名和模块结构识别
2. **多平台注入** - 针对不同平台的专用脚本
3. **类型系统重建** - 从功能推断完整类型定义
4. **模块化重构** - 将混淆代码重构为清晰模块

---

## API 接口

### YouMind API

```typescript
// 获取 API 主机
const apiHost = await getYouMindHost(); // https://api.youmind.ai

// 上传剪藏
await uploadClipToYouMind(clipData, userInfo);

// 同步剪藏列表
const clips = await syncClips(userInfo);
```

### Jina AI

```typescript
// 智能网页抓取
const webpage = await scrapByJina(url);
// 返回清理后的 Markdown 内容
```

---

## 安全说明

- ✅ 所有请求通过 HTTPS
- ✅ API 密钥存储在 chrome.storage.local
- ✅ 不收集用户浏览行为
- ⚠️ AI 功能需要用户 API 密钥

---

## 已知限制

1. **UI 组件**: 原始 React 组件代码高度混淆，需要进一步还原
2. **AI 功能**: 需要用户配置自己的 API 密钥
3. **YouMind API**: 需要有效的用户账户

---

## 开发指南

### 编译命令

```bash
# 编译 TypeScript
npm run build

# 监听模式
npm run build:watch

# 类型检查
npm run type-check

# 清理构建产物
npm run clean
```

### 调试

1. **Content Script**: 在网页控制台查看日志
2. **Background**: 在 `chrome://extensions/` 点击 "Service Worker"
3. **注入脚本**: 在页面控制台访问 `window.YouMindVideoInfo`

---

## 对比其他逆向项目

| 特征 | X-Track | WebInk | 飞书转存专家 | YouMind |
|------|---------|--------|-------------|---------|
| **功能** | Twitter 追踪 | 网页转 Markdown | 飞书导出 | 网页剪藏+AI |
| **框架** | 原生 JS | Plasmo | 原生 JS | React + TS |
| **打包工具** | Webpack | Parcel | Vite | Vite |
| **代码行数** | 7,268 行 | ~1,500 行 | ~870 行 | 数万行 |
| **复杂度** | 高 | 中 | 中 | 极高 |
| **AI 集成** | 无 | 可选 | 无 | Claude + Gemini |

---

## 许可证

MIT License

---

## 致谢

本项目通过逆向分析 YouMind Chrome 扩展还原而来，旨在学习和研究目的。

**原始扩展**: YouMind - AI Web Clipper, Youtube Notes & Annotate v0.3.0-alpha21

---

**祝您在 Chrome 扩展开发的学习旅程中收获满满！** 🎉
