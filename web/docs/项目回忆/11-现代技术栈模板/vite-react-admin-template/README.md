# vite-react-admin-template

`lego-enhance-template`（希音 lego 体系）的**主流技术栈改造版**。

> 版本全部取自 npm registry 实时 latest（2026-09 核实）：
> React 19.2 · TypeScript 7.0（原生编译器）· Vite 8.2 · pnpm 11.25 · React Router 8（ESM-only）· Zustand 5 · Zod 4 · Tailwind CSS 4.3 · shadcn CLI 4.x

## 快速开始

```bash
pnpm install
pnpm dev        # http://localhost:8888（沿用原模板端口，内置 mock，开箱即用）
pnpm build      # tsc -b + vite build
pnpm lint
```

对接真实后端：删除 `vite.config.ts` 里的 `mockApi()`，启用 `server.proxy['/api']`。

## 新旧对照（lego-enhance-template → 本模板）

| 能力 | 旧（lego 体系） | 新（本模板） |
| --- | --- | --- |
| 构建工具 | @shein-lego/cli（webpack 封装），.legorc.ts | **Vite 8** + @vitejs/plugin-react，vite.config.ts |
| 路由 | lego 约定式路由（.lego/routes，pages/** 自动注册） | **React Router 8** 显式路由表（src/routes.tsx），`lazy` 按需加载；注意 v8 起只有 `react-router` 包，`react-router-dom` 已移除 |
| 全局状态 | @shined/reactive（create/mutate/useSnapshot） | **Zustand 5**（create + selector 订阅），页面级 store 对应原 index.hook.tsx + store.ts 分工 |
| 请求层 | src/fetch/index.ts：sheinq fetch + sso-sdk AuthError | **原生 Fetch + Zod**：src/lib/api-client.ts，401 统一出口 `setUnauthorizedHandler`（接 SSO/登录页的钩子位） |
| 响应校验 | 无（手写判空） | **Zod 4** Schema 契约（src/api/schemas.ts），类型全部 `z.infer` 推导，含 `z.lazy` 递归权限树 |
| 命名转换 | helpers/fetch.ts 的 under2Camel/camel2Under | **原样保留**（src/lib/fetch-transform.ts）——你的签名代码，后端 snake_case 时依然必需 |
| 权限 | helpers/permission.ts 三级权限（页面/API/按钮）+ 动态路由正则 | **结构原样保留**（src/helpers/permission.ts），数据源从 reactive 换成 zustand `getState()` |
| UI 组件库 | shineout + @shein-components/* | **Tailwind CSS 4 + shadcn/ui**（`@import "tailwindcss"` 无配置文件；组件带 `data-slot`，样式 token 走 CSS 变量） |
| 图标 | @shein-components/Icon | **lucide-react** |
| Toast/Message | shineout Message | **sonner**（src/components/ui/sonner.tsx） |
| 表格 | shineout Table 公共封装 | shadcn Table + 页面级 zustand 分页 store（src/pages/users/） |
| 布局 | layouts/（header/menu/main + 各自 store） | 单文件 **basic-layout.tsx**（侧边菜单 + 面包屑 + 用户下拉 + Outlet） |
| mock | data/*.json | Vite dev 中间件（mock/server.ts），**故意用 snake_case 字段**验证转换链路 |
| i18n | @shein-bbl/react 的 t() | 未引入（主流栈默认不做 i18n）；需要时加 i18next，或保留 t() 包装层 |
| 埋点/APM | sheinq + @shein/apm-helper | 未引入；埋点位在 api-client 与路由层，接 Sentry/PostHog 时替换 |
| 状态管理（redux） | redux ^4 | 移除，Zustand 全覆盖 |
| 端口/代理 | .legorc devServer 8888 + proxy | vite.config server.port 8888 + proxy |

## 目录结构

```
├── mock/server.ts            # dev mock 中间件（snake_case 字段，验证转换链路）
├── vite.config.ts            # Vite 8 + Tailwind 4 插件 + @ 别名 + 8888 端口
├── components.json           # shadcn CLI 配置
└── src/
    ├── routes.tsx            # 显式路由表 + lazy
    ├── main.tsx              # React 19 createRoot + RouterProvider + Toaster
    ├── index.css             # Tailwind 4（@theme inline，无 tailwind.config）
    ├── api/
    │   ├── schemas.ts        # Zod 契约：UserInfo / PermissionNode(递归) / UserPage…
    │   └── admin.ts          # 类型化接口：schema 一传，返回值自动收窄
    ├── lib/
    │   ├── api-client.ts     # Fetch 封装：权限校验→命名转换→错误码→Zod
    │   └── fetch-transform.ts# under2Camel / camel2Under（希音时期签名代码）
    ├── stores/global.ts      # Zustand 全局 store（bootstrap 引导 + 权限 map）
    ├── helpers/permission.ts # 三级权限 + 动态路由正则匹配（原样保留）
    ├── constants/            # BASIS_MENU / 错误码 / API 白名单
    ├── layouts/basic-layout.tsx
    ├── components/
    │   ├── page-loading.tsx  # 路由加载态
    │   ├── require-auth.tsx  # 路由守卫（bootstrap + 页面权限）
    │   └── ui/               # shadcn 组件（CLI 同款生成物，可继续用 CLI 追加）
    └── pages/                # dashboard（请求层示例）/ users（store+表格+按钮权限）/ not-found
```

## shadcn/ui 追加组件

模板已内置 button/input/card/table/badge/skeleton/dropdown-menu/breadcrumb/sonner 九件。需要更多时直接用 CLI（会按 components.json 生成到 src/components/ui）：

```bash
pnpm dlx shadcn@latest add dialog dialog-command select
```

## 版本备注

- **TypeScript 7**：原生编译器（Go 移植版），`tsc -b` 即可；日常转译由 Vite 8（Rolldown/Oxc）完成，TS 只做类型检查。
- **React Router 8**（2026-06 发布）：ESM-only；`react-router-dom` 包已删除，统一 `import { ... } from 'react-router'`；`createBrowserRouter`/数据路由用法与 v7 一致。
- **Zod 4**：`safeParse`/`z.infer` 用法不变；字符串格式校验改为顶层函数（如 `z.email()`），模板未用到。
- 权限"模板模式"：权限 map 为空（未接权限系统）时 `checkXxxPermission` 默认放行，页面开箱可见；接入后自动生效。
