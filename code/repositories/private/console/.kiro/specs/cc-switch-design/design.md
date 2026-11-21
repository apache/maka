# CC Switch - 系统设计文档

> **项目名称**: CC Switch
> **版本**: 1.0.0
> **创建日期**: 2026-01-14
> **设计者**: Claude Code
> **状态**: 设计完成，待实施

---

## 目录

1. [项目概述](#项目概述)
2. [整体架构](#整体架构)
3. [UI 设计](#ui-设计)
4. [数据流与状态管理](#数据流与状态管理)
5. [错误处理与边界情况](#错误处理与边界情况)
6. [测试策略与实施计划](#测试策略与实施计划)

---

## 项目概述

### 核心定位

**CC Switch** 是一个轻量级的 macOS 原生应用，用于可视化管理 Claude Code 的 `~/.claude/settings.json` 配置文件。采用 Tauri 2.x + React 18 技术栈，专注于提供流畅的插件开关管理和预设切换体验。

### 核心功能

1. **插件开关管理**：可视化开关界面，实时管理 Claude Code 插件
2. **5套预设组合**：内置 5 个场景预设（learn/frontend-dev/plan/ops/research）
3. **自定义预设**：支持用户创建、编辑、删除自定义预设
4. **实时配置同步**：开关切换立即写入配置文件

### 技术栈

| 层级 | 技术 | 版本 |
|------|------|------|
| 桌面框架 | Tauri | 2.x |
| 前端框架 | React | 18 |
| 语言 | TypeScript | 5.3+ |
| 构建工具 | Vite | 5.x |
| UI 库 | Shadcn/ui | Latest |
| 样式 | Tailwind CSS | 3.4+ |
| 状态管理 | Zustand | 5.x |
| 路由 | React Router | 7.x |
| 表单验证 | Zod | 3.22+ |
| 数据请求 | TanStack Query | 5.x |
| 包管理 | pnpm | 8.x |

### 参考项目

本项目参考 **cc-dev** 的架构设计：
- 项目路径：`/Users/ggbdpq/gua/04-github/cc-dev`
- 核心思想：三层配置架构（Base + Profile + Runtime）
- 设计模式：补丁模式、深度合并策略

---

## 整体架构

### 系统架构图

```
┌─────────────────────────────────────────────────┐
│               Frontend (React)                   │
│  ┌────────────┐           ┌─────────────────┐   │
│  │  UI Layer  │  ←──→    │  State Layer    │   │
│  │ (Shadcn)   │           │   (Zustand)     │   │
│  └────────────┘           └─────────────────┘   │
│         ↓                        ↓               │
│  ┌─────────────────────────────────────────┐   │
│  │      Data Layer (TanStack Query)        │   │
│  └─────────────────────────────────────────┘   │
└─────────────────────────────────────────────────┘
                      ↓
┌─────────────────────────────────────────────────┐
│           Backend (Tauri - Rust)                │
│  ┌─────────────────────────────────────────┐   │
│  │  File Commands (JSON 读/写/监听)         │   │
│  └─────────────────────────────────────────┘   │
└─────────────────────────────────────────────────┘
                      ↓
              ~/.claude/settings.json
```

### 技术选型理由

| 技术 | 选择理由 |
|------|---------|
| **Tauri 2.x** | 相比 Electron 包体小 10x+，Rust 后端安全高性能 |
| **Zustand** | 比 Redux 轻量 5x，无需 boilerplate，适合小应用 |
| **TanStack Query** | 自动缓存、重试、失效重取，处理文件 I/O 异常 |
| **Shadcn/ui** | 基于 Radix UI，无障碍支持，macOS 原生风格 |
| **Zod** | 运行时类型验证，防止配置文件损坏 |

### 项目目录结构

```
cc-switch/
├── src-tauri/                 # Rust 后端
│   ├── src/
│   │   ├── commands.rs        # Tauri 命令（读/写/监听文件）
│   │   ├── config.rs          # 配置模型定义
│   │   ├── error.rs           # 错误类型定义
│   │   └── lib.rs
│   ├── Cargo.toml
│   └── tauri.conf.json        # 应用配置（窗口大小、图标等）
│
├── src/                       # React 前端
│   ├── main.tsx
│   ├── App.tsx
│   │
│   ├── components/            # UI 组件
│   │   ├── ui/                # Shadcn 组件
│   │   ├── PluginSwitch.tsx   # 插件开关组件
│   │   ├── PresetSidebar.tsx  # 预设侧边栏
│   │   ├── PluginGroup.tsx    # 插件分组组件
│   │   └── ErrorBoundary.tsx  # 错误边界
│   │
│   ├── stores/                # Zustand 状态
│   │   ├── presetStore.ts     # 预设管理
│   │   └── pluginStore.ts     # 插件状态
│   │
│   ├── hooks/                 # React Hooks
│   │   ├── useSettings.ts     # TanStack Query 封装
│   │   └── useFileWatcher.ts  # 文件监听
│   │
│   ├── lib/                   # 工具函数
│   │   ├── schema.ts          # Zod 验证 schema
│   │   └── presets.ts         # 内置预设定义
│   │
│   └── types/                 # TypeScript 类型
│       └── settings.ts
│
├── e2e/                       # E2E 测试
│   └── main.spec.ts
│
├── package.json
├── tsconfig.json
├── tailwind.config.js
├── vite.config.ts
└── README.md
```

---

## UI 设计

### 主界面布局

应用采用 **左右分栏布局**，窗口默认尺寸 `800x600`，支持用户调整大小：

```
┌─────────────────────────────────────────────────────────┐
│  CC Settings                            ● — □           │  ← 标题栏
├──────────────┬──────────────────────────────────────────┤
│              │  当前预设: Frontend Dev            [+ 新建] │  ← 预设头部
│   预设列表    ├──────────────────────────────────────────┤
│              │                                          │
│ ▶ 学习模式    │  ▶ 官方插件                    (12 开启)  │  ← 插件分组
● 前端开发     │   ☑ Explanatory Output                     │
│   规划模式    │   ☑ Security Guidance                      │
│   运维部署    │   ☐ Context7                               │
│   技术调研    │   ☐ Code Review                            │
│              │                                          │
│ ─────────    │  ▶ 第三方插件                  (2 开启)   │
│ 🔧 我的预设   │   ☑ Superpowers                           │
│   • 调试配置  │   ☐ Taskmaster                            │
│              │                                          │
│              │  ▶ 已禁用                      (8 开启)   │
│              │   ☐ ...                                   │
└──────────────┴──────────────────────────────────────────┘
     240px                560px
```

### 颜色主题与风格

采用 **macOS 原生设计语言**：

| 元素 | 颜色/样式 | 说明 |
|------|----------|------|
| 背景 | `#f5f5f7` | macOS 系统背景色 |
| 侧边栏 | `#e8e8ed` | 分层背景 |
| 分隔线 | `#d1d1d6` | 细线分隔 |
| 主文字 | `#1d1d1f` | SF Pro Text |
| 次要文字 | `#86868b` | 灰色文本 |
| 强调色 | `#007aff` | macOS 系统蓝 |
| 开关 | 原生 Switch | macOS 样式 |

### 核心组件设计

#### PresetSidebar（预设侧边栏）

```tsx
<PresetSidebar>
  <PresetSection title="内置预设">
    <PresetItem
      name="学习模式"
      icon="📚"
      active={false}
      onClick={() => applyPreset('learn')}
    />
    <PresetItem
      name="前端开发"
      icon="⚛️"
      active={true}
      onClick={() => applyPreset('frontend-dev')}
    />
  </PresetSection>

  <Separator />

  <PresetSection title="我的预设">
    <PresetItem
      name="调试配置"
      icon="🔧"
      onEdit={() => editPreset('debug')}
      onDelete={() => deletePreset('debug')}
    />
    <Button onClick={createPreset}>+ 新建预设</Button>
  </PresetSection>
</PresetSidebar>
```

#### PluginGroup（插件分组）

```tsx
<PluginGroup
  title="官方插件"
  count={{ enabled: 2, total: 12 }}
  defaultExpanded={true}
>
  <PluginSwitch
    plugin="explanatory-output-style@claude-plugins-official"
    label="Explanatory Output"
    description="提供详细的教育性解释"
    enabled={true}
    onToggle={(enabled) => togglePlugin(plugin, enabled)}
  />
</PluginGroup>
```

#### PluginSwitch（插件开关）

```tsx
<div className="flex items-center justify-between py-3">
  <div className="flex-1">
    <div className="flex items-center gap-2">
      <Switch checked={enabled} onCheckedChange={onToggle} />
      <Label className="font-medium">{label}</Label>
    </div>
    <p className="text-sm text-gray-500 mt-1">{description}</p>
  </div>
  <Badge variant={enabled ? "default" : "secondary"}>
    {plugin.split('@')[1]}
  </Badge>
</div>
```

### 内置预设定义

```typescript
export const BUILTIN_PRESETS: Preset[] = [
  {
    id: 'learn',
    name: '学习模式',
    icon: '📚',
    description: 'Token 优化 -30%~40%',
    enabledPlugins: {
      'learning-output-style@claude-plugins-official': true,
      'context7@claude-plugins-official': true,
      'hookify@claude-plugins-official': true,
      'feature-dev@claude-plugins-official': false,
      'frontend-design@claude-plugins-official': false,
    }
  },
  {
    id: 'frontend-dev',
    name: '前端开发',
    icon: '⚛️',
    description: 'React/Vue/Angular 专用配置',
    enabledPlugins: {
      'code-review@claude-plugins-official': true,
      'code-simplifier@claude-plugins-official': true,
      'frontend-design@claude-plugins-official': true,
      'feature-dev@claude-plugins-official': true,
      'commit-commands@claude-plugins-official': true,
    }
  },
  {
    id: 'plan',
    name: '规划模式',
    icon: '📋',
    description: 'Token 优化 -50%~60%',
    enabledPlugins: {
      'hookify@claude-plugins-official': true,
      // 禁用大部分开发插件
    }
  },
  {
    id: 'ops',
    name: '运维部署',
    icon: '🚀',
    description: 'CI/CD 和部署专用配置',
    enabledPlugins: {
      'github@claude-plugins-official': true,
      'vercel@claude-plugins-official': true,
      'commit-commands@claude-plugins-official': true,
    }
  },
  {
    id: 'research',
    name: '技术调研',
    icon: '🔍',
    description: '文档查询和知识整理',
    enabledPlugins: {
      'context7@claude-plugins-official': true,
      'learning-output-style@claude-plugins-official': true,
    }
  },
]
```

---

## 数据流与状态管理

### 数据流架构

```
用户交互 (点击开关/切换预设)
    ↓
React 组件层 (PluginSwitch / PresetSidebar)
    ↓
Zustand Store (乐观更新 pendingPlugins)
    ↓
TanStack Query (调用 Tauri command)
    ↓
Tauri 后端 (Rust: 读写文件)
    ↓
~/.claude/settings.json
```

### Zustand Store 设计

```typescript
interface PluginState {
  pendingPlugins: Record<string, boolean | undefined>
  expandedGroups: Set<string>

  togglePlugin: (pluginId: string, enabled: boolean) => void
  setGroupExpanded: (groupId: string, expanded: boolean) => void
  clearPending: (pluginId: string) => void
  rollbackPending: (pluginId: string) => void
}
```

### TanStack Query 封装

```typescript
// 读取配置
export function useSettings() {
  return useQuery({
    queryKey: ['settings'],
    queryFn: async () => {
      const raw = await invoke<string>('read_settings')
      const parsed = JSON.parse(raw)
      return settingsSchema.parse(parsed)
    },
    staleTime: 1000 * 30,
  })
}

// 写入配置
export function useTogglePlugin() {
  return useMutation({
    mutationFn: async ({ pluginId, enabled }) => {
      await invoke('toggle_plugin', { pluginId, enabled })
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['settings'] })
    }
  })
}
```

### Zod Schema 定义

```typescript
export const settingsSchema = z.object({
  enabledPlugins: z.record(z.string(), z.boolean()),
  env: z.record(z.string(), z.string()).optional(),
  language: z.string().optional(),
  includeCoAuthoredBy: z.boolean().optional(),
})

export const presetSchema = z.object({
  id: z.string(),
  name: z.string(),
  icon: z.string(),
  description: z.string(),
  enabledPlugins: z.record(z.string(), z.boolean()),
})
```

### Tauri 命令定义

```rust
#[tauri::command]
fn read_settings() -> Result<String, String>

#[tauri::command]
fn toggle_plugin(plugin_id: String, enabled: bool) -> Result<(), String>

#[tauri::command]
fn apply_preset(preset: &Preset) -> Result<(), String>
```

---

## 错误处理与边界情况

### 错误类型

| 错误类型 | 处理策略 |
|---------|---------|
| 文件不存在 | 创建默认配置 + 欢迎页面 |
| JSON 格式错误 | 显示错误详情 + 修复建议 |
| 权限不足 | 提示修复权限 + 终端打开按钮 |
| 外部修改冲突 | 提示刷新 + 重新加载按钮 |
| 预设插件不存在 | 跳过不存在的插件 + 警告提示 |

### Rust 错误定义

```rust
#[derive(Error, Debug)]
pub enum SettingsError {
    #[error("配置文件不存在: {0}")]
    FileNotFound(String),

    #[error("权限不足，无法读取配置文件")]
    PermissionDenied,

    #[error("JSON 格式错误: {0}")]
    InvalidJson(#[from] serde_json::Error),

    #[error("配置验证失败: 缺少必要字段 {0}")]
    ValidationFailed(String),
}
```

### React Error Boundary

```tsx
export class ErrorBoundary extends Component<Props, State> {
  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error }
  }

  render() {
    if (this.state.hasError) {
      return <ErrorPage error={this.state.error} />
    }
    return this.props.children
  }
}
```

---

## 测试策略与实施计划

### 测试金字塔

```
                    ┌─────────────┐
                    │   E2E 测试   │  5%
                  ┌───────────────────┐
                  │    集成测试        │  15%
                ┌─────────────────────────────┐
                │        单元测试              │  80%
                └─────────────────────────────┘
```

### 测试覆盖率目标

| 模块 | 目标覆盖率 |
|------|-----------|
| Rust Commands | 80%+ |
| React 组件 | 70%+ |
| Zustand Store | 90%+ |
| Hooks | 75%+ |

### 实施计划

```
Phase 1: 项目搭建 (1-2天)
├── 初始化 Tauri + React + TypeScript 项目
├── 配置 Shadcn/ui + Tailwind CSS
├── 设置 Zustand + TanStack Query
└── 定义 Zod Schema 和 TypeScript 类型

Phase 2: Rust 后端 (2-3天)
├── 实现 read_settings 命令
├── 实现 write_settings 命令
├── 实现 toggle_plugin 命令
├── 实现 apply_preset 命令
└── 添加错误处理和单元测试

Phase 3: 核心 UI (3-4天)
├── 实现 PresetSidebar 组件
├── 实现 PluginSwitch 组件
├── 实现 PluginGroup 组件
└── 集成 TanStack Query

Phase 4: 预设管理 (2-3天)
├── 实现内置预设定义
├── 实现预设应用逻辑
└── 实现自定义预设 CRUD

Phase 5: 错误处理与优化 (2天)
├── 实现错误边界
├── 实现 Toast 通知系统
└── 性能优化

Phase 6: 测试与打包 (2天)
├── 编写单元测试
├── 编写 E2E 测试
└── 配置 macOS 打包
```

### 技术依赖

```json
{
  "dependencies": {
    "@tauri-apps/api": "^2.0.0",
    "@tanstack/react-query": "^5.0.0",
    "zustand": "^5.0.0",
    "zod": "^3.22.0",
    "react": "^18.2.0",
    "react-router-dom": "^7.0.0"
  },
  "devDependencies": {
    "@tauri-apps/cli": "^2.0.0",
    "vitest": "^2.0.0",
    "@testing-library/react": "^16.0.0",
    "@playwright/test": "^1.40.0"
  }
}
```

---

## 附录

### 参考资源

- **cc-dev 项目**: `/Users/ggbdpq/gua/04-github/cc-dev`
- **Tauri 文档**: https://tauri.app/
- **Shadcn/ui**: https://ui.shadcn.com/
- **Zustand**: https://zustand-demo.pmnd.rs/

### 设计决策记录

| 决策 | 原因 |
|------|------|
| 使用 Tauri 而非 Electron | 包体小 10x+，Rust 安全高性能 |
| 使用 Zustand 而非 Redux | 更轻量，适合小应用状态管理 |
| 立即写入而非手动保存 | 降低用户操作负担，提升体验 |
| 分组折叠而非扁平列表 | 插件数量多时组织性更好 |
| 左右分栏而非上下分层 | 符合 macOS 应用习惯 |

---

**文档版本**: 1.0.0
**最后更新**: 2026-01-14
