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

# Maka CLI npm 发布操作手册

[English](./cli-npm-release.md)

本文档是发布 `maka-agent` npm 安装渠道的操作权威。根目录 `package.json` 仍是 Maka 唯一产品版本权威，`packages/cli/package.json` 必须与其一致。每个公开 npm 版本都必须来自 Stage workflow 验证过的同一个精确 tarball。

ASF 分发基础设施上经 IPMC 批准的源码归档才是 Apache release。npm、Desktop 安装包和
GitHub Release assets 都是从该源码身份构建的便利包，不是额外的 ASF release artifacts。

source RC 阶段的 [npm 预检](../.github/ASF_NPM_RELEASE.md) 是更早执行、且不持有发布凭据的兼容性检查；其 tarball 不会进入正式发布。source release 获批后，Stage 从位于同一获批 commit 的最终产品 tag 重新构建，并成为 npm staging 与 registry 验证所使用的字节权威。这与 Apache OpenDAL 孵化期的实践一致，同时保留了 Maka 更严格的受保护 Environment、staged publishing、2FA 与 Finalize 控制。

## 发布不变量

- 产品 Release workflow 只能从已批准的 ASF source candidate tag dispatch；npm Stage 只能从随后创建的产品 `v<version>` tag dispatch，npm Finalize 只能从 `main` dispatch；
- 预发布版本使用 `next`，稳定版本使用 `latest`；`next` 不得指向比 `latest` 更旧的版本；没有
  更新的预发布版本时，两个 tag 都指向稳定版；
- 不创建 npm 专属 Git tag 或 GitHub Release；`Release` workflow 在 npm staging 前创建产品
  `v<version>` tag 与 Draft，Finalize 是该 Draft 唯一的发布者；
- 在 npm Finalize 与 Desktop 远程 Runtime Host 验收成功前，GitHub Release 必须保持 Draft；
  Draft 为 npm 提供产品身份，发布 Draft 是最终的产品发布动作；
- 不运行 `npm publish`。GitHub Actions 只能运行 `npm stage publish`，由人工 package
  maintainer 使用 npm 2FA 批准 staged package；
- validation、staging、approval 和 finalization 之间不得重新构建；
- 已公开的版本不得复用。修复必须使用新的 prerelease、patch、minor 或 major 版本。

两个 workflow 边界分别是：

1. [Stage CLI npm release](../.github/workflows/release-cli-stage.yml) 解析已有的产品 tag 与 GitHub
   Release，checkout 该产品的精确 commit，构建并验证一个 immutable tarball，记录这个唯一的 tag commit 与 workflow run，进入受保护的 `npm-release` Environment，然后通过 OIDC 提交到 npm staging；
2. [Finalize product release](../.github/workflows/release-cli-finalize.yml) 只接受精确的成功
   Stage run、Release build run 及其自包含 publication record；`main` 上当前已审查的 verifier
   验证公共 registry 字节、signature、provenance、dist-tag、不可变 build artifacts 与 live Draft
   digest，然后等待受保护的 `product-release` Environment；独立 Desktop 验收完成并批准后，它会
   用受保护 workflow 的身份证明精确便利包，并在同一个操作中发布 GitHub Release 及其 Stable/Latest 分类。

## 一次性控制面配置

### GitHub Environment

仓库中的 `.asf.yaml` 是 `npm-release` 和 `product-release` Environment 的权威。该配置进入 `main` 后，确认 ASF
同步出的 live 配置满足：

- `npm-release` 使用 selected `v*` tag rule，`product-release` 使用 selected `main` branch rule；
- required reviewer 为 `M4n5ter`；
- 禁止 self-review；
- 仓库策略允许时禁用 administrator bypass。

检查或修复同步结果需要仓库 administration 权限；不要再在 GitHub UI 中维护第二套手工
Environment policy。Finalize 使用 GitHub Actions OIDC 为精确便利包生成 Sigstore provenance，
并把离线验证 bundle 与便利包放在一起；不需要仓库 administration credential、签名私钥或 npm token。

