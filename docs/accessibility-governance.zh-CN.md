# 无障碍治理规范

[English](./accessibility-governance.md)

Maka 桌面端的无障碍树有两类读者：使用 VoiceOver 的人，和 Maka 自己的 Computer Use
在驱动另一个窗口。他们想要的东西基本一致；不一致的地方，本文说明以谁为准。

下面所有数字都是 2026-07-29 用 `maka-cu` 的 `snapshot` 对运行中的应用实测的，可复现，
不是举例。

## 0. 现在的树长什么样

615 个元素。网页内容是完整暴露的 —— 树能一直读到真实 DOM，带 role、名称、值、
placeholder 和状态 —— 因为驱动方从外部把它打开了：

```swift
AXUIElementSetAttributeValue(appElement, "AXManualAccessibility", true)
AXUIElementSetAttributeValue(appElement, "AXEnhancedUserInterface", true)
```

Maka 没有调用 `app.setAccessibilitySupportEnabled`，也不需要调用。Chromium 在没人
索取之前不构建这棵树，而驱动方会索取。

## 1. 名称用来标识，不用来汇报状态

这是最要紧的一条，也是当前应用违反的一条。

控件的可访问名称，是两类读者称呼它的方式。如果名称会随控件自身的值改变，那么
对控件动手就等于把找到它的依据改掉了：屏幕阅读器用户会听到值被念两遍，而模型
在动作之后就叫不出这个元素了。

实测，来自输入区：

```
组合框  Description: 权限模式：跳过确认   Value: 跳过确认
                     ^^^^^^^^^^^^^^^^                  同一个事实，出现两次
```

来源是 `packages/ui/src/conversation-copy.ts`：

```ts
modeAriaLabel: (label) => `权限模式：${label}`
```

### 判据

插值本身不是缺陷。要问的是：

> 插进去的这个事实，平台是不是已经在**同一个元素**上暴露过了 —— 作为 `AXValue`，
> 或者作为 `disabled`／`selected`／`expanded` 这类状态位？

| 名称里携带的 | 例子 | 判定 |
|---|---|---|
| 元素自己的值，而 `AXValue` 已有 | `权限模式：跳过确认` | 重复，从名称里去掉 |
| 这个控件作用于哪个对象 | `移除 附件.png`、`kami-report 项目操作` | 那是身份，保留 |
| 平台没有别处暴露的状态 | `显示 12 条更多对话` | 保留，但更应该把状态正经暴露出来 |

第三行不是免死金牌。一个事实如果重要到要写进名称，通常说明它更该待在值或状态里，
让两类读者都不必去解析一个句子。名称是最后的选择。

### 怎么落地

弹出式控件的名称说明它控制什么，当前设置是它的值：

```tsx
// 错 —— 用户一改设置，名称就变了
<Trigger aria-label={`权限模式：${current}`}>

// 对 —— 名称稳定，设置是值
<Trigger aria-label="权限模式">
```

输入区的会话模型切换器已经是对的，可以作为参照：
`Description: 切换当前会话模型`、`Value: Claude Opus 4.6`。

### 忙碌不是新名字

控件不得在自己工作期间改名。四处犯了：

| 控件 | 名称变成 | 而这已经由谁说了 |
|---|---|---|
| 用量刷新 | `刷新中…` | `disabled`、`aria-busy`、`data-pending` |
| 密码复制 | `复制中…`、`已复制` | `disabled` |
| MCP 安装 | `取消中…` | `disabled` |
| 代码块复制 | `复制中…`、`已复制`、`复制失败` | `aria-busy`、`disabled`、`data-copy-feedback` |

进度属于 `disabled` / `aria-busy`，两类读者都读得到。确认属于实时区域 ——
`<span className="maka-visually-hidden" role="status" aria-live="polite">`
是本仓库既有的写法。两者都不属于名称，因为名称是任何人抓住这个控件的唯一把手，
而在操作期间把它拿走，恰好是别人正在等它的时候。

名称因为**动作本身**切换而变是对的，也很常见：停止／刷新、安装／取消、展开／收起。
判据不是用词 —— `loading` 两边都出现 —— 而是处理函数是否随同一个条件切换。
只按词汇判会误报：第一次跑三个命中里两个是误报，所以 `check-a11y.mjs` 现在查处理函数。

## 2. 身份来自 class 名，不来自自动生成的 id

这棵树里没有稳定的逐元素标识，而现存的那些比没有更糟：

