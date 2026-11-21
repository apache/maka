# 05 认证与权限：双 token 与三套权限

> 本篇目标：讲清登录后令牌放在哪、过期怎么无感续期、三套权限各管什么。读完你能正确选用 `<Auth>` 和 `<Perms>`，接后端时知道认证要对接哪些点。

## 一句话定义

认证回答"你是谁"（token 机制），权限回答"你能干什么"（roles 管页面、permissions 和 auths 管按钮）。

类比小区门禁：人脸识别开门是认证（token），能进哪些楼栋是页面权限（roles），能开单元门还是只能按门铃是按钮权限（permissions/auths）。

## 双 token：为什么要两个

`src/utils/auth.ts` 的 `DataInfo` 接口定义了令牌的全部字段：

| 字段 | 用途 |
| --- | --- |
| `accessToken` | 调业务接口的通行证，过期时间短（如 2 小时） |
| `refreshToken` | 专门用来换新 accessToken 的凭证，过期时间长（如 30 天） |
| `expires` | accessToken 的过期时间戳 |

单 token 方案的痛点是：token 一过期用户就得重新登录，体验差；永不过期又不安全。双 token 把"高频使用"和"长期身份"拆开：accessToken 被盗损失窗口只有 2 小时，refreshToken 只出现在刷新接口里，泄露面小得多。

框架实现了**无感刷新**：accessToken 过期瞬间，前端自动用 refreshToken 换新并重放失败请求，用户全程无感知。实现细节在第 07 篇网络层讲。

## 三处存储，各司其职

登录成功后 `setToken()`（`src/utils/auth.ts` 第 48-116 行）把信息写入三个位置，这个设计初看很绕，其实每处都有明确分工：

| 存储位置 | 键名 | 存什么 | 为什么 |
| --- | --- | --- | --- |
| Cookie | `authorized-token` | accessToken、expires、refreshToken | 服务端可读；随过期时间自动销毁 |
| Cookie | `multiple-tabs` | 固定值 "true" | **会话存活标志**。不设 expires（或勾选记住登录后设 loginDay 天），浏览器关闭即销毁，实现"关浏览器就要重新登录" |
| localStorage | `user-info` | 头像、用户名、昵称、roles、permissions 等 | 容量大；刷新页面后 Pinia 从这里恢复状态 |

`getToken()` 的取值顺序体现了优先级：cookie 里有 `authorized-token` 就用它（最新鲜），否则回退 localStorage 的 `user-info`。

易错点：勾选登录页"记住我"影响的是 `multiple-tabs` 的有效期（`isRemembered` 与 `loginDay`，见 `src/store/modules/user.ts` 的 state），不是 accessToken 的有效期。 accessToken 到期照样要靠 refreshToken 续。

## 无感刷新的完整时序

```
业务请求 A → 拦截器发现 expires 已过期
  │
  ├─ isRefreshing = true（加锁）
  ├─ 发起 /refresh-token（带 refreshToken）
  │
  ├─ 此刻并发的请求 B、C 到来 → 发现 isRefreshing
  │    └─ 进入 requests 队列等待（Promise 挂起）
  │
  ├─ 刷新成功 → 拿到新 accessToken
  │    ├─ 放行请求 A（带新 token）
  │    └─ 遍历 requests 队列，B、C 带新 token 依次放行
  │
  └─ 刷新失败 → 清空队列 → logOut() → 提示"登录过期" → 跳登录页
```

加锁的必要性：没有锁，三个并发过期请求会发三次刷新，后两次用的 refreshToken 可能已作废，导致被误踢下线。

## 三套权限，别再混用

这是新手最困惑的地方。三套权限的字段来源、判断函数、组件各不相同：

