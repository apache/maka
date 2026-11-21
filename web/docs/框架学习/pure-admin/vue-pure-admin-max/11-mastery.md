# 11 精通：二次开发与精简指南

> 本篇目标：给出改造点地图、精简策略、已知坑位和上线检查单。这是系列的收束篇：前面各章是地图上的道路，这一章是驾驶守则。

## 一句话定义

二次开发的正确姿势是"替换数据源、保留骨架、按提交裁剪"，而不是推倒重写。

类比老房改造：水电结构（路由、权限、http 层）不动，只重装修（views、mock）；想拆墙（砍模块）前先看图纸（本章的改造点地图）。

## 改造点地图

从"拿到模板"到"交付产品"，按时间顺序会经历五个阶段。下表是每个阶段的标准动作与涉及的文件：

| 阶段 | 动作 | 核心文件 |
| --- | --- | --- |
| 品牌化 | 标题、Logo、主题色、默认布局 | `public/platform-config.json`、`src/assets/login/` |
| 裁剪 | 删掉用不到的演示菜单与页面 | `src/router/modules/`、`src/views/`（策略见下节） |
| 接后端 | 下线生产 mock、对齐接口 | `build/plugins.ts`、`src/utils/http/index.ts`、`src/api/`、`src/config/index.ts` |
| 业务化 | 按第 10 篇范式批量写业务页 | `src/views/`、`src/api/`、`mock/` |
| 上线 | 部署路径、压缩、CDN、检查单 | `.env.production`、`build/compress.ts`、`build/cdn.ts` |

## 精简策略

这是 Max 版买家最关心的问题。根目录 `README.md` 说得很直白：因为高级功能按提交记录取用，官方不提供精简版，需要自己按需裁剪。实践上有两种策略。

**策略一：按提交裁剪（重）**。从开源版 vue-pure-admin 起步，对照 Max 仓库 `README.md` 的"高级功能提交记录"表逐条 cherry-pick。适合：需要与开源版长期保持同步、且只要个别高级功能的团队。代价是要维护一条自己的提交历史。

**策略二：从 Max 裁剪（轻，推荐）**。以 Max 全量为基线，删菜单即可"隐藏"功能，删代码再"瘦身"。关键认知：**删 `src/router/modules/` 里的文件就等于删了功能入口**，views 目录的演示代码不被路由引用就不会进打包产物（Vite 按 import 图打包）。所以正确的裁剪顺序是：

1. 删路由文件（如 `board.ts`、`ppt.ts`、`mind.ts`、`formdesign.ts` 这类 iframe 演示板块）。
2. 跑 `pnpm build`，若打包成功且体积达标，对应 views 目录可以不删（无引用不打包）；追求源码整洁再删对应 `src/views/` 目录。
3. 全局搜索被删路由在 `src/router/enums.ts` 里登记的 rank 变量，清理死代码。
4. 删 mock 里无人消费的端点（对照第 06 篇端点表）。

注意两个"别动"：`src/router/modules/remaining.ts` 里的登录、403、500、redirect、account-settings 是框架必需路由；`home.ts` 的首页路由 rank 为 0 是平台约定（`enums.ts` 首行注释）。需要"首页不可见"时用 `.env` 的 `VITE_HIDE_HOME=true`，而不是删路由。

**演示页面与业务代码的边界**：`src/views/` 下除 `system/`、`tenant/`、`monitor/`、`schedule/`、`account-settings/`（这些是可复用的业务范式）外，多数是能力演示（able、components、table、editor 等）。业务化阶段的原则：演示页可以删，但删之前把它的"能力参考价值"记下来——你迟早会在某个业务页里需要"Excel 导出"或"虚拟滚动"，那时 `views/table/high/excel/` 就是抄写对象。建议做法是先只删路由不删源码，等业务稳定再做物理清理。

## 已知坑位清单

以下是侦察与使用中确认的事实，接手前过一遍能省很多排查时间：

