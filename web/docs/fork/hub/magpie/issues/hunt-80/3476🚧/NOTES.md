# H5 #3476 NOTES

- 占坑：comment 6387626231（take），issue OPEN 0 评论，17 open PR 无引用 #3476。
- 基线：upstream/main = 7b1faf99f2a36732a836fd135a7a2f937b4ed3e9（fetch 2026-10-25）。
- worktree：/tmp/magpie-hunt80-e，分支 hunt80-e-3476。
- NODE_PATH=/Users/ggbdpq/.npm/_npx/e41f203b7505f1fb/node_modules（playwright 1.57.0）。
- 基线 sanity：BROWSER=chromium 全跑（无 test-name-pattern）20/20 绿，20.4s。
- 测试总数：2 引擎 × 5 语言 × 2 宽度 × 2 子测 = 40（任务书"30/30"为估计值，实际 40）。

## 假设（读 spec+app.js 后）
1. 红1（press）：locator 已 resolved（输出自带 "locator resolved to <input>"），press 的 actionability
   stable 检查（连续两帧同框）在负载下帧饥饿，动作本身没在 5s 内完成。无固定等待吃预算——
   press 有独立完整 5s 预算仍超。状态等待无效（元素早已 editable）。
2. 红2（waitFor）：替换响应后行 cccccccccc visible 确认 5s 不够。同上。
3. 与 issue 正文一致（"the element was there, the action didn't finish in 5s"）→
   修法 = 维护者指定沿 ce5b23cdb 先例：key-replace.test.cjs 的 setDefaultTimeout 5000→15000
   + 注释。任务书"改状态等待"方向与实测失败形态不符，以实测+维护者正文为准。

## 交互链（app.js 14320-14362）
- edit.onclick：同步 replaceWith input.rename-in.key-value-in + focus；无异步。
- row.ondblclick → edit.onclick 同路径。Escape → done(false) → renderProviders（input 消失）。
- 替换生效：keys/replace 响应 → renderProviders → 行变 cccccccccc。

## 先例
- key-import.test.cjs:82-83: `// room for a busy machine: one click took over 5s at load 190` + setDefaultTimeout(15000)
- ce5b23cdb 提交正文：同轮四红，key-replace (420px, twice) 与 provider-advanced-fold 该提交不触及。
- provider-advanced-fold.test.cjs:60 也有 5000——不在 #3476 scope（标题/正文均指 key-replace），不碰。

## 注入设计（确定性 RED，不提交）
- 注入A（press 红）：app.css 尾加 `@keyframes hunt80jig` + input.key-value-in 动画 14×0.5s alternate
  ≈7s 持续位移 → press 的 stable 检查 5s 内不过 → 红同字样；15s 下 7s 处稳定 → 绿。
- 注入B（waitFor 红）：app.js api() 对 keys/replace 响应延迟 7s → 行 cccccccccc 晚 7s 出现
  → now.waitFor 5s 红；15s 绿。

## TDD 记录
- RED（app.js 双注入：Escape capture 忙等 6s + keys/replace fetch 后延迟 7s；chromium 全跑无 pattern）：
  20/20 红。签名逐字同 issue：
  - en 420 dblclick：locator.press Timeout 5000ms / resolved to input.rename-in.key-value-in / elementHandle.press("Escape")（143 行）
  - zh-TW 420 Change key：locator.waitFor Timeout 5000ms / .acc[data-account-id="cccccccccc"] to be visible（126 行）
  - 日志 out/red-A2-chromium.log（另 out/red-A-chromium.log 是 input 定时器版：press 抢在 50ms 定时前完成，作废）
- 修复提交：49c21c59（5000→15000 + 注释），worktree 干净后再注回 → GREEN chromium 20/20
  （注入拖慢子测 7-8s 完成，out/green-chromium.log）。
- 消融回红：git checkout HEAD~1 -- key-replace.test.cjs（父提交版）+ 注入保留 → chromium 20/20 红，
  两条签名逐字复现（out/ablation-chromium.log）→ 红仅依赖修复缺席。已恢复 HEAD 版。
- 探针结论：playwright 1.57 press 不做 stable 检查（CSS 动画持续位移中 press 26ms 完成）→
  CSS 抖动路线作废；busy-loop 卡 CDP dispatch ack 才是 press 红的忠实注入。

## 兄弟面 rg
- key-replace.test.cjs 内 9 处 press/waitFor/dblclick（101/114/123/128/141/143/145/146/154 行）
  全部吃 open() 同一个 setDefaultTimeout → 一次改全受益，断言本意零改动。
- rg "key-value-in|Change key" 全 tests/：仅 key-replace 命中，无同模式兄弟。
- dblclick 兄弟（usage-ledger-detail、library-instr-busy）：不同交互面不共享 key 行路径，本单未报红 → 不改。
- provider-advanced-fold.test.cjs:60 也有 5000（ce5b23cdb 那轮红过同族）：#3476 scope 是 key-replace
  （标题+正文），逐文件给余量是维护者先例模式 → 不越 scope，汇报注明。

## 失败读取语义
N/A：纯测试动作预算放宽，不触及读取/失败路径语义；等待条件与断言原样。

## 交付
- commit：49c21c59906ef6295e01542e6a37deb12cdc2948（基于 7b1faf99）
- fork 分支：hunt80-e-3476 已推（ls-remote 比对一致）
- patch：patch-3476.patch，sha256 前 16 = 1f8156388b1bed91
- git am 干跑：7b1faf99 与 2009d33a（新上游头）均干净落地（key-replace.test.cjs 两头逐字节同）
- upstream 复查：main 移到 2009d33a（2 新提交触及 app.js/app.css，key-replace/key-import 未触及）
- 帖：take=6387626231，交付=6387964282；GET 回读正文逐字节一致，patch 内嵌 sha16 同
- 矩阵：key-import 12/12、provider-advanced-fold 50/50（双引擎），均绿
- 清理：/tmp/magpie-am-check 已删；worktree /tmp/magpie-hunt80-e 保留（internal/ 下零未提交改动）
