# 任务书 · orca r49 车道 B · #26898 未解线程 + CONFLICTING rebase 车队

## 环境
同车道 A（主仓/worktree /private/tmp/orca-b/分支按单建/验证纪律同）。

## 任务 1：#26898 未解线程（coderabbit Security Minor Quick win）
raw fallback 解码任意非空 clipboard buffer 只查 image dims 不查 size limit——补 size limit 检查（读线程全文取 coderabbit 建议阈值形态；与主路径既有 limit 对齐）+消融回红+同文件测试。推后在线程内回复处置（resolved or 留证）。

## 任务 2：CONFLICTING rebase 车队（优先序=新单先，能做多少做多少，做完列状态）
序：#37848 → #37041 → #36714 → #36707 → #36117 → #36025 → #28327 → #27517 → #26898(若任务1后仍冲突) → #25708 → #25105 → #25108 → #25191 → #25245 → #25356 → #25446 → #24191。
每单标准步：rebase（冲突双方语义都留；modify/delete 按先例裁决：上游批量测试清洗删低价值用例→跟随删除，我方重写回归钉→保留+披露）+取代核对（touched files log+关键词 grep，命中→STOP 交主线程）+定向套件+tc:node+oxfmt/oxlint+棘轮+push 显式 refspec+ls-remote 回读。**每单推送后 24h 内无我方催审帖才发催审**（英文短帖定型格式）；24h 内已发则跳过。
已知预案：#25245 的 persisted-ui-write-baseline.test.ts 上游已删（r41 预案=跟随删除，行为覆盖仍在 ui-slice-contract 测试）；#25191 typecheck 增量或暴露 fixture 缺新字段（先例补齐）。

## 回报
逐单：`#N | rebase(冲突解) | 套件数 | 新head | push回读 | 催审帖URL或跳过原因`；未做完列剩余状态。
