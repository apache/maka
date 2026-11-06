---
title: 原生后端迁移
description: 从 GPUI 迁移至 AppKit、Direct2D、GTK 和原生终端表面的破坏性变更。
order: 15.5
group: platforms
---

# 从 GPUI 迁移到平台原生后端

本分支移除 GPUI 渲染器及其专用嵌入 API。这是破坏性变更，不提供源码兼容别名。

## 独立应用

使用 `nsh run App.tsx` 选择当前系统的原生后端。显式桌面目标为 `macos`（AppKit）、`windows`（Win32/Direct2D）和 `linux`（GTK 4/Pango）；测试与打包使用相同的原生目标。

旧的 `--target gpui` 会明确报错并提供迁移提示，不会悄悄改用其他目标。默认发行包不再构建或分发 `nsh-gpui-host`。

## 嵌入应用

`nsh-platform-gpui`、GPUI `Entity<AppView>`/`Element` 集成、GPUI 原生组件工厂和对应示例均已退役。按宿主平台改用 `nsh-platform-macos::AppView`、`nsh-platform-windows::AppView` 或 `nsh-platform-linux::AppView`；字符终端使用 `nsh-platform-tui::AppView`。

迁移时必须适配宿主的窗口、焦点、输入和组件所有权，并显式保留 EngineConfig、HostChannel、数据目录和能力配置。GPUI 自定义组件需用所选原生工具包重新实现，不能直接作为原生控件传入。

## 终端像素与行为差异

`nsh-terminal` 负责共享像素传输、终端事件和原生表面契约，AppKit 与 Direct2D 提供离屏表面，Kitty/Sixel 不再依赖 GPUI。

- Linux 的像素终端明确回退到字符渲染，包括无显示服务器的会话；GTK 桌面仍需要图形会话。
- Windows 离屏捕获会拒绝外部合成的 WebView/child HWND 内容，而不是返回误导性的空白图像。
- AppKit 自定义组件中的嵌套 tracking area 不保证支持合成离屏交互；AVPlayer 与 backdrop/compositor 捕获仍有原生局限，需要实机验证。
- GTK 恢复普通窗口大小和最大化/全屏状态；绝对位置与显示器选择由桌面合成器负责。
- 原生文本度量、IME、焦点、无障碍与控件行为遵循各平台，不承诺逐像素或逐行为复刻 GPUI。

## 测试与验证

产品桌面及像素回归用例迁移到 macOS/Windows 原生 runner；GTK 在 Xvfb 下测试，共享终端协议独立于显示服务器测试。原生任务在测试选择为空时失败，不把 Linux 不支持的像素执行算作成功。

仅断言已删除 GPUI Entity/Element 实现的测试随 API 退役；共享应用契约保留在 engine/core、产品原生用例和平台回归中。输入、焦点、模态窗口和导航行为需逐项核对，删除旧渲染器不代表所有平台语义已完全一致。

跨平台编译及实机视觉/输入验证仍是验收要求；本文不宣称三个桌面平台均已通过。
