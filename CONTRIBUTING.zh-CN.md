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

# 参与贡献

[English](CONTRIBUTING.md)

Bug 反馈与具体改进提案请提交 [Issues](https://github.com/apache/maka/issues)，开放式讨论使用 [Discussions](https://github.com/apache/maka/discussions)，安全漏洞请按 [SECURITY.md](SECURITY.md) 私密上报。在未分配的 Issue 下单独回复 `take` 即可认领，回复 `untake` 释放认领。

涉及项目方向、社区治理与重大产品决策的话题请在 [dev@maka.apache.org](https://lists.apache.org/list.html?dev@maka.apache.org) 邮件列表讨论；具体实现细节直接在 PR 里交流即可。

## 本地开发

需要安装 Rust stable、Node.js 24+（CI 使用 26）、npm、`just`、`cargo-nextest`、`cargo-deny` 与 Python 3。Windows 环境需将 Git for Windows 自带的 `sh` 加入 `PATH`。

```sh
just setup
just run --help
just check
```

`just check` 会跑完全仓格式、类型、测试与许可证检查。日常修改单个 Rust crate 时，建议先跑定向测试快速验证：

```sh
cargo nextest run -p <crate> --lib
```

本地 `just` 与 GitHub Actions 共用 [`scripts/ci.mjs`](scripts/ci.mjs) 中的测试套件定义。变更范围计算、V8 预编译缓存与原生打包说明见 [scripts/rust](scripts/rust/README.zh-CN.md#ci)。[官网](website/README.md)使用独立的 manifest 与锁文件。

## 代码与文档约定

- 子模块统一采用 `name.rs` + `name/` 目录结构。单元测试紧挨实现放置，集成测试放在 `tests/`。
- 测试外部可观测行为与关键失败边界，不写源码字符串断言、重复夹具或硬编码 `sleep`。
- 校验放在系统边界，内部信任类型契约；用枚举表达闭合状态机，通过 `schemars` 生成协议 schema，数据库变更走 SQLx migration。
- 业务策略留在插件内，由 Host 统一管理准入控制、能力句柄与资源回收。
- 协议字段与界面文案解耦；新增界面文案时同步补齐 `en`、`zh-CN`、`zh-TW` 三语词条。
- 只在真正能帮读者省时间的地方写文档。已维护的中英文指南保持语义同步，字段级细节直接链向源码或生成好的 schema。

## 提交与评审

PR 标题遵循 Conventional Commits，分支命名为 `<type>/<description>`。仓库采用 squash merge，PR 标题即最终合入的 commit 标题。按 [PR 模板](.github/pull_request_template.md)写明改动结果与实际跑过的验证，涉及界面改动时附上截图或录屏。

每份贡献都必须有明确的人类负责人对代码质量、来源合规与 [Apache-2.0](LICENSE) 许可负责。引入或改编第三方代码时，严格保留原始版权声明并核对[源码来源记录](docs/code-origin-audit.md)与[许可证头规范](.github/ASF_SOURCE_HEADERS.md)。

若使用了生成式 AI 完成实质性的代码或文档编写，需在 PR 中注明工具名称，并在相关 commit 尾部保留 `Generated-by: <tool>` trailer（常规自动补全、拼写纠错和润色翻译不在此列）。

Agent 可以提交代码和推送分支；合入受保护主干仍需通过 CI 检查并获得另一位人类 committer 的独立批准。
