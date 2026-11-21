# WebInk 数据流文档

## 数据流概述

WebInk 的核心功能是将网页 HTML 内容转换为 Markdown 格式。以下是详细的数据流分析。

## 主要数据流

### 1. 网页到 Markdown 转换

```mermaid
flowchart TD
    A[网页 HTML] --> B[Readability.parse]
    B --> C[提取正文 HTML]
    C --> D[TurndownService.convert]
    D --> E[Markdown 输出]
    C --> F[TOCGenerator.generate]
    F --> G[目录 Markdown]
    E --> H[insertTOC]
    G --> H
    H --> I[最终 Markdown]
```

### 2. 消息通信流

```mermaid
sequenceDiagram
    participant P as Popup/SidePanel
    participant C as Content Script
    participant B as Background
    participant S as chrome.storage

    P->>C: chrome.runtime.sendMessage({action: 'GET_MARKDOWN'})
    C->>C: extractor.extract()
    C->>C: readability.parse()
    C->>C: turndown.convert()
    C-->>P: {success: true, data: {markdown: "..."}}

    P->>B: chrome.runtime.sendMessage({action: 'SAVE_CONFIG'})
    B->>S: chrome.storage.local.set({webink_config: {...}})
    B-->>P: {success: true}
```

### 3. 内容提取详细流程

```mermaid
flowchart TD
    A[document.cloneNode] --> B[new Readability]
    B --> C[reader.parse]
    C --> D{解析成功?}
    D -->|是| E[返回 article 对象]
    D -->|否| F[降级处理]
    F --> G[使用 document.body]

    E --> H[提取 title]
    E --> I[提取 content]
    E --> J[提取 byline]
    E --> K[提取 publishedTime]

    H --> L[ExtractedContent]
    I --> L
    J --> L
    K --> L
```

## 数据结构转换

### HTML → Article

```typescript
// 输入: HTML
const html = `
  <article>
    <h1>文章标题</h1>
    <p>文章内容...</p>
  </article>
`;

// Readability 处理
const article = new Readability(documentClone).parse();

// 输出: Article 对象
interface Article {
  title: string;           // "文章标题"
  content: string;         // 清理后的 HTML
  textContent: string;     // 纯文本
  length: number;          // 字符数
  excerpt: string;         // 摘要
  byline: string;          // 作者
  publishedTime?: string;  // 发布时间
  dir: string;             // 文本方向
  leadImageUrl?: string;   // 主图 URL
}
```

### Article → Markdown

```typescript
// 输入: Article.content (HTML)
const html = '<h1>标题</h1><p>内容</p>';

// Turndown 处理
const turndownService = new TurndownService(options);
const markdown = turndownService.turndown(html);

// 输出: Markdown
const markdown = '# 标题\n\n内容';
```

## 存储数据流

### 缓存流程

```mermaid
flowchart LR
    A[提取内容] --> B{缓存存在?}
    B -->|是| C[返回缓存]
    B -->|否| D[执行提取]
    D --> E[保存到缓存]
    E --> F[返回结果]
    C --> F
```

### 历史记录流程

```mermaid
flowchart TD
    A[用户转换内容] --> B[添加到历史开头]
    B --> C{历史 > 500?}
    C -->|是| D[删除最旧记录]
    C -->|否| E[保存]
    D --> E
    E --> F[chrome.storage.local.set]
```

## 配置数据流

```mermaid
flowchart LR
    A[用户修改配置] --> B[SAVE_CONFIG 消息]
    B --> C[Background ConfigManager]
    C --> D[更新内存配置]
    D --> E[保存到 chrome.storage]
    E --> F[通知 Content Script]
    F --> G[更新 Content 配置]
```

## 消息数据结构

### GET_MARKDOWN 请求

```typescript
interface GetMarkdownRequest {
  includeTOC?: boolean;      // 是否包含目录
  tocPosition?: 'top' | 'bottom' | 'custom';  // 目录位置
  useReadability?: boolean;  // 是否使用 Readability
}
```

### GET_MARKDOWN 响应

```typescript
interface GetMarkdownResponse {
  success: boolean;
  data?: {
    markdown: string;         // Markdown 内容
    title: string;            // 页面标题
    sourceUrl: string;        // 源 URL
    domain: string;           // 域名
    extractedAt: string;      // 提取时间
  };
  error?: string;
}
```

## 性能优化

### 缓存策略

1. **URL 级别缓存**: 每个 URL 的提取结果独立缓存
2. **LRU 淘汰**: 缓存满时删除最旧的条目
3. **缓存大小限制**: 最多 100 个 URL

### Readability 优化

1. **文档克隆**: 使用 `cloneNode(true)` 避免修改原 DOM
2. **并行处理**: 多个标签页可以并行提取
3. **降级策略**: Readability 失败时降级到简单提取

### TOC 生成优化

1. **懒生成**: 只在需要时生成目录
2. **IntersectionObserver**: 高效追踪可见标题
3. **缓存结果**: DOM 未变化时复用结果
