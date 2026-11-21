**结论：这是 Claude Desktop 端的限制，不是 magpie 侧还能修的**——网关侧能给的（正确的 `display_name`）已经给了，剩余差距出在 Desktop 对「能折进它自家签名目录的 id」的名称覆盖上。[#1746 合入时的说明](https://github.com/yetone/magpie/issues/1746#issuecomment-6133258946) 已把这条列为已知客户端限制（"id 看起来像 Claude 自家模型的（比如 Opus 5.5），Desktop 会用它自己目录里的名字显示，网关这边改不了"），本 issue 是它在「两个供应商的同一个 Claude 模型」场景下的具体呈现。

**根因链**（对照 main `1d6f461a` 核过）：

1. 菜单内容不是 magpie 写进 Desktop 配置的。magpie 只写 3p `deploymentMode` 和 gateway profile（`internal/agent/claudedesktop.go` 头注释）；没有 `inferenceModels` 时 Desktop 列的是网关 `/v1/models`，菜单是 Desktop 启动时自拉的。`display_name` 已走 `desktopNames` → `provider.Labels`（#1746），你核对到的响应也证实了这点。
2. 覆盖发生在 Desktop 侧：对有推理档位的原生 Claude 模型，`claudeLooking`（`internal/gateway/desktop.go`）必须列成 `magpie-<n>.anthropic.claude-opus-5-5`——Desktop（app.asar 2.7032 的 tIt/IC/HFt 链）剥掉 `<profile>.anthropic.` 前缀后按 `claude-opus-5-5` 查它的签名目录给 per-model effort 档位，**同时用目录名（"Opus 5.5"）替代行名、无视 `display_name`**；两行折进同一目录名时 Desktop 再拿 id 片段加括号区分，就是你看到的「数字哈希 + `.anthropic.claude-opus-5-5` 后缀」。无档位的 Sonnet 走原样 id，同样被目录名覆盖成 "Sonnet 5.5"。

**为什么 magpie 侧剩下的路都走不通**（不想硬凑）：

1. **id 形态被 effort 语义锁死**。改用 `mythos-magpie-<n>` 通配别名确实能让 `display_name` 露出来，但档位会换成通配表：thinking 强制常开、没有 off、丢 per-model 档位，且 Code tab 不再认得这个模型（unrecognized_model）——与期望 #3「保留 reasoning effort 语义」直接冲突。
2. **供应商名进 id 撞厂商词雷区**。Desktop 的网关检查会拒绝 id 里含 deepseek / kimi / glm / gpt / grok 等几十个厂商词中任何一个的模型，且词表随版本增长——供应商名一旦撞词，模型会**整条从菜单消失**，比现在更糟。别名用 10 位数字哈希而不是可读名，正是为了「id 里不给它任何厂商词」。
3. **两个未验证的杠杆不能当修复交付**。`description` 字段和 `inferenceModels[].labelOverride` 对「目录折叠行」是否生效都没在真实 UI 验证过：目录行是否仍附加网关行的 description、labelOverride 能否盖过目录名，都是未知。而自动维护 `inferenceModels` 还会把现在「Desktop 启动时动态拉 `/v1/models`」的机制冻结成静态列表。你把「验证覆盖真实 Desktop 菜单」列为验收条件是合理的——这两条必须先在真实 Desktop（双供应商同模型）环境验证有效，才值得由 magpie 自动维护。

**眼下的缓解**：

- 菜单括号里的 10 位数字是该模型 magpie id 的 FNV 哈希（`aliasNumber`），同一模型稳定不变，认一次即可固定区分；Claude Code CLI 的 `/model` 不受影响（走的是 `display_name`），与你观察一致。
- 某段时间只用一家时，可在 magpie 的 Claude Desktop 行的模型多选里只勾当前用的那家，菜单就只剩一个条目、无歧义。

要不要试 `description`/`labelOverride` 这条路，建议由维护者拍板：若试，先在真实 Desktop（双供应商同模型）确认这两个字段对目录折叠行是否生效，再决定 magpie 是否自动维护。