| 维度 | 页面级 | 按钮级 A（Perms） | 按钮级 B（Auth） |
| --- | --- | --- | --- |
| 数据来源 | 登录返回的 `roles` | 登录返回的 `permissions` | 路由 `meta.auths` |
| 存放位置 | localStorage user-info | localStorage user-info | 路由表 |
| 判断函数 | 守卫与 `filterNoPermissionTree` | `hasPerms()`（`src/utils/auth.ts` 第 131 行） | `hasAuth()`（`src/router/utils.ts` 第 374 行） |
| 组件/指令 | 菜单自动过滤 | `<Perms>` / `v-perms` | `<Auth>` / `v-auth` |
| 通配符 | 无 | `*:*:*` 表示全部权限 | 无 |
| 适用场景 | 菜单与页面可见性 | 权限由用户账号决定的场景（主流 RBAC） | 权限跟着页面走的场景（同一页面不同入口不同权限） |

选型经验：绝大多数后台系统用 **页面 roles + 按钮 Perms** 两件套就够了。Auth 体系把权限声明放在路由上，适合"这个页面的编辑按钮只对从 XX 入口进来的人开放"这类少见的路由级差异化需求。两套并存时注意别对同一按钮既写 `v-perms` 又写 `v-auth`，排查权限问题时先确认按钮用的是哪一套。

`hasPerms` 的判断逻辑（`src/utils/auth.ts` 第 131-141 行）有三个分支：权限列表只有一个 `*:*:*` 直接放行；传字符串做 includes；传数组则要求**用户权限包含数组里所有项**（`isIncludeAllChildren`）。最后一个分支容易想反——是"全含"不是"任含"。

## 登录全流程串讲

把前面的机制串成一次完整登录（对照 `src/views/login/index.vue` 第 81-103 行的 `onLogin`）：

1. 表单校验通过，调 `useUserStoreHook().loginByUsername()`。
2. store 里走 `getLogin()`（`src/api/user.ts`，POST `/login`），成功则 `setToken(data.data)` 写三处存储。
3. 回到登录页，`await initRouter()` 拉动态路由并注册（第 04 篇的流程）。
4. `router.push(getTopMenu(true).path)` 跳到第一个菜单页，`getTopMenu` 取的是 permission store 里 `wholeMenus` 的第一项。
5. 之后的每个请求都被 `PureHttp` 请求拦截器附上 `Authorization: Bearer <accessToken>`，过期自动走刷新队列。

登出则相反：`logOut()` 清 store、`removeToken()` 清三处存储、`resetRouter()` 撤销动态路由、跳 `/login`（见 `src/store/modules/user.ts`）。

## 多租户与认证的关系

Max 版登录页多了租户输入框（`src/views/login/index.vue` 第 230 行起，受 `.env` 的 `VITE_ENABLE_TENANT` 控制）。当前 mock 实现里租户字段**只采集不校验**——`onLogin` 提交的 payload 只有 `username` 和 `password`。它是一个占位能力：真实后端接入时，把租户字段加进登录请求体，由后端做租户隔离即可，前端表单层已经就绪。

## 接真实后端时要动的清单

先给结论，细节在第 06 篇展开：

| 改动点 | 文件 |
| --- | --- |
| 登录、刷新 token 接口的真实地址与出入参 | `src/api/user.ts` |
| token 存储结构（如后端直接给时间戳，`setToken` 第 52 行有注释说明改法） | `src/utils/auth.ts` |
| 动态路由接口 | `src/api/routes.ts` + `mock/asyncRoutes.ts` 对照改造 |
| 请求 baseURL 与代理 | `src/utils/http/index.ts` 的 `defaultConfig` + `vite.config.ts` 的 `server.proxy` |

## 下一步

- 无感刷新的队列实现在网络层，下一章 [06 Mock 体系](./06-mock.md) 先讲清"后端"是怎么被模拟的，再讲怎么换成真的。
- 动手实验：在浏览器 DevTools 里把 localStorage 的 `user-info` 中 `roles` 改为 `["common"]` 后刷新页面，菜单会按 common 角色收缩——因为菜单过滤每次刷新都从 localStorage 读 roles（`src/router/utils.ts` 第 85-95 行）。这能直观验证权限数据的真身就是这份 JSON。
