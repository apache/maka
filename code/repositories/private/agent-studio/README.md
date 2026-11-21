# REA Agent 前端还原学习项目

基于原站授权账号的发布前端，完成静态分析、资源采集和本地离线运行适配。复用原 React 页面、完整侧栏、业务模块及 7 种 Agent 编辑器；数据请求被统一替换为本地接口，**无需原站账号或令牌**。

> **这是发布产物级前端还原**，不是源码或服务端克隆。无 source map，不能恢复原始 TS/TSX、注释、类型；模型推理、真实 API/MCP 调用、脚本执行、上传和发布部署等**后端能力不在本项目**。

---

## 快速开始

### 1. 安装依赖（仅首次）

```bash
npm install
```

### 2. 构建应用（仅首次或更新采集数据后）

```bash
npm run restore
```

**输出**：`app/` 目录（28 MB），包含 56 个模块、82 个 Agent、82 个版本。

### 3. 启动本地服务

```bash
npm start
```

**访问地址**：
- Agent 管理：<http://127.0.0.1:4173/agent/studio/agent/app-manage>
- 提示词库：<http://127.0.0.1:4173/agent/studio/agent/prompt-word-library>
- 知识库：<http://127.0.0.1:4173/agent/studio/agent/knowledge>

**端口**：仅监听 `127.0.0.1:4173`，CSP 限制连接为 `'self'`。

### 4. 验证功能（可选）

```bash
npm run verify
```

**检查项**：14 存储 + 21 业务 + 10 知识库 + 15 路由 + 静态检查 = **全部通过**。

---

## 项目结构

```
rea-agent/
├── app/                         # 可运行前端（28 MB）
│   ├── index.html               # 入口页面
│   ├── main.js                  # 离线初始化与路由
│   ├── offline-api.js           # 本地 Agent/Super 请求层
│   ├── offline-business.js      # 业务数据适配（提示词/专家/技能/插件/MCP/知识库）
│   ├── offline-documents.js     # 知识库文档与内容
│   ├── offline-task.js          # 任务型五表隔离
│   ├── route-state.js           # URL 身份镜像
│   ├── assets/                  # 本地化静态资源
│   └── *.json                   # 数据 fixture（82 Agent + 27 提示词 + 29 知识库等）
│
├── tools/                       # 逆向工程工具链
│   ├── collect/                 # 原站数据采集（5 脚本）
│   ├── analyze/                 # REA 静态分析（4 脚本）
│   ├── build/                   # 重建与格式化（4 脚本）
│   └── verify/                  # 离线功能验证（18 脚本）
│
├── evidence/                    # 采集数据与验收证据（489 MB）
│   ├── capture-20261022/        # 新采集（606 Agent + 126 知识库，279 MB）
│   ├── visual-compare/          # 视觉对照截图
│   ├── page-recheck-20261022.md # 本轮复查报告
│   └── *.json                   # 历史采集基准（82/29）
│
├── upstream/                    # 原站静态资源镜像（29 MB）
│   ├── captured/                # 完整 bundle 副本
│   ├── readable/                # Prettier 格式化后（56 模块）
│   └── analysis-*/              # REA 分析输入
│
├── reference/rea/               # morluto/rea 官方参考库
├── server/                      # 本地静态 SPA 服务
│
├── README.md                    # 本文档
├── 复刻进度与开发计划.md           # 完成状态与剩余项
├── package.json                 # 依赖与脚本入口
└── .gitignore
```

---

## 常用命令

| 命令 | 说明 | 输出 |
|------|------|------|
| `npm install` | 安装依赖 | `node_modules/`（145 包） |
| `npm run restore` | 从采集数据重建应用 | `app/`（28 MB，56 模块） |
| `npm start` | 启动本地服务 | `http://127.0.0.1:4173` |
| `npm run verify` | 完整功能回归测试 | 终端输出（约 20 秒） |
| `npm run summary` | 生成采集摘要 | `evidence/rea-summary.json` |