### npm Trusted Publisher

在 `maka-agent` package settings 中配置一个 GitHub Actions trusted publisher：

| 字段 | 值 |
| --- | --- |
| Organization or user | `apache` |
| Repository | `maka` |
| Workflow filename | `release-cli-stage.yml` |
| Environment name | `npm-release` |
| Allowed actions | 仅 `npm stage publish` |

Workflow filename 区分大小写，并且不包含 `.github/workflows/` 前缀。这个 trust relationship
不得启用 `npm publish`。

第一次 OIDC Stage 成功后，将 package publishing access 设置为 **Require two-factor
authentication and disallow tokens**，然后撤销不再使用的 publish token。不要在这一步移除
人工 package owner 或恢复权限。

## 准备发布

1. 将本次包、文档和发布变更全部合并到 `main`，准备 ASF source candidate，并完成 podling 和 Incubator PMC 两轮投票；
2. 确认已批准 source commit 上的根产品版本、`apps/desktop/package.json` 与 `packages/cli/package.json` 是同一个尚未使用的目标版本。npm 渠道会把 prerelease 映射到 `next`，stable 映射到 `latest`；
3. 从精确的已批准 `v<version>-incubating-rc<rc>` tag dispatch 产品 `Release` workflow，并将同一个 tag 作为 `source_reference_tag`。确认其 Draft `v<version>` Release 指向已批准 commit；npm staging 消费这个身份，不能先于它运行；
4. 确认目标版本既不在公共 registry，也不在 staged package 中：

   ```sh
   version=0.1.0-beta.1
   npm view "maka-agent@$version" version --registry https://registry.npmjs.org/
   npm stage list maka-agent --registry https://registry.npmjs.org/
   ```

   第一个命令应报告目标版本不存在。如果已经存在同版本 stage，先处理它，不要再次提交；
5. 确认 `npm-release` Environment 和 Trusted Publisher 仍与上面的值一致，并确认负责批准的
   npm 账号已经启用 2FA。

## Stage 候选包

1. 使用精确产品 tag 作为 GitHub ref dispatch workflow：

   ```sh
   version=0.1.0-beta.1
   gh workflow run release-cli-stage.yml --ref "v$version" -f version="$version"
   ```

2. 确认新建的 run 使用 `v<version>`。workflow 要求其 GitHub ref、checkout、产品 tag、Release、source commit 和 npm provenance 全部指向这一个 tag commit，并要求该 commit 仍是 `main` 的 ancestor；
3. 等待可复用 package validation jobs 全部通过。它们只构建一个 tarball，并在 Linux x64/arm64、
   macOS arm64、Windows x64 上验证安装态 CLI，在 Linux x64 上运行真实 Harbor 和 Pier
   Docker cell；
4. 审查并批准 `npm-release` Environment deployment；
5. 从 run summary 和 `cli-staged-release-<attempt>` artifact 记录成功 Stage workflow 的 run
   ID、run attempt、source commit、version 和 staged artifact checksum。

Stage workflow 没有成功结束时，不得在 npm 上批准任何内容。

## 在 npm 上检查并批准

执行下面的检查和审批命令需使用 Node.js 22.14.0 或更高版本和 npm 11.15.0 或更高版本。Stage workflow 使用自身经过审查的工具链：workflow 固定的 Node.js 版本，以及仓库 `packageManager` 固定的精确 npm 版本。

```sh
npm stage list maka-agent --registry https://registry.npmjs.org/
stage_id=replace-with-reviewed-stage-id
npm stage view "$stage_id" --registry https://registry.npmjs.org/
npm stage download "$stage_id" --registry https://registry.npmjs.org/
```

批准前必须：

