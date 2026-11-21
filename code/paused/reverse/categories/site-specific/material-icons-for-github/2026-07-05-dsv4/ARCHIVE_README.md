# Material Icons for GitHub 反向工程档案

> 归档目录: `material-icons-for-github-dsv4/` | 日期: 2026-07-06

---

## 档案内容

本目录包含 Material Icons for GitHub Chrome 扩展的完整反向工程分析成果。

### 产出物

| 文件 | 说明 |
|------|------|
| `dist/` | 原始扩展源代码 (完整归档, 1265 文件) |
| `src/types/index.ts` | TypeScript 类型定义 (IconMapping, ExtensionSettings, SiteConfig 等) |
| `src/docs/ARCHITECTURE.md` | 架构分析文档 (中文) |
| `src/docs/DATA_FLOW.md` | 数据流文档 (中文, 含 Mermaid 流程图) |
| `src/docs/SECURITY_AUDIT.md` | 安全审计报告 (中文) |
| `package.json` | 项目配置 |

### 分析维度

- 静态源代码分析 (打包后单文件, ~52K tokens)
- Manifest 权限与能力映射 (MV3 Content Script 模式)
- 站点适配器架构分析 (Adapter Pattern, 10 个站点)
- 图标映射与注入流程追踪 (~1251 SVG 图标)
- 安全边界评估 (DOM 操作, 消息通信, 存储模型)

### 关键发现

1. **无后台脚本**: 纯 Content Script 扩展, 所有逻辑在页面上下文运行
2. **Adapter 模式**: 每个 Git 托管平台有独立配置, 封装 DOM 选择器和行为差异
3. **巨型图标库**: ~1251 个 Material Design SVG 文件, 覆盖数百种文件类型
4. **三级图标匹配**: 精确文件名 > 扩展名 > 默认图标
5. **Per-host 设置**: chrome.storage.sync 支持按域名覆盖全局设置
6. **自定义站点**: 用户可通过 customProviders 扩展支持任意 Git 托管站点
7. **安全评估**: 低风险 — 无 innerHTML/eval, 无网络请求, 无敏感数据处理

---

## 源扩展信息

- **名称**: Material Icons for GitHub
- **版本**: 1.16.2
- **Manifest**: V3
- **类型**: Content Script Only (无 Service Worker)
- **权限**: storage, activeTab, scripting, optional_host_permissions: *://*/*
- **支持站点**: GitHub, Bitbucket, Azure DevOps, Gitea, GitLab, Gitee, SourceForge, Codeberg, Tangled (10 个)
- **图标资源**: ~1251 Material Design SVG 文件
- **图标包**: Angular, Nest, NgRx, React, Redux, Roblox, Qwik, Vue, Vuex, Bashly (10 个)
- **Polyfill**: webextension-polyfill (内联)

---

## 使用限制

本档案仅用于安全研究、教育和学习目的。不得用于任何商业、恶意或侵权用途。
