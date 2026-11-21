---
name: nutui-me
description: NutUI 组件使用与适配实践。Use when implementing or reviewing NutUI forms, popups, pickers, tabs, calendars, toasts, overlays, themes, style overrides, Taro H5/weapp compatibility, or replacing custom controls with NutUI components.
---

# NutUI 实践

## 使用定位

用于 Taro / React 项目里使用 NutUI 组件时的选择、覆盖、适配和验收。业务布局先看 `ui-me`，样式细节看 `css-me`，多端差异看 `taro-me`。

## 使用原则

- 只在组件能力匹配时使用 NutUI，不为了统一而替换稳定自研组件。
- 表单、弹窗、选择器、日历、Toast 优先看项目里已有封装。
- 覆盖样式必须限定在当前模块容器下，避免污染全局 NutUI 类名。
- H5、小程序、老安卓 WebView 分开验收，不用一个端的表现推断所有端。
- 对弹窗和选择器重点检查遮罩、滚动、底部按钮、安全区和键盘压缩。

## 反模式

- 不写宽泛 `:global(.nut-*)` 覆盖。
- 不用 NutUI 组件绕开已有业务权限或数据校验。
- 不在没有设计差异依据时重写主题色。