**提示**：
- `npm start` 前必须先 `npm run restore`（首次或采集更新后）
- 验证失败时可单独运行 `node tools/verify/verify-<模块>.mjs` 调试
- 更新采集数据后重跑 `restore` + `verify`

---

## 已恢复功能

### ✅ Agent 管理与编辑器（7 种模式）

当前运行基准：**82 条 Agent + 82 个版本**，覆盖全部模式：

| 模式 | runMode | 编辑路由 | 特性 |
| --- | ---: | --- | --- |
| 超级智能体 | 6 | `/agent/studio/agent/super-agent` | 多专家协同配置 |
| 工作流 | 4 | `/agent/studio/agent/workflow` | React Flow 画布、节点拖动、连线 |
| 智能体 | 5 | `/agent/studio/agent/standard-agent` | 大模型配置与绑定 |
| 低代码对话 | 0 | `/agent/studio/agent/low-code-chat` | 图编辑器、变量引用 |
| 零代码对话 | 1 | `/agent/studio/agent/no-code-chat` | 表单式配置 |
| 工具型 | 2 | 复用低代码图分支 | 工具调用图 |
| 任务型 | 3 | `/agent/studio/agent/task-app` | 五表隔离、流程画布 |

**已采集图配置**：642 节点 + 677 连线。

**本地操作支持**：列表分页/筛选、新建、复制、元数据修改、发布状态切换、删除。任务型 Agent 复制会同步复制五表数据，删除副本会清理对应任务数据。

### ✅ 完整侧栏与业务模块

当前运行基准：
- **27 条提示词** + 8 个标签
- **10 个 MCP 服务** + 288 工具（可增删改查）
- **51 个插件**（含完整详情）
- **1 个智能专家** + 1 个原子技能（含版本管理）
- **29 个知识库** + 55 份文档详情 + 73 个分段 + 27 条问答

**新采集包**（2026-10-22，独立保存）：
- **606 条 Agent** + 606 配置（含 2 条新 `runMode=7`）
- **126 个知识库** + 385 份文档
- 新旧 ID 交集为 0，需单独整合验证

详见 [采集报告](./evidence/capture-20261022/capture-report-20261022.md)。

### ✅ 本地持久化（四层快照）

浏览器 localStorage 保存：
1. **rea-local-snapshot** — Agent 列表与版本
2. **rea-business-snapshot** — 提示词、专家/技能、插件、MCP、知识库
3. **rea-task-snapshot** — 任务型五表
4. **rea-document-snapshot** — 知识库文档与内容

**特性**：
- 损坏缓存或写入失败明确报错，不会静默覆盖用户数据
- 知识库新建/删除跨两份快照联动，任一侧失败整体回滚
- 重建采集文件不会清空浏览器快照

---

## 浏览器验收状态（2026-10-22）

### ✅ 已实测通过

- 完整侧栏 + Agent 管理七模式筛选
- 工作流画布：真实节点/连线、大模型配置、拖动、本地保存
- 任务型 home 流程画布（4 节点），代码节点配置改输出参数后关闭 → 保存 → 刷新回读（**已修复**关闭面板导致配置丢失）
- 超级/标准智能体配置页面
- 提示词库：新增 → 刷新 → 筛选 → 删除 → 刷新不复活
- 专家团队：新建表单、版本启停（接口测试）
- 知识库：29 条列表、文本分段 62 条、详情编辑保存、刷新持久化
- 知识库问答：分页（27 条总数，第二页第 11-20 条）、本地新增显示”本地保存（未向量化）”
- MCP 工具完整 CRUD：新建 → 编辑 → 禁用 → 启用 → 删除（**已实测**）
- 表格元数据编辑保存 → 刷新持久化 → 恢复原值（**已实测**）
- 标签体系：两组真实树（4/3 节点）+ 真实空态（**已修复**白屏，容器高度链已补齐）

### ⚠️ 部分完成

