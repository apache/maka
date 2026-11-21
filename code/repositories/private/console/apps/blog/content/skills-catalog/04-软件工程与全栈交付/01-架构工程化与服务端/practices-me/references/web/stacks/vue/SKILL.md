---
name: vue-me
description: Vue3 与 React 分叉点。Use when working on Vue 3 / Vue 2 Options API pages, Pinia vs Zustand choice, v-html rendering, oversized SFC files, Vue Router guards, or migrating Vue 后台 modules. Do not duplicate React directory or CSS rules; those stay in web-me and css-me.
---

# Vue 与 React 分叉点

## 使用定位

本专题只收 Vue 与 React 真正分叉的几条。目录、命名、质量门、业务 UI 契约仍走 `web-me`、`ui-me`、`quality-me`、`css-me`。

## 何时读本专题

| 信号 | 动作 |
| --- | --- |
| `.vue` 单文件、Options API、`Pinia`、`v-html` | 读本专题，再回通用前端专题 |
| React / Taro / Zustand | 不要用本专题替代 `zustand` / `taro` |

## 分叉规则

### Options 大文件

超过约 400 行的 Options SFC 按「模板 / 状态 / 请求 / 副作用」拆：

- `setup` 或 composable 承接请求与生命周期。
- 模板只绑定已映射的视图模型。
- 不要在 `methods` 里堆字段映射和路由跳转。

React 侧对应的是 `index.tsx` + `index.hook.ts`，规则在 `web-me`。

### `v-html`

| 来源 | 处理 |
| --- | --- |
| 内部白名单函数输出的固定片段 | 可接受，但优先改成组件 |
| 接口、AI、富文本、用户输入 | 必须消毒、标注来源、补 XSS 测试 |

不要把 `v-html` 当普通插值。React 的 `dangerouslySetInnerHTML` 同一条门禁，收在 `quality-me`。

### Pinia vs Zustand

| 场景 | 选择 |
| --- | --- |
| Vue 模块跨组件业务态 | Pinia store，selector 订阅最小字段 |
| React 模块 | Zustand，走 `zustand-me` |
| 纯 UI 临时态 | 组件内 ref / reactive，不进全局 store |

清理口径两边相同：卸载时停掉轮询、定时器、WebSocket；不要把不可序列化运行时对象放进 store。

## 反模式

- 不把 React 目录规范整份抄进 Vue 项目。
- 不把 Pinia 和 Zustand 规则混写成一份。
- 不在业务模板直接渲染未消毒 HTML。
- 不把本专题扩成完整 Vue 风格指南。

## 输出格式

1. 结论摘要（哪条分叉命中）
2. 修改文件清单
3. 与 React 专题的分工
4. 可执行步骤
5. 验收方式
