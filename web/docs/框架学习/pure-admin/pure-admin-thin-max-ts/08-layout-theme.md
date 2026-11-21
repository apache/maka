# 08 布局与主题：外壳的可配置边界在哪里

本篇你会搞懂三件事：

1. 四种布局模式分别长什么样，切换时到底换了什么。
2. 设置面板上的每个开关落到代码里是什么：一个 html 属性、一个 CSS 变量，还是一段 storage。
3. popular 菜单风格这个 max 版独有功能是怎么挂进去的。

## 一句话定义

`src/layout/` 是系统外壳：侧边栏、导航栏、标签页、设置面板、内容区都是它的子组件，用户的每次外观调整最终只变成三样东西——responsive-storage 里的一条偏好、html 根元素上的一个属性、或一个 CSS 变量。类比汽车仪表台：所有旋钮都在这一块面板上，但每个旋钮后面接的是不同的线（存储、DOM 属性、样式变量），知道线怎么接，定制外观就不用猜。

## 外壳结构

```
src/layout/
├── index.vue              # 外壳入口，按布局模式挂对应导航组件
├── frame.vue              # 内嵌 iframe 的页面壳（配合路由 meta.frameSrc）
├── redirect.vue           # /redirect 跳板页（标签页刷新用）
├── types.ts               # routerArrays（初始标签页）等类型
├── hooks/                 # useLayout、useDataThemeChange、useTag 等
└── components/
    ├── lay-sidebar/       # 侧边栏：NavVertical / NavHorizontal / NavDouble / NavMix + Logo 等
    ├── lay-navbar/        # 顶部导航：面包屑、全屏、用户下拉、折叠按钮
    ├── lay-tag/           # 多标签页（chrome 风格）
    ├── lay-setting/       # 右侧设置抽屉（外观开关都在这）
    ├── lay-notice/        # 消息通知铃铛
    ├── lay-search/        # 菜单搜索（Ctrl+E 唤起，历史条数取 MenuSearchHistory）
    └── lay-content/       # 内容区，keep-alive 的 router-view 在这
```

**四种布局模式**由 storage 里 `layout.layout` 决定（默认值来自 platform-config 的 `Layout: "double"`）：

| 模式 | 形态 | 对应组件 |
| --- | --- | --- |
| `vertical` | 左侧一列菜单 | `NavVertical.vue` |
| `horizontal` | 顶部一条菜单 | `NavHorizontal.vue` |
| `double` | 顶部一级 + 左侧二级双列 | `NavDouble.vue` |
| `mix` | 混合模式 | `NavMix.vue` |

切换模式只换导航组件，内容区和标签页不动。开源 pure-admin 的默认是 vertical，本仓库 platform-config 显式配了 `double`——这是 max 版的默认观感。

## 设置面板的开关去了哪

`lay-setting/index.vue` 是这些偏好的修改入口，写入口径统一走 responsive-storage（第 02 篇的三层优先级），关键开关的落点：

| 开关 | 落点 | 效果 |
| --- | --- | --- |
| 暗黑模式 | html 根元素 class + storage `darkMode` | element-plus 的 dark 变量与 tailwind dark 联动 |
| 主题色 | storage `epThemeColor` | 写入 element-plus 的 CSS 变量 |
| 菜单风格 popular | html 属性 `data-theme-popular`（`src/layout/hooks/useDataThemeChange.ts:96-100`） | 菜单切换圆角卡片样式 |
| 灰色/色弱模式 | html 的 `filter: grayscale/invert` 类 | 全局滤镜 |
| 隐藏标签页 | storage `configure.hideTabs` | lay-tag 整体不渲染 |
| 标签持久化 | storage `configure.multiTagsCache` | 开启后标签写入 `tags` 存储，刷新恢复 |
| 水印 | storage `configure.watermark` | 全局水印层 |

主题变更的统一入口是 `useDataThemeChange` 的 `dataThemeChange`：它根据当前 storage 状态批量设置 html 属性与 CSS 变量，所以手动改 storage 或调组件方法都能换肤，不必重刷页面。

## popular 菜单风格：max 版独有功能

git 历史里 `64777fe feat: 新增菜单风格高级功能` 就是它。实现很克制，三处协作：

1. `lay-setting/index.vue:252`：风格选择器里多一个 `value: "popular"` 选项。
2. `useDataThemeChange.ts:96-100`：风格为 popular 时给 html 根元素挂 `data-theme-popular` 属性，切换其他风格或暗黑联动时移除（暗黑 + popular 组合有专门处理，见 `lay-setting/index.vue:93`）。
3. 样式层按 `[data-theme-popular]` 选择器覆盖菜单项样式，实现圆角卡片效果。

理解这个模式后，想加第五种菜单风格就是同一个套路：设置面板加选项 → 主题钩子挂属性 → 样式文件写覆盖。

## 标签页与 keep-alive 的关系

`lay-tag` 不只是 UI。每个标签对应一条路由记录，右键菜单里的"刷新"走 `handleAliveRoute`（先从 keep-alive 缓存列表删掉组件 name，100ms 后加回，见 `src/router/utils.ts:283-315`）；关闭标签时 permission store 的 `clearCache` 会把不在任何标签上的缓存页清掉。`platform-config.json` 的 `KeepAlive: true` 是总开关，标签上的缓存登记是细粒度控制——页面没被缓存，九成是路由 meta 忘了写 `keepAlive: true`（第 03 篇的三条件）。

## 新手容易搞混的两件事

1. **"我把 platform-config.json 的 Layout 改了，怎么没变？"** 你的浏览器里已经存了用户偏好（`responsivemaxts-layout`），platform-config 只是首次的兜底。清 localStorage 或在设置面板里切回即可。同理适用于所有外观配置。
2. **"菜单搜索的历史存在哪，会不会泄露隐私？"** 存 localStorage，条数上限是 platform-config 的 `MenuSearchHistory: 6`，只在本机，不随用户走。

## 自检清单

1. 把默认布局从 double 改成 vertical，要动几个地方？对已访问过的用户生效吗？
2. popular 风格在暗黑模式下的行为由哪个文件决定？
3. 标签页右键"刷新"为什么能强制重新渲染已缓存页面？说出 100ms 这个数字背后的机制。

下一篇 [09 构建与部署](./09-build-and-deploy.md)。
