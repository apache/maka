# 5588-symlink-phantom（备单，library 移交 symlink skill 幽灵条目）

- 单：#5588，报告者 xqh-jason（0 评论，自带根因定位与控制表，质量高）。
- take：issuecomment-6711470736；PATCH 帖：issuecomment-6712001998，回读 OK。
- 排雷五查：0 评论；无收编；0 open PR 涉 5588；log --grep 命中 2 笔均为数字巧合（gateway MCP/kiro mover）；域词扫描（hand-over+symlink/fork）全净。
- RED：TestHandOverSharedLinkWithGoose（sandbox 默认含 goose，shared symlink→外部目录，直接 hand-over）——修前报「grilling isn't kept in …/.agents/skills」，与报告一字不差。
- 根因（证实报告者分析）：importSkill 清杂散链接环对「Skills 目录=共享目录」的 agent（goose/kimicode/cindy）把 p=共享条目本身当杂散删掉；handOver 随后 sharedEntry=="" 报错，而 library.json 只在成功路径写→幽灵链接。真实目录 linked(p)=false 故不触发（控制表第 3 行）。
- 修法：①该环比照 readsSharedHere/strays 既有惯例跳过 realDir(t.Skills)==realDir(sharedSkillsDir()) 的 agent；②handOver 在 importSkill 前预检共享条目（安全网，不可用态先拒后动）。removeFound 的删除共享条目是有意行为（文档明示），不动。
- 测试断言勘误：移交成功后 change() 发放步骤会给 goose 重建条目=magpie 自有链接（TestHandOverWithGoose 同款 ours() 终态），断言从「条目消失」改为「ours 指库」。
- 消融回红：退两产品文件→红（报告原文错误）；恢复→绿。
- 兄弟面：同惯例在库内另有 7 处；importSkill 3 个调用方（handOver/ImportSkill/ImportSkills）同根一处修；removeFound/2434 意图不同不动。
- 矩阵：library 全包 143s 绿；nogui 全仓 83 包 ok，5 失败全为本机预存（TestMothX/TestProxyCheckSaysAProxyPassedBy/TestHostToldTheGatewayAddress 清单内；TestSettingsCLISetsWhatTheWindowSaves/TestSettingsSaveKeepsWhatItDoesNotSend 经 nav worktree（Go 代码=upstream）交叉复跑确证同红，与本 diff 无关）；-race TestHandOver 绿；gofmt/vet×3/build×3 干净。
- rebase：46b10af87→30b7a1732（提交 bd888f7f5）→d32a7a70c（rebase 后 head e7d47e1aa，library 包复跑 98s 绿）。
- 发布：head e7d47e1aa9072905c4203378f6dc733a0fd6ef4e；分支 fix/5588-symlink-skill-phantom（ls-remote 一致）；patch sha256 前16=f4af3976b7548bab（5874 字节）。