- 四对同视口截图（1280×720），不同像素占比 8.1–10.7%、MAE 2.4–3.6，存在导航结构差异
- 文档删除/下架菜单项处于禁用状态（非弹窗问题）
- 可编辑插件保存、低代码/工具型节点编辑、标准/超级绑定选择器待完整 UI 闭环
- 音视频筛选为空（旧本地无样本、新采集 126 库无媒体库）

详见 [页面复查](./evidence/page-recheck-20261022.md) 与 [进度文档](./复刻进度与开发计划.md)。

---

## 技术细节

### REA 静态分析

已完成三组 JavaScript application 分析，**无解析失败**：

| 范围 | 文件 | findings | AST nodes |
| --- | ---: | ---: | ---: |
| 管理页 | 12 | 317 | 37,737 |
| 核心工作流编辑器 | 6 | 486 | 153,293 |
| 完整导航和各模式编辑器 | 12 | 1,138 | 303,664 |

### 核心目录说明

| 路径 | 说明 |
| --- | --- |
| `app/` | 可运行的本地项目，含四层离线数据适配 |
| `tools/collect/` | 原站数据采集脚本（5 个 Python） |
| `tools/analyze/` | REA 静态分析与摘要（4 脚本） |
| `tools/build/` | 重建与格式化工具（4 脚本） |
| `tools/verify/` | 离线功能验证套件（18 脚本） |
| `upstream/readable/` | Prettier 排版后发布 JavaScript（56 模块） |
| `upstream/captured/` | 未改动的原发布静态资源 |
| `evidence/rea-summary.json` | 三组 REA 分析摘要 |
| `evidence/navigation-resources.json` | 原账号菜单权限树 |
| `evidence/capture-20261022/` | 新采集包（606/126） |

---

## 明确限制

❌ **后端能力未实现**：
- 模型推理、真实 API/MCP 调用
- 服务端脚本执行
- 上传、AI 头像生成
- 真实部署发布
- 知识库向量化

❌ **源码恢复不可行**：
- 无 source map，不能恢复原始 TS/TSX
- 不能恢复注释、类型、编译前目录

⚠️ **数据隐私**：
- 产物未保存测试账号、密码、令牌
- `upstream/captured/` 可能含构建期常量，仅用于已授权的本地学习

---

## 常见问题

**Q: 为什么页面报错或某功能不可用？**  
A: 检查以下项：
1. 是否已运行 `npm run restore`
2. 本地服务是否已启动（`npm start`）
3. 查看浏览器控制台 `window.__reaLocalErrors` 数组
4. 运行 `npm run verify` 确认核心功能正常

**Q: 如何更新到新采集数据（606/126）？**  
A: 新采集包独立保存在 `evidence/capture-20261022/`，需要：
1. 验证新包与当前模块兼容性
2. 更新 `tools/build/restore.mjs` 引用路径
3. 重跑 `npm run restore` + `npm run verify`

**Q: 浏览器显示的数量与 manifest 不同？**  
A: 浏览器快照保留本地编辑/删除结果，重建不会清空。若需恢复基准，手动清除 localStorage 对应快照后刷新。

**Q: 能否连接真实后端？**  
A: 当前本地适配层替换了全部请求入口，连接真实后端需要：
1. 移除 `app/offline-*.js` 的请求拦截
2. 配置后端 API 地址与认证
3. 处理跨域与权限

---

## 参考文档

- [复刻进度与开发计划](./复刻进度与开发计划.md) — 完成状态、剩余项、验收证据
- [页面复查报告](./evidence/page-recheck-20261022.md) — 本轮浏览器验收详情
- [采集报告](./evidence/capture-20261022/capture-report-20261022.md) — 新采集数据覆盖与失败清单

---

**项目依赖**：
- Node.js ≥ 18（实测 Windows Git Bash）
- npm（实测 10.x）
- rea-agents@6.4.0（已安装在 `reference/rea/`）

**贡献与反馈**：本项目为授权学习项目，不接受公开贡献。
