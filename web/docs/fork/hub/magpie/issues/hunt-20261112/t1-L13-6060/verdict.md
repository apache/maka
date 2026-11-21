# t1-L13 · #6060 出列判定笔记（2026-11-13）

## 单号与定性

yetone/magpie#6060「[Feature] Enhance usage requests API with stable record IDs, original IDs and resumable incremental reads」（saltbo/WakaToken 插件作者，2026-11-11，OPEN，1 评论）。功能请求：稳定记录 ID+原始 ID 暴露+可恢复增量游标。

## 处置：已收编 → 出列，零帖

### 三查（2026-11-13，tip 9c33839de）

1. **末评=维护者收编帖**（yetone 6826983758，2026-11-12 14:53Z）：「Shipped in v0.1.3917」——cursor=start/now 增量读、rows 按 stable id upsert、origin、original_ids（只含来源给的）、deleted 墓碑、next_cursor/has_more、修正同 id 高 seq、原生态被网关归并进 deleted、不可续游标 400 cursor_invalid/cursor_filter_changed 与 410 cursor_expired/cursor_reset、墓碑留 30 天、offset/limit 不变、docs（reference.md 'Connecting anything else' + site remote docs）已写；**末句「Leaving this open for you to try it」=故意留 open 等报告者验证，球在报告者场**。
2. **fork 分支**：无。
3. **收编实证**：实现提交 477bbb7a1（2026-11-12 22:40 +0800）主题明点 `#6060`，`git merge-base --is-ancestor 477bbb7a1 upstream/main` = YES；实现在库核验（**ref 读取**）：`internal/usage/feed.go`（头注明点 #6060，feedID=内容派生稳定 id 设计）、`internal/usageapi/feed.go`、`internal/gateway/usage_api.go` cursor 引用 7/15/5 处；docs 四处（reference.md +52、integrating.md、gateway-routing/gateway-sessions、site remote 三语）+usage-feed.jsonl 持久日志+held-key 作用域，与 commit message/末评逐项吻合。

### 派单提示核验

#6199（e6bf4adf1）=「Claude Code helper requests are labelled…」——helper 请求内容推断标注+BigWrite 行，**另一单另一诉求，与 #6060 无覆盖关系**（其正文「Not done: the per-request branch recovery result asked for in #6199」同证）。#6060 的实际覆盖来自其本体实现 477bbb7a1。

### 零帖理由

维护者末评即收编公告且明确等报告者带插件验证（报告者正文亦自荐「愿意用插件验证实现」）；我方任何帖（确认/背书/催促）对等待中的双方零收益，违反七问 Q4；已收编不重复交付、已解决不机械触达（handbook/05 §6）。零新帖是正常结果。

## 事故自纠（工作树陷阱）

主 clone 工作树停在 detached HEAD 3fc6ee411——首轮 `ls/rg` 读工作树误判「feed.go 在 tip 消失」；改 `git show upstream/main:<path>`/`git grep <ref>` 后确认在库。教训现役重申（handbook/05 §2：核对 checkout HEAD 与 tracking ref；**tip 状态一律 ref 读取，不读主 clone 工作树**）。

## Not verified / 不自信

- 未实测 shipped API（无 magpie 运行时+用量数据；维护者明确要报告者插件级验证）；v0.1.3917 tag 与 477bbb7a1 的包含关系未逐 tag 核（ls-remote 确认 3910-3913 存在，3917 属同段发布流）。
- 末评承诺与代码逐字段吻合度未全量 diff（cursor 语义按 commit message+feed.go 头注抽验）。
