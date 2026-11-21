# 09 · Mock 接口层

一句话定义：`mock/` 目录就是一个完整的假后端，当前配置在生产构建里同样生效，所以"对接真实后端"是上线前的必做项，不是可选项。

上一篇：[08 本地存储双轨制](./08-本地存储双轨制.md) ｜ 下一篇：[10 布局系统](./10-布局系统.md)

## 先打个比方

样板间里的家具是道具。交付之前你有两个选择：把道具换成真家具（接真实后端），或者明确告知买家家具不卖（维持纯前端演示）。最糟的是忘了说明，买家住进去才发现床是画在墙上的。

## 机制

插件是 `vite-plugin-fake-server`，接入配置在 `build/plugins.js`：

```js
vitePluginFakeServer({
  logger: false,
  include: "mock",      // 扫描根目录 mock/
  infixName: false,
  enableProd: true      // 生产构建也生效，重点
})
```

写法是"文件即接口"。`mock/` 下每个文件用 `defineFakeRoute([...])` 导出一组路由定义，`url` + `method` + `response()`。响应函数能拿到 `body`（请求体），所以查询过滤、条件分支都能模拟。

## 接口清单

当前 4 个文件、10 个接口，全量列一遍，对接后端时按这张表核对。

| url | method | 文件 | 用途 | 特殊行为 |
| --- | --- | --- | --- | --- |
| `/login` | post | `mock/login.js` | 登录 | 用户名 `admin` 返回管理员身份，其余一律 `common`；不校验密码 |
| `/refresh-token` | post | `mock/refreshToken.js` | 刷新 token | 带 `refreshToken` 即成功 |
| `/get-async-routes` | get | `mock/asyncRoutes.js` | 动态路由 | 返回 4 个模块路由 |
| `/dict-tree` | get | `mock/system.js` | 字典树 | 4 个根节点 |
| `/dict-detail` | post | `mock/system.js` | 字典详情 | 按 `dictId` 过滤 + 分页 |
| `/tenant-list` | post | `mock/system.js` | 租户列表 | 名称模糊、状态、联系人精确过滤 |
| `/tenant-package` | post | `mock/system.js` | 租户套餐 | 同上 |
| `/tenant-package-menu` | post | `mock/system.js` | 套餐菜单权限树 | 全量菜单平铺返回 |
| `/tenant-package-menu-ids` | post | `mock/system.js` | 已勾选菜单 | 套餐 101 返回 7 个 id，102 返回空 |
| `/tenant-package-simple` | get | `mock/system.js` | 套餐下拉 | 简化字段 |

## 两条全项目约定

**响应信封。** 所有接口返回 `{code, message, data}`，`code === 0` 表示成功。前端每一处都按这个判断，`src/views/dict/utils/hook.jsx` 的 `onSearch`、`src/router/utils.js` 的 `initRouter` 都能看到 `if (code === 0)`。后端业务码若不是 0 表成功，统一在请求层转换，别改散落各处的判断。

**分页信封。** 列表类接口的 `data` 统一为 `{list, total, pageSize, currentPage}`。表格 hook 拿到后直接灌进 reactive 的 `pagination`。时间字段是毫秒时间戳，展示层用 dayjs 格式化。

还有一条隐含约定值得点名：**写操作是演示级的**。字典和租户页面的新增、修改、删除按钮只弹提示、本地不落库，`hook.jsx` 里留着注释"实际开发先调用新增接口"。也就是说 mock 只覆盖了读，写接口要你在接后端时一起补。

## 对接真实后端的五步

**第一步，配代理。** `vite.config.js` 的 `server.proxy` 当前是空对象。加上例如 `"/api": { target: "http://localhost:8080", changeOrigin: true }`。

**第二步，定前缀。** 两种做法选一：统一改 `src/api/` 里的 URL 加 `/api` 前缀，或者利用代理的重写把 `/api` 剥掉。当前所有接口都是无前缀相对路径，且没有设置 baseURL，这是你要动的第一个地方。

**第三步，关掉生产 mock。** `build/plugins.js` 里 `enableProd: true` 改成 `false`。开发期 mock 和真实后端可以共存（代理优先，mock 拦不到已代理的路径），但生产构建必须关。

**第四步，对齐响应约定。** 确认后端满足 `{code: 0}` 和分页信封，不满足就在 `src/utils/http` 的响应拦截器里做映射。同时检查 `expires` 的格式，后端给时间戳的话按第 06 篇说的改 `setToken`。

**第五步，补登录参数。** `src/views/login/index.vue` 的 `onLogin` 只传了 `username` 和 `password`，租户名 `ruleForm.tenant` 没有带上。需要租户标识的后端在这里补。

每改一步就验证一步：第一步完成后 Network 面板里请求应该出现在代理目标下；第三步完成后 `pnpm build` 产物里不应再有 mock 拦截行为。

## 新手常见误区

**以为 mock 只在开发环境。** `enableProd: true` 会让 `pnpm build` 出来的包继续用假数据。项目全景篇说过，这是全项目最容易踩的雷。

**改了 mock 文件没反应。** mock 是 node 侧代码，热更新对它支持有限。改完重启 dev server，别在浏览器刷新上浪费时间。

**在后端接口还没就绪时就删 mock。** 按"一个接口一个接口"的节奏替换：某个接口的真后端好了，就让前端请求绕过它，其余接口继续走 mock。渐进替换比一次性切换的风险小得多。

## 动手验证

1. 打开 `mock/login.js`，给 `common` 用户加一个 `permission: "permission:btn:delete"`（拼进 permissions 数组），重启后用 common 登录，按钮权限页多出"删除"按钮。mock 数据和界面表现的因果链走通了一遍。
2. 在 `mock/system.js` 的 `/dict-detail` 响应里加一条数据，重启后字典管理页立即可见。新增字典详情接口的全流程就通了。
3. 把 `vite.config.js` 的 `server.proxy` 配一个指向不存在地址的目标，观察请求报错并显示代理目标，确认代理生效路径。

## 自查清单

- [ ] 能背出响应信封和分页信封的准确结构
- [ ] 五步对接法能按顺序复述，知道每步怎么验证
- [ ] 明确知道 `enableProd` 当前是 true，上线前必须处理

## 下一步

[10 布局系统](./10-布局系统.md)：数据有了，看它被装进什么样的壳。
