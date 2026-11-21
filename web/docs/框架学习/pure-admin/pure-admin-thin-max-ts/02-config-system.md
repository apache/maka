# 02 配置体系：三层配置各管一段

本篇你会搞懂三件事：

1. 为什么改标题不用重启、改端口必须重启——编译期与运行时配置的分界线。
2. 用户在界面上改的主题偏好存到哪里，为什么刷新页面不会丢。
3. `wrapperEnv` 做了什么，为什么环境变量要经过它转一手。

## 一句话定义

这个项目的配置分三层：`.env` 系列文件是"出厂设置"（打包时焊死），`platform-config.json` 是"门店手册"（运行时读取、可热替换），responsive-storage 里的用户偏好是"顾客自己调的座椅"（跟随浏览器存储，优先级最高）。类比：出厂设置决定这台车有没有天窗，门店手册决定交车时的默认设置，顾客上车后调的座椅位置以顾客为准。

## 第一层：编译期 .env 文件

`.env` 对所有模式生效，`.env.development`、`.env.production`、`.env.staging` 按 Vite 的 mode 覆盖合并。当前仓库的全部环境变量：

| 变量 | 定义处 | 值 | 作用 |
| --- | --- | --- | --- |
| `VITE_PORT` | `.env` | `8848` | dev server 端口 |
| `VITE_HIDE_HOME` | `.env` | `false` | 隐藏首页菜单，true 时直访 `/welcome` 跳 404 |
| `VITE_ENABLE_TENANT` | `.env` | `true` | 登录页是否渲染"租户名"输入框 |
| `VITE_PUBLIC_PATH` | `.env.development` 等 | `/` | 打包基础路径 |
| `VITE_ROUTER_HISTORY` | `.env.development` 等 | `"hash"` | 路由模式，支持 `hash`/`h5` 及 `,base参数` 变体 |
| `VITE_CDN` | `.env.staging` | `true` | 打包时把 vue 等大依赖替换为 CDN 引用（生产默认 false） |
| `VITE_COMPRESSION` | `.env.production` 等 | `"none"` | 打包压缩：gzip/brotli/both 及 -clear 变体 |

两个特性值得注意：

- **代码里读取要过 `wrapperEnv`**。`.env` 文件里的值全是字符串，`build/utils.ts` 的 `wrapperEnv`（`build/utils.ts:51`）负责把 `"true"`/`"false"` 转成布尔、`VITE_PORT` 转成数字，并给出默认值（如 `VITE_ENABLE_TENANT` 默认 `"true"`）。组件里直接 `import.meta.env.VITE_ENABLE_TENANT === 'true'` 拿到的仍是原始字符串（`src/views/login/index.vue:122` 就是这么比的），所以只有走 vite.config 链路的变量才有类型转换。
- **`.env` 里的注释明说了"勿删除"**：`VITE_HIDE_HOME` 和 `VITE_ENABLE_TENANT` 即使不用也要保留定义，因为代码里用 `=== "true"` 的方式判断（`src/router/index.ts:120`、`src/views/login/index.vue:39`），变量缺失与 `false` 在这里行为不同——缺失时值是 `undefined`，判断结果同为 false，但保留定义便于后来者发现开关的存在。

## 第二层：运行时 platform-config.json

`src/main.ts:55` 的启动序列里，第一件事就是 `getPlatformConfig(app)`：它用**裸 axios**（不是项目封装的 http，因为此刻 token 体系还没初始化）请求 `public/platform-config.json`，把内容合并进全局配置（`src/config/index.ts:30-50`）。文件缺失会直接抛出"请在public文件夹下添加platform-config.json配置文件"并中止启动。

这个文件的完整字段（当前值）：

