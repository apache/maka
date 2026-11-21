# X-Track by CC with GLM-4.7

X-Track Chrome 扩展的逆向工程版本 - 由 CC 使用 GLM-4.7 完成

## 项目概述

这是对 **X-Track Chrome 扩展 v1.3.1** 的完整逆向工程分析和代码还原。

**扩展信息**:
- **名称**: X-Track by CC with GLM-4.7
- **版本**: 1.3.1
- **Manifest 版本**: V3
- **目标平台**: Twitter/X.com

## 项目结构

```
x-track-by-cc-with-GLM-4.7/
├── dist/                    # 可运行的扩展文件（加载此目录到 Chrome）
│   ├── manifest.json        # 扩展清单
│   ├── background.js        # 后台服务（原始 webpack 打包文件）
│   ├── content.js           # 内容脚本（原始文件）
│   ├── inject.js            # 注入脚本（原始文件）
│   ├── popup.html           # 弹出窗口
│   ├── index.html           # 仪表板页面
│   ├── icons/               # 图标资源
│   ├── _locales/            # 国际化文件
│   └── assets/              # Webpack 打包的资源
│
├── src/                     # TypeScript 源代码（逆向分析结果）
│   ├── types/               # 类型定义
│   │   ├── index.ts
│   │   ├── twitter-api.ts
│   │   ├── storage.ts
│   │   ├── messages.ts
│   │   ├── config.ts
│   │   └── utils.ts
│   │
│   ├── content/             # Content Scripts
│   │   ├── index.ts         # 主入口
│   │   ├── interceptor.ts   # 网络拦截处理
│   │   ├── cache.ts         # 推文缓存
│   │   ├── parser.ts        # API 数据解析
│   │   ├── scraper.ts       # DOM 抓取
│   │   ├── observer.ts      # 浏览追踪
│   │   ├── scraping.ts      # 智能抓取
│   │   ├── floating-ui.ts   # 浮动 UI
│   │   └── utils.ts         # DOM 工具
│   │
│   ├── background/          # Background Service Worker
│   │   ├── index.ts         # 主入口
│   │   ├── migration.ts     # 数据迁移
│   │   └── messages.ts      # 消息处理
│   │
│   ├── inject/              # Injected Script
│   │   └── interceptor.ts   # 网络拦截器
│   │
│   ├── storage/             # 数据库层
│   │   ├── database.ts      # Dexie.js 数据库
│   │   ├── adapter.ts       # 存储适配器
│   │   └── utils.ts         # 存储工具
│   │
│   ├── docs/                # 分析文档
│   │   ├── ARCHITECTURE.md  # 架构文档
│   │   ├── DATA_FLOW.md     # 数据流图
│   │   ├── API_MAPPING.md   # API 映射
│   │   └── SECURITY_AUDIT.md # 安全审计
│   │
│   ├── inject.ts            # 原始 inject.js 还原
│   └── README.md            # 项目说明
│
├── icons/                   # 图标资源
├── _locales/                # 国际化文件
├── package.json             # NPM 配置
├── tsconfig.json            # TypeScript 配置
└── README.md                # 本文件
```

## 快速开始

### 1. 安装依赖

```bash
npm install
```

### 2. 在 Chrome 中加载扩展

1. 打开 Chrome 浏览器
2. 访问 `chrome://extensions/`
3. 启用"开发者模式"
4. 点击"加载已解压的扩展程序"
5. 选择项目的 `dist/` 目录

**重要**: 加载 `dist/` 目录，而不是项目根目录！

### 3. 使用扩展

1. 访问 https://x.com 或 https://twitter.com
2. 扩展会自动开始追踪你的浏览行为
3. 点击工具栏中的扩展图标查看仪表板

## 开发

### TypeScript 编译

```bash
# 编译 TypeScript 文件
npm run build:ts

# 监听模式
npm run watch

# 类型检查
npm run type-check
```

### 查看 TypeScript 源代码

所有的 TypeScript 源代码都在 `src/` 目录下，包含：

- **类型定义**: `src/types/` - 完整的 TypeScript 类型
- **核心逻辑**: `src/content/` - 内容脚本逻辑
- **后台服务**: `src/background/` - 服务工作者
- **数据库层**: `src/storage/` - IndexedDB 操作
- **分析文档**: `src/docs/` - 详细的技术文档

## 功能特性

### 核心功能

1. **网络拦截**
   - 拦截 Twitter API 请求
   - 提取推文、用户、媒体数据
   - 支持书签、点赞、用户推文

2. **浏览追踪**
   - IntersectionObserver 实时追踪
   - 记录浏览时长（1000ms 阈值）
   - 浏览历史记录

3. **智能抓取**
   - 手动模式：被动收集数据
   - 自动模式：人类化滚动抓取
   - 批量处理和去重

4. **数据存储**
   - IndexedDB 本地存储
   - 全文搜索支持
   - 数据导出功能

### 数据收集

扩展收集以下数据：
- 推文内容、作者、媒体
- 浏览时长和类型
- 用户书签和点赞
- 用户发布的推文

**隐私说明**: 所有数据仅存储在本地，不会上传到任何服务器。

## 技术栈

- **前端**: React (通过 vendor chunk)
- **状态管理**: Chrome Message Passing
- **数据库**: IndexedDB (Dexie.js)
- **构建工具**: Webpack 5
- **开发语言**: TypeScript

## 安全评估

### 安全评分: 7.5/10

**优点**:
- ✅ 权限请求最小化
- ✅ 数据仅本地存储
- ✅ 无数据外传
- ✅ 安全的 DOM 操作

**需要改进**:
- ⚠️ 缺少用户同意机制
- ⚠️ 隐私政策需完善
- ⚠️ 未实现数据加密

详细的安全评估请查看 `src/docs/SECURITY_AUDIT.md`

## 文档

### 技术文档

- [架构文档](src/docs/ARCHITECTURE.md) - 系统架构概览
- [数据流图](src/docs/DATA_FLOW.md) - Mermaid 流程图
- [API 映射](src/docs/API_MAPPING.md) - 端点和字段映射
- [安全审计](src/docs/SECURITY_AUDIT.md) - 风险评估和建议

### 逆向分析

本项目包含完整的逆向工程分析：
- **23 个 TypeScript 文件**
- **7268 行代码**
- **完整的类型定义**
- **详细的技术文档**

## 原始扩展信息

**原始扩展**: X-Track v1.3.1
**CRX 文件**: ELHBFJBKEKMAKCEINFLGPFKCLGHKPKFA_1_3_1_0.crx
**来源**: Chrome Web Store

## 免责声明

本项目仅用于学习和研究目的。X-Track Chrome 扩展的版权归其原始作者所有。

**使用须知**:
- 本项目不鼓励任何恶意使用
- 请遵守 Twitter/X 的服务条款
- 用户对自己的数据负责
- 不得用于商业目的

## 许可证

MIT License - 仅供学习和研究使用

## 贡献

这是一个逆向工程项目，不接受外部贡献。如需学习，请参考源代码和文档。

## 联系方式

如有问题或建议，请通过 GitHub Issues 联系。

---

**Made with ❤️ by CC using GLM-4.7**
