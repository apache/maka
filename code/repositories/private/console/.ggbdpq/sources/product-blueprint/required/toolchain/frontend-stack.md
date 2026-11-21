# 前端技术栈说明

> 本文档定义母本支持的前端技术栈，以 React 为默认主线，其他栈只写差异点。

---

## 一、React 技术栈（默认主线）

### 完整技术栈

```
React 19 + TypeScript + Vite 8 + React Router 7 + Zustand + Zod + Tailwind + shadcn/ui
```

### 适用场景

- 内部工具平台（workbench）
- 中后台管理系统
- 需要 SSE/WebSocket 实时更新的应用
- 单页应用（SPA）

### 核心依赖版本

| 依赖         | 版本   | 说明                     |
| ------------ | ------ | ------------------------ |
| React        | 19.x   | 使用 Concurrent Features |
| TypeScript   | 5.x    | strict 模式              |
| Vite         | 8.x    | 构建与开发服务器         |
| React Router | 7.x    | 路由管理                 |
| Zustand      | 5.x    | 状态管理                 |
| Zod          | 3.x    | 运行时类型校验           |
| Tailwind CSS | 4.x    | 原子化 CSS               |
| shadcn/ui    | latest | UI 组件库                |

### 目录结构约定

```
src/
├── components/     # 通用组件
├── routes/         # 页面路由（按 React Router 7 约定）
├── hooks/          # 自定义 hooks
├── stores/         # Zustand stores
├── types/          # TypeScript 类型定义
├── utils/          # 工具函数
└── main.tsx        # 入口文件
```

---

## 二、Vue 技术栈（差异点）

### 完整技术栈

```
Vue 3.5 + TypeScript + Vite 8 + Vue Router 4 + Pinia + Zod + Element Plus
```

### 与 React 主线的差异

| 差异项    | React 主线     | Vue 差异     |
| --------- | -------------- | ------------ |
| 框架      | React 19       | Vue 3.5      |
| 状态管理  | Zustand        | Pinia        |
| 路由      | React Router 7 | Vue Router 4 |
| UI 组件库 | shadcn/ui      | Element Plus |

### 适用场景

- 管理控制台（admin-console）
- 需要 Element Plus 生态的项目
- 团队 Vue 经验更丰富时

### 目录结构约定

```
src/
├── components/     # 通用组件
├── views/          # 页面视图
├── router/         # 路由配置
├── stores/         # Pinia stores
├── types/          # TypeScript 类型定义
├── utils/          # 工具函数
└── main.ts         # 入口文件
```

---

## 三、Next.js 技术栈（差异点）

### 完整技术栈

```
Next.js 16 (App Router) + TypeScript + Tailwind + shadcn/ui
```

### 与 React 主线的差异

| 差异项   | React 主线      | Next.js 差异                             |
| -------- | --------------- | ---------------------------------------- |
| 框架     | React 19 + Vite | Next.js 16 (App Router)                  |
| 路由     | React Router 7  | 文件系统路由                             |
| 渲染模式 | CSR             | SSR/SSG/ISR                              |
| 状态管理 | Zustand         | 按需（Server Components 减少客户端状态） |

### 适用场景

- 开发者门户（developer-portal）
- 文档站点
- 需要 SEO 的营销页面
- 需要 SSR/SSG 的场景

### 目录结构约定

```
app/
├── layout.tsx      # 根布局
├── page.tsx        # 首页
├── globals.css     # 全局样式
├── (routes)/       # 路由分组
│   ├── docs/
│   ├── api-keys/
│   └── ...
└── components/     # 组件（可选放 app 外）
```

---

## 四、Svelte/SvelteKit 技术栈（实验性）

### 完整技术栈

```
SvelteKit + TypeScript + Tailwind
```

### 与 React 主线的差异

| 差异项   | React 主线 | Svelte 差异           |
| -------- | ---------- | --------------------- |
| 框架     | React 19   | Svelte 5              |
| 编译模式 | 虚拟 DOM   | 编译时优化            |
| 状态管理 | Zustand    | Svelte stores         |
| 构建工具 | Vite 8     | Vite (SvelteKit 内置) |

### 适用场景

- 性能敏感的小型应用
- 实验性项目
- 团队想尝试新技术栈时

### 注意事项

- 生态相对较小
- 第三方组件库选择有限
- 建议仅用于非核心项目

---

## 五、通用约定（所有技术栈）

### 构建工具

- 统一使用 Vite 8（Next.js 除外）
- TypeScript strict 模式
- ESLint + Prettier 格式化

### 样式方案

- 优先 Tailwind CSS 4.x
- 支持 dark mode
- 语义化 CSS 变量

### 测试方案

- 单测：Vitest + Testing Library
- E2E：Playwright

### 状态管理原则

- 优先使用 Server State（TanStack Query）
- 客户端状态用 Zustand/Pinia
- 避免全局状态过度膨胀

---

## 六、技术栈选择决策树

```
是否需要 SEO/SSR？
├── 是 → Next.js
└── 否
    └── 团队主要技术栈？
        ├── React → React 主线
        ├── Vue → Vue 技术栈
        └── 想尝试新技术 → Svelte（仅非核心项目）
```

---

## 七、版本升级策略

- 主版本升级前必须在分支验证
- 次版本升级可直接进行（需通过测试）
- 补丁版本自动升级（dependabot/renovate）

---

> 本文档为母本技术栈说明，具体项目可根据需求裁剪。
