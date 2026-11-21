# 08 布局与主题系统

> 本篇目标：讲清布局壳的组装方式、五种布局形态的区别、主题三层的概念、以及"设置面板改一下、全站立即生效还持久化"背后的数据流。

## 一句话定义

布局系统是一个响应式的外壳组件：根据当前布局模式和设备类型，决定侧边栏、导航栏、标签页、内容区怎么拼装；主题系统则通过 CSS 变量和 class 切换实现全站换肤。

类比手机桌面：壳（layout）决定图标网格长什么样，主题（theme）决定壁纸配色，你的设置（responsive-storage）在重启后依然保留。

## 布局壳的组装

入口 `src/layout/index.vue`。它本身不渲染具体界面，而是按状态装配四个子部件：

| 子部件 | 目录 | 职责 |
| --- | --- | --- |
| LayNavbar | `layout/components/lay-navbar/` | 顶部导航：折叠按钮、面包屑、搜索、全屏、国际化、主题快捷按钮、用户下拉 |
| LaySidebar | `layout/components/lay-sidebar/` | 侧边栏，按布局模式选用 NavVertical、NavHorizontal、NavDouble 之一 |
| LayTag | `layout/components/lay-tag/` | 多标签页栏，chrome 风格卡片或简洁风格 |
| LayContent | `layout/components/lay-content/` | 内容区，内嵌 router-view 与 keep-alive 缓存 |

另有三个常驻成员：`lay-setting/`（右侧设置面板，就是那个齿轮弹屉）、`lay-search/`（菜单搜索，Ctrl+E 唤起，历史记录数由配置 `MenuSearchHistory` 控制）、`lay-notice/`（消息通知弹层）。

`layout/hooks/` 下 7 个 hooks 是壳的行为逻辑：`useNav`（导航栏数据）、`useLayout`（布局模式响应式读取）、`useDataThemeChange`（主题切换）、`useTranslationLang`（语言切换）、`useMultiFrame`（多 iframe 页管理）、`useTag`（标签页操作）、`useBoolean`（开关状态）。

## 五种布局形态

在设置面板可实时切换，形态差异如下：

| 模式 | 形态 | 典型场景 |
| --- | --- | --- |
| vertical | 左侧一列菜单 | 经典后台 |
| horizontal | 菜单横排在顶部 | 菜单少的系统 |
| mix | 顶部一级菜单 + 左侧二级菜单 | 菜单两层结构时减负 |
| double（Max 默认） | 左侧窄条一级图标栏 + 展开式二级栏 | Max 版招牌布局，`platform-config.json` 的 `"Layout": "double"` |
| 手机端 | 760px 以下强制 vertical 且默认折叠 | 响应式降级 |

手机端降级逻辑在 `src/layout/index.vue` 的 `useResizeObserver` 回调：宽度小于等于 760 时强制 `setTheme("vertical")` 并收起侧边栏，宽于 990 才恢复。这就是第 01 篇说"它不是移动端方案"的代码依据。

## 主题的三层概念

初学者最容易在这里犯迷糊：为什么有 Theme、ThemeMode、DarkMode 三个配置。它们是三个互相独立的旋钮（`src/utils/responsive.ts` 第 17-25 行的注释区分了它们）：

| 旋钮 | 取值 | 管什么 |
| --- | --- | --- |
| `theme`（页面主题） | light、dark 等 | 布局配色的"套系"，跟 Element Plus 联动 |
| `themeColor`（主题色） | 色值，默认 `#409EFF` | 品牌色，点按钮、选中态用的那个颜色，切深浅色不影响它 |
| `themeMode`（主题模式） | light、dark、system | 明暗模式，system 跟随系统；对应 useDark |

一个记忆法：主题色是"企业 VI"，主题模式是"白天黑夜"，页面主题是"装修套餐"。设置面板顶部的快捷按钮（Max 版功能，`lay-navbar` 里）操作的是主题模式。

换肤的实现分两路：Element Plus 侧通过给 `html` 根元素写 CSS 变量（`--el-color-primary` 等），Tailwind 侧靠 `dark:` 前缀类配合根元素 class。切换动作集中在 `layout/hooks/useDataThemeChange.ts`，改的是存储再由响应式联动，业务组件一般不需要感知。

## 设置项的数据流：从点击到持久化

以"切换布局为纵向"为例，完整链路：

```
设置面板点击"纵向"
  → setTheme("vertical")（layout/index.vue 第 78 行）
      ├─ document.body.setAttribute("layout", "vertical")   // 立即生效，CSS 按属性选择器响应
      └─ $storage.layout = { layout: "vertical", ... }      // 写入 responsive-storage
            → localStorage["responsivemax-layout"] 持久化
  → 下次刷新：injectResponsiveStorage 启动时 Storage.getData 读回，布局恢复
```

这套机制的两个关键角色：

1. **responsive-storage**：让 localStorage 拥有 Vue 响应性。组件里改 `$storage.layout.layout` 等于改 localStorage，同时触发依赖更新。命名空间 `responsivemax-` 来自 `platform-config.json` 的 `ResponsiveStorageNameSpace`，作用是同域名部署多个 pure-admin 项目时存储互不踩踏。
2. **三份存储键**（`injectResponsiveStorage` 注册）：`responsivemax-layout`（布局与主题）、`responsivemax-configure`（界面开关：灰度、水印、隐藏标签页等）、`responsivemax-locale`（语言）。加上 `responsivemax-tags`（标签页持久化，受 `multiTagsCache` 开关控制）。

排查"设置改了不生效"或"改了配置文件没反应"时，第一步永远是看这些键的现值——用户值覆盖配置默认值，这是第 03 篇讲过的规则，在这里最容易实际撞上。

## 标签页系统

`multiTags` store（`src/store/modules/multiTags.ts`）管理标签页，核心是 `handleTags(mode, value)`，mode 有五种：`equal`（整体替换）、`push`（新增，去重）、`splice`（按位置删）、`spliceRoute`（按路由删，含"关闭右侧/其他"）、`deleteTag`。标签页初始内容是 `routerArrays`（`layout/types.ts` 定义，默认含首页）加上动态路由里 `fixedTag: true` 的固定页。

keep-alive 联动：permission store 的 `cachePageList` 记录该缓存的组件 name，`clearCache` 保证"标签页里没有的缓存页会被清掉"，避免缓存泄漏。这就是为什么路由 `name`、组件 `name`、标签页三者必须同名。

## iframe 页面的特殊处理

带 `frameSrc` 的路由渲染为 `layout/frame.vue` 包裹的 iframe。`useMultiFrame` 处理多 iframe 共存与 keepAlive 复活。第 04 篇提过 board、mind、ppt、formdesign 四个 Max 板块全是这类页面。注意 `frameLoading: false` 可关掉 iframe loading 动画（ppt 与 formdesign 就关了，因为外站加载慢，转圈反而像卡死）。

## 下一步

- 壳讲完了，下一章 [09 状态管理与组件生态](./09-ecosystem.md) 把 6 个 store、25 个 Re 组件和工具库串成一张能力地图。
- 动手实验：打开设置面板把布局切成 horizontal，然后看 DevTools 里 `responsivemax-layout` 键的变化；再把该键手动改成 `"layout": "double"` 并刷新，布局随之恢复——你就验证了"设置即存储"这个结论。
