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

本文档是发布 `maka-agent` npm 安装渠道的操作权威。根目录 `package.json` 仍是 Maka 唯一产品版本权威，`packages/cli/package.json` 必须与其一致。每个公开 npm 版本都必须来自共享 package workflow 验证过的精确 tarball。

ASF 分发基础设施上经 IPMC 批准的源码归档才是 Apache release。npm、Desktop 安装包和
GitHub Release assets 都是从该源码身份构建的便利包，不是额外的 ASF release artifacts。

source RC 阶段的 [npm 预检](../.github/ASF_NPM_RELEASE.md) 是更早执行、且不持有发布凭据的兼容性检查；其 tarball 不会进入正式发布。source release 获批后，Stage 从位于同一获批 commit 的最终产品 tag 重新构建，并成为 npm staging 与 registry 验证所使用的字节权威。这与 Apache OpenDAL 孵化期的实践一致，同时保留了 Maka 更严格的受保护 Environment、staged publishing、2FA 与 Finalize 控制。

## 发布不变量

- 产品发布工作流只能从已批准的 ASF source candidate tag dispatch；npm Stage 与 npm
  Finalize 都只能从 `main` dispatch，Stage 仅把随后创建的产品 `v<version>` tag 作为已验证数据；
- 获批的稳定版本使用 `latest`，开发快照使用 `nightly`；不再存在 `next` 渠道，`nightly`
  永远不得修改 `latest`；
- 不创建 npm 专属 Git tag 或 GitHub Release；`Release` workflow 在 npm staging 前创建产品
  `v<version>` tag 与 Draft，Finalize 是该 Draft 唯一的发布者；
- 在 npm Finalize 与 Desktop 远程 Runtime Host 验收成功前，GitHub Release 必须保持 Draft；
  Draft 为 npm 提供产品身份，发布 Draft 是最终的产品发布动作；
- 正式发布只能运行 `npm stage publish`，由人工 package maintainer 使用 npm 2FA 批准；只有
  Product Nightly 可以直接运行 `npm publish --tag nightly`；
- validation、staging、approval 和 finalization 之间不得重新构建；
- 已公开的版本不得复用。正式产品修复必须使用新的 patch、minor 或 major 版本。

workflow 边界分别是：

1. [npm publication](../.github/workflows/npm-publication.yml) 是唯一的 Trusted Publisher
   caller；它只能从 `main` 运行，把精确产品 tag 作为待验证的数据路由正式发布，并发布 npm Nightly；
2. [Stage CLI npm release](../.github/workflows/release-cli-stage.yml) 解析已有的产品 tag 与 GitHub
   Release；无 OIDC 的 job 从产品 commit 构建并验证一个 immutable tarball；OIDC job 只执行
   `main` 上已审查的 publisher 代码，分别记录产品 source 与 publisher 身份，再把验证过的字节提交到 npm staging；
3. [Desktop Nightly](../.github/workflows/desktop-nightly.yml) 只在 npm Nightly 成功后启动，只消费
   immutable version file；source commit 与上游 run 身份直接取自已认证的
   `workflow_run` event；
4. [Finalize product release](../.github/workflows/release-cli-finalize.yml) 只接受精确的成功
   Stage run、Release build run 及其自包含 publication record；`main` 上当前已审查的 verifier
   验证公共 registry 字节、signature、provenance、dist-tag、不可变 build artifacts 与 live Draft
   digest，然后等待受保护的 `product-release` Environment；独立 Desktop 验收完成并批准后，它会
   用受保护 workflow 的身份证明精确便利包，并在同一个操作中发布 GitHub Release 及其 Stable/Latest 分类。

## 一次性控制面配置

### GitHub Environment

仓库中的 `.asf.yaml` 是 `npm-publication`、`nightly` 和 `product-release` Environment 的权威。该配置进入 `main` 后，确认 ASF
同步出的 live 配置满足：

- `npm-publication` 只允许 selected `main` branch；为保证 Nightly 自动运行，不设置
  approval gate；
