# 10 - Mock 与真实后端联调

本章结论：mock 由 vite-plugin-fake-server 实现，拦截层在 dev server 和生产构建产物里都生效（`enableProd: true`），部署真实环境前必须处理这个开关。切换真实后端的改动点有三处：mock 开关、请求代理、接口路径。

## mock 的工作机制

mock 文件放在 `mock/` 目录，每个文件用 `defineFakeRoute` 导出路由数组，插件会把这些定义注册成真实的 HTTP 端点：

```js
// mock/login.js 的结构
export default defineFakeRoute([
  {
    url: "/login",            // 请求路径
    method: "post",           // 请求方法
    response: ({ body }) => { // body 是请求体
      return { code: 0, message: "操作成功", data: { ... } };
    }
  }
]);
```

现有三个 mock 文件与后端契约的关系：

| 文件 | 端点 | 定义的契约 |
| --- | --- | --- |
| `mock/login.js` | POST `/login` | 入参 `{username, password}`；出参 `data` 内含 `avatar`、`username`、`nickname`、`roles`、`permissions`、`accessToken`、`refreshToken`、`expires` |
| `mock/refreshToken.js` | POST `/refresh-token` | 入参 `{refreshToken}`；校验失败返回 `code: 10001` |
| `mock/asyncRoutes.js` | GET `/get-async-routes` | 出参 `data` 是路由树数组，`component` 为 views 下的路径字符串 |

这三个文件就是模板定义的前后端接口契约。后端照着实现，前端零改动切换，这是本模板联调设计的核心思路。

## 最重要的一个坑：生产环境 mock 默认开启

`build/plugins.js` 里 fake server 的配置是：

```js
vitePluginFakeServer({
  logger: false,
  include: "mock",
  infixName: false,
  enableProd: true   // 生产构建也启用 mock
})
```

`enableProd: true` 意味着 `pnpm build` 出来的产物里，`/login` 等请求仍然被 mock 拦截。直接把这个产物部署上线，接了真实后端也不会生效，而且任何人用 `admin/admin123` 就能登进系统。**这个仓库交付时 mock 就是开着的，接真实后端后部署前必须把它关掉**（改为 `false` 或直接移除该插件），并把这个检查写进上线清单。

## 切换真实后端的三步

**第一步，关 mock。** 如上，改 `build/plugins.js` 的 `enableProd`。开发期想保留 mock 就只在部署构建时关，或者干脆删掉 vitePluginFakeServer 那一段，让开发环境也直连后端。

**第二步，配代理。** `vite.config.js` 里 `server.proxy` 目前是空对象。开发环境跨域就在这里加：

```js
server: {
  proxy: {
    "/api": {
      target: "http://your-backend:8080",
      changeOrigin: true,
      rewrite: path => path.replace(/^\/api/, "")
    }
  }
}
```

生产环境的跨域由 Nginx 处理（第 11 篇），与这里的开发代理无关。

**第三步，对齐接口路径。** `src/utils/http/index.js` 没有配 `baseURL`，所有接口都是 `/login` 这样的根路径。两种对齐方式：后端按现有路径实现（路径风格是 kebab-case 动词短语）；或者给 axios 实例加 `baseURL` 统一加前缀（改 `defaultConfig` 一处即可），再配合代理转发。

## 环境变量速查

`.env` 系列文件控制构建行为，改动后需要重启 dev server 或重新构建：

| 变量 | 文件 | 作用 |
| --- | --- | --- |
| `VITE_PORT` | `.env` | dev 端口 8848 |
| `VITE_HIDE_HOME` | `.env` | 隐藏首页菜单（守卫会同步拦截 `/welcome`） |
| `VITE_PUBLIC_PATH` | `.env.development` / `.env.production` | 部署子路径，默认 `/` |
| `VITE_ROUTER_HISTORY` | 各环境 | `hash` 或 `h5`，支持逗号后跟 base |
| `VITE_CDN` | `.env.production` | 构建时用 CDN 替换本地大依赖 |
| `VITE_COMPRESSION` | `.env.production` | 构建压缩：`gzip`、`brotli`、`both` 及 `-clear` 变体 |

## 常见误解纠偏

**误解一：mock 只在开发环境有用。** 本仓库恰恰相反，`enableProd: true` 让 mock 跟着上了生产。第 01 篇说的"密码不校验、token 写死 2030 年"，在开着 mock 的生产产物里全部成立，安全风险真实存在。

**误解二：改 mock 文件需要重启。** vite-plugin-fake-server 支持热更新，改 `response` 返回值保存即生效。改 `url` 或 `method` 这类路由定义才需要重启。

**误解三：接后端要大改前端。** 契约一致时前端零改动；有出入时改动通常集中在 `src/api/` 的路径参数和响应字段映射，鉴权、刷新、路由这些机制层完全不用碰。

## 自检清单

1. 后端要提供哪三个接口才能让登录、鉴权、动态路由全部工作？各自的入参出参是什么？
2. `enableProd` 现在是什么值？直接部署会有什么后果？
3. 开发环境跨域在哪配？生产环境跨域在哪配？
4. 想让所有接口带上 `/api` 前缀，最小改动是什么？
5. `expires` 字段后端打算返回时间戳，前端哪一行要跟着改？（提示：第 05 篇）

下一篇进入工程化：构建、规范与部署。
