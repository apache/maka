# 03 路由系统：静态自动注册与动态路由引擎

本篇你会搞懂三件事：

1. 静态路由为什么不用手动注册，三级路由为什么被拍平成二级。
2. 后端下发菜单后，从 JSON 到"能跳转的路由 + 侧边栏菜单"经历了哪几步。
3. 路由守卫在登录、刷新、无权限三种场景下分别做了什么。

## 一句话定义

路由系统由两个文件分工：`src/router/index.ts` 是"门禁系统"（守卫决定放行还是拦截），`src/router/utils.ts` 是"钥匙库管理员"（把后端发来的菜单 JSON 铸造成真正能跳转的路由）。类比酒店：路由表是客房门锁，菜单是楼层指示牌——门锁决定你能不能进，指示牌决定你看得见哪些房间号。**能走和能看见是两套数据**，这是理解本篇的前提。

## 静态路由：自动注册，无需手写

`src/router/index.ts:44-49` 用 `import.meta.glob` 扫描 `src/router/modules/` 下所有 `.ts` 文件（`remaining.ts` 除外），新增静态页面路由时只要在 modules 目录建文件，无需改任何注册代码。当前 modules 目录有四个文件，分两类：

| 文件 | 内容 | 是否进菜单 |
| --- | --- | --- |
| `home.ts` | `path: "/"` 挂 Layout，redirect 到 `/welcome`，rank 0 永远第一 | 是 |
| `error.ts` | `/error/403`、`/error/404`、`/error/500`，rank 9 | **当前是**（`showLink: false` 被注释掉了，上线前建议取消注释隐藏） |
| `remaining.ts` | `/login`、`/access-denied`、`/server-error`、`/redirect/:path(.*)` | 否（不参与菜单渲染，但参与跳转） |

### 三级拍平：keep-alive 的硬约束

静态路由收尾时执行了一条链（`src/router/index.ts:59-61`）：

```
buildHierarchyTree → ascending → formatFlatteningRoutes → formatTwoStageRoutes
```

`formatTwoStageRoutes`（`src/router/utils.ts:262`）把所有页面路由统一挂到 `path: "/"` 这个节点的 children 下，也就是整个路由表只有两级。原因是 Vue 的 keep-alive 对多级嵌套组件缓存支持不好（源码注释指向 vue-pure-admin 的 issue #67）。代价是"目录 → 页面"的层级在路由表里消失了，菜单层级另有一份数据维护（见下文 permission store）。

`ascending`（`src/router/utils.ts:45`）负责按 `meta.rank` 升序：没写 rank 的一级路由按声明顺序自动补 `index + 2`，Home 因为 rank 0 永远排第一。

## 动态路由：从后端 JSON 到可跳转页面

登录后（以及刷新页面时）守卫会调用 `initRouter()`（`src/router/utils.ts:201`），完整流水线如下：

```
getAsyncRoutes()            # GET /get-async-routes，mock 数据在 mock/asyncRoutes.ts
  → cloneDeep(data)         # 防止污染 mock 源数据
  → addAsyncRoutes()        # 把 JSON 铸造成路由对象（关键步骤）
  → formatFlatteningRoutes()
  → 逐条 push 进 "/" 的 children 并 router.addRoute()
  → handleWholeMenus()      # 生成菜单数据
  → addPathMatch()          # 最后补 404 通配路由
```

`addAsyncRoutes`（`src/router/utils.ts:318`）做了五件事，每一件都有讲究：

1. 给 meta 打上 `backstage: true`，标记"这是后端下发的路由"（刷新恢复标签页时用来区分动态顶级路由）。
2. 父级缺 `redirect` 时默认指向第一个子级的 path。
3. 父级缺 `name` 时自动取"第一个子级 name + `Parent` 后缀"——源码注释写明了原因：父子 name 重复会导致重定向失效跳 404。
4. `meta.frameSrc` 存在时组件指向内置的 IFrame 壳子（`src/layout/frame.vue`），用于内嵌第三方页面。
5. 组件解析靠 `import.meta.glob("/src/views/**/*.{vue,tsx}")`：后端传了 `component` 字符串就按它匹配文件路径，没传就按 `path` 匹配。对照 `mock/asyncRoutes.ts` 里的两种写法：`/permission/page/index` 没传 component（path 即组件路径），`/permission/button/router` 传了 `component: "permission/button/index"`（path 可以随便写）。