- `nightly` 只允许 selected `main` branch；为保证 Desktop Nightly 自动运行，不设置 approval gate；
- `product-release` 只允许 selected `main` branch，required reviewer 为 `M4n5ter`，并禁止
  self-review；
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
| Workflow filename | `npm-publication.yml` |
| Environment name | `npm-publication` |
| Allowed actions | `npm publish` 与 `npm stage publish` |

Workflow filename 区分大小写，并且不包含 `.github/workflows/` 前缀。正式 staging 与 Nightly
direct publish 都使用 `npm-publication` Environment；它只允许 `main`。因为 Nightly 需要自动
运行，所以不设置 GitHub approval gate；正式发布在 staging 后仍须由
人工使用 npm 2FA 批准。不要配置第二个 publisher 或 npm token。

第一次 OIDC Stage 成功后，将 package publishing access 设置为 **Require two-factor
authentication and disallow tokens**，然后撤销不再使用的 publish token。不要在这一步移除
人工 package owner 或恢复权限。

在 `.asf.yaml` 完成 Environment 同步且 Trusted Publisher 与其匹配前，不要设置仓库变量
`NPM_NIGHTLY_ENABLED`。之后将它设为 `true`，先手动运行一次 Nightly，再依赖 schedule。该变量
只控制 npm；Desktop 使用独立的 `DESKTOP_NIGHTLY_ENABLED` rollout gate。

## Product Nightly

定时 `npm-publication.yml` run 会从精确的 `main` commit 生成一个类似
`0.2.0-dev.42.20260829` 的 immutable 版本，验证四平台 `maka-agent` tarball 并发布到
`nightly`。只有精确版本和 dist-tag 已公开后，成功的 workflow 才会触发
`desktop-nightly.yml`。Desktop 只消费该版本；精确 source commit 来自已认证的上游 event。
打包后的 Desktop 记录精确的 Runtime Host setup specifier，例如
`maka-agent@0.2.0-dev.42.20260829`，绝不安装会漂移的 `nightly` tag。

两个 workflow 按以下顺序发布：

1. 要求候选 npm run number 大于当前 `nightly` tag；
2. 使用 provenance 将精确 npm tarball 发布到 `nightly`；
3. 要求公共 registry 中的精确版本和 `nightly` tag 都已可读；
4. 构建、验证并 attest 精确的 Desktop 安装包和 GitHub `dev` metadata；
5. 将受保护的 `v<version>` tag 绑定到精确 source commit，并验证 Draft 中全部九项资产；
6. 仅在 Draft 完整后发布 Latest 关闭的 GitHub prerelease。

这个顺序既避免 Desktop 指向 npm 中不存在的 Runtime Host，也让 npm Nightly 与 Desktop 打包彼此
独立。npm 或 Desktop run 失败后都不得原地 rerun；应启动新的 npm Nightly：

```sh
gh workflow run npm-publication.yml --ref main -f channel=nightly
```

Nightly 是开发快照，不是 Apache Release，不得从面向最终用户的下载页推广。开发者可以明确使用
`maka-agent@nightly`；产品自动化必须使用 Desktop 记录的精确版本。

## 准备发布

1. 将本次包、文档和发布变更全部合并到 `main`，准备 ASF source candidate，并完成 podling 和 Incubator PMC 两轮投票；
2. 确认已批准 source commit 上的根产品版本、`apps/desktop/package.json` 与
   `packages/cli/package.json` 是同一个尚未使用的稳定目标版本。正式 npm 发布只推进 `latest`；
3. 从精确的已批准 `v<version>-incubating-rc<rc>` tag dispatch 产品 `Release` workflow，并将同一个 tag 作为 `source_reference_tag`。确认其 Draft `v<version>` Release 指向已批准 commit；npm staging 消费这个身份，不能先于它运行；
4. 确认目标版本既不在公共 registry，也不在 staged package 中：

   ```sh
   version=0.2.0
   npm view "maka-agent@$version" version --registry https://registry.npmjs.org/
   npm stage list maka-agent --registry https://registry.npmjs.org/
   ```

   第一个命令应报告目标版本不存在。如果已经存在同版本 stage，先处理它，不要再次提交；
