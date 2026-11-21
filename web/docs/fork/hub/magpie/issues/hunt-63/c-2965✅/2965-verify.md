# hunt63 Lane C：#2965 澄清回帖核验笔记（2026-10-22）

对象：yetone/magpie#2965（TestRequestBuildsProvidersOnce goes red under load）。
前轮材料：hunt62/e-flaky/verification.md #2965 节（判定 b）。本轮任务 = 核验事实 + 新基线复验 + 定稿，不发帖。

## 1. 帖内事实核对（gh issue view 2965，全帖 1 正文 + 3 评论）

- 正文（10-19 14:21Z yetone）：e433d3fb3 上 load ~280-400 全量跑红一次，失败行被输出过滤器截掉；单跑 -count=8 绿。诊断=按请求起点判 900ms 窗，与 1s hold 错位。
- 我方 patch 评论（10-19 22:11Z ggbdpq）：d7136798，分支 hunt49-a-builds-once，构造证明 + 全套验证表，与草稿引用一致。
- 通报 1（10-20 10:20Z yetone）：load ~380 batch **dee5c9d75**，`request 1 built the providers 2 times, want 1`（不同签名：单请求内两次构建），单跑 3/3 绿。
- 通报 2（10-20 19:08Z yetone）：**c8c0985df**（4bb93b325+4 本地批次）全量跑，`request 2 built the providers 1 times, want 0`（同签名=本单原始病）；同 head 单包 ok 1551.8s。

草稿引用的两条红、负载、SHA、签名全部与帖内原文吻合。

## 2. 谱系核验（merge-base，worktree 对象库）

- dee5c9d75（10-20 16:32 +0800）：是 6a050eeb 的**祖先**（`merge-base --is-ancestor` 通过），即不含 6a050eeb；不含 d7136798。
- 4bb93b325（10-21 02:44 +0800）：是 6a050eeb 的祖先，不含 6a050eeb、不含 d7136798。c8c0985df 为维护者本地批次（对象不在远端），用 4bb93b325 做代理；c8c0985df 跑测时间 10-21 03:08 +0800 **早于** 6a050eeb 提交时间 07:32 +0800，时间线排除其本地 +4 含 6a050eeb 的可能。
- 结论：**两条通报的树都不含 6a050eeb、不含我方 patch d7136798** → 草稿第 1 段成立。

## 3. 新基线复验（ba1dc7f9，worktree /tmp/magpie-r63-c，detached）

- 增量核对：87d703c5..ba1dc7f9 共 6 提交，`git diff --stat -- internal/provider/ internal/gateway/` 只动 middleware_test.go、plugin_checkin.go、plugin_checkin_test.go，**未触及 provider.go 与 request_builds_once_test.go** → 前轮构造实验（87d703c5 上请求 2 全程未调 allProviders）结论对 ba1dc7f9 成立。
- cherry-pick d7136798 → **干净落上**（自动合并，6325eaa6，2 files changed +26/-12）。
- 守护测试：`go test -tags nogui -count=4 -run 'TestRequestBuildsProvidersOnce$' ./internal/gateway/` → **4/4 PASS**（-v 逐遍确认 0.11s/0.02s/0.02s/0.02s；`ok ... 1.179s`）。本机空载（macOS arm64）。
- 还原：`git reset --hard ba1dc7f9`，worktree 干净（detached @ba1dc7f9，无未跟踪文件）。
- 前轮对照：87d703c5 上 -count=8 8/8 绿（2965-patched-count8.log）；本轮按任务要求轻量 -count=4。

## 4. 定稿改动点（相对前轮草稿）

1. "current main (87d703c5)" → 谱系表述改为按通报 SHA 直陈（dee5c9d75 / c8c0985df=4bb93b325+4 均先于 6a050eeb），实验段改说 "on main since 6a050eeb"（实验实测树为 87d703c5，增量未触及该区域）。
2. patch 段更新为 **ba1dc7f9、-count=4**（实际验证值，替换 87d703c5/-count=8）。
3. 保留 "request 1 built 2 times" 形状段（回应通报 1 的不同签名：patch 不会遮住它——request 1 仍要求恰 1 次；pre-kept 码上可能是 hold 正常松手而非 #2502 复发）。
4. 语气=澄清分流：6a050eeb 大概率已吸收原始形状，patch 去留按 10-21 后签名浸泡决定（安静→撤回；再现→rebase）。无邀功表述；零中文；普通确认类评论，**无尾注、无 Attribution**。

## 5. 环境卫生

- 未 push、未发帖、未评论；仓库文件零改动（cherry-pick 已 reset 丢弃）。
- 本目录新增：2965-reply.body.md（定稿）、2965-verify.md（本笔记）。