**404 通配路由为什么最后才加**（`src/router/utils.ts:145-156`）：如果它一开始就注册，刷新一个动态路由页面时，动态路由还没注册完成，`/:pathMatch(.*)*` 会先匹配成功，页面直接 404。等动态路由全部 addRoute 完再补 404，就不会误伤。`platform-config.json` 的 `CachingAsyncRoutes` 为 true 时，菜单数据会缓存进 localStorage（key `async-routes`）跳过网络请求——但缓存没有失效机制，后端改了菜单要等用户清存储才可见，默认 false 是合理的选择。

### 菜单是另一份数据

菜单由 permission store 生成（`src/store/modules/permission.ts` 的 `handleWholeMenus`）：

```
constantMenus（静态路由原始层级） + 后端 routes
  → ascending 排序
  → filterTree          # 剔除 meta.showLink === false
  → filterNoPermissionTree  # 用 localStorage 里当前用户的 roles 过滤
  → filterChildrenTree  # 剔除空目录
  = wholeMenus（侧边栏渲染的数据源）
```

这份数据保持真实层级，路由表是拍平的二级——再次印证"能走"和"能看见"分离。

## 路由守卫：三种场景一张图

`src/router/index.ts:122` 的 `beforeEach` 先做公共事务（NProgress、keepAlive 缓存登记、设置页面标题），然后按登录态分流：

**已登录**（`multiple-tabs` Cookie 存在且 localStorage 有 user-info）：

1. 目标路由声明了 `meta.roles` 且与用户角色无交集 → 跳 `/error/403`（注意是带布局的 403，`src/router/modules/error.ts`；全屏版在 `/access-denied`）。
2. `VITE_HIDE_HOME` 开启时直访 `/welcome` → 404。
3. 如果是从别的页面导航过来（`_from.name` 存在），直接放行。
4. 如果是**刷新/首次进入**（`_from.name` 为空）且菜单为空 → 执行 `initRouter()` 重建动态路由，恢复当前标签页，最后 `router.push(to.fullPath)` 重进一次。源码注释明确提醒：这个过程守卫会触发两次，做副作用时要判断 `to.name` 存在与否，避免执行两次。

**未登录**：目标在白名单（只有 `/login`）放行；否则 `removeToken()` 清空凭证后送回 `/login`。

**已登录访问 `/login`**：弹回原页面（`toCorrectRoute`），防止登录后还能回到登录页。

历史模式由 `getHistoryMode`（`src/router/utils.ts:347`）解析，支持 `hash`、`h5` 以及带 base 的 `hash,base参数` 写法，当前配置为 hash。

登出时的 `resetRouter`（`src/router/index.ts:105`）用启动时深拷贝的 `initConstantRoutes` 清空重建路由表，并清空菜单和缓存页面——保证切换账号后不会残留上一个账号的动态路由。

## 新手容易搞混的三件事

1. **"我在 mock/asyncRoutes.ts 里加了菜单，为什么刷新后 404？"** 九成是 component 匹配失败：path 或 component 字符串必须能在 `/src/views` 下找到同名文件。排查方法：看 `addAsyncRoutes` 解析后 `v.component` 是否为 `undefined`。
2. **"页面缓存（keep-alive）不生效。"** 三个条件缺一不可：`platform-config.json` 的 `KeepAlive: true`、路由 meta 里 `keepAlive: true`、组件 name 与路由 name 一致。缓存列表由 permission store 的 `cachePageList` 管理，`handleAliveRoute` 负责增删（`src/router/utils.ts:283`）。
3. **"为什么有两套 403？"** 守卫无权限跳的是带布局的 `/error/403`（菜单里"异常页面"分组下的那个），`remaining.ts` 里的 `/access-denied` 是全屏独立页。跳转到哪个取决于业务场景。

## 自检清单

1. 新增一个静态页面路由，最少要写哪些东西？需要动 `router/index.ts` 吗？
2. 后端菜单 JSON 里父节点没有 name，注册时会发生什么？
3. 用户 F5 刷新在 `/dict/index` 页面上，守卫里发生了什么？为什么守卫会跑两次？

下一篇 [04 认证与无感刷新](./04-auth-token.md)。
