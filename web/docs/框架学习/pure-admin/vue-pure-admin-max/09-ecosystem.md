# 09 状态管理与组件生态

> 本篇目标：一张地图看清 6 个 store 的分工、25 个 Re 组件的能力、工具库与指令的分布。写业务页面前的最后一章铺垫，以后用到什么回来查表。

## 一句话定义

状态管理与组件生态是框架的中台层：store 存全局状态，Re 组件提供预制积木，@pureadmin/utils 提供工具函数，三者共同让业务页面只写"这一页特有"的代码。

类比宜家：store 是中央仓库（全屋共享的库存），Re 组件是标准化板材（跨页面复用），utils 是随附的工具包（螺丝刀扳手）。你组装自己的柜子（业务页面）时不需要自制板材。

## 六个 store 的分工

全在 `src/store/modules/`，命名前缀 `pure-`：

| store | 文件 | 状态 | 高频用法 |
| --- | --- | --- | --- |
| user | `user.ts` | avatar、username、roles、permissions、isRemembered 等 | 登录登出、按钮权限数据源 |
| permission | `permission.ts` | wholeMenus（菜单树）、flatteningRoutes、cachePageList | `getTopMenu` 取首页菜单、keep-alive 缓存管理 |
| multiTags | `multiTags.ts` | multiTags 标签页数组、multiTagsCache | `handleTags("push", route)` 添加标签 |
| app | `app.ts` | sidebar 开合、device 类型、viewport 尺寸 | 移动端判断 `useAppStoreHook().device` |
| epTheme | `epTheme.ts` | Element Plus 主题色 | 设置面板换色 |
| settings | `settings.ts` | title、fixedHeader、hiddenSideBar 等界面开关 | 读取 `title`、控制侧栏隐藏 |

两个使用惯例值得记住：

1. **始终用 `useXxxStoreHook()` 而不是直接 `useXxxStore()`**。hook 版本显式传入 `store` 实例（如 `user.ts` 最后一行 `return useUserStore(store)`），保证在组件外（拦截器、守卫、工具函数里）调用时 Pinia 已激活。框架内所有非组件环境的调用都走 hook 形式，这是 Pinia 官方推荐写法，也是 `src/store/index.ts` 存在的意义。
2. **持久化状态不走 store 而走 responsive-storage**。store 只存运行时状态，需要跨刷新的（布局、设置）由 layout 层写入 localStorage（第 08 篇）。两套体系的边界清晰：store 管"会话内"，responsive-storage 管"跨会话"。

## Re 组件族：25 个预制积木

`src/components/` 下全部以 `Re` 前缀命名（避免与 HTML 自定义元素冲突）。按用途分四组：

**表格与表单组**（业务页面最常用）：

| 组件 | 能力 |
| --- | --- |
| RePureTableBar | 表格页顶栏：列显隐设置、刷新、全屏，配合 @pureadmin/table 使用 |
| ReVxeTableBar | vxe-table 版顶栏，能力同上 |
| ReDialog | 函数式弹窗，`addDialog(options)` 一行唤起，内部套了纯 admin 风格 |
| ReCol | 响应式栅格封装 |

**数据展示组**：ReCountTo（数字滚动，normal 与 rebound 两种）、ReFlop（翻牌数字）、ReSeamlessScroll（无缝滚动）、ReText（文本溢出省略号并悬浮完整提示，基于 vue-tippy）、ReTypeit（typeit 打字机动画文本）、ReAnimateSelector（动画选择器）。

**媒体与图形组**：ReCropper 与 ReCropperPreview（头像裁剪，用户管理页在用）、ReQrcode（二维码）、ReBarcode（条形码，jsbarcode）、ReMap（高德地图）、ReFlowChart（LogicFlow 流程图）、ReFlicker（闪烁点，在线状态指示）。

**安全与权限组**：ReAuth、RePerms（第 05 篇讲过）、ReImageVerify（图形验证码，登录页在用）、ReSegmented（分段选择器）、ReSplitPane（分栏拖拽）、ReTreeLine（带连接线的树）、ReFloatButton（Max 版悬浮按钮）。

多数组件没有全局注册，按需 import（全局注册的只有 ReIcon 三件套和 Auth、Perms，见第 03 篇清单）。写页面时先翻这个目录，大概率已有现成积木。

## 工具函数去哪找

