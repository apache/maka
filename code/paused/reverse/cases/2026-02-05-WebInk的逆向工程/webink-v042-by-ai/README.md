# WebInk v0.4.2 - 逆向工程项目

**逆向日期**: 2026-02-28
**AI 助手**: Claude (GLM-4.6)
**原始版本**: 0.4.2 (manifest 显示 0.4.2)

---

## 📋 项目概述

WebInk 是一款智能网页转 Markdown 工具 Chrome 扩展，支持：
- 📄 智能内容提取 (Mozilla Readability)
- 🔄 HTML → Markdown 转换 (Turndown)
- 📑 自动目录生成
- 📊 Mermaid 图表支持
- 📝 Monaco Editor 代码编辑器
- 🌐 多语言翻译 (NEW!)
- 💾 本地存储和历史记录

---

## 🚀 快速开始

### 加载扩展

1. 打开 Chrome 扩展页面: `chrome://extensions/`
2. 启用"开发者模式"
3. 点击"加载已解压的扩展程序"
4. 选择: `/webink-v042-source-code/`

### TypeScript 项目

```bash
# 安装依赖
npm install

# 编译 TypeScript
npm run build

# 监听模式
npm run watch

# 类型检查
npm run type-check
```

---

## 📂 项目结构

```
webink-v042-by-ai/
├── src/                    # TypeScript 源代码
│   ├── types/              # 类型定义
│   │   ├── index.ts        # 核心类型
│   │   ├── storage.ts      # 存储类型
│   │   └── messages.ts     # 消息类型
│   ├── content/            # Content Scripts
│   │   └── index.ts        # 页面内容提取
│   ├── background/         # Background
│   │   └── index.ts        # Service Worker
│   └── utils/              # 工具函数
│       ├── toc.ts          # 目录生成
│       └── metadata.ts     # 元数据提取
├── dist/                   # 编译输出
├── docs/                   # 技术文档
├── package.json
├── tsconfig.json
└── README.md
```

---

## 🔧 技术栈

| 类别 | 技术 |
|------|------|
| 框架 | Plasmo |
| 打包 | Parcel |
| 语言 | TypeScript |
| 内容提取 | Mozilla Readability |
| Markdown 转换 | Turndown |
| 代码编辑 | Monaco Editor |
| 图表 | Mermaid |

---

## 📊 与 v0.4.1 对比

| 特性 | v0.4.1 | v0.4.2 |
|------|--------|--------|
| 文件数 | 18 | 359 (+20x) |
| 大小 | 3.8 MB | 12.2 MB |
| Monaco Editor | ❌ | ✅ |
| Mermaid 图表 | ❌ | ✅ |
| 多语言翻译 | ❌ | ✅ |
| 语言高亮包 | - | 200+ |

---

## 🛡️ 安全审计

- ✅ 数据仅本地存储
- ✅ 权限最小化
- ✅ 无隐私追踪
- ✅ 无数据外传

---

## 📝 核心功能

### 1. 内容提取
```typescript
const content = await getMarkdownContent();
console.log(content.title, content.markdown);
```

### 2. 目录生成
```typescript
const toc = generateTOC(html, document);
console.log(toc); // [{ text, id, level, children }]
```

### 3. 配置管理
```typescript
const config = await StorageHelper.getConfig();
await StorageHelper.setConfig({ enableGFM: true });
```

---

## 📚 更多文档

- [ARCHITECTURE.md](docs/ARCHITECTURE.md) - 架构文档
- [DATA_FLOW.md](docs/DATA_FLOW.md) - 数据流图
- [SECURITY_AUDIT.md](docs/SECURITY_AUDIT.md) - 安全审计

---

**逆向工程完成于 2026-02-28**
