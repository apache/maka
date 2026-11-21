# 07 业务模块精读：字典、排班、租户三个页面的实现套路

本篇你会搞懂三件事：

1. 三个业务页面共用的代码组织套路：页面组件薄、逻辑进 hook、表单独立组件、弹窗用 ReDialog。
2. 每个页面的字段、接口和操作行为，到能直接接后端的程度。
3. 哪些功能是"演示级"的（数据写死、没有接口），接后端时要补什么。

## 一句话定义

这三个页面是官方留的"标准施工样板"：字典管理展示树 + 表格联动，日历排班展示日历组件二次开发，租户管理展示完整 CRUD 加权限树。学会一个，另外两个就是换数据。类比样板间：户型和工艺都摆给你看了，家具（数据）换成你自己的就能住。

## 共用套路：页面组件为什么这么薄

以字典页为例，`src/views/dict/index.vue` 的 script 只有四十行，职责全部分出去了：

| 文件 | 职责 |
| --- | --- |
| `index.vue` | 模板组装：左树 + PureTableBar + pure-table |
| `utils/hook.tsx` | `useDict()`：状态、列定义（含 tsx 渲染器）、增删改查动作 |
| `form/index.vue`、`form/dict.vue` | 弹窗表单组件，由 `addDialog` 动态挂载 |
| `hooks.ts` | `usePublicHooks()`：跨页面共用的小样式（状态开关配色、el-tag 配色） |
| `utils/types.ts`、`utils/rule.ts` | 表单类型与校验规则 |

列表渲染用 `@pureadmin/table` 的 pure-table，列定义写在 hook 里，自定义渲染用 tsx 的 `cellRenderer`（字典标签列直接按 `row.color` 渲染成色块按钮，状态列渲染成 el-switch）。弹窗统一走 `@/components/ReDialog` 的 `addDialog`，传表单组件和 props 进去，不用在每个页面手写 el-dialog 的显隐状态。这套"薄页面 + 胖 hook"的写法是本仓库所有列表页的统一模式，照抄即可。

## 字典管理（/dict/index）

**页面结构**：左侧字典树（`tree.vue`，支持层级分类，右键可修改删除），右侧字典详情表格 + `PureTableBar` 工具栏。

**数据流**：`onMounted` 里先 `getDictTreeData()` 拉树再 `onSearch()` 拉右侧表格（`src/views/dict/index.vue:36-39`）。左侧选中节点后 `onTreeSelect` 记下 `dictId`，右侧表格按 `dictId` 过滤；`dictId` 为空时"新增字典详情"按钮 disabled（`src/views/dict/index.vue:62`）。

**mock 字段**（`mock/system.ts`）：

- 树节点：`id`（100/200/300/400，如"通知类型 notice_type"、"性别 gender"）、`name`、`code`、`remark`、`createTime`。
- 详情行：`id`、`label`（字典标签）、`value`（字典值）、`color`（标签颜色）、`status`（1 启用 0 停用）、`sort`、`remark`、`createTime`、`dictId`（挂在哪棵树下）。

**业务用法**：仓库自带的 `src/views/dict/README.md` 写了消费方式——任何页面按 dictId 调 `getDictDetail` 取 `data.list`，把 label/value 当下拉选项用。这就是"数据字典"的意义：状态、性别这类枚举不写死在代码里。

## 日历排班（/schedule/index）

**页面结构**：顶部月份选择器 + 上月/今天/下月按钮组 + 三色图例，下方 `el-calendar`，每个日期格里渲染排班标签。

**实现要点**：

- `dayjs.locale("zh-cn", { weekStart: 1 })` 让日历从周一开始（`src/views/schedule/index.vue:13`，源码注释指向 element-plus 的一个已知问题）。
- 图例三班：早班 `#67C23A`、中班 `#E6A23C`、晚班 `#409EFF`，图标是 `svg/` 下三个本地图，用 `?component` 后缀导入成 Vue 组件（`src/views/schedule/utils/hook.tsx:8-10`）。
- 排班数据结构：`{id, scheduling(人名), classes(morning/noon/evening), startDate, endDate, remark}`，支持跨日期区间排班（mock 里"李四"从本月 2 号排到 5 号）。
- 点击日期格的排班项弹 `form.vue` 编辑，`formatSchedule` 负责把数据按日期区间铺进日历格。

**必须知道的"演示级"事实**：排班数据是**硬编码在 hook 里的 ref 数组**（`src/views/schedule/utils/hook.tsx:43`），没有任何接口调用。`api/system.ts` 里没有 schedule 相关函数。接后端时需要自建接口并改造 `getScheduling` 等动作。

## 租户管理（/tenant）

两个子页面 + 一个权限树：

**租户列表**（`/tenant/list/index`）：搜索字段 `name`（租户名）、`contactName`（联系人）、`contactMobile`（联系电话）、`status`；表格字段依次为 `id`（租户编号）、`name`、`packageName`（租户套餐）、联系人、`accountCount`（账号数量）、`expireTime`（过期时间）、`website`、状态开关、备注、`createTime`、操作列（修改/删除，删除走 `ElMessageBox` 二次确认）。mock 里现有 pure-admin（高级套餐）和 boot-admin（普通套餐）两条数据。

**租户套餐**（`/tenant/package/index`）：字段 `id`（101 高级套餐 / 102 普通套餐）、`name`、`status`、`remark`。核心功能是"权限"按钮：打开后用 `getTenantPackageMenu` 拉全量菜单树、`getTenantPackageMenuIds` 拉该套餐已勾选的菜单 id，用 el-tree 勾选后提交——这就是 SaaS 里"不同租户看到不同菜单"的数据源头。

**联动**：`getTenantPackageSimple` 提供不分页的套餐下拉，租户新增/修改表单里选套餐用。

**另一个"演示级"事实**：整个租户模块的增删改在前端内存里完成，刷新即恢复 mock 初始数据。真实的租户体系（登录时选租户、请求头带租户 id）没有实现——`.env` 的 `VITE_ENABLE_TENANT = true` 目前只在登录页渲染一个"租户名"输入框（`src/views/login/index.vue:122`），`tenant` 字段没有进入登录请求体，也没有任何请求头注入。把多租户做实，是二开工作量最集中的地方。

## 新手容易搞混的两件事

1. **"字典树右键菜单是 element-plus 的吗？"** 是 `@imengyu/vue3-context-menu`（`package.json` 依赖里可见），在 `tree.vue` 里绑定右键事件弹出，编辑动作复用 `form/dict.vue` 弹窗。
2. **"排班页的数据为什么刷新就变回去？"** 见上文，它没接接口。同样情况出现在租户的增删改上。判断一个页面是否演示级，最快的办法是看它引用了 `src/api/` 里的哪些函数——引用为空的页面数据必然写死在 hook 里。

## 自检清单

1. 新做一个"部门管理"列表页，按本仓库套路需要建哪几个文件，各放什么？
2. 字典详情行的 `status` 字段值 1 和 0 分别代表什么？前端在哪渲染成开关？
3. 租户套餐的菜单权限树用了哪两个接口，各自什么时候调？

下一篇 [08 布局与主题](./08-layout-theme.md)。
