# 04 路由体系：静态与动态双轨制

> 本篇目标：讲清菜单从哪来、动态路由怎么注册、为什么三级路由要拍平成二级。这是全框架最核心的机制，也是接真实后端时改动最集中的一章。

## 一句话定义

路由体系是"静态路由打底、动态路由按权限注入"的双轨制：静态路由由前端文件自动扫描生成，动态路由由后端接口下发，两者合并后按用户角色过滤出菜单。

类比公司通讯录：公共部门（静态路由，如首页、演示页）印在员工手册人手一份；你所在项目组（动态路由，如系统管理、多租户）由 HR 按你的职位（角色）单独通知。手册人人一样，通知因人而异。

## 双轨各自长什么样

### 静态轨：文件即菜单

`src/router/index.ts` 第 45-57 行：

```ts
const modules: Record<string, any> = import.meta.glob(
  ["./modules/**/*.ts", "!./modules/**/remaining.ts"],
  { eager: true }
);
```

Vite 的 `import.meta.glob` 在构建时扫描 `src/router/modules/` 下所有 `.ts` 文件（`remaining.ts` 除外），自动汇总为静态路由。新增菜单的第一步就是在这个目录加文件，无需任何手动 import。

看一个最小样本 `src/router/modules/remaining.ts` 之外的典型结构（摘自 `board.ts`）：

```ts
export default {
  path: "/board",
  redirect: "/board/index",
  meta: {
    icon: "ri/artboard-line",
    title: $t("menus.pureBoard"),
    rank: board            // 菜单排序号，统一在 src/router/enums.ts 维护
  },
  children: [
    {
      path: "/board/index",
      name: "FrameBoard",
      component: IFrame,   // 也可直接指向 views 下的组件
      meta: {
        title: $t("menus.pureBoard"),
        keepAlive: true,
        frameSrc: "https://songlh.top/paint-board/"  // 有 frameSrc 就是 iframe 页
      }
    }
  ]
} satisfies RouteConfigsTable;
```

`meta` 字段速查（完整类型见 `types/router.d.ts`）：

| 字段 | 作用 |
| --- | --- |
| `rank` | 顶级菜单排序，30 个板块的序号集中在 `src/router/enums.ts` |
| `title` | 菜单与标签页标题，走 i18n |
| `icon` | 菜单图标，iconify 名称或 `IF-xxx svg` 格式的 iconfont |
| `roles` | 页面级权限，数组求交集才可见 |
| `keepAlive` | 页面缓存开关，要求组件 `name` 与路由 `name` 一致 |
| `frameSrc` | 非空则该页渲染为 iframe |
| `showLink` | `false` 则不在菜单显示（如登录页、404） |
| `showParent` | 双栏菜单模式下是否显示父级 |

### 动态轨：后端说了算

登录成功后，`src/views/login/index.vue` 的 `onLogin` 会调用 `initRouter()`。这个函数在 `src/router/utils.ts` 第 200-235 行，流程是：

1. 请求 `/get-async-routes` 拿到路由 JSON（mock 实现在 `mock/asyncRoutes.ts`）。
2. `addAsyncRoutes()`（第 317-343 行）把 JSON 规范化：给 `meta` 打上 `backstage: true` 标记；父级缺 `redirect` 就取第一个子级 path，缺 `name` 就用子级 name 加 `Parent` 后缀；**组件解析**——如果 `meta.frameSrc` 存在则绑定 IFrame 组件，否则拿 `component` 字符串（缺省用 `path`）去 `import.meta.glob("/src/views/**/*.{vue,tsx}")` 的 key 里做 `includes` 匹配，找到就绑定对应组件。
3. `handleAsyncRoutes()`（第 158-197 行）把规范化后的路由 `router.addRoute()` 进去，再通知 permission store 生成菜单。
4. 最后 `addPathMatch()` 补一个 `/:pathMatch(.*)*` 兜底 404，放在动态路由注册之后，避免刷新动态页时误跳 404。

动态路由 JSON 长这样（摘自 `mock/asyncRoutes.ts`）：

```ts
{
  path: "/system",
  meta: { icon: "ri:settings-3-line", title: "menus.pureSysManagement", rank: system },
  children: [
    {
      path: "/system/user/index",
      name: "SystemUser",
      meta: { icon: "ri:admin-line", title: "menus.pureUser", roles: ["admin"] }
    }
  ]
}
```

