# #5542 验证纪要（车道 M5，2026-11-07）

- 单：yetone/magpie#5542「dsh: parentless forks still stay under their source after #5491」——**外部 patch port 请愿单**
- 先例 #5491：dsh fork 的请求按 reply id（replayState.response.responseId）归属 fork；守卫要求 opening 是 reply 会话自己的或其 ForkOf 链上的（parentSession）；已 port 进 v0.1.3145（yetone re-author + co-author Flandern1211）
- 回归机理：dsh 0.2.2 的 fork 不再写 parentSession → ForkOf 空 → forkedFrom 拒绝 → ownerOf 回退 opening hash 归源。证据（源 opening hash）在 fork 文件 copied prefix 里，但被 end-seed reset 丢弃
- 报告者 patch：Flandern1211/magpie `fix/dsh-fork-without-parent` @ `ead1abcce`（SeedConvs + forkedFrom seed 证据分支 + parseVersions dsh 1→2）

## 处置

port 而非重写（报告者已给实现+精确测试名+RED 形态，#5491 先例即 port 收编形态）。cherry-pick 一处冲突：upstream 在其分叉后加 `antigravity` parseVersions 条目，解法=两者并存（dsh:2 + antigravity:1）。全 diff review 通过：
- `dsh.go`：end-seed reset 时 `SeedConvs = SeedConvs + Convs`（fork of fork 跨 markers 累积成立——子 fork 的 end-seed 时 Convs 含源 opening）
- `sessions.go`：Session.SeedConvs（json:"-"）/state.SeedConvs（seed_convs，进缓存）/clone/assembleListed/parseVersions
- `context.go`：forkedFrom 新增 seed 证据分支（`ownerSeed(id+"\x00"+conv)`），数据源仍是本地会话文件，collision guard 实际语义不放宽；Route.ResponseID 唯一性要求不变
- fixture `trace_dsh_response_test.go` 去 parentSession——#5491 的集成测试转为锁定本修

- 分支：`fix/5542-dsh-parentless-forks`（fork ggbdpq/magpie），head `0d7e18d1e785a4246014c0df1b66ada5c17ea43b`，基线 upstream/main `416305451`
- 提交：author=ggbdpq + **Co-authored-by: Flandern1211**（报告者要求 re-author 时加，#5491 先例同形态）+ Ported from 标注 + 尾注；6 文件 +109/−14
- patch：`git format-patch -1 --zero-commit`，SHA-256 前 16 `764a9ce8e940997a`
- take 帖 6694052409；PATCH 帖 6694231142（GET 回读 OK）
- worktree：/private/tmp/mg-5542（GOCACHE=/tmp/mg-5542-gocache）

## TDD（port 场景：消融即 RED 证据）

- `TestDshForkWithoutAParentKeepsItsSeedOpenings`（sessions）/`TestDshForkWithoutAParentIsNamedByItsReply`（gui）：GREEN 后消融回红
- 消融 A（只回 dsh.go）：`seed openings [], want [magpie-e2f7b8e6… magpie-dc816daf… magpie-be45a6b1…]`（报告者原句一字不差）+ `TestRoutingTellsAForkByItsReply` 红（fixture 去_parentSession 后无新机制即红）
- 消融 B（只回 context.go）：`reply "chatcmpl-fork", opening "magpie-open": "source", want "fork"`（报告者原句一字不差）

## 矩阵

| 项 | 结果 |
| --- | --- |
| gui `-run 'Dsh|Fork|Routing|Context|Conv'` | ok |
| gateway `-run 'Dsh|ResponseID'` | ok（本单不触 gateway 产品代码，不跑 gateway 全包） |
| sessions 全量 nogui | ok（55.7s） |
| gui 全量 nogui | 唯一红 TestProxyCheckSaysAProxyPassedBy=**任务书点名预存红**（本机代理 7897），其余 ok |
| gofmt -l / vet nogui darwin+linux / build | clean / clean / ok |

## 发布

push 显式 refspec `0d7e18d1e:refs/heads/fix/5542-dsh-parentless-forks` → ls-remote 一致 → PATCH 帖 6694231142（五段+验证表+patch 折叠+Co-authored credit+port 溯源+尾注）→ GET 回读 OK（len 18095，全要素在）。
