# hunt-122 续场开场底账（2026-11-03 晚）

## 基线
- tip：upstream/main `1e1068c86`（50265256b→1e1068c86 前进）；origin/main `f835bd713` 落后（fork 同步自动化会在 ：47 补）。
- 主 clone 挂 hunt77-b 分支（遗留，未动）；本会话 worktree：/private/tmp/mg122-{a,b,c,d,e}，全落 tip。
- /tmp/magpie-sweep/ 有前一 hunt-122 会话遗留产物（mg122-c-patch、mg122-*-log 文件），与新目录不冲突，未动。

## 在途底账（不碰）
- r15 帖 8 支维护者逐支审中：#4900/#4940/#4954/#4958/#4944/#4899/#4936/#4938（hunt-119 会话组稿）。
- 散支 2 支待审：#2972 rework ccefad997、#4909 90830b010。
- r16 帖 10 支已备（/tmp/magpie-sweep/r16-discord.md，批测 10/10 CLEAN @50265256ba）：#2972/#4909/#5062/#5037/#5042/#5091/#5089/#5085/#5075/#5074——发帖时机用户管。
- 另一我方会话正活跃回应 r16 支维护者 review（UTC 14:00-15:16：#5037/#5074/#5075/#5091/#5085/#5089）——本会话候选与其零交集。

## 出列记录（排雷）
- #5090（sessions fork marker）：报告者 SKYhuangjing 自带 fork patch → 让位；叠加上游 fb1f4856a 已覆盖同面。双出列。
- #5084（Claude allowance stale）：标题自带 "(fix on a fork branch)"（qiqll）→ 让位闸明文。
- #5083（provider editor 擦账号）：同为 qiqll "(fix on a fork branch)" → 让位。
- #5058：前会话已出列（RED 后绿=面已被盖判例），不接。
- Feature/UI/咨询类排除：#5103/#5101/#5098/#5097/#5087/#5056/#5046/#5041/#5039（Feature）、#5059/#5083-UI（UI）、#5086/#5073/#5071/#5066-待判（咨询，#5066 后转强候选）、#5081（弱）、#5061（Windows ConPTY 本机不可验）。

## 第一波派单（5 车道，全 c=0 干净、上游自修窗零命中）
- A：#5104 gateway 锁 convoy（性能侦探；报告者 held dump 栈分析质量高；darwin 可复现）
- B：#5067 compaction 400 System messages→Codex 后端（gateway 翻译；报告者三评论深挖）
- C：#5082 session-title output_config.format schema 被忽略（gateway 翻译；#4905 同主题不同路径先例）
- D：#5079 capCareful 重启后 unread 持续 429（状态语义；**兄弟面警告：#5085 我方 patch 在审未收编，帖内须 disclose**）
- E：#5043 长会话 599s 取消+重复恢复历史（流式/诊断；判定帖出口可接受）

## 第二波候选池（待第一波收尾派）
- #5066 mistral 422 reasoning_content extra_forbidden（assistant 消息泄漏私有字段；dsh 正常 vscode/codex 出错=路径分叉）
- #5064 OpenCode V2 providers 键：每次重启新增 v1 provider（配置写入版本分叉）
- #5102 OTLP export System One 调用无 bodies（观测性接线缺口）
- #5099 ChatGPT credit-paid whole-week estimates（usage 估算语义）
- #5100 Drift 误报：magpie 自起 claude 进程写 history.jsonl 被当用户（检测语义；报告者根因分析完整；Linux 报告但逻辑跨平台）
- #5078 antigravity 间歇 stall 2-5min（诊断位，判定帖出口预期）
