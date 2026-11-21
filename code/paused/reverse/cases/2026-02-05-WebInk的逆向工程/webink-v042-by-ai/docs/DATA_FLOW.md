# WebInk v0.4.9 - 数据流图

## 数据流图

```mermaid
flowchart TD
    A[用户点击扩展图标] --> B{Side Panel 打开}
    B --> C[发送 GET_MARKDOWN 消息]
    C --> D[Background 接收消息]
    D --> E[检查缓存]
    E -->|缓存命中| F[返回缓存内容]
    E -->|缓存未命中| G[转发到 Content Script]

    G --> H[Content Script 处理]
    H --> I[Readability 提取内容]
    I --> J[Turndown 转 Markdown]
    J --> K[生成目录 TOC]
    K --> L[提取元数据]

    L --> M[返回 Markdown]
    M --> N[Background 存储缓存]
    N --> O[返回给 Side Panel]

    F --> O
    O --> P[渲染 Markdown 预览]
    P --> Q[用户操作]

    Q -->|复制| R[复制到剪贴板]
    Q -->|下载| S[下载 MD 文件]
    Q -->|编辑| T[打开 Monaco Editor]

    style A fill:#e1f5ff
    style O fill:#e1f5ff
    style P fill:#e1f5ff
    style I fill:#fff4e1
    style J fill:#fff4e1
    style T fill:#f0e1ff
```

## 详细数据流

### 1. 页面转换流程

```
┌────────────────────────────────────────────────────────────┐
│ 1. 用户点击扩展图标                                         │
├────────────────────────────────────────────────────────────┤
│ → Side Panel 打开                                           │
│ → 发送 GET_MARKDOWN 消息到 Background                      │
└────────────────────────────────────────────────────────────┘
                          ↓
┌────────────────────────────────────────────────────────────┐
│ 2. Background 处理                                          │
├────────────────────────────────────────────────────────────┤
│ → 检查 chrome.storage.local 缓存                           │
│ → 如果缓存命中 → 直接返回                                  │
│ → 如果缓存未命中 → 转发到 Content Script                  │
└────────────────────────────────────────────────────────────┘
                          ↓
┌────────────────────────────────────────────────────────────┐
│ 3. Content Script 提取                                     │
├────────────────────────────────────────────────────────────┤
│ → 使用 Readability 提取文章正文                           │
│ → 使用 Turndown 转换为 Markdown                            │
│ → 生成目录 (TOC)                                           │
│ → 提取元数据 (作者、时间、描述等)                          │
│ → 返回 MarkdownContent 对象                                │
└────────────────────────────────────────────────────────────┘
                          ↓
┌────────────────────────────────────────────────────────────┐
│ 4. Background 存储                                         │
├────────────────────────────────────────────────────────────┤
│ → 存储到缓存 (chrome.storage.local)                        │
│ → 添加到历史记录                                           │
│ → 返回给 Side Panel                                        │
└────────────────────────────────────────────────────────────┘
                          ↓
┌────────────────────────────────────────────────────────────┐
│ 5. UI 渲染                                                 │
├────────────────────────────────────────────────────────────┤
│ → 渲染 Markdown 预览                                       │
│ → 渲染目录树                                               │
│ → 显示元数据                                               │
└────────────────────────────────────────────────────────────┘
```

### 2. 存储数据结构

```typescript
// chrome.storage.local 结构
{
  "webink_config": {
    "defaultTitle": "Untitled",
    "maxHeadingDepth": 6,
    "enableGFM": true,
    "enableCodeHighlight": true,
    "enableDiagram": true,
    "enableEditor": false,
    "translateLanguage": "en"
  },
  "webink_history": [
    {
      "id": "history-1234567890",
      "url": "https://example.com/article",
      "title": "Article Title",
      "content": "# Article Title\n...",
      "createdAt": 1709107200000,
      "tags": ["markdown", "example"]
    }
  ],
  "webink_cache": {
    "https://example.com/article": {
      "title": "Article Title",
      "content": "# Article Title\n...",
      "url": "https://example.com/article",
      "createdAt": 1709107200000,
      "toc": [...],
      "metadata": {...}
    }
  },
  "webink_editor_state": {
    "language": "markdown",
    "theme": "vs-dark",
    "fontSize": 14,
    "readOnly": false,
    "wordWrap": true
  }
}
```

### 3. 消息通信协议

```typescript
// Background ↔ Content Script
interface Message {
  type: "GET_MARKDOWN" | "SET_MARKDOWN" | ...;
  data?: any;
}

// 响应
interface Response {
  success: boolean;
  data?: any;
  error?: string;
}
```

## 性能优化

1. **缓存策略**: URL 级别缓存，避免重复转换
2. **增量更新**: 仅处理变化的内容
3. **懒加载**: Monaco Editor 和 Mermaid 按需加载
4. **历史记录限制**: 最多保存 100 条记录
