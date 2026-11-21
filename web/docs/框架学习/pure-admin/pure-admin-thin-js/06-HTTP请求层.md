# 06 - HTTP 请求层

本章结论：全站请求走 `src/utils/http/index.js` 导出的单例 `http`，它是 axios 的薄封装，职责有三：自动带 token、token 过期自动刷新并重放（第 05 篇讲过）、统一错误出口。业务代码只需要记住 `http.request`、`http.get`、`http.post` 三个入口和 `src/api/*.js` 的组织方式。

## PureHttp 的结构

`PureHttp` 类把所有可变状态做成静态属性，实例化即完成两个拦截器的注册，最后导出单例：

```js
export const http = new PureHttp();
```

默认配置（`defaultConfig`）：超时 10 秒，JSON 头，数组参数用 `qs.stringify` 序列化（规避 axios 已知的数组序列化问题，注释里附了 issue 链接）。没有配 `baseURL`，所有接口都是相对路径，这一点在第 10 篇联调时很重要。

## 请求拦截器的决策树

每次请求发出前，拦截器按顺序问四个问题：

1. 这次请求单独传了 `beforeRequestCallback` 吗？传了就只执行回调跳过后续逻辑（临时请求的逃生通道）。
2. URL 在白名单里吗（以 `/refresh-token` 或 `/login` 结尾）？在就直接放行。
3. 有 token 且未过期？带上 `Authorization: Bearer xxx` 放行。
4. token 过期？走无感刷新流程（详见第 05 篇），当前请求挂进队列等待重放。

响应拦截器做的事很克制：把 `response.data` 解出来直接返回（业务方拿到的就是后端的 `{code, message, data}` 结构），错误时给 error 对象打上 `isCancelRequest` 标记再继续 reject，方便业务区分"主动取消"和"真失败"。

## 业务侧的标准写法

接口定义集中在 `src/api/`，按业务域拆文件。现有两个文件就是两个标准模板：

```js
// src/api/user.js —— 表单类接口的写法
export const getLogin = data => {
  return http.request("post", "/login", { data });
};

// src/api/routes.js —— 查询类接口的写法
export const getAsyncRoutes = () => {
  return http.request("get", "/get-async-routes");
};
```

新增一个业务接口的步骤，以"知识库列表"为例：

```js
// src/api/knowledge.js 新建
import { http } from "@/utils/http";

/** 知识库列表（分页） */
export const getKnowledgeList = (params) => {
  return http.request("get", "/knowledge-list", { params });
};

/** 新建知识条目 */
export const addKnowledge = data => {
  return http.request("post", "/add-knowledge", { data });
};
```

页面里调用时注意响应结构：拦截器解过一层，所以 `res` 直接就是 `{code, message, data}`，取列表数据写 `res.data`。

## 临时回调与全局回调

`beforeRequestCallback` / `beforeResponseCallback` 有两个生效层级，请求级优先于全局级：

```js
// 请求级：只影响这一次
http.request("get", "/export", {}, {
  beforeRequestCallback() { loading.value = true; }
});
```

全局级通过 `PureHttp.initConfig` 设置，目前模板没有使用它。上传下载、进度条这类场景用请求级回调足够。

## 错误处理现状与补强建议

模板把错误处理的自由留给了业务层，拦截器只做标记不弹提示（登录过期那个提示是刷新失败分支特例）。也就是说，接口 500 时页面不会自动弹任何东西。团队接入真实后端后，建议在响应拦截器的 error 分支按 HTTP 状态码统一弹 message（401 跳登录、403 提示无权、500 提示稍后重试），只在 `isCancelRequest` 为真时静默。这一处是二次开发中最高频的改造点之一。

## 常见误解纠偏

**误解一：要在每个请求里手动带 token。** 拦截器全包了，手动加 `Authorization` 反而会在无感刷新时被队列重放机制覆盖掉。

**误解二：业务代码里要处理 token 过期。** 过期刷新、排队重放、失败登出都在拦截器里闭环了，业务层永远只看到"请求成功"或"请求失败"。

**误解三：`http.get` 和 `http.request("get")` 行为不同。** 只是参数位置的语法糖，最终都走 `request` 方法。

## 自检清单

1. 业务方拿到的响应和 axios 原始响应差了一层什么？
2. 新增接口文件应该放在哪？参照哪两个现有文件？
3. 哪两类 URL 不需要 token？为什么？
4. 接口报 500 时用户会看到什么？如果要统一弹提示应该改哪里？
5. `isCancelRequest` 标记是怎么来的？什么场景下用得上？

下一篇转向状态管理：Pinia 模块怎么组织、为什么每个 store 都配了一个 Hook 函数。
