# Maka CLI npm 发布操作手册

[English](./cli-npm-release.md)

本文档是发布 `maka-agent` 的操作权威。CLI 包版本独立于 Desktop 发布线。每个公开版本都必须
来自 Stage workflow 验证过的同一个精确 tarball。

## 发布不变量

- 只从 `main` dispatch 发布 workflow；
- 预发布版本使用 `next`，稳定版本使用 `latest`；`next` 不得指向比 `latest` 更旧的版本；没有
  更新的预发布版本时，两个 tag 都指向稳定版；
- Git tag 使用 `cli-v<version>`；CLI release 不得替换 Desktop 的 GitHub Latest release；
- 不运行 `npm publish`。GitHub Actions 只能运行 `npm stage publish`，由人工 package
  maintainer 使用 npm 2FA 批准 staged package；
- validation、staging、approval 和 finalization 之间不得重新构建；
- 已公开的版本不得复用。修复必须使用新的 prerelease、patch、minor 或 major 版本。

两个 workflow 边界分别是：

1. [Stage CLI npm release](../.github/workflows/release-cli-stage.yml) 构建并验证一个 immutable
   tarball，记录其 source identity，进入受保护的 `npm-release` Environment，然后通过 OIDC
   提交到 npm staging；
2. [Finalize CLI npm release](../.github/workflows/release-cli-finalize.yml) 只接受精确的成功
   Stage run 和 attempt，验证公共 registry 字节、signature、provenance 和 dist-tag，然后创建
   精确 Git tag 和非 Latest 的 GitHub Release。

## 一次性控制面配置

### GitHub Environment

创建名为 `npm-release` 的 Environment，并设置：

- 只允许 `main` 部署；
- 将当前 CLI 发布维护者设为 required reviewer；
- 只有一名发布维护者期间允许 self-review；
- 仓库策略允许时禁用 administrator bypass；
- 不配置 environment secret 或 variable。

配置 Environment 需要仓库 administration 权限。workflow 使用 GitHub OIDC，不读取 npm
token。

### npm Trusted Publisher

在 `maka-agent` package settings 中配置一个 GitHub Actions trusted publisher：

| 字段 | 值 |
| --- | --- |
| Organization or user | `maka-agent` |
| Repository | `maka-agent` |
| Workflow filename | `release-cli-stage.yml` |
| Environment name | `npm-release` |
| Allowed actions | 仅 `npm stage publish` |

Workflow filename 区分大小写，并且不包含 `.github/workflows/` 前缀。这个 trust relationship
不得启用 `npm publish`。

第一次 OIDC Stage 成功后，将 package publishing access 设置为 **Require two-factor
authentication and disallow tokens**，然后撤销不再使用的 publish token。不要在这一步移除
人工 package owner 或恢复权限。

## 准备发布

1. 将本次包、文档和发布变更全部合并到 `main`；
2. 把 `packages/cli/package.json` 更新为尚未使用的目标版本并合并。release tool 会把
   prerelease 映射到 `next`，stable 映射到 `latest`；
3. 确认目标版本既不在公共 registry，也不在 staged package 中：

   ```sh
   version=0.1.0-beta.1
   npm view "maka-agent@$version" version --registry https://registry.npmjs.org/
   npm stage list maka-agent --registry https://registry.npmjs.org/
   ```

   第一个命令应报告目标版本不存在。如果已经存在同版本 stage，先处理它，不要再次提交；
4. 确认 `npm-release` Environment 和 Trusted Publisher 仍与上面的值一致，并确认负责批准的
   npm 账号已经启用 2FA。

## Stage 候选包

1. 打开 **Actions → Stage CLI npm release → Run workflow**；
2. 选择 `main`，输入 `packages/cli/package.json` 中的精确版本；
3. 等待可复用 package validation jobs 全部通过。它们只构建一个 tarball，并在 Linux x64、
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

## Finalize 公共发布

npm 显示该版本已经公开后：

1. 在 `main` 上打开 **Actions → Finalize CLI npm release → Run workflow**；
2. 输入成功 Stage 的 run ID、精确 run attempt 和 version；
3. 让 inspection job 验证公共 tarball 字节、checksum、inventory、npm signature、Trusted
   Publishing provenance、发布 dist-tag，并确认 `next` 不比 `latest` 更旧；
4. 审查并批准用于 Git tag 和 GitHub Release 的 `npm-release` Environment deployment；
5. 确认 workflow 在 Stage source commit 上创建了 `cli-v<version>`。预发布版本必须标记为
   prerelease；任何 CLI release 都不得成为仓库的 GitHub Latest release。

检查最终 registry 状态：

```sh
version=0.1.0-beta.1
npm view "maka-agent@$version" version dist.tarball dist.integrity --json
npm view maka-agent dist-tags --json
```

最后，在每个发布平台安装精确的公共版本，并完成一次真实的 TUI/model turn。在支持的 Eval
host 上完成至少一个真实 experiment cell，检查 score、usage、cost 和 artifacts。

## 失败恢复

### npm staging 之前失败

如果 validation 或 Environment approval 在 `npm stage publish` 前失败，在 `main` 修复后启动
新的 Stage run。此时没有消耗 npm 版本。

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

拒绝该 stage，在 `main` 修复后重新 Stage。不要为了清空 staging area 而批准有问题的候选。

### npm approval 成功，但 Finalize 失败

npm 版本此时已经 immutable，不要再次 publish 或 approve。保留 Stage run ID、attempt、version
和 artifacts。如果 package 字节与 provenance 有效，在 `main` 修复当前 Finalize verifier，
然后针对同一个成功 Stage identity 重新运行 Finalize。

Finalize 可以幂等地恢复部分完成的 GitHub Release 创建：它会继续处理精确匹配的
draft，并且只会在验证 metadata 和 asset digest 后接受已经发布的 release。如果已经
存在的 `cli-v<version>` 指向的不是记录的 Stage source commit，或已经发布的 release
与验证过的 candidate 不一致，立即停止并调查。不要通过移动或删除 tag 让 workflow 通过。

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

- [npm staged publishing](https://docs.npmjs.com/staged-publishing/)
- [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/)
- [npm dist-tags](https://docs.npmjs.com/cli/dist-tag/)
- [npm deprecation](https://docs.npmjs.com/cli/v11/commands/npm-deprecate/)
- [GitHub deployment environments](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments)
