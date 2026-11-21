# 03 启动链路：从 main.ts 到页面出现

> 本篇目标：逐行讲清 `src/main.ts` 这 70 行代码，理解"运行时配置"这个贯穿全框架的设计。读完你能回答：为什么改 `platform-config.json` 不用重启，为什么权限组件能全局直接用。

## 一句话定义

启动链路就是一份装配清单：把指令、全局组件、插件、路由、状态按顺序装到 Vue 应用实例上，最后挂载到 DOM。

类比汽车的总装线：零件（插件、组件、指令）各自造好，总装线（main.ts）按固定顺序把它们拧到车架（app 实例）上，点火（mount）之前还要刷一次行车电脑固件（拉取 platform-config.json）。

## main.ts 全流程

文件位于 `src/main.ts`，共 71 行，做五件事。按执行顺序列表：

| 顺序 | 代码位置 | 做了什么 |
| --- | --- | --- |
| 1 | 第 30-33 行 | 批量注册 6 个自定义指令（`v-auth`、`v-copy`、`v-longpress`、`v-optimize`、`v-perms`、`v-ripple`） |
| 2 | 第 36-49 行 | 全局注册 3 个图标组件（`IconifyIconOffline`、`IconifyIconOnline`、`FontIcon`）和 2 个权限组件（`Auth`、`Perms`） |
| 3 | 第 57 行 | `getPlatformConfig(app)` 异步拉取运行时配置 |
| 4 | 第 58-61 行 | 装配 Pinia、挂路由、等 `router.isReady()`、注入响应式存储 |
| 5 | 第 62-70 行 | 注册 i18n、Element Plus、pureadmin Table、VxeTable、ECharts，最后 `app.mount("#app")` |

注意第 4 步的顺序细节：`await router.isReady()` 之后才 `injectResponsiveStorage`。路由先就绪，是为了让首次导航的守卫（第 04 篇）能在存储注入前完成判断。

样式文件的引入顺序也有讲究。`main.ts` 第 20 行的注释写明：tailwind.css 必须在 main.ts 引入，否则 Vite 每次 HMR 都会重新请求 `src/style/index.scss` 整个文件，热更新会明显变慢。这是作者踩过坑留下的注释，别随意调整这三个样式文件的顺序。

## 运行时配置：这个框架最值得学的设计

### 它解决什么问题

大多数 Vue 项目把标题、主题、布局开关写在 `.env` 或硬编码里，改一次重新构建一次。pure-admin 把这类"部署时才定"的配置抽到了 `public/platform-config.json`，运行时用 axios 拉取、注入全局。

类比酒店入住：房间（代码）是建好的，但空调温度、 minibar 清单（配置）是入住时才写进房卡的。换客人不用重新盖楼。

### 工作机制

核心只有两个函数，都在 `src/config/index.ts`（共 56 行）：

- `getPlatformConfig(app)`：第 30-50 行。发 GET 请求拉 `${VITE_PUBLIC_PATH}platform-config.json`，把返回对象 `Object.assign` 到 `app.config.globalProperties.$config`，同时存入模块级变量。失败会抛出明确错误"请在 public 文件夹下添加 platform-config.json 配置文件"。
- `getConfig(key?)`：第 11-27 行。支持点号路径取值，比如 `getConfig().Title`、`getConfig().ResponsiveStorageNameSpace`。全框架读取配置统一走它。

`platform-config.json` 里每个字段的含义（文件本身无注释，这里补全）：

| 字段 | 当前值 | 作用 |
| --- | --- | --- |
| `Title` | PureAdmin | 浏览器标签标题后缀、水印等展示位 |
| `Layout` | double | 默认布局，可选 vertical、horizontal、mix、double |
| `Theme` / `ThemeMode` / `DarkMode` | light / light / false | 三层主题控制，区别见第 08 篇 |
| `KeepAlive` | true | 页面缓存总开关 |
| `CachingAsyncRoutes` | false | 动态路由是否缓存到 localStorage（见第 04 篇） |
| `MultiTagsCache` | false | 标签页是否持久化 |
| `ResponsiveStorageNameSpace` | responsivemax- | localStorage 键名前缀 |
| `MapConfigure.amapKey` | adc139d... | 高德地图 key，地图页在用，生产部署记得换成自己的 |

### 为什么改了不用重启

dev server 下 `public/` 目录是静态文件服务，浏览器每次加载都拿到最新 JSON。而配置的消费者（比如 `getConfig().Title`）在路由守卫 `router.beforeEach` 里每次导航都会执行（`src/router/index.ts` 第 140-147 行设置 `document.title`），所以刷新页面配置即生效。

配套的持久化机制在 `src/utils/responsive.ts` 的 `injectResponsiveStorage`：它把 platform-config 的值作为**默认值**写入 responsive-storage（命名空间 `responsivemax-` 下的 `locale`、`layout`、`configure` 三个键）。用户在界面上改过的设置优先于 JSON 文件，想恢复默认就去浏览器清掉这几个 localStorage 键。这一点容易踩坑：改了 `platform-config.json` 却"不生效"，多半是 localStorage 里已经有旧值。

## 全局注册了什么，为什么能全局用

`main.ts` 注册的资产可以在任何模板里直接使用，无需 import。下表是清单和典型用例：

| 全局名 | 类型 | 典型用例 |
| --- | --- | --- |
| `<IconifyIconOffline>` | 组件 | 菜单图标离线渲染，图标集来自 `@iconify/json` |
| `<IconifyIconOnline>` | 组件 | 在线按需加载 iconify 图标 |
| `<FontIcon>` | 组件 | 使用 `src/assets/iconfont` 的自体图标 |
| `<Auth>` | 组件 | 按钮权限（路由 meta.auths 体系），如 `<Auth value="btn:add">` |
| `<Perms>` | 组件 | 按钮权限（登录 permissions 体系） |
| `v-auth` / `v-perms` | 指令 | 同上两种权限的指令形式 |
| `v-copy` | 指令 | 点击复制元素文本 |
| `v-ripple` | 指令 | 点击波纹效果 |
| `v-longpress` | 指令 | 长按触发 |
| `v-optimize` | 指令 | 防抖节流包装 |

权限双体系为什么各注册一份组件和指令，是第 05 篇的主题。

## 最容易误解的一点：main.ts 不是"入口的全部"

很多人以为读懂 main.ts 就懂了启动。实际上它只是装配线，真正的"大脑"藏在两处：

1. `router.beforeEach`（`src/router/index.ts` 第 123 行起）：每次导航都要过它，登录态判断、动态路由初始化、403 拦截全在这里。页面能显示什么，是它说了算。
2. `getPlatformConfig` 的 Promise 时机：`app.mount` 在它的 `.then` 里，意味着这份 JSON 拉取失败时整个应用不会挂载。这也是为什么本地开发时如果 `public/platform-config.json` 被误删，页面会白屏并抛出中文错误提示。

理解了这两点，你就知道排查"白屏"该先看配置文件，再看路由守卫，最后才看具体页面。

## 下一步

- 下一站是启动链路的延续：路由怎么加载、菜单怎么生成，见 [04 路由体系](./04-router.md)。
- 想动手验证配置机制：把 `platform-config.json` 的 `Title` 改成任意文字，刷新页面看标签栏变化；再把浏览器 localStorage 里 `responsivemax-` 开头的键全部清掉，感受"默认值"和"用户值"的区别。
