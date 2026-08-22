<!--
  Licensed to the Apache Software Foundation (ASF) under one
  or more contributor license agreements.  See the NOTICE file
  distributed with this work for additional information
  regarding copyright ownership.  The ASF licenses this file
  to you under the Apache License, Version 2.0 (the
  "License"); you may not use this file except in compliance
  with the License.  You may obtain a copy of the License at

      http://www.apache.org/licenses/LICENSE-2.0

  Unless required by applicable law or agreed to in writing,
  software distributed under the License is distributed on an
  "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
  KIND, either express or implied.  See the License for the
  specific language governing permissions and limitations
  under the License.
-->

# perf(desktop): remove models.dev metadata from the renderer startup path

<details open>
<summary><strong>English</strong></summary>

## Problem

Most users configure only a few providers, but Maka currently loads metadata for every provider and hundreds of models on startup. This data should remain behind the main-process authority boundary, with the renderer receiving only the lightweight projection needed for the current UI.

The Desktop AppShell startup path statically loads `packages/core/src/model-metadata.generated.ts`. This models.dev snapshot is currently about 520 KB / 13,988 lines and contains full metadata for roughly 44 providers and hundreds of models.

Measured from the 2026-08-04 renderer build:

| Artifact | Size |
|---|---:|
| `model-metadata.generated.ts` source | 520 KB |
| `EmptyState-*.js` shared chunk containing the metadata | 644 KB |
| `model-catalog-choices-*.js` chunk | 98 KB |
| `index-*.js` entry | 253 KB |
| 29 modulepreload chunks combined | 1,769 KB |

The `EmptyState-*.js` chunk contains 312 references matching model names such as `claude-opus`, `gpt-5.`, and `gemini-2.`, confirming that the snapshot is part of the startup artifact. Electron reads these files locally, so the main cost is renderer-main-thread parsing and evaluation rather than network I/O.

Five independent runtime import paths make the metadata reachable at startup:

1. `thinkingVariantsForModel` → `model-thinking.ts` → `model-metadata.ts`
2. `buildChatModelChoices` → `model-catalog-choices.ts` → `model-catalog.ts`
3. `@maka/ui` `modelMenuGroups` → `PROVIDER_DEFAULTS`
4. `provider-display.tsx` → `PROVIDER_DEFAULTS`
5. `OnboardingHero` → `RECOMMENDED_PROVIDER_TYPES`

Each path eventually reaches `model-metadata.generated.ts`. Removing only one path, or assigning the metadata to a Vite `manualChunks` entry, does not remove the static startup dependency.

The first screen needs only model choices, their thinking levels, provider heading labels, and local display copy for four onboarding providers. Rich metadata such as pricing, context windows, full capabilities, and lifecycle information is used only by the lazy-loaded SettingsModal.

## Desired outcome

Reuse the existing `onboarding:getSnapshot` path. The main process already loads the metadata and should provide the renderer with the lightweight startup projection:

- available chat model choices;
- thinking levels for each connection/model;
- provider fallback labels used by model-menu headings.

The renderer consumes this projection instead of reading the model catalog or metadata at startup. Connection changes continue to use the existing `connections:event → onboarding snapshot refresh` flow; no new IPC channel is needed.

The session health notice uses the last completed snapshot while an event-triggered refresh is in flight, then updates from that pull; it does not wait for another invalidation cycle. Credential lookup failures are projected conservatively as `hasSecret: false`. This replaces the renderer's former optimistic `true` fallback on probe errors, so an unreadable credential surfaces the existing repair path instead of hiding a likely send failure.

Remove the remaining provider-registry dependencies from the startup path:

- `modelMenuGroups` receives the required label from the startup projection instead of reading `PROVIDER_DEFAULTS`.
- `providerDisplay` uses the existing exhaustive `PROVIDER_DISPLAY_COPY`; an unknown cross-version type falls back to the type string and generic local description instead of `PROVIDER_DEFAULTS`.
- OnboardingHero gets its four first-run provider types from a small metadata-free product constant or equivalent lightweight projection instead of importing `RECOMMENDED_PROVIDER_TYPES` at runtime.

Full metadata remains available to the main process and lazy-loaded SettingsModal. The metadata code-generation flow remains unchanged.

Acceptance criteria:

- The startup entry and all of its static transitive dependencies exclude `model-metadata.generated.ts`, `model-metadata.ts`, `provider-registry.ts`, `model-catalog.ts`, and `model-thinking.ts`.
- The startup path no longer statically depends on the renderer's `model-catalog-choices.ts` or `chat-model-selection.ts`.
- Searching startup chunks for `claude-opus|gpt-5\.|gemini-2\.` returns zero; full metadata exists only on lazy Settings paths.
- Model choices, headings, provider logos, and active/new-chat thinking levels remain correct.
- OnboardingHero still shows the four recommended providers with their names, descriptions, and logos.
- Adding, changing, or removing a connection refreshes model choices and thinking levels through the snapshot flow.
- Model management, Daily Review, and provider catalog behavior in SettingsModal does not regress.
- Before/after measurements record the median of ten cold starts and startup JavaScript parse/evaluation time to verify a real improvement.

## Alternatives or workarounds

- **Vite `manualChunks`:** changes file placement but does not break a static import path, so the metadata chunk would still load and execute at startup.
- **A new `connections:listModelChoices` IPC channel:** duplicates the existing prefetched and connection-invalidated onboarding snapshot flow.
- **Reducing or changing the models.dev code-generated snapshot:** the main process and Settings still need the full data; its consumption path, not its generation, is the problem.
- **Sending provider descriptions and badges in the snapshot:** the renderer already has compile-time-complete localized display copy for every `ProviderType`.