注意子级没有 `component` 字段，`addAsyncRoutes` 会拿 path `/system/user/index` 去匹配到 `src/views/system/user/index.vue`。这就是"组件路径约定"：动态路由不写 component 时，path 即组件路径。

## 最容易误解的一点：三级拍平

Vue 的 `<KeepAlive>` 只支持两层组件缓存，而管理后台菜单动辄三四层。pure-admin 的解法写在 `src/router/utils.ts` 第 255-260 行的注释里：

> 一维数组处理成多级嵌套数组（三级及以上的路由全部拍成二级，keep-alive 只支持到二级缓存）

`formatTwoStageRoutes(formatFlatteningRoutes(...))` 先把整棵路由树拍成一维，再把所有路由挂到根路由 `/` 的 children 下，重组成"根 + 二级"结构。菜单展示依然保留原始层级（`constantMenus` 单独维护，见 `src/router/index.ts` 第 68-70 行），只是**跳转表**是扁平的。

这带来一个实践后果：**路由的 `name` 必须全局唯一**，因为 keep-alive 的缓存列表（permission store 的 `cachePageList`）按 name 存取，重名会导致缓存互相污染。

## 路由守卫：每次导航的安检门

`src/router/index.ts` 第 123-222 行的 `beforeEach` 是理解页面行为的钥匙。完整时序：

```
导航触发
  │
  ├─ keepAlive 处理：handleAliveRoute 维护缓存页列表
  │
  ├─ 读登录态：cookie "multiple-tabs" + localStorage "user-info"
  │
  ├─【已登录】
  │    ├─ meta.roles 有值且与用户 roles 无交集 → 重定向 /error/403
  │    ├─ VITE_HIDE_HOME=true 且访问 /welcome → 重定向 /error/404
  │    ├─ 页内跳转（_from.name 存在）
  │    │    ├─ 外链路由（name 是 URL）→ window.open，终止导航
  │    │    └─ 其他 → 正常放行
  │    └─ 刷新/首次进入（_from.name 不存在）
  │         └─ 菜单为空 → initRouter() 重建动态路由 → 恢复标签页 → router.push 补跳
  │
  └─【未登录】
       ├─ 目标是 /login 或白名单 → 放行
       └─ 其他 → removeToken() → 重定向 /login
```

两个细节值得记住：

1. **外链菜单的实现方式很特别**：路由的 `name` 直接存 URL，守卫里 `isUrl(to.name)` 判断为真就 `openLink()` 打开新窗口并 `return false` 终止本次导航。所以给菜单加外链不需要真实路由记录。
2. **刷新页面会触发两次守卫**：第一次动态路由还没注册完，第二次补跳到目标页。源码第 204 行注释明确提醒：在守卫里做判断时用 `to.name` 存在作为条件，可以只命中一次。

## 动态路由缓存开关

`platform-config.json` 的 `CachingAsyncRoutes` 默认 `false`：每次刷新都重新请求 `/get-async-routes`。改为 `true` 后，`initRouter` 会把动态路由 JSON 存进 localStorage（key 为 `async-routes`），刷新时直接读缓存不再发请求。菜单在会话期间基本不变的系统可以打开，换取刷新性能；代价是改了菜单必须清缓存才能生效。接后端联调期间保持 `false`。

## 退出登录时发生了什么

`src/store/modules/user.ts` 的 `logOut` action：清空用户状态 → `removeToken()` 清三个存储键 → 标签页重置为初始数组 → `resetRouter()`（`src/router/index.ts` 第 106-116 行，`clearRoutes` 后用启动时的 `initConstantRoutes` 深拷贝重建，并清空菜单与缓存）→ 跳 `/login`。动态路由由此被整体撤销，下次登录另一账号不会残留上个账号的菜单。

## 下一步

- 路由守卫里的登录态判断、403 拦截用到的 token 与角色，全部来自认证体系，下一章 [05 认证与权限](./05-auth.md) 拆解它。
- 动手实验：用 `admin` 登录后打开 DevTools 的 Application 面板，观察 localStorage 的 `user-info`；再换个浏览器窗口用普通用户名登录，对比左侧菜单差异，并到 `mock/asyncRoutes.ts` 里找 `roles: ["admin"]` 的位置，你就打通了"角色 → 菜单"的因果链。