- 确认 package name、version、dist-tag、provenance 和 source repository 与 Stage run 一致；
- 将下载的 staged tarball SHA-256 与 workflow artifact 的 `.tgz.sha256` 比较；
- 检查文件清单和包内 `README.md`；
- 确认 tarball 属于所记录的 Stage run 和 source commit。

批准前的最后一步，重新检查 Stage run 记录的 live 产品权威：

```sh
set -eu
source_commit=replace-with-stage-recorded-commit
node scripts/product-release-authority.mjs verify-draft \
  "v$version" "$source_commit" apache/maka
```

verifier 必须成功。tag 不存在、已移动、不再位于 `main`，匹配的 GitHub Release 不再是 Draft，
或 prerelease 分类与版本不一致时都必须停止。

只批准这个 stage ID。npm 会要求 2FA，并在批准时将 package 公开：

```sh
npm stage approve "$stage_id" --registry https://registry.npmjs.org/
```

也可以在 npmjs.com package 的 **Staged Packages** 页面完成相同的检查和批准。

稳定版获得批准后，检查公共 dist-tags：

```sh
version=0.1.0
npm view maka-agent dist-tags --json --registry https://registry.npmjs.org/
```

如果 `next` 不存在或比 `latest` 更旧，使用 npm package owner 身份进行交互式认证，并在运行
Finalize 前将其推进到新的稳定版：

```sh
npm dist-tag add "maka-agent@$version" next --registry https://registry.npmjs.org/
```

如果 `next` 已经指向 `0.2.0-beta.1` 之类的更新版本，则不要修改。此步骤有意保留为人工操作：
npm Trusted Publishing 只认证 `npm publish` 和 `npm stage publish`，不认证 dist-tag 变更，而
release workflow 不得获得长期 npm token。

## Finalize 产品发布

npm 显示该版本已经公开后：

1. 在 `main` 上打开 **Actions → Finalize product release → Run workflow**；
2. 输入成功 Stage 的 run ID 与精确 attempt、成功 Release build 的 run ID 与精确 attempt，以及
   version；
3. 让 inspection job 验证公共 tarball 字节、checksum、inventory、npm signature、Trusted
   Publishing provenance、发布 dist-tag，并确认 `next` 不比 `latest` 更旧；
4. publication job 等待 `product-release` 批准期间，针对 Draft 完成产品检查清单中的跨机器验收；
5. 批准 Environment，并确认 workflow 将每个 live Draft digest 与精确 Release attempt 的
   publication record 对比，生成并上传 `Maka-<version>-attestation.sigstore.json`，发布便利包
   Release；stable release 会同时成为 Latest，不再需要单独人工操作。

检查最终 registry 状态：

```sh
version=0.1.0-beta.1
npm view "maka-agent@$version" version dist.tarball dist.integrity --json
npm view maka-agent dist-tags --json
```

最后，在每个发布平台安装精确的公共版本，并完成一次真实的 TUI/model turn。在支持的 Eval
host 上完成至少一个真实 experiment cell，检查 score、usage、cost 和 artifacts。

[产品发布检查清单](../.github/RELEASE_CHECKLIST.md)仍是批准发布前所需验收证据的权威。

## 失败恢复

### npm staging 之前失败

如果在 `npm stage publish` 前发生瞬时失败，从同一个产品 tag 重新运行 Stage。如果必须修改代码或 workflow，则在 `main` 修复、递增产品版本、创建新的产品 tag 和 Draft，再 Stage 新版本。此时没有消耗 npm 版本。

### Stage workflow 失败，但 npm 中存在 stage

提交是 Stage workflow 的最后一个业务步骤，因此响应丢失可能导致 workflow 未成功但 npm
已经存在 stage。不要批准这个 orphan：Finalize 只接受成功的 Stage run attempt。

检查后，先用 2FA 拒绝精确的 stage ID，再启动新的 Stage run：

```sh
stage_id=replace-with-reviewed-stage-id
npm stage view "$stage_id" --registry https://registry.npmjs.org/
npm stage reject "$stage_id" --registry https://registry.npmjs.org/
```

