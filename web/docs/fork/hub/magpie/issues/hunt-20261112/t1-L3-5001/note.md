# t1-L3-5001（2026-11-12，第二批）

处置：✅ 现状帖（三期望全部已在 main 落地=无声收编甄别；无 patch 余地；维护者今日在该文件 5+ 提交含 wip=七问 Q5 热区不做 patch）
- take: 6825664678；现状帖: 6825692416（GET 回读一致）
- 甄别映射（提交均无单号引用、issue 零评论=排雷⑤ -S 扫描抓回）：
  1. 期望 2（502 说原因）=627fd1a3b（11-08，v0.1.3316）：endedBefore 携 exit+stderr 尾 300 字符，三协议测试 fixture 即报告者同款 stderr 行
  2. 期望 3（MCP 超时不回退更大粘贴）=325dc3ab3（11-07，v0.1.3230）：helper ready 失败 saidOnEnd("claude-tui: ") 且非 EndedEarly → tuiNoStart → claudeTUIErr 免回退；sowhynot 注释逐字描述报告者旧链为所修场景；真不可加载 session 仍回退（区分面）；今日 531b27783（v0.1.3860）shelf 机制再补 resume 存活
  3. 期望 1 部分落地（等待说名+诊断原因）；222KB 摄取本身=CC 输入路径、机器依赖（#5205 帖 217KB 真机数据交叉引用，不重复取证）
- 代码事实：helper initialize 应答无条件（tui.go:746）但 ready() 在其前（:221→:668 MCP listing 超时→fail() stderr）；裸 "ended without an answer" 仅剩无事件兜底（relay_status.go:40 / :7560 有 KError 取其文本）
- Not verified：Windows/ConPTY/真 CC（读码+提交测试为证）
- 不自信点：tuiInitWait 与 readyWait(45s) 的先后竞速未逐值核对（两路均达 tuiNoStart，结论不受影响）；报告者 0.1.2781/2786 构建上两提交的确切 absent 未做 tag 双向验证（仅 --contains 正向）
