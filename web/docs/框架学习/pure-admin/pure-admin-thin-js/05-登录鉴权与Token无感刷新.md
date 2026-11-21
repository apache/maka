# 05 - 登录鉴权与 Token 无感刷新

本章结论：登录后凭证分散在三处存储，各司其职；token 过期后由 HTTP 拦截器自动换取新 token 并重放失败的请求，用户全程无感。核心代码集中在 `src/utils/auth.js`、`src/utils/http/index.js` 和 `src/store/modules/user.js` 三个文件。

## 登录时发生了什么

从点击登录按钮开始，完整时序如下（对照 `src/views/login/index.vue` 的 `onLogin`）：

1. 表单校验通过，调 user store 的 `loginByUsername`（`src/store/modules/user.js`）。
2. store 调 `src/api/user.js` 的 `getLogin`，POST `/login`。mock（`mock/login.js`）只看用户名：`admin` 返回 admin 角色，其他任何用户名返回 common 角色，**密码根本不校验**，接真实后端后这里由服务端把关。
3. 响应 `code === 0` 时调 `setToken(data)`（`src/utils/auth.js`）落盘，见下节。
4. 回到登录页，`await initRouter()` 拉动态路由（第 03 篇讲过）。
5. `router.push(getTopMenu(true).path)` 跳到第一个菜单，弹出"登录成功"。

请求防抖也在这里：Enter 键触发的登录用 `debounce(fn, 1000, true)` 包装，连按回车只发一次。

## 三把钥匙：凭证存储模型

`setToken` 把登录数据拆成三份存放，各有各的生命周期。这是整个鉴权体系最值得背下来的设计。

| 存储 | 键名 | 内容 | 生命周期 | 职责 |
| --- | --- | --- | --- | --- |
| Cookie | `authorized-token` | `accessToken`、`expires`、`refreshToken` | 随 accessToken 过期时间自动销毁 | 请求鉴权凭证 |
| Cookie | `multiple-tabs` | 固定值 `"true"` | 会话级，浏览器完全关闭即销毁；勾选"记住登录"则存 `loginDay` 天（默认 7） | 判断"是否已登录" |
| localStorage | `user-info` | `avatar`、`username`、`nickname`、`roles`、`permissions`、`refreshToken`、`expires` | 手动清理 | 用户信息与角色权限 |

这样拆的理由：token 需要自动过期所以放 cookie；"关浏览器就要重新登录"的语义靠会话级 cookie 实现；用户信息需要跨页面同步进 Pinia 初始值（user store 的 state 初始值直接从 `user-info` 读），所以放 localStorage。

`getToken()` 的读取顺序是先 cookie 后 localStorage：cookie 被浏览器清掉但 localStorage 还在时，仍能拿到一份旧凭证走刷新流程。登出时 `removeToken()` 把三个键全部清掉。

## 无感刷新：拦截器里的接力赛

`src/utils/http/index.js` 的请求拦截器在每次请求前检查 token 余量，流程如下：

1. 白名单请求（URL 以 `/refresh-token` 或 `/login` 结尾）直接放行，避免刷新请求自己触发刷新造成死循环。
2. `getToken()` 拿不到凭证，放行（由后端接口返回 401 处理）。
3. `expires - now > 0`，token 有效，直接带上 `Authorization: Bearer xxx` 放行。
4. 已过期：用静态标志 `isRefreshing` 抢锁。抢到锁的那个请求去调 `handRefreshToken`（POST `/refresh-token`），其余过期期间的请求进入 `requests` 队列挂起。
5. 刷新成功：新 token 发给队列里所有等待的回调，它们补上新的 `Authorization` 后继续放行，原请求重放，用户无感。
6. 刷新失败：清空队列，`logOut()` 登出，弹出"登录已过期，请重新登录"。

接真实后端时的一个关键适配点写在 `mock/refreshToken.js` 的注释里：mock 的 `expires` 用日期字符串方便调试，如果后端返回的是时间戳，需要把 `src/utils/auth.js` 里 `setToken` 的 `new Date(data.expires).getTime()` 改成直接赋值 `expires = data.expires`。这个注释是模板作者留给接后端的人的路标，改的时候顺便确认后端每次刷新返回的过期时间都在递增。

## 登出与多标签页

`logOut()`（user store）是纯前端登出，不调后端接口：清空 store、删三把钥匙、把标签页重置回初始集合 `routerArrays`、`resetRouter()` 重建路由表、跳登录页。**接真实后端时通常需要在这里补一个"通知服务端销毁 token"的接口调用**，否则服务端 token 依然有效。

多标签页共享登录靠 `multiple-tabs` 这个会话 cookie：cookie 的特性决定同一浏览器的所有标签页天然共享，所以开第二个标签页访问系统不需要重新登录；浏览器完全关闭后 cookie 销毁，下次打开必须重新登录。这就是它的键名叫 multiple-tabs 的原因，它存在的意义就是配合浏览器 cookie 生命周期实现"关浏览器即登出"。

## 常见误解纠偏

**误解一：token 存 localStorage 就够了。** 模板刻意拆成 cookie 加 localStorage 两份，因为两者生命周期不同。只存一份，要么失去"关浏览器重登"，要么失去 cookie 的自动过期。

**误解二：无感刷新是定时器轮询。** 模板没有定时器，刷新发生在"请求发现自己带着过期 token"的那一刻，惰性触发。没有请求就没有刷新，简单且省心。

**误解三：登录失败的提示来自后端。** 登录页 catch 里统一弹"登录失败"，后端的 `message` 字段没有展示。需要透出后端错误文案的话，改 `src/views/login/index.vue` 的 catch 分支。

## 自检清单

1. 登录后三把钥匙分别存在哪？各自的生命周期和职责是什么？
2. 为什么 `/refresh-token` 和 `/login` 要放进请求白名单？
3. 并发十个请求都撞上 token 过期，会发生几次刷新请求？其余请求的命运是什么？
4. 后端返回时间戳格式的 expires，前端要改哪个文件的哪一行？
5. 勾选"记住登录"七天，实际改变的是哪个 cookie 的什么属性？

下一篇看这些 token 是怎么被装进每一个请求里的：HTTP 请求层。
