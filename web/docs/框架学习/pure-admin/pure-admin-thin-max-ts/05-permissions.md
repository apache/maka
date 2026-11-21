# 05 权限体系：页面级 roles 与按钮级 Auth/Perms

本篇你会搞懂三件事：

1. 页面级权限（roles）和按钮级权限为什么是两条独立链路。
2. `<Auth>` 和 `<Perms>` 两个组件长得几乎一样，什么时候用哪个。
3. `*:*:*` 通配符是怎么实现"超管全通过"的。

## 一句话定义

页面级权限回答"这个页面你能不能进"（守卫在路由层面拦），按钮级权限回答"这个按钮你能不能点"（组件在渲染层面藏）。类比写字楼：roles 是楼层门禁——没权限刷卡根本进不了这层；按钮权限是进层后的房间钥匙——进了这层，不代表每间房都能开。

## 页面级：roles 在路由 meta 上

权限来源是登录接口返回的 `roles` 数组（admin 账号是 `["admin"]`，common 账号是 `["common"]`，见 `mock/login.ts`），存进 localStorage 的 user-info 后被两处消费：

1. **守卫硬拦**：`src/router/index.ts:152`，目标路由的 `meta.roles` 与用户角色无交集时直接跳 `/error/403`。交集判断 `isOneOfArray`（`src/router/utils.ts:78`）有一个反直觉默认值：**只要一方不是数组就返回 true**——即没写 roles 的路由对所有人放行。
2. **菜单过滤**：`filterNoPermissionTree`（`src/router/utils.ts:87`）用同样的交集逻辑剔除无权限菜单。所以 common 账号登录后，schedule、dict、tenant 三个菜单根本不渲染（它们在 `mock/asyncRoutes.ts` 里都声明了 `roles: ["admin"]`），而不是渲染出来点了再报错。

对照实验：分别用 admin 和 common 登录，观察菜单数量；再以 common 身份在地址栏手输 `/dict/index`，会被守卫送到 403——菜单只是"看不见"，真正的防线在守卫。

## 按钮级：两条来源，两个组件

按钮级权限有两种数据来源，分别对应两个全局组件（都在 `src/main.ts:43-47` 注册）：

| 组件 | 权限来源 | 判断函数 | 适用场景 |
| --- | --- | --- | --- |
| `<Auth>` | 当前路由 `meta.auths` | `hasAuth`（`src/router/utils.ts:375`） | 权限跟着页面走：后端下发路由时在 meta 里声明本页有哪些按钮权限 |
| `<Perms>` | 登录返回的 `permissions` 数组 | `hasPerms`（`src/utils/auth.ts:131`） | 权限跟着人走：用户在系统里的功能权限，跨页面通用 |

两个判断函数逻辑同构：value 是字符串就做 `includes`，是数组就要求"声明的权限全部具备"（`isIncludeAllChildren`）。

demo 页面把两种用法都铺好了，路径就在权限管理菜单下：

- `/permission/button/router`（`src/views/permission/button/index.vue`）：演示 `<Auth>`，路由 meta 声明了 `permission:btn:add/edit/delete` 三个权限码。
- `/permission/button/login`（`src/views/permission/button/perms.vue`）：演示 `<Perms>`，吃登录接口返回的 permissions。

common 账号只有 `permission:btn:add` 和 `permission:btn:edit`，登录后进这两个页面，能看到"新增/编辑"按钮、"删除"按钮消失。

### 通配权限 `*:*:*`

`hasPerms` 的前几行（`src/utils/auth.ts:133-136`）：

```
allPerms = "*:*:*"
permissions.length === 1 && permissions[0] === allPerms → 直接返回 true
```

admin 的 permissions 就是 `["*:*:*"]`，一个特殊值短路了所有判断。这是一个约定俗成的权限码风格（`模块:资源:操作` 三段式），通配值可换，但要同步改 `src/utils/auth.ts:133` 的常量。注意 `<Auth>` 用的 `hasAuth` **没有**通配逻辑——它只认路由 meta 里写了什么。

## 新手容易搞混的三件事

1. **"前端藏了按钮，是不是就安全了？"** 不是。前端权限是交互体验，真正的安全边界永远是后端接口鉴权。common 账号只是看不到删除按钮，直接调接口照样能发请求（mock 甚至根本不校验）。前后端权限码体系对齐后，前端这一层的作用是"不让用户点到会失败的按钮"。
2. **"roles 和 permissions 有什么区别？"** roles 控制页面/菜单（粗粒度，数量少），permissions 控制按钮/操作（细粒度，数量多）。一套后端通常 roles 决定 permissions 的集合，前端只是分别消费。
3. **"菜单没显示但路由能跳？"** 菜单过滤和路由注册是两步（第 03 篇讲过）。如果后端只把菜单藏了而没在 meta.roles 上声明，用户手输地址照样能进。**菜单可见性靠 showLink，访问合法性靠 roles，两件事都要配。**

## 给新页面加权限的标准动作

1. 后端菜单 JSON 的页面级路由加 `roles: ["admin"]`（或目标角色）。
2. 按钮权限跟着页面走 → 路由 meta 加 `auths: ["xxx:yyy:add", ...]`，页面里用 `<Auth value="xxx:yyy:add">`；跟着人走 → 后端在登录接口返回 permissions，页面里用 `<Perms>`。
3. 敏感操作的后端接口必须再做一次鉴权，前端权限只是第一道体验层。

## 自检清单

1. common 账号手输 `/dict/index` 会去哪？哪个函数拦的它？
2. `<Auth>` 和 `<Perms>` 的权限数据分别从哪来？各自读哪个函数？
3. 为什么说 `*:*:*` 只对 `<Perms>` 链路有效？

下一篇 [06 HTTP 封装与 mock 后端](./06-http-and-mock.md)。
