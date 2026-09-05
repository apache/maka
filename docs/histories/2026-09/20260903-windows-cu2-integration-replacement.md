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

## [2026-09-03] | Task: 重建 Windows `maka.cu/2` 集成

### Changes

- 在最新 `apache/main` 上让现有 `MakaCuService`/`maka.cu/2` 后端复用到
  Windows；没有增加第二套 service 或 model-facing 协议。
- Desktop 按 `windowsCu` manifest 选择 helper，并校验目录内文件集合、大小和
  SHA-256；electron-builder 只在 `distributionReady=true` 时打包它，并在此时
  helper 缺失则直接失败。
- 增加 `prepare-windows` artifact 准备命令。该本地命令固定保持
  `distributionReady=false`，不再信任调用者写入 provenance JSON 的布尔字段。
  未来只能由机械验证 exact digest/attestation、Authenticode、clean-machine 和
  packaged conversation 的发布流水线开启。
- source build 使用 `--locked --target x86_64-pc-windows-msvc`；安装包验证器在
  ready 时校验完整文件集合/大小/hash，并要求 Authenticode 状态为 `Valid`。
- 未带回旧 PR 的 generated JSON、raw outputs、experiments 或兼容输入代码。

### Verification

- `npm run build --workspace @maka/computer-use`：通过。
- `node --test scripts/prepare-windows-cu-helper.test.mjs`：4 passed。
- Desktop main typecheck 的本次文件无诊断；全量 typecheck 被主线既有的无关
  类型错误阻断。
- 未执行真实 Windows clean-machine/packaged conversation E2E，未提交或推送。
