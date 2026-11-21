# routing: 路由组编辑器加「规则试算」，保存前看清意图规则会把一句话送到哪

一个真实场景：中文用户用「路由组 + 意图规则 + 小分类器」（比如 Cloudflare Workers AI 上的 Clef）配组，意图照模板写成英文：`a hard task: designing, debugging, a change across several files, or planning`。写完他就卡住了：自己平时那句「帮我把这个函数改成并发安全的」，分类器会判成 hard 还是 easy？规则读不出答案，因为它的真实行为就是小模型对这句话的回答。现在要验证只能保存草稿，开新会话跑一条真实 agent 对话，再去 Routing 页翻 trace 读 `classWhy`。改一次措辞，就得把这套流程从头走一遍。

## 提议

在编辑器规则区下方加一个试算框。粘贴一段文本，GUI 里不到一秒就能看到：分类器判成哪个意图、命中哪条规则、交给哪个成员。试的是还没保存的草稿。

## 实现

- **和真实流量用同一个判定函数**：把 `ruleFor` 里不保存任何状态的部分拆成 `turnDecide`。真实 turn 调用它之后照旧写 `turnRules`；`TryRule` 只调用它。没有 dry-run 标志穿过热路径。
- **试算直接问分类器**（`directAnswer`）：不读也不写共享缓存，分类器失败了不进休息，不在组卡片上留失败记录，也不向任何成员发请求。
- **三个入口**：编辑器的 Try 框；`POST /api/groups/try`；`magpie group try <id> <message…>`，CLI 在本地自己算，不依赖正在运行的 magpie，试的是已保存的组。
- **结果直接用 trace 的 `RuleHit`**，复用 Routing 页现有的 `ruleWhy`/`classWhy` 渲染。

## 验证

- macOS 和 Windows 真机共 14 个用例，全部通过。Windows 上 GUI 的真实分类器调用耗时 548–791ms，CLI（含进程启动）0.79–1.08s；macOS 上 CLI 本地自算 654ms。成员模型全程零请求。判断调用按 `agent=magpie`、`kind=routing` 记账，在 Routing 页带「路由分类器」徽标。
- 分支 [ggbdpq-try-rule](https://github.com/ggbdpq/magpie/tree/ggbdpq-try-rule)：`22952132` 是功能实现，`b96469dc` 修正单意图文案。两个提交的正文附完整验证记录：守卫消融由红转绿；三平台 vet 和 build；GUI 用 Chromium、WebKit 两个引擎测试（`routing-rule-try.test.cjs` 16/16，组编辑器相关的另外 17 个文件 192 例）。

## 节省（估算）

调一组 2–3 条意图规则，通常要迭代 5–20 次。现在每一轮是一次大模型对话（约 10k–50k tokens），外加 0.5–2 分钟手工操作；用试算约 150 tokens，GUI 不到一秒。

## 边界

- 纯附加功能，删掉不影响任何现有路径。
- 受益的是写意图规则、要反复调措辞的用户。没有规则的组会直接提示 decides nothing，不调用分类器。
- 试算只是预览：按会话第一轮算，不带推理档位、图片、文件夹信息，也不考虑会话保持和成员休息。
- 一个观察：组里只有一个意图时，小模型偶尔偏向回答 1（有一次把 "hey, what's up?" 判成了 hard task）。试算能让用户看到这种情况，但不会纠正它。

## 开放问题

试算触发的判断调用，在 Routing 页上和真实流量的判断调用显示得一样。要不要加字段区分，请维护者决定，这个分支没有做。

---

**English summary.** This adds "Try these rules" to the routing group editor: paste a message and see, in under a second in the GUI, which intent the classifier picks, which rule matches and which member goes first, for an unsaved draft. The decision is `turnDecide`, the stateless part split out of `ruleFor`, so a try and a live turn share one code path, and a try leaves no cache, rest, turn state or member request behind. It is reachable from the editor, `POST /api/groups/try` and `magpie group try`, and was checked on macOS and Windows (14 cases). It is purely additive, previews a first turn only, and leaves open whether try-originated classifier calls should be marked apart on the Routing page.

**Attribution**: If you apply these commits, please keep their author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`.

**AI**: written with AI assistance — `Generated-by: GLM-5.3-Flash (ZCode)`.
