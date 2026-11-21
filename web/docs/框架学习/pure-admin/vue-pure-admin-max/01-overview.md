# 01 认识 vue-pure-admin-max

> 本篇目标：说清这个框架是什么、适合做什么、和你可能听过的开源版是什么关系，最后给你一张目录地图。不写一行代码。

## 一句话定义

vue-pure-admin-max 是一个开箱即用的后台管理系统前端模板：登录、权限、菜单、主题、请求封装、数十个业务页面演示全部内置，你基于它写自己的业务页面，而不是从零搭工程。

把它类比成精装修交房：水电（工程配置）、厨卫（登录、权限、请求层）、家具（30 多个演示页面）都已就位，你只需要布置自己的房间（业务页面）。

## 三个核心要素

理解这个框架，只需要抓住三件事。

**第一，它是模板，不是框架。** 它不提供新语法、新运行时，就是一套组织良好的 Vue 3 工程代码。所以学习方式是读源码、改源码，而不是查 API 文档。这也是这个系列存在的理由：官方文档讲原理，这里带你逐文件走一遍本仓库。

**第二，前后端分离到"零后端也能跑"。** 它用 `vite-plugin-fake-server` 在 `mock/` 目录里模拟了约 35 个接口（`mock/system.ts` 一个文件 2503 行，覆盖用户、角色、菜单、部门、字典、日志、租户的增删改查）。关键配置在 `build/plugins.ts` 第 58 行附近：`enableProd: true`，mock 连生产构建都生效。所以 `pnpm build` 出来的产物不接后端也能完整演示，这是它和多数模板的本质区别。

**第三，权限是立体的。** 页面级（路由 `meta.roles`）、按钮级 A（登录接口返回的 `permissions` 字段，配合 `<Perms>` 组件和 `hasPerms` 函数）、按钮级 B（路由 `meta.auths`，配合 `<Auth>` 组件和 `hasAuth` 函数）三套并存。三套的区别与选用见第 05 篇，这里先记住"它有三种粒度"即可。

## 最容易搞混的一件事：Max 版和开源版的关系

很多人以为 Max 是"另一个产品"，其实它是开源版 [vue-pure-admin](https://github.com/pure-admin/vue-pure-admin) 的付费增强版，由同一作者（xiaoxian521）维护。根目录 `README.md` 写明了机制：

> Max 版在保留 vue-pure-admin 所有功能基础上，再添加更多高级功能，每个高级功能仅一个提交记录，方便用户同步代码。

这句话的实际含义是：Max 的每个高级功能对应一个独立 commit，你可以把开源版当作基底，按需 cherry-pick 这些提交。Max 版高级功能共 7 项，全部能在本仓库找到代码落点：

| 高级功能 | 代码落点 |
| --- | --- |
| 左侧双栏菜单布局 | `public/platform-config.json` 中 `"Layout": "double"` |
| 悬浮按钮 | `src/components/ReFloatButton/` |
| 繁体中文、日语、韩语 | `locales/` 下 5 个 yaml（zh-CN、zh-TW、en、ja、ko） |
| 字典管理 | `src/views/system/dict/` |
| 多租户管理 | `src/views/tenant/`，登录页由 `.env` 的 `VITE_ENABLE_TENANT=true` 开关 |
| 页头主题模式快捷按钮 | `src/layout/components/lay-navbar/` |
| 日历排班 | `src/views/schedule/` |

另外注意授权：根目录 `README.md` 首段写明仅供购买者使用，不可售卖或公开源代码。公司内部使用没问题，把这份代码开源出去不行。

## 技术栈一览

下表是 `package.json` 中的关键依赖及其在框架中的角色。

| 技术 | 版本要求 | 在框架中的角色 |
| --- | --- | --- |
| Vue | ^3.5.32 | 全部页面基于组合式 API（`<script setup>`） |
| Vite | ^8.0.8 | 构建工具，配置很薄，实际逻辑在 `build/` 目录 |
| TypeScript | ^6.0.3 | 全量 TS，`types/` 目录有全局类型增强 |
| Element Plus | ^2.13.7 | UI 组件库 |
| Pinia | ^3.0.4 | 状态管理，`src/store/modules/` 下 6 个模块 |
| Tailwind CSS | ^4.2.2 | 原子化样式，与 SCSS 混用 |
| vue-i18n | ^11.3.2 | 国际化，词条在 `locales/` 目录 |
| @pureadmin/utils | ^2.6.4 | 作者自研工具库，多数工具函数来自这里而非 `src/utils` |

Node 版本要求 `^20.19.0 || >=22.13.0`，pnpm 要求 9 以上（`package.json` 的 `engines` 字段）。

## 目录地图

`src` 下共 268 个 `.vue`、169 个 `.ts`、51 个 `.tsx`。下面是骨架，记住"每个目录一句话"就够，后续章节会逐个深入。

```
src/
├── api/          # 5 个文件，所有后端请求的出口
├── assets/       # 静态资源（svg、iconfont、登录背景）
├── components/   # 25 个 Re* 封装组件，业务页面的积木
├── config/       # 运行时配置读取器（读 public/platform-config.json）
├── directives/   # 6 个自定义指令（auth、perms、copy、longpress、ripple、optimize）
├── layout/       # 布局壳：导航栏、侧边栏、标签页、设置面板
├── plugins/      # 4 个插件装配：echarts、elementPlus、i18n、vxeTable
├── router/       # 路由核心：index.ts 守卫、utils.ts 动态路由、modules/ 静态路由
├── store/        # Pinia：app、epTheme、multiTags、permission、settings、user
├── style/        # 全局样式与 tailwind 入口
├── utils/        # http 封装、auth、本地存储、mitt 事件总线等
└── views/        # 30+ 业务页面，system/ 是 CRUD 的标准范本
mock/             # 假后端，7 个文件约 35 个端点
build/            # vite 构建逻辑（插件、压缩、CDN、环境变量处理）
types/            # 全局类型声明（router.d.ts 是读懂路由配置的钥匙）
public/           # platform-config.json 运行时配置在这里
```

两个目录值得单独点名。`src/router/modules/` 有 25 个路由文件，每个文件就是左侧菜单的一个板块，你以后新增菜单就是在这里加文件（第 10 篇实战）。`src/views/system/user/` 是全框架最完整的 CRUD 范本（列表、搜索、左侧部门树、弹窗表单、权限按钮俱全），写业务页面前建议先精读它。

## 这个框架不适合什么

客观说三条边界，帮你建立判断力。

1. 移动端。布局系统面向桌面管理后台，760px 以下只是折叠侧边栏做降级（`src/layout/index.vue` 的 `useResizeObserver` 逻辑），不是移动端方案。
2. 微前端基座。它没有 qiankun、wujie 之类的集成，多页签 iframe（`frameSrc`）是它支持外部系统的全部手段。
3. 强 SSR 场景。纯 SPA，没有 SSR 预算。管理后台一般也不需要。

## 下一步

环境就绪的话，直接进 [02 把项目跑起来](./02-getting-started.md)，五分钟后你就能用 `admin` 账号登录并看到全部菜单。
