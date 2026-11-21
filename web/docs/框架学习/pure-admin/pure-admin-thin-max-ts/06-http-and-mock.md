# 06 HTTP 封装与 mock 后端：十个接口撑起一个系统

本篇你会搞懂三件事：

1. PureHttp 封装的结构，业务代码怎么发请求。
2. mock 后端的工作原理，以及 `enableProd: true` 这个埋在构建配置里的关键开关。
3. 对接真实后端的完整动作清单。

## 一句话定义

数据层只有两个角色：`src/utils/http/index.ts` 的 PureHttp 是"唯一的快递员"（所有请求都经它发，token、超时、序列化统一处理），`mock/` 目录是"自家后院搭的假仓库"（四个文件模拟后端全部接口）。类比：快递员只认地址和包裹，不关心仓库是真的还是假的——所以真后端就位时，换仓库不换快递员。

## PureHttp 的结构

`src/utils/http/index.ts` 用 class 组织了四类静态成员，最后导出单例 `http`：

```
PureHttp
├── axiosInstance        # Axios.create(defaultConfig) 创建的实例
├── requests             # token 刷新期间挂起的请求队列（第 04 篇讲过）
├── isRefreshing         # 刷新单飞锁
└── request/get/post     # 对外工具函数
```

默认配置（`src/utils/http/index.ts:18-30`）：超时 10 秒；`Content-Type: application/json`；数组参数用 `qs.stringify` 序列化（规避 axios 对数组的默认序列化问题，源码里给了 issue 链接）。

响应拦截器只做一件事：把 `response.data` 直接返回，所以业务代码里 `const { data } = await getDictTree()` 拿到的已经是后端 body。拦截器还支持请求级回调 `beforeRequestCallback`/`beforeResponseCallback`，单个请求想临时插逻辑时用，优先级高于全局。

业务侧的标准写法（`src/api/system.ts`）：

```ts
export const getDictDetail = (data?: object) => {
  return http.request<ResultTable>("post", "/dict-detail", { data });
};
```

url 不带域名——dev 环境是同源请求，由 vite 的 dev server 接住交给 fake-server；需要跨域转发时在 `vite.config.ts:27` 的 `proxy: {}` 里配。

## 接口全景

三个 api 文件共 10 个函数，就是整个系统对后端的全部期待：

| 函数 | 方法与 url | 用途 |
| --- | --- | --- |
| `getLogin` | POST `/login` | 登录，返回 token 与用户信息 |
| `refreshTokenApi` | POST `/refresh-token` | 无感刷新 token |
| `getAsyncRoutes` | GET `/get-async-routes` | 拉取动态菜单 |
| `getDictTree` | GET `/dict-tree` | 字典管理左侧树 |
| `getDictDetail` | POST `/dict-detail` | 按 dictId 查字典详情（分页） |
| `getTenantList` | POST `/tenant-list` | 租户列表（分页） |
| `getTenantPackage` | POST `/tenant-package` | 租户套餐列表（分页） |
| `getTenantPackageMenu` | POST `/tenant-package-menu` | 套餐的菜单权限树 |
| `getTenantPackageMenuIds` | POST `/tenant-package-menu-ids` | 按套餐 id 查已勾选菜单 |
| `getTenantPackageSimple` | GET `/tenant-package-simple` | 套餐下拉（不分页） |

统一响应结构两种：`Result`（`{code, message, data}`）和 `ResultTable`（data 里是 `{list, total, pageSize, currentPage}` 分页结构），定义在 `src/api/system.ts:3-22`。成功码约定 `code === 0`。

## mock 后端

实现是 `vite-plugin-fake-server`，四个 mock 文件各自定义一批 `url + method + response`：

| 文件 | 模拟内容 |
| --- | --- |
| `mock/login.ts` | 两种账号身份，不校验密码，token 过期时间 2030 年 |
| `mock/refreshToken.ts` | 永远成功的新 token（除非缺 refreshToken 参数，返回 code 10001） |
| `mock/asyncRoutes.ts` | 权限、排班、字典、租户四组菜单，含 roles 声明 |
| `mock/system.ts` | 410 行字典与租户数据，`/tenant-package` 还演示了按 name/status 的内存过滤 |

### enableProd: true，本篇最重要的一个开关

`build/plugins.ts:43-48`：

```ts
vitePluginFakeServer({
  logger: false,
  include: "mock",
  infixName: false,
  enableProd: true
})
```

`enableProd: true` 意味着 **mock 在生产构建里也生效**。`pnpm build` 出的 dist 直接打开，所有接口照样有数据——演示方便，但对接真实后端时会出现灵异现象：后端没实现的接口被 mock"抢答"，你以为联调通了其实数据是假的。**接真实后端前把它改为 false（或删除该插件）**，让该失败的请求真实地失败。

顺带说明 mock 的机制：它在浏览器端劫持 XHR/fetch，所以 Network 面板里请求"看起来发出去过"，Response 也正常返回——排查"这数据哪来的"时先看请求是否命中了 mock。

## 对接真实后端的动作清单

按顺序执行：

1. **关 mock**：`build/plugins.ts` 的 `enableProd` 改为 `false`。
2. **配代理或 baseURL**：后端跨域时在 `vite.config.ts` 的 `proxy` 配置转发；或在 `defaultConfig` 里给 axios 实例加 `baseURL`。
3. **对响应结构**：后端若不是 `{code: 0, message, data}` 结构，改 `src/api/` 下的类型和各调用处的判断（搜索 `code === 0`）。
4. **对分页结构**：`ResultTable` 的 `list/total/pageSize/currentPage` 四个字段名与后端对齐，改字段名最小成本的位置是 api 层做一次映射。
5. **认证适配**：按第 04 篇末尾的清单处理 expires 格式、登出接口、Bearer 前缀。
6. **菜单接口**：`/get-async-routes` 的返回结构对照 `mock/asyncRoutes.ts`，字段含义见第 03 篇 `addAsyncRoutes` 的五步处理。

## 自检清单

1. 生产构建里 mock 还活着吗？由哪个配置项决定？
2. 为什么业务代码里 `await getLogin()` 拿到的直接是 body，不需要 `.data.data`？
3. 联调时"接口时好时坏"（有的接口走真后端、有的返回假数据），最可能的原因是什么？

下一篇 [07 业务模块精读](./07-business-modules.md)。