</details>

<details>
<summary><strong>简体中文</strong></summary>

## 问题

大多数用户只配置少数几个 provider，但 Maka 当前会在启动时加载全部 provider 和数百个模型的元数据。完整目录应留在 main process 的权威边界内，renderer 只接收当前界面所需的轻量投影。

桌面端 AppShell 的首屏静态依赖会加载 `packages/core/src/model-metadata.generated.ts`。该文件由 `scripts/sync-model-metadata.mjs` 从 models.dev 生成，当前约 520 KB、13,988 行，包含约 44 个 provider 和数百个模型的完整元数据。

2026-08-04 的 renderer 构建实测：

| 产物 | 大小 |
|---|---:|
| `model-metadata.generated.ts` 源文件 | 520 KB |
| 含元数据的 `EmptyState-*.js` 共享 chunk | 644 KB |
| `model-catalog-choices-*.js` chunk | 98 KB |
| `index-*.js` 入口 | 253 KB |
| 29 个 modulepreload chunk 合计 | 1,769 KB |

`EmptyState-*.js` 中可检出 312 处 `claude-opus`、`gpt-5.`、`gemini-2.` 等模型名引用，说明完整快照已进入首屏产物。Electron 从本地磁盘读取这些文件，主要问题不是网络请求，而是 renderer 主线程需要同步解析和执行这批首屏并不需要的数据。

目前有五条独立的首屏运行时依赖链可以触达完整元数据：

1. `thinkingVariantsForModel` → `model-thinking.ts` → `model-metadata.ts`
2. `buildChatModelChoices` → `model-catalog-choices.ts` → `model-catalog.ts`
3. `@maka/ui` 的 `modelMenuGroups` → `PROVIDER_DEFAULTS`
4. `provider-display.tsx` → `PROVIDER_DEFAULTS`
5. `OnboardingHero` → `RECOMMENDED_PROVIDER_TYPES`

这些链最终都会进入 `model-metadata.generated.ts`。只处理其中一条或使用 Vite `manualChunks` 都不会解除首屏静态依赖。

首屏实际只需要模型选项、对应的 thinking levels、provider heading label，以及 4 个首次引导 provider 的本地展示信息。pricing、context window、完整 capabilities、lifecycle 等富元数据只在懒加载的 SettingsModal 中使用。

## 期望结果

复用现有 `onboarding:getSnapshot`，由已经加载元数据的 main process 向 renderer 提供首屏所需的轻量投影：

- 可用的 chat model choices；
- 各 connection/model 对应的 thinking levels；
- model menu heading 所需的 provider fallback label。

Renderer 使用 snapshot 数据渲染首屏，不再自行读取 model catalog 或 model metadata。connection 发生变化时，继续复用现有 `connections:event → onboarding snapshot refresh` 更新投影，不新增 IPC channel。

Session health notice 在 event 触发的异步刷新完成前继续使用上一份 snapshot，当前 pull 返回后立即更新，不需要再等下一轮 invalidation。Credential lookup 失败时会保守投影为 `hasSecret: false`；这取代了 renderer 旧逻辑在 probe 报错时乐观返回 `true` 的行为，使凭据无法读取时进入已有修复路径，而不是隐藏一次很可能失败的发送。

同时切断其余 provider registry 依赖：

- `modelMenuGroups` 从首屏投影获取所需 label，不再直接读取 `PROVIDER_DEFAULTS`。
- `providerDisplay` 使用已有且类型完整的 `PROVIDER_DISPLAY_COPY`；遇到跨版本未知 type 时直接显示 type 和通用本地描述，不再 fallback 到 `PROVIDER_DEFAULTS`。
- OnboardingHero 的 4 个首次引导 provider 使用不依赖 provider registry 的小型产品常量或等价轻量投影，不再运行时引用 `RECOMMENDED_PROVIDER_TYPES`。

完整元数据继续保留在 main process 和懒加载的 SettingsModal 中，codegen 流程保持不变。

验收标准：

- 首屏入口及其所有静态传递依赖不包含 `model-metadata.generated.ts`、`model-metadata.ts`、`provider-registry.ts`、`model-catalog.ts` 或 `model-thinking.ts`。
- 首屏不再静态依赖 renderer 的 `model-catalog-choices.ts` 和 `chat-model-selection.ts`。
- 构建产物的首屏 chunk 中检索 `claude-opus|gpt-5\.|gemini-2\.` 为 0；完整元数据只存在于设置页懒加载路径。
- model picker 的模型、heading、provider logo，以及 active/new-chat thinking level 选项保持正确。
- OnboardingHero 正常显示 4 个推荐 provider 的名称、描述和 logo。
- connection 增删改后，model choices 和 thinking levels 随 snapshot 刷新。
- SettingsModal 中的模型管理、Daily Review 和 provider catalog 功能不回归。
- 记录改动前后 10 次冷启动中位数，以及首屏 JavaScript 解析/执行时间，验证优化是否产生实际收益。

## 备选方案或变通方法

- **Vite `manualChunks`**：只能改变模块所属文件，不能切断静态 import；首屏仍会加载并执行元数据 chunk。
- **新增 `connections:listModelChoices` IPC**：现有 onboarding snapshot 已经在首屏预取，并监听 connection 变更；新 channel 会重复现有机制。
- **修改或缩减 models.dev codegen 快照**：设置页和 main process 仍需要完整元数据；问题在消费位置，不在生成方式。
- **把 provider description/badge 放入 snapshot**：renderer 已有编译时覆盖全部 `ProviderType` 的本地文案，重复传输没有必要。

</details>
