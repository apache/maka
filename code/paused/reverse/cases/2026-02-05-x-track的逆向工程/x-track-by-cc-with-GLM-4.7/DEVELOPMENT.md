# 开发指南

## 项目设置

### 1. 安装依赖

```bash
cd x-track-by-cc-with-GLM-4.7
npm install
```

### 2. 项目结构说明

```
dist/           # 可运行的扩展（加载此目录到 Chrome）
src/            # TypeScript 源代码（逆向分析结果）
icons/          # 图标资源
_locales/       # 国际化文件
```

## 在 Chrome 中运行扩展

### 开发模式

1. 编译 TypeScript（可选）：
```bash
npm run build:ts
```

2. 在 Chrome 中加载：
   - 打开 `chrome://extensions/`
   - 启用"开发者模式"
   - 点击"加载已解压的扩展程序"
   - 选择 `dist/` 目录

3. 访问 https://x.com 测试扩展

### 调试

#### Content Script 调试
1. 在 X.com 页面上，按 F12 打开开发者工具
2. 在 Console 中可以看到 `X-Track:` 前缀的日志
3. 在 Sources 标签中可以看到 content scripts

#### Background Service Worker 调试
1. 在 `chrome://extensions/` 页面
2. 找到"X-Track by CC with GLM-4.7"
3. 点击"Service Worker"链接打开调试器

#### IndexedDB 查看器
1. 在开发者工具中，转到"Application"标签
2. 左侧找到"Storage" → "IndexedDB"
3. 查看 `xtrack_db` 数据库

## 文件说明

### dist/ 目录（可运行的扩展）

| 文件 | 说明 |
|------|------|
| `manifest.json` | 扩展清单文件 |
| `background.js` | 后台服务（原始 webpack 打包） |
| `content.js` | 内容脚本（原始文件） |
| `inject.js` | 注入脚本（原始文件） |
| `popup.html` | 弹出窗口 |
| `index.html` | 仪表板页面 |
| `icons/` | 图标资源 |
| `_locales/` | 国际化文件 |
| `assets/` | Webpack 打包的资源文件 |

### src/ 目录（TypeScript 源代码）

#### 类型定义 (types/)
- `index.ts` - 核心类型定义
- `twitter-api.ts` - Twitter API 类型
- `storage.ts` - 存储类型
- `messages.ts` - 消息通信类型
- `config.ts` - 配置类型
- `utils.ts` - 工具类型

#### Content Scripts (content/)
- `index.ts` - 主入口
- `interceptor.ts` - 网络拦截处理
- `cache.ts` - 推文缓存
- `parser.ts` - API 数据解析
- `scraper.ts` - DOM 抓取
- `observer.ts` - 浏览追踪
- `scraping.ts` - 智能抓取
- `floating-ui.ts` - 浮动 UI
- `utils.ts` - DOM 工具

#### Background (background/)
- `index.ts` - 主入口
- `migration.ts` - 数据迁移
- `messages.ts` - 消息处理

#### Inject (inject/)
- `interceptor.ts` - 网络拦截器

#### Storage (storage/)
- `database.ts` - Dexie.js 数据库
- `adapter.ts` - 存储适配器
- `utils.ts` - 存储工具

## TypeScript 编译

### 编译命令

```bash
# 一次性编译
npm run build:ts

# 监听模式（自动重新编译）
npm run watch

# 仅类型检查
npm run type-check
```

### 配置

TypeScript 配置在 `tsconfig.json` 中：
- 输出目录：`dist/`
- 源代码目录：`src/`
- 严格模式已启用
- 生成声明文件和 source map

## 修改扩展

### 修改内容脚本

1. 编辑 `src/content/` 中的 TypeScript 文件
2. 运行 `npm run build:ts` 编译
3. **重要**：由于原始的 `content.js` 是 webpack 打包的，编译后的 TypeScript 文件不会自动生效
4. 如需使用修改后的代码，需要重新构建整个项目

### 修改后台脚本

1. 编辑 `src/background/` 中的 TypeScript 文件
2. 运行 `npm run build:ts` 编译
3. 同样需要重新构建项目

### 修改注入脚本

1. 编辑 `src/inject/interceptor.ts`
2. 编译后生成 `dist/inject/interceptor.js`
3. 需要更新 `dist/inject.js`

## 数据库结构

### IndexedDB 表

```javascript
// tweets 表
{
  id: string              // 推文 ID
  authorId: string        // 作者 ID
  content: string         // 推文内容
  createdAt: string       // 创建时间
  textTokens: string[]    // 搜索标记
  likes: number           // 点赞数
  retweets: number        // 转推数
  replies: number         // 回复数
  views: number           // 浏览数
  tweetType: string       // 推文类型
  media: array            // 媒体附件
}

// history 表
{
  tweetId: string         // 推文 ID
  viewedAt: number        // 浏览时间
  durationSeconds: number // 浏览时长
  type: string            // 浏览类型
}

// bookmarks 表
{
  tweetId: string         // 推文 ID
  addedAt: number         // 添加时间
  tags: array             // 标签
}

// likes 表
{
  tweetId: string
  addedAt: number
}
```

## 消息通信

### Content → Background

```javascript
chrome.runtime.sendMessage({
  action: 'SAVE_FOOTPRINT',
  data: {
    tweetData: tweetData,
    durationMs: durationMs
  }
}, response => {
  console.log(response.success)
});
```

### Background → Content

```javascript
chrome.runtime.sendMessage({
  action: 'SCRAPE_STARTED',
  data: {
    mode: 'MANUAL',
    pageType: 'PROFILE'
  }
});
```

## 测试

### 手动测试

1. **功能测试**
   - 访问 https://x.com
   - 检查控制台是否有 "X-Track: Content script loaded"
   - 滚动页面，检查是否追踪推文
   - 检查 IndexedDB 中是否有数据

2. **抓取测试**
   - 访问用户的 profile 页面
   - 点击浮动按钮开始抓取
   - 检查是否保存数据到数据库

3. **数据验证**
   - 打开开发者工具
   - Application → IndexedDB → xtrack_db
   - 检查各表的数据

## 常见问题

### Q: TypeScript 编译后的文件不生效

A: 原始的 `dist/` 目录包含的是 webpack 打包后的文件。要使用修改后的 TypeScript 代码，需要：
1. 重新构建整个项目
2. 或者仅查看 TypeScript 源代码作为参考

### Q: 扩展无法加载

A: 检查：
1. 是否加载了 `dist/` 目录
2. `manifest.json` 是否存在
3. Chrome 控制台是否有错误信息

### Q: 看不到浮动按钮

A: 检查：
1. 是否在支持的页面（Profile、Bookmarks、Likes）
2. 控制台是否有错误
3. 扩展是否已启用

## 资源链接

- [Chrome 扩展开发文档](https://developer.chrome.com/docs/extensions/)
- [Manifest V3 迁移指南](https://developer.chrome.com/docs/extensions/migrating/)
- [Dexie.js 文档](https://dexie.org/)
- [TypeScript 文档](https://www.typescriptlang.org/docs/)

## 贡献

本项目是一个逆向工程项目，主要目的是学习和研究。如发现问题，请创建 Issue。
