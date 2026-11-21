# 01 入门：把项目跑起来，看清它的骨架

本篇你会搞懂三件事：

1. 这个项目"是什么"——它是壳子不是产品，后端是假的，但工程是真格的。
2. 怎么把它跑起来，用什么账号登录。
3. 源码目录怎么分布，每个目录负责什么。

## 一句话定义

pure-admin-thin-max-ts 是一套"后台管理系统的前台壳子"：登录、菜单、权限、布局这些每个后台系统都要写的东西它已经写好了，业务页面只留了四个示例（字典、排班、租户、权限演示），后端接口全部由本地 mock 提供。类比一下：它是一间精装修的门店，货架位置、收银台、门禁都装好了，货（业务数据）要你自己进。

## 它"max"在哪，"thin"在哪

开源版 [pure-admin-thin](https://github.com/pure-admin/pure-admin-thin) 是 vue-pure-admin 砍掉所有演示页面的极简版。本仓库是作者 xiaoxian521 的付费版本（见 `README.md` 的授权说明），在 thin 基础上加回了少量企业级功能，这是它区别于开源 thin 版的地方：

| 功能 | 位置 | 说明 |
| --- | --- | --- |
| 字典管理 | `src/views/dict/` | 左侧字典树 + 右侧字典详情表格 |
| 日历排班 | `src/views/schedule/` | el-calendar 上做早/中/晚三班排班 |
| 租户管理 | `src/views/tenant/` | 租户列表 + 租户套餐 + 套餐菜单权限 |
| 登录页多租户输入框 | `src/views/login/index.vue:122` | 由环境变量 `VITE_ENABLE_TENANT` 控制 |
| popular 菜单风格 | `src/layout/hooks/useDataThemeChange.ts:96` | 圆角卡片风菜单主题 |

版本号在两处声明且一致：`package.json:3` 与 `public/platform-config.json` 的 `Version` 字段，当前都是 `7.0.0`。

## 跑起来

环境要求写在 `package.json:128-131` 的 `engines` 字段：Node ≥ 22.22.1，pnpm ≥ 11（仓库根目录 `.nvmrc` 声明的是 `v24.18.0`，直接用 nvm 切过去即可）。

```bash
# 安装依赖（preinstall 钩子会强制只允许 pnpm，见 package.json:22）
pnpm install

# 启动开发服务器，预期输出本地地址 http://localhost:8848
pnpm dev
```

端口 8848 来自 `.env` 的 `VITE_PORT`。启动后浏览器访问 `http://localhost:8848`，会重定向到登录页。

### 登录账号

mock 登录接口 `mock/login.ts` 只按用户名返回两种身份，**不校验密码**——密码只需要过前端表单格式校验（`src/views/login/utils/rule.ts`），随便填符合格式的内容即可：

| 用户名 | 角色 | 按钮权限 | 能看到的内容 |
| --- | --- | --- | --- |
| admin | `admin` | `*:*:*`（全部） | 全部菜单：权限、日历排班、字典、租户 |
| common | `common` | `permission:btn:add`、`permission:btn:edit` | 只有"权限管理"菜单，按钮权限残缺 |

用两个账号各登录一次，对比左侧菜单的差异，这是理解第 05 篇权限体系最直观的方式。

## 目录地图

按"配置 → 入口 → 分层"的顺序看，每个目录的职责如下：

```
pure-admin-thin-max-ts/
├── .env / .env.development / .env.production / .env.staging   # 编译期环境变量
├── public/platform-config.json    # 运行时全局配置（标题、布局、主题）
├── mock/                          # 假后端：login、refreshToken、asyncRoutes、system
├── build/                         # vite 构建脚本（插件、cdn、压缩、别名）
├── types/                         # 全局类型声明（路由、组件、指令）
├── src/
│   ├── main.ts                    # 应用入口：配置 → store → router → 挂载
│   ├── config/index.ts            # 运行时配置加载器 getPlatformConfig
│   ├── router/                    # 路由：index.ts 守卫，utils.ts 动态路由引擎，modules/ 静态路由
│   ├── store/modules/             # pinia：user、permission、multiTags、app、epTheme、settings
│   ├── api/                       # 接口定义：user(登录)、routes(动态菜单)、system(字典/租户)
│   ├── utils/
│   │   ├── http/index.ts          # axios 封装 PureHttp（token 无感刷新在这里）
│   │   └── auth.ts                # token 存取、角色/按钮权限判断
│   ├── layout/                    # 整个外壳：侧边栏、导航栏、标签页、设置面板
│   ├── components/                # 业务无关组件：ReAuth、RePerms、ReDialog、PureTableBar 等
│   ├── views/                     # 页面：welcome、login、permission、schedule、dict、tenant、error
│   ├── directives/                # 自定义指令（v-ripple 等）
│   └── style/                     # 样式：reset、tailwind.css、index.scss
└── Dockerfile                     # 两阶段构建：node 构建 → nginx 托管
```

三条主干线贯穿全仓库，后续每篇都围绕它们展开：

- **路由线**：`src/router/index.ts`（守卫）+ `src/router/utils.ts`（动态路由引擎）+ `mock/asyncRoutes.ts`（菜单数据源）
- **认证线**：`src/utils/auth.ts`（存取）+ `src/utils/http/index.ts`（刷新）+ `src/store/modules/user.ts`（动作）
- **配置线**：`.env*`（编译期）+ `public/platform-config.json`（运行时）+ `src/utils/responsive.ts`（用户偏好）

## 做第一个修改

改 `public/platform-config.json` 的 `"Title": "PureAdmin"` 为任意值，保存后刷新浏览器：登录页标题和浏览器标签页后缀会跟着变（标题的读取逻辑在 `src/router/index.ts:139-144`）。这个改动不用重启 dev server，因为该文件是运行时通过 axios 拉取的（第 02 篇展开）。

再改一个需要重启的：把 `.env` 的 `VITE_HIDE_HOME = false` 改为 `true`，重启后首页菜单消失，手动访问 `/welcome` 会跳 404（守卫逻辑在 `src/router/index.ts:156-158`）。环境变量是编译期注入的，改完必须重启。

两处改动的差异（一个热生效、一个要重启）正是 02 篇的主题。

## 自检清单

1. admin 和 common 登录后菜单为什么不一样？菜单数据从哪个请求来的？
2. `pnpm dev` 的端口想改成 9000，应该改哪个文件？改完要不要重启？
3. mock 的登录接口校验密码吗？这对联调真实后端意味着什么？

能答上 1 和 2，进入 [02 配置体系](./02-config-system.md)。