新人的高频误区：想找个深拷贝、防抖，先去 `src/utils/` 翻，翻不到就自己写。正确顺序是：

1. **先查 @pureadmin/utils**（作者的独立工具库，文档在 pure-admin-utils.netlify.app）。全框架大量使用它的 `cloneDeep`、`debounce`、`deviceDetection`、`isAllEmpty`、`storageLocal`、`getKeyList`、`switchStyle` 等。`src/utils/README.md` 明确写了：3.3.0 版本之后大部分工具和 hooks 都集成到了这个包。
2. **再查 src/utils/**，剩下的是框架自留的：

| 文件 | 职责 |
| --- | --- |
| `http/` | 网络层（第 07 篇） |
| `auth.ts` | 认证（第 05 篇） |
| `tree.ts` | `handleTree`、`buildHierarchyTree` 树处理，部门树、菜单树全靠它 |
| `message.ts` | 消息提示封装，统一防抖与堆叠 |
| `mitt.ts` | 事件总线，标签页刷新等跨组件通信 |
| `print.ts` | 浏览器打印 |
| `chinaArea.ts` | 省市区数据 |
| `propTypes.ts` | Vue props 类型快捷封装 |
| `responsive.ts` | 响应式存储注入（第 08 篇） |
| `sso.ts` | 单点登录预留（router/index.ts 首行引入） |
| `localforage/` | IndexedDB 封装，存大体量数据 |
| `globalPolyfills.ts` | 浏览器全局补丁 |

3. **最后才自己写**，且优先放进 `src/utils/` 而不是页面里，保持框架惯例。

## 插件层

`src/plugins/` 四个文件对应四项能力的"按需化装配"：

- `echarts.ts`：把 echarts 实例挂到全局属性（`$echarts`，源码注释指向 @pureadmin/utils 的 useECharts 使用前提），业务页用 @pureadmin/utils 的 `useECharts` hook 配合模板 ref 拿图表实例，主题自动跟随系统明暗。
- `elementPlus.ts`：全局中文语言包装配（随 i18n 切换）。
- `i18n.ts`：vue-i18n 实例，词条来自 `locales/` 五个 yaml（构建期由 `@intlify/unplugin-vue-i18n` 预编译，`build/plugins.ts` 第 33-35 行）。业务代码用 `$t("menus.pureUser")` 取词条，`transformI18n` 处理动态 key。
- `vxeTable.ts`：vxe-table 全量注册与主题，用于高性能大表格场景（`views/table/virtual` 虚拟滚动演示）。普通页面用 @pureadmin/table（Element Plus 风格）就够了，两者选型经验：数据量上万、需要虚拟滚动才上 vxe-table。

## 公共业务 hooks

`src/views/system/hooks.ts`（与 `views/tabs/hooks.ts`、`views/tenant/hooks.ts` 同属页面级公共 hooks）存放跨业务页共享的 hooks，其中 `usePublicHooks` 提供表格行的 `switchStyle`、`tagStyle` 等渲染函数，用户管理页的状态开关、角色标签就用它。你的业务公共 hooks 建议按同样惯例放在对应业务目录，避免页面间互相 import 造成纠缠。

## 业务页面的标准零件清单

综合本章与前面章节，一个标准 CRUD 页面会用到这些零件（第 10 篇实战串讲）：

```
页面 index.vue
├── PureTableBar        顶栏（搜索区 + 操作按钮插槽）
├── pure-table          表格本体（@pureadmin/table）
├── useXxx hook.tsx     逻辑层：form 响应式对象、loading、columns 定义、事件函数
├── addDialog + form    弹窗表单（ReDialog 唤起，表单组件放同级 form/ 目录）
├── hasPerms / <Perms>  按钮权限
├── api/xxx.ts          接口定义
└── mock/xxx.ts         假数据（接后端前）
```

这个结构在 `src/views/system/user/`（index.vue + hook.tsx + form/ + utils/）和 `src/views/system/role/` 完全一致，是框架的事实标准。

## 下一步

- 零件齐了，下一章 [10 实战：新增一个完整业务模块](./10-crud.md)，手把手照着 user 页的范式新增一个"商品管理"模块。
- 动手实验：全局搜索 `addDialog(` 看它出现在多少个业务页里，再打开 `src/components/ReDialog/index.tsx` 读它的参数类型——十几行类型定义就是弹窗的全部 API，这是理解"Re 组件如何简化业务"最快的一个样本。
