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

# 贡献 Maka

[English](CONTRIBUTING.md)

缺陷和具体提案使用 [Issues](https://github.com/apache/maka/issues)，一般问题使用 [Discussions](https://github.com/apache/maka/discussions)，安全漏洞通过 [SECURITY.md](SECURITY.md)报告。认领未分配 issue 时，评论内容只写 `take`；放弃认领只写 `untake`。

项目方向、治理和重要产品决策在 [dev@maka.apache.org](https://lists.apache.org/list.html?dev@maka.apache.org)讨论。实现细节可以在 PR 中讨论。

## 开发

安装 Rust stable、Node.js 26、npm 12.2.1、just、cargo-nextest 和 Python 3。许可证检查还需 cargo-deny。Windows 需要将 Git for Windows 的 `sh` 加入 `PATH`。

```sh
just setup
just run --help
just check
```

`just check` 执行格式、lint、类型、测试和许可证检查。针对 Rust 局部修改，可运行 `cargo nextest run -p CRATE`；通过 `--lib` 或 `--test NAME` 限制构建的测试目标。先运行与改动行为相关的检查，再做完整仓库检查。

[产品指南](products/maka/README.zh-CN.md)说明 TypeScript 开发方式，[插件指南](plugins/README.zh-CN.md)介绍声明与组合。原生打包和 V8 要求见 [scripts/rust](scripts/rust/README.zh-CN.md)。[官网](website/README.md)使用独立的 manifest 和锁文件。

`just` 与 CI 共用[套件定义和执行命令](scripts/ci.mjs)。通过 [CI 命令](scripts/rust/README.zh-CN.md#ci)查看受影响范围的计划或在本地复现套件。

## 代码与文档

- 使用 `name.rs` 和同名 `name/` 目录组织子模块。单元测试与实现放在一起，集成测试位于 `tests/`。
- 测试可观察行为和重要失败边界，避免重复夹具、源码文本断言和固定延时。
- 领域策略留在插件，Host 管理准入和资源结算，服务接收显式能力。
- 用类型表达闭合状态，通过 `schemars` 生成 schema。数据库变更使用 SQLx migration。
- 协议字段与本地化文案分离，保留完整的 `en`、`zh-CN` 和 `zh-TW` locale。
- 维护简洁的中英文 README，说明职责和有用入口；字段级细节链接到 schema。

## 提交与评审

标题使用 Conventional Commits，分支使用 `<type>/<description>`。填写 [PR 模板](.github/pull_request_template.md)，说明结果及相关验证；UI 变更附截图或录屏。仓库使用 squash merge，PR 标题会成为最终提交标题。

每份贡献都需要一位人类负责人，对准确性、来源和许可负责。只提交有权贡献的内容，遵循 [Apache-2.0](LICENSE)，保留第三方归属信息。参阅[来源记录](docs/code-origin-audit.md)和[文件头规范](.github/ASF_SOURCE_HEADERS.md)。

在 PR 中披露实质性的生成工具使用并注明工具名称。翻译、措辞修改、自动补全和拼写修正不计入此范围。包含实质性 AI 编写内容的提交应携带 `Generated-by: <tool>`，并在 squash 或 amend 后保留。自动消息应表明身份。

Agent 可以提交和推送。合并到 `main` 需要另一位 committer 批准，并通过 `test` 检查。AI 评审不能替代独立的人类判断。后续推送不会自动撤销已有批准；变更超出原评审范围时，应再次请求评审。维护者决定评审是否充分。