5. 确认 `npm-publication` Environment 和 Trusted Publisher 仍与上面的值一致，并确认负责批准的
   npm 账号已经启用 2FA。

## Stage 候选包

1. 从已审查的 `main` dispatch workflow，并提供精确产品版本：

   ```sh
   version=0.2.0
   gh workflow run npm-publication.yml --ref main \
     -f channel=formal \
     -f version="$version"
   ```

2. 确认新建的 run 使用 `main`。workflow 把 `v<version>` 与 Draft 作为数据解析，要求 tag
   commit 仍是 `main` 的 ancestor，在无 OIDC 的 job 构建候选包，并把 npm provenance 绑定到
   已审查的 `main` publisher workflow 与精确 run；
3. 等待可复用 package validation jobs 全部通过。它们只构建一个 tarball，并在 Linux x64/arm64、
   macOS arm64、Windows x64 上验证安装态 CLI，在 Linux x64 上运行真实 Harbor 和 Pier
   Docker cell；
4. 从 run summary 和 `cli-staged-release-<attempt>` artifact 记录成功 Stage workflow 的 run
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
或被标记为 prerelease 时都必须停止。

只批准这个 stage ID。npm 会要求 2FA，并在批准时将 package 公开：

```sh
npm stage approve "$stage_id" --registry https://registry.npmjs.org/
```

也可以在 npmjs.com package 的 **Staged Packages** 页面完成相同的检查和批准。

获得批准后，检查公共 dist-tags：

```sh
version=0.1.0
npm view maka-agent dist-tags --json --registry https://registry.npmjs.org/
```

`latest` 必须指向获批版本；`nightly` 如果存在，保持独立。

## Finalize 产品发布

npm 显示该版本已经公开后：

1. 在 `main` 上打开 **Actions → Finalize product release → Run workflow**；
2. 输入成功 Stage 的 run ID 与精确 attempt、成功 Release build 的 run ID 与精确 attempt，以及
   version；
3. 让 inspection job 验证公共 tarball 字节、checksum、inventory、npm signature、Trusted
   Publishing provenance 与精确的 `latest` dist-tag；
4. publication job 等待 `product-release` 批准期间，针对 Draft 完成产品检查清单中的跨机器验收；
5. 批准 Environment，并确认 workflow 将每个 live Draft digest 与精确 Release attempt 的
   publication record 对比，生成并上传 `Maka-<version>-attestation.sigstore.json`，发布便利包
   Release；stable release 会同时成为 Latest，不再需要单独人工操作。

检查最终 registry 状态：

```sh
version=0.2.0
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
known_good=0.2.0
npm dist-tag add "maka-agent@$known_good" latest
```

然后只 deprecate 有缺陷的版本，并引导用户使用已经指向验证版本的恢复 dist-tag：

```sh
bad_version=0.2.1
recovery_tag=latest
npm deprecate "maka-agent@$bad_version" "Known issue; install maka-agent@$recovery_tag."
```

验证 dist-tags、修复缺陷，然后通过完整 Stage 和 Finalize 流程发布新版本。不要把
`npm unpublish` 当作常规回滚：删除 immutable dependency bytes 会破坏现有安装，也不能恢复
经过审查的发布链。

Nightly 存在缺陷时，dispatch 新 run，让新的 immutable 版本推进 `nightly`。如果必须立即回滚，
人工 package owner 可以把 `nightly` 指回之前验证过的 Nightly，并只 deprecate 有缺陷的精确
版本。绝不能让 `latest` 指向 Nightly。

## 所有权和紧急恢复

- GitHub repository admin 负责 `npm-publication` Environment 配置；release maintainer 负责
  dispatch、staged-package 检查、npm 2FA approval 和最终验收；
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
