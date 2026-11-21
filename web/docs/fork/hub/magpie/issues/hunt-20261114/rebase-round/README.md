# 在途分支批量 rebase 轮（2026-11-14）

- 口径：三列清单在途 144 单（唯一单号去重，每单取最新 head 分支），rebase 到开工时 tip `63c91cae5`；无冲突 rebase+push（显式 sha refspec + --force-with-lease），冲突一律 defer 不自动解。未跑测试套件（分支保鲜轮，非交付轮）。
- 结果：PUSHED 104（range-diff 零漂移）/ PUSHED-DRIFT 11（干净 rebase 但同域上游有活动，语义复核候选）/ DEFER-CONFLICT 29（分支原样未动，冲突文件见 ledger）/ 零 MISSING/FETCHFAIL/PUSHFAIL。
- 抽查：fix/3967（origin=25c612dbe=台账 new）/fix/5074（origin=231af275a=台账 new）/fix/3106（origin=596e88dba=台账 old，defer 分支未触碰）三方一致 PASS。
- 台账列：unit / branch / verdict / old_sha / note（PUSHED 带 new sha+drift+dropped；DEFER 带冲突文件清单）。
