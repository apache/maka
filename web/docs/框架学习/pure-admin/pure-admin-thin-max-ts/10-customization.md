# 10 二次开发实战：新增一个完整页面 + 全仓库坑位图

本篇是系列的终点，也是日常开发的起点：把前九篇的知识串成一条可执行的工作流，并给出一份按出现频率排序的坑位清单。

## 一句话定义

在这个仓库做二开就是走一条流水线：mock 造数据 → api 定义接口 → views 建页面 → 菜单 JSON 注册路由，四步全通就是完整功能。类比装修流程：先看户型图（菜单注册）、再走水电（api/mock）、最后软装（views 页面），顺序反了会返工。

## 实战：新增一个"公告管理"页面

以加一个典型的 CRUD 页面为例，四步走完（先在 mock 环境跑通，后端就绪后再切换数据源）。

### 第一步：mock 造数据

`mock/system.ts` 里按既有格式追加：

```ts
// 公告列表（分页）
{
  url: "/notice-list",
  method: "post",
  response: ({ body }) => {
    const list = [
      { id: 1, title: "停机公告", type: "1", status: 1,
        createTime: 1722441600000, remark: "" }
    ];
    return { code: 0, message: "操作成功",
             data: { list, total: list.length,
                     pageSize: body?.pageSize ?? 10,
                     currentPage: body?.currentPage ?? 1 } };
  }
}
```

分页结构对齐 `ResultTable`（`list/total/pageSize/currentPage`）。

### 第二步：api 定义接口

`src/api/system.ts` 追加：

```ts
/** 公告管理-列表 */
export const getNoticeList = (data?: object) => {
  return http.request<ResultTable>("post", "/notice-list", { data });
};
```

### 第三步：建页面（照抄字典页骨架）

```
src/views/notice/
├── index.vue          # 模板：PureTableBar + pure-table（从 src/views/dict/index.vue 复制改名）
└── utils/
    ├── hook.tsx       # useNotice()：columns、dataList、pagination、增删改查
    ├── types.ts       # FormItemProps 等表单类型
    └── rule.ts        # 表单校验规则
└── form.vue           # 弹窗表单组件（addDialog 挂载用）
```

hook 的写法对照 `src/views/dict/utils/hook.tsx`：ref 状态 + reactive 分页 + columns 列定义（自定义渲染用 tsx `cellRenderer`）+ 动作函数。组件 name 必须写且与路由 name 一致（`defineOptions({ name: "Notice" })`），这关系 keep-alive 缓存（第 08 篇三条件）。

### 第四步：注册菜单

`mock/asyncRoutes.ts` 的 `data` 数组追加：

```ts
{
  path: "/notice/index",
  name: "Notice",
  meta: { title: "公告管理", roles: ["admin"], rank: 14 }
}
```

不传 `component` 时，`addAsyncRoutes` 按 path 匹配 `src/views` 下的文件（第 03 篇五步处理）。保存后浏览器刷新，菜单出现、页面可跳转，CRUD 走通。

**切真实后端时**：接口换成真 url（第 06 篇清单）、`enableProd` 关 mock、菜单改由后端 `/get-async-routes` 返回同构 JSON——前端代码一行不用动，这正是这套架构的设计意图。

## 全仓库坑位图（按遇到频率排序）

| # | 坑 | 现象 | 出处与解法 |
| --- | --- | --- | --- |
| 1 | mock 在生产生效 | 联调时部分接口返回假数据 | `build/plugins.ts` 的 `enableProd: true`，接后端先关 |
| 2 | `CachingAsyncRoutes` 缓存 | 后端改了菜单，前端不变 | localStorage 的 `async-routes` 永不过期，清存储或保持 false |
| 3 | keep-alive 不生效 | 页面状态丢失/不缓存 | 三条件：配置开关 + 路由 meta.keepAlive + 组件 name 等于路由 name |
| 4 | 动态路由 404 | 刷新后短暂 404 或菜单页打不开 | component/path 匹配不到 `src/views` 文件；404 通配是最后注册的（`addPathMatch`），别在它之前拦截 |
| 5 | Windows 下 `pnpm dev` 报错 | `NODE_OPTIONS` 不是内部或外部命令 | scripts 用了 Unix 前缀语法，换 Git Bash 或改写脚本 |
| 6 | Docker 构建失败 | COPY 阶段 cache key 报错 | `.npmrc` 不存在（Dockerfile:8）；node:20 镜像与 engines `>=22.22.1` 矛盾（09 篇两问题） |
| 7 | 父子路由 name 重复 | 重定向失效跳 404 | `addAsyncRoutes` 会给父级自动加 `Parent` 后缀，自己命名时避免父子同名 |
| 8 | 守卫副作用执行两次 | 刷新时请求重复发 | beforeEach 重建动态路由会触发两次，判断 `to.name` 存在与否（`src/router/index.ts:202` 注释） |
| 9 | 配置改了不生效 | 主题/布局改不动 | 三层优先级：用户 localStorage > platform-config.json > 代码默认值（02 篇） |
| 10 | 菜单可见但能被直连访问 | 越权页面能打开 | showLink 只管显示，roles 才管访问，两个都要配（05 篇） |

## 精简与加固清单

做产品化二开前的两份动作清单。

**裁掉**（若不需要对应功能）：

- mock 生产开关（必做）：`build/plugins.ts`
- "异常页面"菜单组：`src/router/modules/error.ts` 取消 `showLink: false` 的注释
- 不用的业务页（如不做 SaaS 可裁 tenant）：删 views + mock + api + 菜单 JSON 四处
- code-inspector（生产代码里无痕，但 dev 依赖可按团队习惯保留）

**补齐**（演示功能做实）：

- 租户体系：登录请求体加 tenant 字段（`src/views/login/index.vue`）、http 拦截器统一注入租户头（`src/utils/http/index.ts`）、租户 CRUD 接真实接口（07 篇指出的演示级位置）
- 服务端登出：`logOut` 里补调接口（`src/store/modules/user.ts:84`）
- 排班数据接口化：`src/views/schedule/utils/hook.tsx` 的硬编码数组换接口
- 密码校验：mock 不校验密码，真实登录错误提示链路要在真后端联调时验证

## 学完之后

十篇读完，你应该具备了三种能力：给这个仓库接上任意真实后端（02/04/06 篇）、在它上面快速长出业务页面（07/10 篇）、以及审查它的每一处工程决策并说出代价（03/05/09 篇）。往下深入的两个方向：把 `@pureadmin/utils`、`@pureadmin/table` 这些配套库的文档过一遍（它们是这套写法的地基）；读 vue-router 与 pinia 的官方进阶文档，补齐 router.addRoute 与 store 组合式用法的底层原理。

有任何一篇与源码对不上的地方，以源码为准并视为本文的 bug——本系列的每个结论都应在 `main` 分支上可复现。
