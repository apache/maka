# 06 Mock 体系与接入真实后端

> 本篇目标：讲清假后端的工作原理和全部端点分布，然后给出接真实后端的完整改动清单。这一章是"演示项目"变"生产项目"的分水岭。

## 一句话定义

Mock 体系是用 `vite-plugin-fake-server` 在 Node 中间层拦截 HTTP 请求、按 `mock/` 目录的规则返回假数据的机制，让前端在没有后端的情况下完整运行。

类比飞行模拟器：座舱（前端页面）和仪表（接口响应）一应俱全，气流（数据）是程序生成的。训练（开发、演示）够用，但要上天（生产）得换真发动机（真实后端）。

## 为什么这个 mock 与众不同

多数模板的 mock 只在 dev 生效，`pnpm build` 后演示就断。本仓库在 `build/plugins.ts` 第 54-59 行做了不同选择：

```ts
vitePluginFakeServer({
  logger: false,
  include: "mock",
  infixName: false,
  enableProd: true
})
```

`enableProd: true` 让 mock 中间件打进生产产物。结果是：构建出的 `dist/` 部署到任意静态服务器就能完整登录、增删改查。代价也要清楚——**生产环境跑着假数据**，接入真实后端前绝不能把这种产物交付出去。这是使用本框架第一条要写进团队规范的注意事项。

## 端点全景

mock 共 7 个文件。下表列出全部端点与前端消费方，接后端时可当作改造核对表：

| 文件 | 端点 | 前端消费方 |
| --- | --- | --- |
| `mock/login.ts` | POST `/login` | 登录页 |
| `mock/refreshToken.ts` | POST `/refresh-token` | 无感刷新（第 05 篇） |
| `mock/asyncRoutes.ts` | GET `/get-async-routes` | 动态路由（第 04 篇） |
| `mock/system.ts` | POST `/user`、GET `/list-all-role`、POST `/list-role-ids`、POST `/role`、GET/POST `/role-menu`、`/role-menu-ids`、POST `/menu`、`/dept`、GET `/dict-tree`、`/dict-detail`、POST `/online-logs`、`/login-logs`、`/operation-logs`、`/system-logs`、`/system-logs-detail`、`/tenant-list`、`/tenant-package`、`/tenant-package-menu`、`/tenant-package-menu-ids`、`/tenant-package-simple` | 系统管理、监控、多租户全部页面 |
| `mock/list.ts` | POST `/get-card-list` | 列表页演示（`src/views/list/card`） |
| `mock/mine.ts` | GET `/mine`、`/mine-logs` | 账户设置页（`src/views/account-settings`） |
| `mock/map.ts` | GET `/get-map-info` | 高德地图演示页 |

`mock/system.ts` 一个文件 2503 行，是端点密度最高的文件。它的写法值得学习：每个端点用 `defineFakeRoute([...])` 声明，响应函数里用 `@faker-js/faker` 造随机数据，分页结构统一为 `{ list, total, pageSize, currentPage }`——这个结构就是全框架列表页的接口契约。

## 假数据规则的写法

看一个带"写操作"的样本（简化自 `mock/system.ts`）：

```ts
{
  url: "/role",
  method: "post",
  response: ({ body }) => {
    if (body?.filter) { /* 按条件过滤内置数组并分页返回 */ }
    return { code: 0, data: { list, total } };
  }
}
```

要点：响应约定为 `{ code: 0, message, data }`，前端各处判断的正是 `code === 0`（见 `src/store/modules/user.ts` 的 `loginByUsername`、`src/router/utils.ts` 的 `initRouter`）。接真实后端时，要么后端适配这个信封格式，要么在前端响应拦截器统一转换（第 07 篇的改造点）。

## 接入真实后端：完整改动清单

按执行顺序排列，勾完即可下线 mock。

### 第一步：关闭生产 mock

`build/plugins.ts` 中 `enableProd: true` 改为 `false`（dev 期间的 mock 保留，方便前端独立开发）。这是安全底线，防止假数据产物上线。

