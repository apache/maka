# WebInk v0.4.2 逆向工程笔记

**逆向日期**: 2026-02-28
**AI 助手**: Claude (GLM-4.6)
**CRX 文件**: `WebInk_ 智能网页转Markdown工具 0.4.2.crx`

---

## 执行总结

### 8 阶段完成情况

| 阶段                  | 状态 | 输出                              |
| --------------------- | ---- | --------------------------------- |
| Phase 1: 提取与扫描   | ✅   | `webink-v042-source-code/`        |
| Phase 2: 代码结构分析 | ✅   | 分析报告                          |
| Phase 3: 类型定义     | ✅   | `src/types/`                      |
| Phase 4: 代码还原     | ✅   | `src/content/`, `src/background/` |
| Phase 5: 数据流分析   | ✅   | `docs/DATA_FLOW.md`               |
| Phase 6: 安全审计     | ✅   | `docs/SECURITY_AUDIT.md`          |
| Phase 7: 文档生成     | ✅   | `docs/ARCHITECTURE.md`            |
| Phase 8: 项目打包     | ✅   | `dist/` (可运行)                  |

---

## 关键发现

### 1. 版本差异

**v0.4.1 → v0.4.2**:

- 文件数: 18 → 359 (+20x)
- 大小: 3.8 MB → 12.2 MB (+3.2x)
- 新增: Monaco Editor (200+ 语言包)
- 新增: Mermaid 图表支持 (15+ 种图表)
- 新增: 多语言翻译功能

### 2. 版本号不一致问题 (已修正)

- **原始文件名**: `WebInk_ 智能网页转Markdown工具 0.4.9.crx`
- **manifest.json 版本**: `0.4.2`
- **问题**: 文件名与实际版本号不匹配
- **处理**: 项目已重命名为 v0.4.2 以匹配实际版本

**证据**:

- 文件大小差异: v0.4.1 (3.8 MB) vs v0.4.2 (12 MB)
- 文件数量差异: 18 vs 359
- MD5 哈希完全不同: 确认是不同版本

### 3. 技术栈确认

- **框架**: Plasmo
- **打包**: Parcel (`w.isParcelRequire=!0`)
- **核心库**:
  - `@mozilla/readability` - 内容提取
  - `turndown` - Markdown 转换
  - `monaco-editor` - 代码编辑
  - `mermaid` - 图表渲染

---

## 代码结构

### 核心文件

| 文件                  | 大小   | 行数 | 功能     |
| --------------------- | ------ | ---- | -------- |
| content.06af5f40.js   | 4.2 MB | 1206 | 内容脚本 |
| dist.95dd2b81.js      | 4.2 MB | -    | 主逻辑   |
| options.95eda3f3.js   | 1.1 MB | -    | 设置页   |
| sidepanel.b7741352.js | 3.3 MB | -    | 侧边栏   |
| background/index.js   | 17 KB  | -    | 后台服务 |

### 新增文件类型

**语言高亮包 (200+)**:

- `abap.5c1503b8.js`
- `actionscript-3.c8d41696.js`
- `ada.dfd87b38.js`
- ... (更多)

**图表支持 (15+)**:

- `architectureDiagram-VXUJARFQ.7a42637e.js`
- `classDiagram-v2-WZHVMYZB.7b6e8906.js`
- `flowDiagram-NV44I4VS.b3523040.js`
- `mermaid.72bd615c.js`
- ... (更多)

---

## 与 v0.4.1 对比

| 功能          | v0.4.1 | v0.4.2 | 变化     |
| ------------- | ------ | ------ | -------- |
| 内容提取      | ✅     | ✅     | 相同     |
| Markdown 转换 | ✅     | ✅     | 相同     |
| 目录生成      | ✅     | ✅     | 相同     |
| GFM 支持      | ✅     | ✅     | 相同     |
| 代码编辑器    | ❌     | ✅     | **新增** |
| 图表渲染      | ❌     | ✅     | **新增** |
| 多语言翻译    | ❌     | ✅     | **新增** |
| 语言高亮      | -      | 200+   | **新增** |

---

## 安全审计结果

**总体评分**: 8.5/10

### 优点

- ✅ 无数据外传
- ✅ 本地存储
- ✅ 权限最小化
- ✅ 无第三方追踪

### 建议

- ⚠️ 添加 HTML 清理 (DOMPurify)
- ⚠️ 限制 host_permissions 范围
- ⚠️ 添加隐私政策

---

## 项目产出

### TypeScript 源代码

```
webink-v042-by-ai/src/
├── types/
│   ├── index.ts      - 核心类型定义
│   ├── storage.ts    - 存储类型和工具
│   └── messages.ts   - 消息类型和工具
├── content/
│   └── index.ts      - Content Script
├── background/
│   └── index.ts      - Background Service Worker
└── utils/
    ├── toc.ts        - 目录生成工具
    └── metadata.ts   - 元数据提取工具
```

### 技术文档

```
webink-v042-by-ai/docs/
├── ARCHITECTURE.md    - 架构文档
├── DATA_FLOW.md       - 数据流图
└── SECURITY_AUDIT.md  - 安全审计
```

### 配置文件

- `package.json` - NPM 配置
- `tsconfig.json` - TypeScript 配置
- `README.md` - 项目说明

---

## 可运行项目

### 加载到 Chrome

1. 打开 `chrome://extensions/`
2. 启用"开发者模式"
3. 加载 `webink-v042-by-ai/dist/` 目录
4. 或加载 `webink-v042-source-code/` 目录

### TypeScript 编译

```bash
cd webink-v042-by-ai
npm install
npm run build
```

---

## 新增功能详解

### Monaco Editor

- 200+ 编程语言支持
- 主题切换 (浅色/深色)
- 代码高亮
- 自动补全
- 多光标编辑

### Mermaid 图表

支持以下图表类型:

- 流程图 (flowchart)
- 序列图 (sequence)
- 类图 (class)
- 状态图 (state)
- ER 图 (er)
- 甘特图 (gantt)
- 饼图 (pie)
- 思维导图 (mindmap)
- Git 图 (gitgraph)
- 桑基图 (sankey)
- 架构图 (architecture)
- 块图 (block)
- C4 图 (c4)
- 象限图 (quadrant)
- 需求图 (requirement)
- 旅程图 (journey)

### 多语言翻译

- 使用 Chrome Translation API (Origin Trial)
- 支持多种语言互译
- 保持 Markdown 格式

---

## 技术亮点

1. **Plasmo 框架**: 简化 Chrome 扩展开发
2. **Parcel 打包**: 快速构建和模块热更新
3. **TypeScript**: 类型安全
4. **Readability**: Mozilla 可靠性
5. **Turndown**: 高质量 Markdown 转换

---

## 下一步建议

1. 深入分析 Monaco Editor 集成方式
2. 分析 Mermaid 图表渲染机制
3. 研究翻译 API 的调用方式
4. 对比两个版本的差异细节

---

**逆向工程完成于 2026-02-28**
