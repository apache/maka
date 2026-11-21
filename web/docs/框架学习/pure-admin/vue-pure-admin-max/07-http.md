# 07 网络层：PureHttp 封装

> 本篇目标：拆解 `src/utils/http/index.ts` 这 197 行的类设计，讲清拦截器如何注入 token、无感刷新队列如何实现、业务代码怎么正确发起请求。第 05 篇埋的"无感"伏笔在这章兑现。

## 一句话定义

PureHttp 是对 axios 的类封装：出口只有 `request`、`get`、`post` 三个方法，所有认证逻辑藏在请求拦截器里，业务代码只管发请求。

类比前台总机：员工（业务代码）只需说"帮我接 X 部门"（调 `http.get("/user")`），报工号（token）、工号过期自动续（刷新队列）、接线失败登记（错误处理）都是总机（拦截器）的事。

## 类结构总览

`src/utils/http/index.ts` 共 197 行，成员如下：

| 成员 | 类型 | 职责 |
| --- | --- | --- |
| `defaultConfig` | 模块常量 | 超时 10 秒、JSON 头、qs 序列化数组参数 |
| `axiosInstance` | 静态属性 | 真正的 axios 实例 |
| `requests` | 静态属性 | token 刷新期间暂存的请求回调队列 |
| `isRefreshing` | 静态属性 | 刷新锁，防止并发刷新 |
| `retryOriginalRequest` | 静态方法 | 把等待中的请求包装成 Promise，等新 token 后重放 |
| `httpInterceptorsRequest` | 实例方法 | 请求拦截：注入 Authorization |
| `httpInterceptorsResponse` | 实例方法 | 响应拦截：剥离 axios 包装，直接返回 data |
| `request` / `get` / `post` | 实例方法 | 业务出口 |

文件末尾 `export const http = new PureHttp()`，全框架共享这一个实例。`src/api/` 下 5 个文件全部通过 `http.request<T>(method, url, config)` 调用，泛型参数保证响应类型可推导（如 `http.request<UserResult>("post", "/login")`）。

## 请求拦截器：token 注入与刷新队列

拦截器主体在 `src/utils/http/index.ts` 第 63-117 行，逻辑分四层：

**第一层，回调短路。** 单次请求可传 `beforeRequestCallback`，传了就跳过后续逻辑直接发出，用于登录、刷新这类不想带 token 的请求。

**第二层，白名单。** 第 75 行定义 `const whiteList = ["/refresh-token", "/login"]`。这两个 URL 不带 token。设计意图写在注释里：防止 token 过期后请求刷新接口、刷新接口又因带过期 token 触发刷新的死循环。

**第三层，未过期路径。** 读 `getToken()`，`parseInt(data.expires) - now <= 0` 判断过期。未过期直接 `config.headers["Authorization"] = formatToken(data.accessToken)` 放行，`formatToken` 就是加 `Bearer ` 前缀（`src/utils/auth.ts` 第 126-128 行）。

**第四层，过期路径（无感刷新核心）。** 过期时检查刷新锁：

- 锁空闲：上锁，调 `useUserStoreHook().handRefreshToken({ refreshToken })` 发起刷新。成功则把新 token 注入当前请求、遍历 `requests` 队列逐个放行、清队列、解锁。失败则清队列、`logOut()`、弹"登录过期"提示、解锁。
- 锁被占：`resolve(PureHttp.retryOriginalRequest(config))`，把当前请求塞进队列挂起。`retryOriginalRequest`（第 52-59 行）返回一个 Promise：往队列里推一个回调，等刷新成功后有人拿着新 token 来调用它，这个请求才 resolve 出去。

这里有两个实现细节值得学：

1. **队列存的是"注入动作"而非请求本身**。队列元素是 `(token) => { config.headers.Authorization = ...; resolve(config) }`。刷新完成后 axios 还没真正发出这些请求，只是把 header 补上了——所以叫"重放"其实是"延迟发出"，天然不会重复请求。
2. **锁的释放放 `finally`**。刷新成功失败都解锁，失败路径同时清空队列，否则队列里的 Promise 永远挂起，内存泄漏加界面卡死。

## 响应拦截器：只做剥离

响应拦截器（第 125-148 行）比请求端简单得多：有 `beforeResponseCallback` 就回调，没有就 `return response.data`。也就是说业务代码拿到的直接是后端信封 `{ code, message, data }`，不是 axios 的 `AxiosResponse`。

注意它**没有做错误统一弹窗和 code 非零统一处理**。HTTP 层面的失败（网络错、超时）走 `Promise.reject($error)`，`$error.isCancelRequest` 标记是否为主动取消。code 非零（业务失败）需要各调用处自行判断，这是接真实后端时最常加逻辑的地方（第 06 篇第三步提到的响应映射就落在这里）。

## 业务侧的正确用法

### 标准姿势

以 `src/api/user.ts` 为范本：

```ts
export const getLogin = (data?: object) => {
  return http.request<UserResult>("post", "/login", { data });
};
```

要点三条：接口调用集中在 `src/api/`，页面不直接 import http；每个接口导出一个语义化函数；响应类型写全（`UserResult` 里 `data` 的每个字段都有注释），后端改字段时 TS 编译期就能发现。

### get 请求的参数

`http.request("get", url, { params })`，params 里的数组由 `defaultConfig.paramsSerializer` 用 qs 序列化（第 27-30 行），规避了 axios 原生数组序列化的兼容问题（axios issue #5142，源码注释有链接）。

### 需要跳过认证的请求

单次跳过用 `beforeRequestCallback: () => {}` 传一个空回调即可短路拦截器；全局性的免认证前缀建议维护白名单数组而不是散落空回调。

### 上传与下载

框架对上传没有额外封装，走 axios 原生能力：`http.request("post", url, { data: formData, headers: { "Content-Type": "multipart/form-data" } })`。下载大文件建议绕开 http 实例直接用 axios 实例并加 `responseType: "blob"` 与更长超时，因为 `defaultConfig` 的 10 秒超时对文件接口偏紧。

## 常见坑

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 刷新接口死循环 | 后端刷新接口路径不以 `/refresh-token` 结尾 | 白名单按 `endsWith` 匹配（第 76 行），路径需对齐或在白名单补真实路径 |
| 接口偶发 401 后被登出 | refreshToken 也过期了 | 预期行为；产品层面可把 refreshToken 时效加长 |
| 并发请求只发出一个 | 业务侧误把同一请求对象复用传入队列 | 每次请求传新 config 对象 |
| 生产环境请求 404 | 相对路径没配反代或 baseURL | 见第 06 篇第二步 |

## 下一步

- 请求层讲完了，下一章 [08 布局与主题](./08-layout-theme.md) 看用户每天盯着的那张"壳"是怎么组装和换肤的。
- 动手实验：在 `src/utils/http/index.ts` 第 75 行白名单里临时加入 `/user`，然后到用户管理页刷新列表，会发现请求头里没有 Authorization（mock 不校验所以照样返回）。再把白名单还原。这一分钟能帮你彻底理解白名单的作用位置。