| | 数量 |
|---|---|
| 元素 | 615 |
| 带 DOM id（`AXDOMIdentifier`） | 17 |
| 带 CSS class（`AXDOMClassList`） | 198 |

那 17 个全都是 `base-ui-_r_9c_` 这种框架自动生成的 id，来自 React 的 `useId`，
跨渲染会变 —— 看起来稳定，实际不是。不要用它们定位，也不要再制造。

那 198 个 class 名才是本仓库一直在维护的身份 —— e2e 套件今天就在按
`.maka-composer-textarea`、`.maka-list-row`、`.maka-session-panel` 定位。
把交互元素上的 `.maka-*` class 当作公开契约：改名对 e2e 和 Computer Use 都是破坏性变更。

只有在 class 表达不了身份时才加显式 `id` —— 某个东西全局只有一个，而且没有 class
指代它。命名用 `cu-<区域>-<对象>`，让人一眼看出这个 id 是给自动化用的，不是样式钩子。

## 3. 不要把机器标识塞进用户可见的字段

`title` 到树上变成 `AXHelp`，到用户那里变成悬停提示。它是给帮助文本用的。
把标识藏在里面，等于给用户塞了一条他没要的提示。

`aria-roledescription` 同理：macOS 会把它渲染成本地化的角色名（`按钮`、`组合框`），
覆盖它等于把"这个元素**是什么**"换成"我们想叫它什么"。

## 4. 可操作的元素必须带动作

驱动方靠读 AX 动作来决定自己能做什么。一个点得动但不暴露动作的元素，
对 Computer Use 是不可达的，哪怕人用起来毫无问题。落到实践就是：
用真正的 `<button>`、`<a href>`、`<input>`，以及建立在它们之上的 `@maka/ui` primitive。
`<div onClick>` 对两类读者都是隐形的。

`scripts/check-a11y.mjs` 已经会拒绝没有 `aria-label` 的纯图标按钮，以及正的 `tabIndex`。

## 5. 容器要配得上自己的位置

615 个元素里大部分是没有名称的容器。它们在每次观测里都要花 token，而且对两类读者
都不说明任何事。为布局而存在的包装层不应该同时是地标：只有当一个容器聚合的东西
是读者会想整体跳过去的单元时，才给它 `role` 或 `aria-label`。

## 6. 哪些是机器管的，哪些不是

机器管的，在 `scripts/check-a11y.mjs` 里：

- 纯图标按钮必须有名称
- 禁止正的 `tabIndex`
- `aria-label` 不得插入元素自身已经暴露的值（§1）
- 控件不得在忙碌期间改名，除非它的处理函数也随之切换（§1）

机器管不了、因而属于评审责任的：

- 名称是在标识还是在汇报（§1 的判据需要看树才能回答）
- 容器该不该有名称（§5）
- id 稳不稳定（§2）

改交互组件的时候，读树，不要靠推理：

```
maka-cu/.build/release/OpenComputerUse snapshot "Maka"
```

## 7. 已清的欠账

五个汇报状态的名称都修好了，对应的 `a11y-allow` 一条不剩。每一处都是把值搬到实处，
而不是删掉：

| 控件 | 原来 | 现在 |
|---|---|---|
| 权限选择器 | `权限模式：跳过确认` | `权限模式`，值 `跳过确认` |
| 项目选择器 | `选择项目：kami-report` | `选择项目`，值作为 described-by 的子节点 |
| 分支切换器 | `切换分支：main` | `切换分支`，同一形状 |
| 模型 chip | `<span>` 上用 `aria-label` 写 `当前模型：X` | 文本旁的视觉隐藏前缀 —— 静态展示的名称就是它的内容，`aria-label` 只是把内容盖掉了 |
| 新对话／配置选择器 | `…，当前 X` | 常量；选择器本身是组合框，会自己报值 |

改完之后在运行中的应用上实测：

```
组合框      Description: 权限模式            Value: 跳过确认
弹出式按钮   选择项目
  文本      kami-report
```

项目选择器那条值得看两遍。把值从名称里拿掉之后，它**从树上彻底消失了** ——
`aria-label` 一旦生效，按钮的文本就不再单独暴露。用 `aria-describedby` 指向那个值
的 span 才把它接回来，成为一个子节点，而那正是它该待的地方：名称说明按下做什么，
子节点说明当前选的是什么。

剩下的两条 `a11y-allow` 挂在 `removeSkillAriaLabel` 上，它说明这一行删的是哪个 skill。
那是身份，属于 §1 的第二行。