```json
{
  "Version": "7.0.0",
  "Title": "PureAdmin",
  "FixedHeader": true,
  "HiddenSideBar": false,
  "MultiTagsCache": false,
  "KeepAlive": true,
  "Layout": "double",
  "Theme": "light",
  "DarkMode": false,
  "ThemeMode": "light",
  "MenuStyle": "popular",
  "Grey": false,
  "Weak": false,
  "HideTabs": false,
  "HideFooter": false,
  "Stretch": false,
  "SidebarStatus": true,
  "EpThemeColor": "#409EFF",
  "ShowLogo": true,
  "Watermark": false,
  "TagsStyle": "chrome",
  "MenuArrowIconNoTransition": false,
  "CachingAsyncRoutes": false,
  "TooltipEffect": "light",
  "ResponsiveStorageNameSpace": "responsivemaxts-",
  "MenuSearchHistory": 6
}
```

几个高价值字段：

| 字段 | 作用 | 消费位置 |
| --- | --- | --- |
| `CachingAsyncRoutes` | true 时把后端下发的菜单缓存进 localStorage（key 为 `async-routes`），下次刷新不再请求 | `src/router/utils.ts:202-223` |
| `ResponsiveStorageNameSpace` | 用户偏好的 localStorage key 前缀，当前是 `responsivemaxts-` | `src/utils/responsive.ts:8` |
| `KeepAlive` | 页面缓存总开关 | layout 内容区 |
| `MultiTagsCache` | 标签页是否持久化，true 时会额外注入 `tags` 存储 | `src/utils/responsive.ts:36-41` |

因为它是运行时读取的静态文件，**打包后改这个文件不需要重新构建**——这是"改标题不用重新发版"的原因。运维直接改服务器上 `dist/platform-config.json` 即可。

## 第三层：用户偏好 responsive-storage

`src/utils/responsive.ts` 的 `injectResponsiveStorage` 在应用挂载前执行（`src/main.ts:59`），它以 `ResponsiveStorageNameSpace` 为命名空间初始化两组用户偏好：

- `responsivemaxts-layout`：布局模式、主题、暗黑模式、菜单风格等
- `responsivemaxts-configure`：灰色模式、色弱、隐藏标签页、水印、标签样式等

初始化规则是"用户存储优先，platform-config 兜底"：`Storage.getData("layout", nameSpace) ?? { layout: config.Layout ?? "double", ... }`。也就是说用户一旦在设置面板改过，就以浏览器里的为准；清空 localStorage 后回落到 platform-config.json 的值。

新手容易搞混的一点：**同一个配置在代码里可能出现两次默认值**。比如 `HideFooter`，`src/layout/hooks/useLayout.ts` 里的兜底是 `true`，而 `platform-config.json` 里显式配了 `false`，最终用户看到的是 false——因为 platform-config 先覆盖了代码默认值，用户存储又优先于 platform-config。排"为什么我的配置不生效"类问题时，按 **用户 localStorage → platform-config.json → 代码默认值** 的顺序查，从上往下第一层命中即生效。

## 三层如何串起来

```
.env*  ──vite 编译期注入──> 代码里的 import.meta.env（开关类：端口、租户开关、路由模式）
platform-config.json ──启动时 axios 拉取──> 全局 $config（外观与行为默认值）
浏览器 localStorage ──responsive-storage──> 用户改过的偏好（优先级最高）
```

修改后是否需要重启 dev server：`.env` 需要，`platform-config.json` 不需要。

## 自检清单

1. 想让客户部署后自己改系统标题，改哪个文件？需要重新打包吗？
2. `CachingAsyncRoutes` 打开后，菜单更新的时机会有什么变化？（提示：localStorage 里的 `async-routes` 什么时候会过期？——答案是永不过期，除非清存储，第 03 篇展开）
3. 用户把主题改成暗黑后，`responsivemaxts-layout` 里的 `darkMode` 和 `platform-config.json` 里的 `DarkMode` 谁生效？

下一篇 [03 路由系统](./03-routing.md)，全项目逻辑密度最高的一个文件。
