# 飞书转存专家 by AI - 文档复制与导出工具

**项目**: 飞书转存专家 Chrome Extension v0.1.80 逆向工程还原
**还原日期**: 2026-02-05
**AI 助手**: Claude (GLM-4.7)

---

## 项目概述

飞书转存专家是一个强大的飞书（Lark）文档转存、导出工具 Chrome 扩展，支持将飞书文档一键导出为多种格式。

### 核心功能

- ✅ **PDF 导出** - 高质量 PDF 文档生成
- ✅ **Word 导出** - 生成可编辑的 Word 文档
- ✅ **Markdown 导出** - 转换为 Markdown 格式
- ✅ **HTML 导出** - 保留样式的 HTML 文件
- ✅ **图片导出** - 导出为高清图片
- ✅ **右键菜单** - 快捷导出操作
- ✅ **复制内容** - 一键复制 Markdown 内容

---

## 技术栈

| 技术 | 用途 |
|------|------|
| Vite | 模块打包工具 |
| html2canvas | 网页截图 (图片导出) |
| jsPDF | PDF 生成 |
| docx | Word 文档生成 |
| Turndown | HTML → Markdown 转换 |

---

## 项目结构

```
feishu-by-ai/
├── src/                      # TypeScript 源代码
│   ├── types/                # 类型定义
│   │   └── index.ts          # 核心类型
│   ├── inject/               # 注入脚本
│   │   └── index.ts          # 核心导出逻辑
│   ├── content/              # Content Scripts
│   │   └── index.ts          # 主入口
│   ├── background/           # Background
│   │   ├── index.ts          # 主入口
│   │   ├── storage.ts        # 存储管理
│   │   ├── config.ts         # 配置管理
│   │   └── messages.ts       # 消息路由
│   └── utils/                # 工具函数
│
├── dist/                     # 可运行的扩展
├── docs/                     # 技术文档
├── icons/                    # 图标资源
├── package.json              # NPM 配置
├── tsconfig.json             # TypeScript 配置
└── README.md                 # 本文件
```

---

## 快速开始

### 1. 安装依赖

```bash
cd /Users/ggbdpq/cc/test/2026-02-05-飞书转存专家的逆向工程/feishu-by-ai
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

1. 访问飞书文档页面（feishu.cn 或 larksuite.com）
2. 右键点击页面
3. 选择"飞书转存专家"
4. 选择导出格式（PDF/Word/Markdown/HTML/图片）

---

## 配置选项

### 导出配置

```typescript
interface FeishuExportConfig {
  defaultFormat: ExportFormat;      // 默认导出格式
  autoDownload: boolean;             // 自动下载
  imageOptions: {
    quality: number;                 // 图片质量 (1-100)
    maxWidth: number;                // 最大宽度
    format: 'png' | 'jpeg' | 'webp'; // 图片格式
  };
  pdfOptions: {
    orientation: 'portrait' | 'landscape';  // 页面方向
    pageSize: 'A4' | 'A3' | 'Letter';        // 页面大小
    margin: number;                         // 边距 (mm)
  };
}
```

---

## 核心功能说明

### 1. PDF 导出

使用 html2canvas + jsPDF 实现：

```typescript
const canvas = await html2canvas(element);
const pdf = new jsPDF();
pdf.addImage(canvas, 'PNG', 0, 0, width, height);
pdf.save('document.pdf');
```

### 2. Word 导出

使用 docx 库生成：

```typescript
const doc = new Document({
  sections: [{
    children: [
      new Paragraph({
        children: [new TextRun(title)]
      })
    ]
  }]
});

const blob = await Packer.toBlob(doc);
```

### 3. Markdown 导出

使用 Turndown 转换：

```typescript
const turndownService = new TurndownService();
const markdown = turndownService.turndown(html);
```

### 4. 图片导出

使用 html2canvas 截图：

```typescript
const canvas = await html2canvas(element, { scale: 2 });
canvas.toBlob((blob) => {
  // 保存图片
});
```

---

## 权限说明

| 权限 | 用途 |
|------|------|
| `contextMenus` | 右键菜单 |
| `scripting` | 动态脚本注入 |
| `tabs` | 标签页操作 |
| `storage` | 配置和历史存储 |

### Host Permissions

- `https://*.feishu.cn/*` - 飞书中国
- `https://*.feishu.net/*` - 飞书测试环境
- `https://*.larksuite.com/*` - 飞书国际版
- `https://*.feishu-pre.net/*` - 飞书预发布环境
- `https://*.larkoffice.com/*` - Lark Office

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

# 完整构建
npm run build:all
```

### 调试

1. **Content Script**: 在飞书页面控制台查看日志
2. **Background**: 在 `chrome://extensions/` 点击"Service Worker"
3. **Injected Script**: 在页面控制台访问 `window.FeishuExporter`

---

## 功能对比

| 特征 | X-Track | WebInk | 飞书转存专家 |
|------|---------|--------|--------------|
| 功能 | Twitter 追踪 | 网页转 Markdown | 飞书文档导出 |
| 打包工具 | Webpack | Parcel | Vite |
| 核心库 | 自研 | Turndown + Readability | html2canvas + jsPDF + docx |
| 代码行数 | 7,268 行 | ~1,500 行 | ~870 行 |
| 存储方式 | IndexedDB | chrome.storage | chrome.storage |
| 主要操作 | 数据收集 | 内容提取 | 文档导出 |

---

## 安全说明

- ✅ 所有操作仅在本地执行
- ✅ 不向任何外部服务器发送数据
- ✅ 不收集用户浏览行为
- ✅ 用户完全控制导出的内容

---

## 已知限制

1. **动态内容**: 某些动态加载的内容可能无法完整导出
2. **权限限制**: 需要访问飞书文档的编辑权限
3. **格式兼容**: 复杂的飞书格式可能无法完美转换

---

## 逆向工程说明

本项目是通过逆向分析原始飞书转存专家 Chrome 扩展还原而来的 TypeScript 代码，旨在学习和研究目的。

### 还原内容

- ✅ 完整的类型定义系统
- ✅ 核心导出逻辑还原
- ✅ Background Service Worker
- ✅ Content Script 通信
- ✅ 右键菜单集成

### 技术亮点

1. **Vite 打包识别** - 通过 `import.meta.hot` 等特征识别 Vite
2. **功能模式检测** - 通过关键词频率分析核心功能
3. **模块化重构** - 将 870 行混淆代码重构为清晰模块

---

## 许可证

MIT License

---

**逆向工程说明**: 本项目是通过逆向分析原始飞书转存专家扩展还原而来的 TypeScript 代码，旨在学习和研究目的。
