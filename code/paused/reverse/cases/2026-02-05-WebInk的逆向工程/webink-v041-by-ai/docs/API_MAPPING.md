# WebInk API 映射文档

## Chrome API 使用

### 权限

| 权限 | 用途 | 使用位置 |
|------|------|----------|
| `storage` | 存储配置、缓存、历史 | Background, Content |
| `sidePanel` | 侧边栏界面 | Background |
| `scripting` | 动态脚本注入 | Background |

### Host Permissions

| 权限 | 范围 |
|------|------|
| `http://*/*` | 所有 HTTP 网站 |
| `https://*/*` | 所有 HTTPS 网站 |

## Chrome API 调用映射

### chrome.storage

#### chrome.storage.local.get

```typescript
// 获取配置
const result = await chrome.storage.local.get('webink_config');
const config = result.webink_config;

// 获取缓存
const cache = await chrome.storage.local.get('webink_cache');

// 获取历史
const history = await chrome.storage.local.get('webink_history');
```

#### chrome.storage.local.set

```typescript
// 保存配置
await chrome.storage.local.set({
  webink_config: { enableHighlight: true }
});

// 保存缓存
await chrome.storage.local.set({
  webink_cache: { [url]: content }
});

// 保存历史
await chrome.storage.local.set({
  webink_history: [content1, content2]
});
```

#### chrome.storage.local.remove

```typescript
// 清除缓存
await chrome.storage.local.remove('webink_cache');

// 清除历史
await chrome.storage.local.remove('webink_history');

// 清除所有
await chrome.storage.local.clear();
```

### chrome.runtime

#### chrome.runtime.sendMessage

```typescript
// Content 发送消息
chrome.runtime.sendMessage(
  { action: 'GET_MARKDOWN', data: { includeTOC: true } },
  (response) => {
    if (response.success) {
      console.log(response.data.markdown);
    }
  }
);

// 返回 Promise
const response = await chrome.runtime.sendMessage({
  action: 'SAVE_CONFIG',
  data: { config: {...} }
});
```

#### chrome.runtime.onMessage

```typescript
// Background 监听消息
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then((response) => sendResponse(response));
  return true; // 保持通道开启
});

// Content 监听消息
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.action) {
    case 'GET_MARKDOWN':
      handleGetMarkdown(message.data)
        .then((data) => sendResponse({ success: true, data }));
      return true;
  }
});
```

### chrome.sidePanel

#### chrome.sidePanel.open

```typescript
// 点击扩展图标打开侧边栏
chrome.action.onClicked.addListener((tab) => {
  if (tab.id) {
    chrome.sidePanel.open({ tabId: tab.id });
  }
});
```

## 第三方库 API

### Turndown Service

#### TurndownService

```typescript
// 创建实例
const turndownService = new TurndownService(options);

// 转换 HTML
const markdown = turndownService.turndown(html);

// 添加规则
turndownService.addRule('ruleName', {
  filter: 'div.custom',
  replacement: (content) => `Custom: ${content}`
});

// 使用插件
turndownService.use(gfmPlugin);
```

#### Turndown Options

```typescript
interface TurndownOptions {
  headingStyle?: 'setext' | 'atx';
  hr?: string;
  bulletListMarker?: '-' | '*' | '+';
  codeBlockStyle?: 'fenced' | 'indented';
  fence?: string | null;
  emDelimiter?: '_' | '*';
  strongDelimiter?: '__' | '**';
  linkStyle?: 'inlined' | 'referenced';
  linkReferenceStyle?: 'full' | 'collapsed' | 'shortcut';
  strikethrough?: boolean;
  taskListItems?: boolean;
}
```

### Readability

#### Readability.parse

```typescript
// 创建实例
const documentClone = document.cloneNode(true);
const reader = new Readability(documentClone);

// 解析文章
const article = reader.parse();

// Article 结构
interface Article {
  title: string;
  content: string;
  textContent: string;
  length: number;
  excerpt: string;
  byline: string;
  publishedTime?: string;
  dir: string;
  leadImageUrl?: string;
}
```

## 内部消息 API

### 消息类型定义

```typescript
type MessageType =
  | 'GET_MARKDOWN'      // 获取 Markdown
  | 'EXTRACT_CONTENT'   // 提取内容
  | 'GENERATE_TOC'      // 生成目录
  | 'TRANSLATE'         // 翻译
  | 'SAVE_CONFIG'       // 保存配置
  | 'GET_CONFIG'        // 获取配置
  | 'COPY_TO_CLIPBOARD'; // 复制到剪贴板
```

### 消息格式

```typescript
interface Message<T = unknown> {
  action: MessageType;
  data?: T;
  tabId?: number;
}

interface Response<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
}
```

## DOM API

### IntersectionObserver (TOC 追踪)

```typescript
const observer = new IntersectionObserver(
  (entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) {
        const element = entry.target as HTMLElement;
        const headingId = element.id;
        // 高亮对应目录项
      }
    });
  },
  {
    rootMargin: '-100px 0px -66%',
    threshold: 0
  }
);

// 追踪标题
headings.forEach((heading) => {
  observer.observe(heading.element);
});
```

### Clipboard API (复制功能)

```typescript
// 复制到剪贴板
await navigator.clipboard.writeText(markdown);

// 读取剪贴板
const text = await navigator.clipboard.readText();
```

## URL 解析 API

### tldts 库

```typescript
import { parse } from 'tldts';

// 解析 URL
const result = parse(url);

// 结果结构
interface ParseResult {
  hostname: string;      // www.example.com
  domain: string;        // example.com
  subdomain: string;     // www
  publicSuffix: string;  // com
  domainWithoutSuffix: string;  // example
}
```

## 存储键常量

```typescript
enum StorageKey {
  CONFIG = 'webink_config',
  CACHE = 'webink_cache',
  HISTORY = 'webink_history'
}
```

## CSS 类名约定

| 类名 | 用途 |
|------|------|
| `.webink-highlight` | 高亮元素 |
| `.webink-toc-item` | 目录项 |
| `.webink-toc-item.active` | 活动目录项 |
