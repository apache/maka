# hunt79-k-3497 NOTES
- 基线: e57e785633a7976d9ad31771979a6ed5b2e8e99a (upstream/main, fetch 2026-10-25)
- issue #3497: OPEN, 0评论(占坑前), 无 open PR 引用
- take: comment-6387174453
- worktree: /tmp/magpie-hunt79-k, branch hunt79-k-3497

## 定性（2026-10-25）
- 复现红: 每引擎 15 子测红 10（5语言×2宽度全红，env 子测 5 绿），fail 22 含 2 父套件
- 失败点: account-discovery.test.cjs L112 deepEqual
  actual(discovery)=['Off','On'], expected(#redactList .row 首行 .opt)=[]
- 根因提交: e698a688f (2026-10-24 18:14 +0800) "gui: Insights › Masking shows each request as sent..."
  提交说明明确: Privacy keeps "What was masked" row that opens the page → redactList prepend 新行（无 .opt）
  app.js L21996: box.prepend(rowIn(box, t("What was masked"), ..., open)); 守卫 featureHides($('#nav button[data-view="masking"]'))
- 63c0c354a 嫌疑排除: 只动 plugins 页资产（i18n.js/plugins.css/plugins.js/plugins.go/github.go），不触及 settings 页
- 控件是有意新增（提交说明明写），修=更新测试期望形状
- 修法（拟）: L112 比对目标从「redactList 首行」改为「redactList 第一个含 .opt 的行」（=Mask secrets，意图不变）
- L164 #redactList .opt nth(1) 不受影响（新行无 .opt，索引不变）

## 幻象 pass 警示
- node --test --test-name-pattern X <file> 可能整文件不跑子测计 1 pass（135ms）——消融/红绿判定必须全跑

## 矩阵
- 目标 spec 修后: 双引擎 32/32 绿（5语言×2宽度+5 env ×2）
- 消融: 还原期望→chromium 全跑 10/15 红 L112（+['Off','On'] - []）
- 相邻抽测 chromium: redact-kinds+redact-rule-row 15/15, privacy-model 12/12
- 预存红（非本单）: redact-words-any-case chromium 10/10 红 = #3500; builtins 红 = #3498

## 交付
- commit: 4dc732cdf6c1fd906e04bf223c306a8d9e074dbc (branch hunt79-k-3497, pushed)
- patch sha256 前16: 019e44f1998aca6c
- 交付帖: comment-6387355583, GET 回读六项全真 (author ggbdpq, body_len 6175)
- 发帖前上游 3a47e377e (#3464 usage 页) 零触及复查通过
