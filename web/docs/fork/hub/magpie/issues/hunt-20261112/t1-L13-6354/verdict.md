# t1-L13 · #6354 出列判定笔记（2026-11-13）

## 单号与定性

yetone/magpie#6354「v0.1.3927 never published: macOS amd64 build lost proxy.golang.org (run 43254320209)」——**维护者亲单**（author=yetone，2026-11-12 17:04Z，OPEN，0 评论，updatedAt=createdAt 零互动）。正文=发布流水一次失败的完整自诊：run 43254320209 的 `mac (macos-15-intel, amd64)` 任务 `Build magpie.app` 步在 go mod download 时 proxy.golang.org 连接错误 → make build-release Error 1；tag v0.1.3927（bbce1fc1a，即 updater 的 attestation check 提交、#6347 Sigstore 域）无 release；v0.1.3928/3930/3931 含该 commit、各 17 assets 非 draft；结论「runner 网络抖动，非代码变更；build 的 go mod download 无重试」。

## 三查（2026-11-13）

1. **末评**：0 评论（复测 length=0），无占坑、无新回合。
2. **fork 分支**：无 6354 相关分支。
3. **收编三查**：`git log --all --grep=6354` 唯一命中 ab1006bb8 正文内 sha 片段 `8e6354714`——数字巧合，lower+contains 排除；无 PR 引用；magpie-releases 近 10 commit 全是 homebrew tap bump（v0.1.3931-3941），**无任何重试类改动**（自诊中的"无重试"缺口至今未修）。

## 实测补充（GitHub API）

- run 43254320209：conclusion=failure（2026-11-12 16:02-16:17Z），失败任务=`mac (macos-15-intel, amd64)` 失败步=`Build magpie.app`，publish skipped——与正文一致。
- **同晚第二起失败 run 3954（43268190719，17:19:24Z）是不同面**：`publish` 任务的 `Update Homebrew tap` 步失败，六构建任务全绿——当晚失败面比单帖记录的更宽。
- 16:57-18:49Z 两个小时内 v0.1.3931→3941 连发 10 版（tap commit 序列），流水自愈；3955-3958 全 success。

## 两向定性（任务书决策树）

- **CI 重试面 = 维护者侧基础设施**（yetone/magpie-releases 仓 workflow）→ 不越权改 CI（任务书明示）。
- **updater 容错面 = 无缺陷，PATCH 无对象**（代码核实，tip 9c33839de）：
  - `internal/update/update.go`：版本发现只走 `usemagpie.ai/api/latest` feed（单 release 描述：version/notes/assets+SHA256），客户端**不枚举 tag/release**；缺失的 v0.1.3927 对客户端不可见，用户 ≤3926 直接从 feed 拿到最新已发布版。
  - `internal/update/notes.go`：历史 notes 走站点 `/api/notes`（站点只列已发布 release），`ReleasePage` 仅按站点给出版本生成链接——同样零 tag 依赖。
  - 客户端下载侧重试完备（retryWaits×5、stallAfter 断流重试、GitHub→API 路由回退）——#6354 的失败面在构建侧不在客户端。
  - `bbce1fc1a` 经 v0.1.3928+ 全部下发，attestation check 提交无覆盖缺口。

## 处置：零帖出列

- **亲单纪律不 take**（选单正典 #2，2026-10-25 用户令；#6347 同日先例「亲单纪律出列不接」零帖）；自留单判别三征（handbook/10 条目 16）全命中：正文只有失败日志+自诊、作者=维护者自录、无 ask 无 @ 无求助语句。
- **判定帖七问 Q4 不过**：收益说不清——无人受影响（后续版本已覆盖，流水自愈），报告者=维护者且已自诊完毕；我方两条增量事实（第二起失败不同面、至今无重试改动）均为维护者自知的流水状态，发帖即 #3488 形噪声。零新帖是正常结果（handbook/05 §2）。

## Not verified / 不自信

- 未复核 run 43254320209 完整日志原文（仅 API job/step 粒度；正文错误摘录未逐字比对 runner 日志）。
- 3954 失败 tap 步与 3932-3941 连发的因果关系未深挖（维护者流水考古，非本单域）。
- 站点 feed（usemagpie.ai/api/latest /api/notes）为服务端黑盒，其生成是否依赖 releases 列表未验证——但即使依赖，缺失版本也只是不在列表，无失败面。
