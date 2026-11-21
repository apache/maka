# WebInk by AI - 智能网页转 Markdown 工具

**项目**: WebInk Chrome Extension v0.4.1 逆向工程还原
**还原日期**: 2026-02-05
**AI 助手**: Claude (GLM-4.7)

---

## 项目概述

WebInk 是一个智能网页转 Markdown 工具 Chrome 扩展，可以将任何网页内容转换为干净的 Markdown 格式。

### 核心功能

- ✅ **智能内容提取** - 使用 Mozilla Readability 提取文章正文
- ✅ **HTML 转 Markdown** - 使用 Turndown 进行高质量转换
- ✅ **目录生成** - 自动生成并追踪目录结构
- ✅ **GFM 支持** - 完整的 GitHub Flavored Markdown 支持
- ✅ **本地存储** - 所有数据仅存储在本地，保护隐私
- ✅ **历史记录** - 保存转换历史供后续查看
- ✅ **侧边栏界面** - 优雅的侧边栏操作界面

---

## 技术栈

| 技术 | 用途 |
|------|------|
| Plasmo | Chrome 扩展开发框架 |
| Parcel | 模块打包工具 |
| TypeScript | 类型安全的开发语言 |
| Turndown | HTML → Markdown 转换 |
| Readability | 文章内容提取 |
| tldts | URL 解析库 |

---

## 项目结构

```
webink-by-ai/
├── src/                      # TypeScript 源代码
│   ├── types/                # 类型定义
│   │   ├── index.ts          # 核心类型
│   │   ├── turndown.ts       # Turndown 类型
│   │   └── messages.ts       # 消息类型
│   ├── content/              # Content Scripts
│   │   ├── index.ts          # 主入口
│   │   ├── extractor.ts      # Markdown 提取器
│   │   ├── toc.ts            # 目录生成器
│   │   ├── highlight.ts      # 内容高亮器
│   │   └── messages.ts       # 消息处理器
│   ├── background/           # Background
│   │   ├── index.ts          # 主入口
│   │   ├── storage.ts        # 存储管理
│   │   ├── config.ts         # 配置管理
│   │   └── messages.ts       # 消息路由
│   └── utils/                # 工具函数
│
├── docs/                     # 技术文档
│   ├── ARCHITECTURE.md       # 架构文档
│   ├── DATA_FLOW.md          # 数据流图
│   ├── API_MAPPING.md        # API 映射
│   └── SECURITY_AUDIT.md     # 安全审计
│
├── dist/                     # 可运行的扩展
├── icons/                    # 图标资源
├── _locales/                 # 国际化文件
├── package.json              # NPM 配置
├── tsconfig.json             # TypeScript 配置
└── README.md                 # 本文件
```

---

## 快速开始

### 1. 安装依赖

```bash
cd /Users/ggbdpq/cc/test/2026-02-05-WebInk的逆向工程/webink-by-ai
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

### 4. 使用扩展

1. 访问任意网页
2. 点击扩展图标打开侧边栏
3. 点击"转换为 Markdown"
4. 复制或保存结果

---

## 配置选项

### WebInkConfig

```typescript
interface WebInkConfig {
  enableHighlight?: boolean;         // 启用高亮 (默认: true)
  tocPosition?: 'top' | 'bottom' | 'custom';  // 目录位置 (默认: 'top')
  autoExtract?: boolean;             // 自动提取 (默认: false)
  markdownOptions?: MarkdownOptions; // Markdown 选项
  translationOptions?: TranslationOptions;  // 翻译选项
}
```

### MarkdownOptions

```typescript
interface MarkdownOptions {
  gfm?: boolean;                     // GFM 支持 (默认: true)
  headingStyle?: 'setext' | 'atx';   // 标题样式 (默认: 'atx')
  codeBlockStyle?: 'fenced' | 'indented';  // 代码块样式 (默认: 'fenced')
  taskListItems?: boolean;           // 任务列表 (默认: true)
  strikethrough?: boolean;           // 删除线 (默认: true)
  tables?: boolean;                  // 表格 (默认: true)
}
```

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

# 代码格式化
npm run format

# 完整构建
npm run build:all
```

### 调试

1. **Content Script**: 在网页的控制台中查看日志
2. **Background**: 在 `chrome://extensions/` 中点击"Service Worker"
3. **Side Panel**: 右键点击侧边栏 → "检查"

---

## 技术文档

| 文档 | 描述 |
|------|------|
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | 系统架构和模块说明 |
| [DATA_FLOW.md](docs/DATA_FLOW.md) | 数据流和消息通信 |
| [API_MAPPING.md](docs/API_MAPPING.md) | Chrome API 和第三方库映射 |
| [SECURITY_AUDIT.md](docs/SECURITY_AUDIT.md) | 安全审计报告 |

---

## 功能说明

### 1. 内容提取

使用 Mozilla Readability 库提取文章的主要内容：

```typescript
const article = new Readability(document).parse();
// article.title, article.content, article.byline...
```

### 2. Markdown 转换

使用 Turndown 将 HTML 转换为 Markdown：

```typescript
const turndownService = new TurndownService(options);
const markdown = turndownService.turndown(html);
```

### 3. 目录生成

自动从标题生成目录并支持点击跳转：

```typescript
const toc = tocGenerator.generate();
const tocMarkdown = tocGenerator.toMarkdown(toc);
```

### 4. 内容缓存

缓存转换结果以提高性能：

```typescript
await storageManager.saveCache(url, content);
const cached = await storageManager.getCache(url);
```

---

## 数据存储

所有数据存储在 `chrome.storage.local`：

```typescript
{
  webink_config: WebInkConfig,      // 用户配置
  webink_cache: {                   // 内容缓存
    [url: string]: ExtractedContent
  },
  webink_history: ExtractedContent[] // 历史记录
}
```

---

## 隐私和安全

- ✅ 所有数据仅存储在本地
- ✅ 不向任何外部服务器发送数据
- ✅ 不追踪用户浏览行为
- ✅ 用户可以随时清除所有数据

详见 [SECURITY_AUDIT.md](docs/SECURITY_AUDIT.md)

---

## 国际化

支持语言:
- 🇨🇳 中文 (zh_CN)
- 🇯🇵 日语 (ja)
- 🇷🇺 俄语 (ru)
- 🇰🇷 韩语 (ko)

---

## 已知问题

1. 某些网站可能有反爬虫机制，Readability 可能无法正确提取内容
2. 动态加载的内容可能需要等待页面完全加载

---

## 未来改进

- [ ] 添加更多翻译服务支持
- [ ] 支持自定义 CSS 样式
- [ ] 添加批量转换功能
- [ ] 支持导出为 PDF

---

## 致谢

本项目基于以下开源库：

- [Turndown](https://github.com/mixmark-io/turndown) - HTML to Markdown converter
- [Readability](https://github.com/mozilla/readability) - Article content extractor
- [Plasmo](https://www.plasmo.com/) - Chrome Extension Framework

---

## 许可证

MIT License

---

**逆向工程说明**: 本项目是通过逆向分析原始 WebInk Chrome 扩展还原而来的 TypeScript 代码，旨在学习和研究目的。
