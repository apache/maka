# t1-L3-4977（2026-11-12）

处置：✅ VERDICT/triage 帖 6825350770（take 6825333271；无 patch——档3+无复现+区域已被上游改掉）
- 证据链：
  1. renderPools v0.1.2767(:7501-7534) ↔ tip(:8844-8877) diff 为空=字节级相同，「按钮被上游删掉」不成立；标题无行唯一可达路径=两语句间抛异常（需 console 佐证）
  2. 「文字残留」=常驻长解释；cec267f90(11-10, yujezhang 抱怨) 把 Routing 卡片长解释折进 hover——正是报告者所见残留，已在报告后 7 天被上游处理；8e9b048b6(11-03 当日) settings 行解释改 hover
  3. 命名诉求（去 group/ 前缀+小写）=auto/… 命名空间是有意设计（toggle 文案自证）→ 指向 @yetone 拍板，建议开独立 feature issue
- 版本陈旧度：0.1.2767→v0.1.3906 = 1607 commits；a6e4cf763(11-09) settings 迁移 Models›Routing
- Not verified/不自信点：GUI 本体未跑（无复现可驱动，引擎面 NOT-RUNNABLE）；「标题无行」的唯一代码路径推演未在真实浏览器验证（无报告者 console）；2767↔tip 字节级断言仅覆盖 renderPools 函数窗（7501-7534/8844-8877），非整个文件