不要只根据 version 文本拒绝 stage；操作必须绑定到已经检查的 stage ID。

### Stage 成功，但人工检查发现问题

拒绝该 stage，在 `main` 修复、递增产品版本、创建新的产品 tag 和 Draft，再 Stage 新版本。不要为了清空 staging area 而批准有问题的候选。

### npm approval 成功，但 Finalize 失败

npm 版本此时已经 immutable，不要再次 publish 或 approve。保留 Stage run ID、attempt、version，
以及 Release run ID、attempt、publication record 和 artifacts。如果这些字节与 provenance
有效，在 `main` 修复 Finalize verifier，然后针对同一组不可变 Stage 与 Release 证据重新运行。

inspection job 只读；只有受保护的 publication job 可以执行一次 Draft-to-published 转换并证明其字节。如果
npm identity、build evidence 或 Draft 不一致，立即停止并调查；不要修改产品 tag 或 GitHub
Release 来让验证通过。如果错误发生在 publication request 之后，先检查精确 Release；已经成功
完成的发布不得重复执行。

### 公共版本存在缺陷

先把受影响的 dist-tag 指回先前验证过的版本：

```sh
known_good=0.1.0-beta.1
npm dist-tag add "maka-agent@$known_good" next
# 稳定版事故使用 latest，而不是 next。
```

然后只 deprecate 有缺陷的版本，并引导用户使用已经指向验证版本的恢复 dist-tag：

```sh
bad_version=0.1.0-beta.2
recovery_tag=next
# 稳定版事故使用 latest，而不是 next。
npm deprecate "maka-agent@$bad_version" "Known issue; install maka-agent@$recovery_tag."
```

验证 dist-tags、修复缺陷，然后通过完整 Stage 和 Finalize 流程发布新版本。不要把
`npm unpublish` 当作常规回滚：删除 immutable dependency bytes 会破坏现有安装，也不能恢复
经过审查的发布链。

## 所有权和紧急恢复

- GitHub repository admin 负责 `npm-release` Environment 配置；release maintainer 负责
  dispatch、Environment review、staged-package 检查、npm 2FA approval 和最终验收；
- npm package owner 负责 Trusted Publisher、publishing access、maintainer 和 dist-tag 恢复；
- trusted publishing 启用期间，至少保留一个启用 2FA 的人工 owner。移除当前 direct owner
  前，先加入预期的 npm organization publishing team 和另一名人工 direct recovery
  maintainer，并验证两条恢复路径；
- workflow 不得获得长期 npm token。OIDC、Environment 或 trust relationship 损坏时，暂停
  发布并修复控制面，不要使用 `npm publish` 绕过 staging；
- npm 账号丢失时，使用该账号的恢复方式或另一名已经验证的 package owner。在建立第二名
  owner 之前，恢复依赖当前 owner 的 npm recovery credential；完成所有权 follow-up 属于
  明确的运维债务；
- repository 或 npm publisher 设置出现意外变更时，移除或禁用 trust relationship，保留
  workflow 与 npm audit 证据，恢复经过审查的配置，并为 integrity 存疑的候选使用新版本。

## 参考资料

- [ASF Incubator npm 分发指南](https://incubator.apache.org/guides/distribution.html#npm)
- [Apache OpenDAL 孵化期 Node.js 发布 workflow](https://github.com/apache/opendal/blob/v0.44.0/.github/workflows/bindings_nodejs.yml)
- [Apache OpenDAL 孵化期发布指南](https://github.com/apache/opendal/blob/v0.44.0/website/community/committers/release.md)
- [npm staged publishing](https://docs.npmjs.com/staged-publishing/)
- [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/)
- [npm dist-tags](https://docs.npmjs.com/cli/dist-tag/)
- [npm deprecation](https://docs.npmjs.com/cli/v11/commands/npm-deprecate/)
- [GitHub deployment environments](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments)
