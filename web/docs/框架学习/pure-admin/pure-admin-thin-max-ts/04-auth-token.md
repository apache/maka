# 04 认证与无感刷新：双 Cookie 设计与 token 队列

本篇你会搞懂三件事：

1. 为什么凭证要拆成 Cookie 两份加 localStorage 一份，各自管什么。
2. accessToken 过期那一刻，并发请求如何被"无感"地补发。
3. 登出到底做了什么，接真实后端时要补哪一块。

## 一句话定义

认证模块把凭证拆成三种寿命：accessToken 是"两小时门禁卡"（短命，随身带），refreshToken 是"补卡凭证"（长命，只在补卡时出示），`multiple-tabs` Cookie 是"前台登记表"（浏览器关了就销毁，代表"这个浏览器登录过"）。类比酒店：门禁卡过期了没关系，凭押金单（refreshToken）去前台免费续一张，你正在去的各个房间（并发请求）由门童统一拿着新卡代刷，你完全无感。

## 凭证的存放位置

`src/utils/auth.ts` 定义了三把 key：

| key | 位置 | 存什么 | 寿命 |
| --- | --- | --- | --- |
| `authorized-token`（`TokenKey`） | Cookie | `{accessToken, expires, refreshToken}` 三件套 | 按 expires 时间设置 Cookie 过期，到期浏览器自动销毁 |
| `user-info`（`userKey`） | localStorage | refreshToken、expires、avatar、username、nickname、roles、permissions 七项 | 持久 |
| `multiple-tabs`（`multipleTabsKey`） | Cookie | 固定值 `"true"` | 勾选免登录时按 `loginDay`（默认 7 天）设置，否则会话级，关浏览器即销毁 |

为什么要拆这么细，各有用途：

- `multiple-tabs` 是"是否登录"的快速判断位（`src/router/index.ts:150` 守卫第一条件）。不勾免登录时它是会话级 Cookie，浏览器重开就要重新登录，行为符合直觉。
- `authorized-token` 跟随 accessToken 同寿命，过期即被浏览器清理，`getToken()`（`src/utils/auth.ts:35`）读不到它时回落读 localStorage 的 `user-info`。
- roles 和 permissions 放 localStorage 而不是 Cookie，是因为守卫和权限组件高频读取，且不需要随 token 一起销毁——刷新页面时用户信息还在，菜单和权限不用重新拉。

`setToken`（`src/utils/auth.ts:48`）是唯一的写入口，登录成功和刷新 token 成功都走它。注意第 52 行的注释：后端若直接返回时间戳，把 `expires = new Date(data.expires).getTime()` 改成 `expires = data.expires` 即可，这是对接真实后端的第一处适配点。

## 无感刷新：请求队列与单飞锁

核心逻辑在 `src/utils/http/index.ts:61-121` 的请求拦截器里，时序如下：

```
请求 A 进入拦截器
  → url 以 /login 或 /refresh-token 结尾？→ 直接放行（白名单，防死循环）
  → 读 getToken()
      → 没 token → 放行（登录接口本身就需要无 token）
      → expires 未过期 → 挂上 Authorization: Bearer xxx 放行
      → 已过期：
          isRefreshing === false？
            → 加锁 isRefreshing = true
            → 调 /refresh-token
              → 成功：setToken 写新凭证 → 用新 token 重放当前请求
                     → 遍历队列 requests，逐个用新 token 放行 → 清队列 → 解锁
              → 失败：清队列 → logOut → 提示"登录已过期，请重新登录"
          isRefreshing === true（刷新已在进行）？
            → 把请求包装成回调推进 PureHttp.requests 队列，挂起等待
```

三个设计点值得记住：

1. **单飞锁 `isRefreshing`**：并发十个请求同时发现 token 过期，只有第一个触发刷新请求，其余全部入队等待，避免刷新接口被打爆或新旧 token 交叉使用。
2. **白名单用 `endsWith` 匹配**（`src/utils/http/index.ts:75`）：`/refresh-token` 和 `/login` 不带 token 也不触发刷新，否则"token 过期 → 刷新失败 → 又带着过期 token 刷新"会无限循环。
3. **刷新失败的处理是登出而不是重试**：`catch` 分支清空队列并强制登出。refreshToken 也是短命的（只是比 accessToken 长），它失效意味着用户确实需要重新认证。

想亲眼看到这套机制运转：把 `mock/login.ts` 返回的 `expires` 改成一个几分钟后的时间，登录后随便点几个页面，观察 Network 面板里 `/refresh-token` 先行、后续请求重放的过程。mock 的默认值是 2030 年（`mock/login.ts:23`），所以平时永远走不到刷新分支。

## 登录与登出

登录动作在 `src/store/modules/user.ts:67` 的 `loginByUsername`：调 `/login`，`code === 0` 就 `setToken` 落盘。登录页的"免登录"勾选控制的是 `isRemembered`/`loginDay` 两个 state（同样在 user store），最终影响 `multiple-tabs` Cookie 的有效期。

登出（`src/store/modules/user.ts:84` 的 `logOut`）是**纯前端动作**：清空 store 里的用户字段 → `removeToken()` 删两个 Cookie 加 localStorage → 重置标签页 → `resetRouter()` 清动态路由 → 跳 `/login`。**它不调用任何后端接口**，服务端的 token 依然有效直到自然过期。对接真实后端时，如果服务端需要使 token 失效（比如防泄漏），要在这里补一个登出接口调用——`src/api/user.ts` 目前只有 `getLogin` 和 `refreshTokenApi` 两个函数。

## 新手容易搞混的两件事

1. **"为什么我手动删了 localStorage 的 user-info，系统还认为我登录着？"** 守卫判断登录看的是 `multiple-tabs` Cookie 和 user-info 两项同时存在（`src/router/index.ts:150`），只删其一不彻底。完整的登出请走界面上的退出登录，它会三个存储一起清。
2. **"刷新 token 接口返回的 expires 是 2030 年，那 refreshToken 永远有效？"** mock 如此，仅为了调试方便（`mock/refreshToken.ts` 注释里写明了）。真实后端应当让 refreshToken 的过期时间明显长于 accessToken（比如 30 天对 2 小时），前端逻辑不用改，但安全策略由后端保证。

## 对接真实后端的认证适配清单

| 适配点 | 位置 |
| --- | --- |
| expires 改为时间戳格式 | `src/utils/auth.ts:52` |
| 登录/刷新接口的 url 与出入参字段 | `src/api/user.ts` + `mock/login.ts` 对照 |
| 补服务端登出接口 | `src/store/modules/user.ts:84` 的 `logOut` |
| token 放 header 的格式（当前 `Bearer ` 前缀） | `src/utils/auth.ts:126` |
| 响应码约定（当前以 `code === 0` 为成功） | `src/store/modules/user.ts:71`、各 api 调用处 |

## 自检清单

1. accessToken、refreshToken、multiple-tabs Cookie 各自的寿命和销毁时机是什么？
2. 并发 10 个请求遇到 token 过期，实际会发出几次刷新请求？其余请求的命运是什么？
3. 为什么 `/login` 必须出现在请求拦截器的白名单里？

下一篇 [05 权限体系](./05-permissions.md)。
