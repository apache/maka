# React Developer Tools v7.0.1 — 逆向工程报告

**逆向日期**：2026-07-06
**AI 模型**：DeepSeek V4 Pro（dsv4）
**Manifest 版本**：MV3
**原始构建**：修订版 `3cde211b0c`（2025-10-20）

## 产出物清单

| 文件 | 说明 |
|------|------|
| `dist/` | 可加载到 Chrome 的完整扩展（17 个 build JS + 49 个图标 + 7 个弹窗 HTML + 2 个入口 HTML） |
| `src/types/index.ts` | TypeScript 类型定义（16 个模块，涵盖 Hook/Bridge/Agent/Renderer 等核心接口） |
| `src/docs/ARCHITECTURE.md` | 架构文档（分层图、模块职责表、技术决策、权限清单） |
| `src/docs/DATA_FLOW.md` | 数据流文档（10 个 Mermaid 序列图，覆盖启动/检查/覆写/性能分析等关键流程） |
| `src/docs/SECURITY_AUDIT.md` | 安全审计报告（9 维度评估） |
| `package.json` | TypeScript + @types/chrome 项目配置 |

## 关键发现

### 打包工具
Webpack 5，通过 `__webpack_require__` 模块系统识别。代码经压缩但未混淆，`installHook.js` 和 `react_devtools_backend_compact.js` 附带 source map。

### 架构亮点
1. **动态 Content Script 注册**：使用 `chrome.scripting.registerContentScripts()` 而非 manifest 静态声明，实现执行世界（MAIN/ISOLATED）的精细控制
2. **Port 桥接模式**：后台维护 `Tab → { extension, proxy }` 的端口映射，通过命名端口实现双向消息管道
3. **多 Backend 支持**：使用 semver 比较来匹配不同 React 版本的渲染器后端，`compact` 作为兜底

### 安全状况
- CSP 严格（`script-src 'self'`）
- 无数据外传
- 无外部依赖（仅内嵌 lru-cache 和 semver）
- `postMessage` 通信有 source 标识验证
- 安全评级：中等偏高

### 文件规模
- 总文件数：61
- JS 代码总量：约 2.5 MB（含两个 Worker 线程）
- 主面板 `main.js`：1.2 MB（最大的单文件）
- `parseSourceAndMetadata.worker.worker.js`：839 KB（次大文件）

## 结构对照

```
dist/
├── build/
│   ├── background.js           ← Service Worker (5.5K)
│   ├── main.js                 ← DevTools 前端 UI (1.2M)
│   ├── panel.js                ← 面板初始化 (169B)
│   ├── proxy.js                ← 内容代理 (1.4K)
│   ├── prepareInjection.js     ← 消息中继 (334B)
│   ├── fileFetcher.js          ← 文件获取 (671B)
│   ├── hookSettingsInjector.js ← Hook 设置注入 (755B)
│   ├── installHook.js          ← 全局 Hook 注入 (175K)
│   ├── backendManager.js       ← 后端管理器 (14K)
│   ├── react_devtools_backend_compact.js ← Compact 后端 (50K)
│   ├── importFile.worker.worker.js       ← 导入 Worker (219K)
│   └── parseSourceAndMetadata.worker.worker.js ← 解析 Worker (839K)
├── icons/                      ← 49 个图标 (7 种状态 × 7 种尺寸 + 7 个 SVG)
├── popups/                     ← 7 个弹窗页面 + 共用 JS/CSS
├── main.html                   ← DevTools 入口
├── panel.html                  ← 面板容器
├── manifest.json               ← MV3 清单
└── _metadata/                  ← Chrome Web Store 元数据
```