### 第二步：指定接口前缀

`src/utils/http/index.ts` 第 19-31 行的 `defaultConfig` 当前没有 baseURL，请求都是相对路径（`/login`、`/user`）。两种接法：

- 加 `baseURL: import.meta.env.VITE_API_BASE`，并在 `.env.production` 里新增 `VITE_API_BASE = https://api.example.com`；
- 或保持相对路径，用 `vite.config.ts` 第 27 行现成的 `proxy: {}` 配置 dev 代理，生产靠 Nginx 反代同域路径。

后者是本框架的设计意图（proxy 字段已预留且注释指向 Vite 文档），同域部署还能省掉 CORS 配置。

### 第三步：对齐认证接口

对照 `src/api/user.ts` 逐个核对：

| 接口 | 需要确认的点 |
| --- | --- |
| POST `/login` | 响应结构是否为 `{ code, data: { avatar, username, nickname, roles, permissions, accessToken, refreshToken, expires } }`；`expires` 是日期字符串还是时间戳（后者需按 `src/utils/auth.ts` 第 52 行注释调整类型） |
| POST `/refresh-token` | 是否接受 `{ refreshToken }` 入参，返回新 token 三元组 |
| GET `/mine`、`/mine-logs` | 账户设置页字段 |

若后端信封不是 `{ code: 0 }`，统一在 `src/utils/http/index.ts` 的响应拦截器（第 125-148 行）做一次映射，业务代码就不用动。

### 第四步：对齐动态路由

真实后端通常已有菜单接口，把它的返回映射成 `getAsyncRoutes` 期待的格式（第 04 篇有样本）。三条硬性要求：`path` 能匹配到 `src/views` 下的组件文件（或显式给 `component` 字符串）；`name` 全局唯一；`meta.roles` 与后端角色编码一致。映射逻辑建议写在 `src/api/routes.ts` 里保持侵入最小。

另一种常见诉求是"不用动态路由，全部走前端静态路由"。可行做法：让 `/get-async-routes` 返回空数组，菜单完全由 `src/router/modules/` 决定，权限仍靠静态路由上的 `meta.roles` 过滤（`filterNoPermissionTree` 对静态菜单同样生效）。中小项目这样更省事，代价是菜单调整要发前端版本。

### 第五步：替换或保留其余端点

按 `mock/system.ts` 的端点表逐个对齐。项目初期用不到字典、租户的，对应页面菜单直接在 `mock/asyncRoutes.ts`（或未来后端）里不发即可，前端代码无需删除。

### 验收

接入完成的验收标准：关闭 `enableProd` 后重新构建，`pnpm preview:build` 打开，用真实账号登录，逐个打开保留的菜单页无 404 与网络报错；DevTools Network 面板里所有请求指向真实域名。

## 常见坑

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 生产产物登录不了 | 关了 mock 但没接后端 | 按上面清单走完 |
| 刷新后 404 | 部署在子路径但 `VITE_PUBLIC_PATH` 没改 | `.env.production` 当前是 `/vue-pure-admin-max/`，按实际部署路径修改 |
| 登录成功但菜单空白 | 动态路由 `path` 匹配不到 views 组件 | 检查 path 与文件路径的包含关系（`addAsyncRoutes` 用 includes 匹配） |
| token 一直失效 | 后端 `expires` 单位是秒级时间戳，前端当毫秒解析 | 按 `src/utils/auth.ts` 第 52 行注释调整 |

## 下一步

- mock 拦截请求靠的是 axios 封装层的约定，下一章 [07 网络层 PureHttp](./07-http.md) 拆这个类的完整设计，包括第 05 篇埋的无感刷新队列实现。
- 动手实验：在 `mock/system.ts` 里搜 `/user` 端点，把返回的假用户名改成一个你认识的名字，到系统管理 → 用户管理页搜索验证。改的是假后端，页面一行没动，这就是 mock 体系的正确打开方式。