| 坑 | 事实 | 应对 |
| --- | --- | --- |
| 生产 mock | `build/plugins.ts` 中 `enableProd: true`，构建产物带假数据 | 接后端后立即改 false，写入团队规范 |
| mock 登录后门 | `mock/login.ts` 不校验密码，任意用户名可登录 | dev 无妨；生产关闭 mock 后自然失效 |
| 高德 key | `platform-config.json` 内置作者的高德 key | 换成自己申请的 key，防限额 |
| 登录态与存储 | 用户改过的设置存 localStorage（`responsivemax-` 前缀），覆盖配置文件默认值 | 改配置"不生效"先清浏览器存储再验证 |
| `expires` 单位 | `src/utils/auth.ts` 第 52 行默认按日期字符串解析 | 后端给时间戳时按该行注释调整 |
| name 冲突 | 路由 name 重复导致 keep-alive 缓存污染、重定向跳 404 | 新增路由后跑 `pnpm typecheck` 之前先全局搜重名 |
| 路由 includes 匹配 | 动态路由组件解析用 `includes`（`router/utils.ts` 第 333-335 行），`/system/user` 会匹配到 `/system/user/xxx` | 后端下发 path 时避免前缀包含关系，或显式给 component |
| Node 版本管理器 | fnm 用户非交互 shell 里 `cd` 进项目可能报环境变量错误 | shell 配置里加载 `fnm env` |
| 移动端 | 760px 以下仅折叠降级 | 移动端需求另起方案，别改造它 |

## 构建与部署

生产构建相关的事实清单：

- `pnpm build` 产物在 `dist/`，静态资源按 `static/js`、`static/[ext]` 分类（`vite.config.ts` 的 `rolldownOptions.output`），chunk 警告阈值 4000kb。
- 部署子路径要改两处：`.env.production` 的 `VITE_PUBLIC_PATH`（当前 `/vue-pure-admin-max/`）与 Nginx 的 root/try_files 配置。路由历史默认 hash 模式（`VITE_ROUTER_HISTORY`），hash 模式不需要服务端路由回退配置；想切 h5 模式必须配 try_files 兜底 index.html。
- 压缩产物用 `.env.production` 的 `VITE_COMPRESSION`（可选项见该文件注释：gzip、brotli、both 及对应 `-clear` 变体），实现在 `build/compress.ts`。
- CDN 加速用 `VITE_CDN = true`，依赖映射在 `build/cdn.ts`。
- 构建信息（版本、构建时间）由 `build/info.ts` 打印；`vite-plugin-remove-console` 会在生产移除 console（`build/plugins.ts` 第 70 行，iconfont 被显式豁免）。
- 版本更新检测依赖 `version-rocket`（package.json 依赖），配合 `public/platform-config.json` 的 `Version` 字段提示用户刷新。

## 上线前检查单

逐项打勾后发布：

| # | 检查项 | 验证方式 |
| --- | --- | --- |
| 1 | 生产 mock 已关闭 | `build/plugins.ts` 中 `enableProd: false` |
| 2 | 平台配置已品牌化 | `platform-config.json` 的 Title、Logo、主题、amapKey |
| 3 | 演示菜单已裁剪 | 登录后逐个点菜单，无空白或 404 页 |
| 4 | 真实登录可用 | 用真实后端账号登录，含"记住我"与登出再登 |
| 5 | token 无感刷新可用 | 把后端 accessToken 有效期临时调成 60 秒，挂机等过期后继续操作不掉线 |
| 6 | 权限两把尺子验证过 | admin 与普通账号各登录一次，核对菜单与按钮差异 |
| 7 | 部署路径正确 | 子路径部署下刷新任意页面无白屏 |
| 8 | 浏览器兼容达标 | 构建目标 es2015（`vite.config.ts` build.target），按业务需要真机验证 |
| 9 | `pnpm typecheck` 与 `pnpm lint` 通过 | CI 或本地执行，零报错 |
| 10 | 授权合规 | 根目录 `README.md` 授权条款：未公开源码、未转售 |

## 学习路径收束

把系列十一篇连成一条从新手到能扛活的路径：

```
入门（第 1 天）     01 认识框架 → 02 跑起来
核心机制（第 1 周） 03 启动 → 04 路由 → 05 认证权限 → 06 Mock 与接后端
进阶（第 2-3 周）   07 网络层 → 08 布局主题 → 09 组件生态
实战（第 1 个月）   10 新增业务模块 → 11 本篇：裁剪、上线
```

之后的精进方向按需选择：精读 `src/views/system/` 全家桶掌握复杂业务形态（树表、字典联动、租户套餐）；跟读 pure-admin 官方文档与开源仓库的 issue 区，框架的很多机制（keep-alive 拍平、路由二次触发）在那里有第一手讨论；如果你们要上微前端或 SSR，那是超越本模板边界的架构决策，先想清楚再动手。

本系列到此完结。文中任何路径与你手上的代码对不上时，以代码为准——模板代码会升级，而读源码的能力才是这个系列真正想交给你东西。
